/**
 * 回合异常分类与退避（health watch 的 L 表批注）。
 *
 * 问题：现在只区分「回合报错（stopReason=error）」一种，一律按 urgent 喊人。
 * 结果 ① API 429 限流 ② 上下文超限 这两种「自己会好 / 自己能处理」的情况
 * 也会把正在做饭的用户喊回来，回来后发现 agent 其实只是被限流了。
 *
 * 办法：先分类，再决定处置。
 *   - rate-limit        → 退避重试，不喊人；退避到上限才升级
 *   - context-overflow  → 先 compact 再重试，不喊人；仍失败才升级
 *   - transient (5xx/网络) → 退避重试
 *   - permanent (语法错误/路径不存在/参数错) → 直接喊（现状不变，这是真需要人）
 *   - unknown           → 直接喊（宁可误喊，不可漏喊）
 *
 * 判定来源的限制（写进 docs）：pi 的 `AgentMessage` 只暴露 `stopReason` /
 * `rawStopReason` / `errorMessage` 文本，**没有单独的状态码字段**。
 * 所以这里优先从文本里抠状态码，其次匹配错误措辞；`stopReason` 本不够用。
 *
 * 本模块纯函数，不碰定时器 / ctx / 配置（那些在 index.ts）。
 */

export type TurnErrorKind =
  | "rate-limit"
  | "context-overflow"
  | "transient"
  | "permanent"
  | "unknown";

export interface TurnErrorInput {
  /** AssistantMessage.errorMessage（provider 原文） */
  errorMessage?: string;
  /** provider 原生结束原因（有些 provider 会放 "rate_limit" / "context_length_exceeded"） */
  rawStopReason?: string;
  /** 已解析出的 HTTP 状态码（调用方可先自己解析；不传则从文本里抠） */
  statusCode?: number;
  /** ctx.getContextUsage()?.percent（上下文占用百分比，0-100；用于识别「快撑爆了」） */
  contextPercent?: number | null;
}

/** 从错误文本里抠 HTTP 状态码：429 / (429) / status 429 / HTTP 429 / 429 Too Many … */
export function extractStatusCode(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /\b(?:http|status|code|error)?[\s:_-]*\(?(4\d{2}|5\d{2})\)?\b/i.exec(text);
  if (!m) return undefined;
  const code = Number(m[1]);
  // 4xx/5xx 里排除「行号」「端口」这类误命中：只接受常见错误码
  const known = new Set([400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, 529]);
  return known.has(code) ? code : undefined;
}

const RATE_LIMIT_RE =
  /rate[\s_-]?limit|too many requests|quota (exceeded|exhausted)|resource[_ ]?exhausted|requests? per minute|tokens per minute|\brpm\b|\btpm\b|overloaded_error|overloaded/i;

const CONTEXT_OVERFLOW_RE =
  /context (window|length)|context_length_exceeded|maximum context|prompt is too long|too many tokens|input (is )?too long|exceeds? (the )?(maximum|model)|reduce the length|token limit|max_tokens|input length/i;

const TRANSIENT_RE =
  /overloaded|service unavailable|bad gateway|gateway timeout|upstream (error|timeout)|\btimed? ?out\b|\btimeout\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network (error|is unreachable)|temporarily unavailable|try again later/i;

const PERMANENT_RE =
  /ENOENT|no such file|not found|SyntaxError|Unexpected token|Unexpected end of (JSON|input)|is not a function|is not defined|permission denied|EACCES|invalid (request|argument|parameter|api key)|unauthorized|forbidden|missing (required|api key)|cannot find module|unexpected character/i;

/**
 * 分类回合异常。优先级：状态码 > rawStopReason > 错误文本 > 上下文占用。
 */
export function classifyTurnError(input: TurnErrorInput): TurnErrorKind {
  const text = [input.errorMessage, input.rawStopReason].filter(Boolean).join("\n");
  const code = input.statusCode ?? extractStatusCode(input.errorMessage ?? input.rawStopReason);

  // ① 状态码最准
  if (code === 429) return "rate-limit";
  if (code === 413) return "context-overflow";
  if (code === 408 || code === 500 || code === 502 || code === 503 || code === 504 || code === 529) {
    return "transient";
  }
  if (code === 401 || code === 403 || code === 404 || code === 400 || code === 409 || code === 422) {
    return "permanent";
  }

  // ② rawStopReason 里 provider 有时直接给语义值
  if (input.rawStopReason) {
    if (RATE_LIMIT_RE.test(input.rawStopReason)) return "rate-limit";
    if (CONTEXT_OVERFLOW_RE.test(input.rawStopReason)) return "context-overflow";
  }

  // ③ 错误文本
  if (RATE_LIMIT_RE.test(text)) return "rate-limit";
  if (CONTEXT_OVERFLOW_RE.test(text)) return "context-overflow";
  if (TRANSIENT_RE.test(text)) return "transient";
  if (PERMANENT_RE.test(text)) return "permanent";

  // ④ 上下文占用已经很高 → 大概率是超限（文本里可能只有一句 "Error"）
  if (typeof input.contextPercent === "number" && input.contextPercent >= 95) return "context-overflow";

  return "unknown";
}

/** 这一类异常是否值得自动重试（而不是立刻喊人） */
export function isRetryable(kind: TurnErrorKind): boolean {
  return kind === "rate-limit" || kind === "transient" || kind === "context-overflow";
}

/** 这一类异常是否应该先 compact 再重试 */
export function shouldCompactFirst(kind: TurnErrorKind): boolean {
  return kind === "context-overflow";
}

/**
 * 指数退避：attempt 从 1 开始，base 60s / cap 10min 时 → 1、2、4 分钟。
 * 到 `maxAttempts` 之后不再重试（调用方据 shouldEscalate 决定升级喊人）。
 */
export function backoffMs(
  attempt: number,
  baseMs: number = 60_000,
  capMs: number = 600_000,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(Math.max(1, baseMs), 60_000) * 2 ** (n - 1);
  return Math.min(Math.max(raw, baseMs), capMs);
}

/**
 * 是否应该升级为喊人：不可重试的类别立刻升级；可重试的类别到上限才升级。
 * `attempt` = 已经重试过的次数（0 = 第一次失败）。
 */
export function shouldEscalate(
  kind: TurnErrorKind,
  attempt: number,
  maxAttempts: number,
): boolean {
  if (!isRetryable(kind)) return true;
  if (!(maxAttempts > 0)) return true; // 关掉重试 → 回到旧行为（立刻喊）
  return attempt >= maxAttempts;
}

const KIND_LABEL: Record<TurnErrorKind, string> = {
  "rate-limit": "API 限流（429 / quota）",
  "context-overflow": "上下文超限（context window）",
  transient: "暂时性故障（5xx / 网络抖动）",
  permanent: "永久性失败（脚本语法 / 路径 / 参数错误）",
  unknown: "未分类错误",
};

export function describeErrorKind(kind: TurnErrorKind): string {
  return KIND_LABEL[kind];
}

export interface RetrySteerOptions {
  kind: TurnErrorKind;
  attempt: number;
  maxAttempts: number;
  /** 下一次重试的等待时长（ms） */
  retryInMs: number;
  /** 是否已经先 compact 过 */
  compacted?: boolean;
  /** 上一回合最后一条 agent 文本（摘要，帮它认回上下文） */
  lastText?: string;
}

/**
 * 退避重试注入给 agent 的提示。
 * 要点：① 说明是什么错、已重试几次；② 明确「不是让你原地重试」而是换做法；
 *      ③ 其他不依赖它的工作照常推进（R6 暂停/继续语义）。
 */
export function buildRetrySteer(o: RetrySteerOptions): string {
  const hours = Math.round(o.retryInMs / 60_000);
  const lines = [
    `[健康巡检 · 回合异常自动重试 ${o.attempt}/${o.maxAttempts}] 上一回合是**${describeErrorKind(o.kind)}**中断的，` +
    `不是你的逻辑错。`,
  ];
  if (o.kind === "context-overflow") {
    lines.push(
      `上下文已经压缩过${o.compacted ? "（本次已触发 compact）" : ""}。压缩后上下文里较早的细节会变简略——` +
      `**先核对已落盘的文件 / 已有产出，不要凭记忆重做已完成的部分**。`,
    );
  } else if (o.kind === "rate-limit") {
    lines.push(
      `这是 provider 侧的限流，等 ${hours} 分钟后会自动重试；这期间把节奏放慢、减少并发与重试次数，` +
      `不要连续重打同一个请求。`,
    );
  } else {
    lines.push(`等 ${hours} 分钟后会自动重试一次。先把能并行的、不依赖它的部分推进。`);
  }
  lines.push(
    `**不要原样重放上一回合**：先看它到底卡在哪一步，必要的话换做法（拆小、换工具、先用小样验证）。`,
  );
  if (o.lastText) {
    const t = o.lastText.replace(/\s+/g, " ").trim();
    lines.push(`📄 你上一回合最后一句话：「${t.length > 160 ? `${t.slice(0, 160)}…` : t}」`);
  }
  lines.push(
    `这是暂停交接提示：从停下的地方继续，已完成的部分不要重做；其他不依赖本次失败的工作照常推进。`,
  );
  return lines.join("\n");
}
