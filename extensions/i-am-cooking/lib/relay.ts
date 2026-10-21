/**
 * 子 Agent → 父 Agent 的呼喊转达（需求：子 Agent 不许直接喊用户）。
 *
 * 为什么需要：pi-subagents 起的子 Agent 是**独立进程**。它可能跑在用户没打开的会话里
 * （比如"Zen 镜像"）。子 Agent 自己响铃/弹窗，用户听到也回不到那个界面去答话——
 * 所以子 Agent 的呼喊必须交给父 Agent，由父 Agent（用户真正面对的那个会话）转述。
 *
 * 跨进程怎么传：子 Agent 把请求写成一行 JSON，追加到以**父会话 id** 命名的文件里。
 * 父 Agent 在收尾 / 巡检 / 子代理结束时把文件读走（读完即清空），
 * 再以一条 `[子Agent 转达]` 消息投给自己——真正响铃的是父 Agent。
 *
 * 为什么不用 pi-subagents 的 nested-event sink：那是它的私有目录 + capability token
 * 校验，格式是子代理状态记录，不是通用消息通道。走我们自己的状态目录更稳、可测、也少一层耦合。
 *
 * 本模块只做「文件路径 / 序列化 / 解析 / 文案」，读写由入口用 fs 完成（便于测试）。
 */

import { sanitizeLabel } from "./identity.ts";

export const RELAY_DIR_NAME = "relay";
export const RELAY_FILE_MAX_BYTES = 256 * 1024;

export interface RelayRequest {
  /** 本请求唯一 id（去重用） */
  id: string;
  /** 写入时间（ms epoch） */
  ts: number;
  /** 发起者的可读名（"Zen 镜像" / "trellis-implement: 修 R1"） */
  from: string;
  /** 发起者的会话 id（可能没有） */
  fromSessionId?: string;
  /** 发起者的 agent 名（如 trellis-implement） */
  fromAgent?: string;
  /** 交给用户处理的内容（父 Agent 会拿到原文） */
  message: string;
  urgency: "info" | "normal" | "urgent";
  category: string;
  /** 可选语音原文 */
  ttsText?: string;
}

/** 子 Agent 的呼喊请求文件：按父会话 id 分文件，父会话只读自己那份 */
export function relayFilePath(relayDir: string, parentSessionId: string): string {
  // 会话 id 可能带路径分隔符 / 冒号 / 自己的 .jsonl 后缀；统一压成安全 token
  const token = parentSessionId
    .trim()
    .replace(/\.jsonl?$/i, "") // 会话文件路径自带的扩展名别再叠一层
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${relayDir}/${token || "unknown"}.jsonl`;
}

/** 序列化一条请求（单行 JSON，调用方负责换行） */
export function serializeRelayRequest(req: RelayRequest): string {
  return JSON.stringify(req);
}

/**
 * 解析请求文件内容。**坏行直接跳过**（子 Agent 可能写到一半被杀）——
 * 一条坏数据不能让整批转达失败。
 */
export function parseRelayRequests(content: string): RelayRequest[] {
  const out: RelayRequest[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const req = normalizeRelayRequest(parsed);
    if (req) out.push(req);
  }
  return out;
}

function normalizeRelayRequest(raw: unknown): RelayRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return undefined;
  if (typeof r.message !== "string" || !r.message.trim()) return undefined;
  const urgency =
    r.urgency === "urgent" ? "urgent" : r.urgency === "normal" ? "normal" : "info";
  // 可选字段为空时不写入键：让解析结果与序列化前的对象结构一致（便于往返比较）
  const fromSessionId = typeof r.fromSessionId === "string" && r.fromSessionId ? r.fromSessionId : undefined;
  const fromAgent = typeof r.fromAgent === "string" && r.fromAgent ? sanitizeLabel(r.fromAgent, 24) : undefined;
  const ttsText = typeof r.ttsText === "string" && r.ttsText ? r.ttsText.slice(0, 2_000) : undefined;
  return {
    id: r.id.slice(0, 64),
    ts: typeof r.ts === "number" && Number.isFinite(r.ts) ? r.ts : 0,
    from: sanitizeLabel(typeof r.from === "string" ? r.from : undefined, 40) || "子Agent",
    ...(fromSessionId ? { fromSessionId } : {}),
    ...(fromAgent ? { fromAgent } : {}),
    message: r.message.slice(0, 8_000),
    urgency,
    category: typeof r.category === "string" && r.category ? r.category.slice(0, 32) : "other",
    ...(ttsText ? { ttsText } : {}),
  };
}

/** 去重：同一 id 只保留最早那条 */
export function dedupeRelayRequests(reqs: RelayRequest[]): RelayRequest[] {
  const seen = new Set<string>();
  const out: RelayRequest[] = [];
  for (const r of reqs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * 父 Agent 收到的转达提示（作为一条成员消息投给父 Agent 自己）。
 *
 * 关键要求：**由父 Agent 决定要不要喊**，而不是机械转发。
 * 父 Agent 有上下文，能判断这件事是否值得此刻喊醒用户、能否自己处理掉。
 */
export function buildRelayPrompt(reqs: RelayRequest[], parentLabel: string): string {
  const list = reqs
    .map((r, i) => {
      const who = r.fromAgent && r.fromAgent !== r.from ? `${r.from}（agent: ${r.fromAgent}）` : r.from;
      return (
        `${i + 1}) 来自「${who}」的呼喊请求（urgency=${r.urgency}, category=${r.category}）：\n` +
        `${indent(r.message, "   ")}` +
        (r.ttsText ? `\n   它想要的语音：${r.ttsText}` : "")
      );
    })
    .join("\n\n");

  return [
    `[子Agent 转达 · ${reqs.length} 条] 你派的子 Agent 不能直接呼喊用户（用户可能没打开它的会话，听得到也回不了它）。`,
    `下面这些是它们交给你的请求，**由你决定怎么处理**：`,
    ``,
    list,
    ``,
    `请按下面三种情况之一处理，不要原样机械转发：`,
    `1) 确实只有用户能解决（决策/凭据/验证码/审批/外部服务故障）→ 你来调用 shout_for_user，` +
    `message 里写清是「${parentLabel} 转达 · 子Agent X 需要你」，并把上下文补齐到用户能直接行动的程度。`,
    `2) 你能自己处理掉 → 直接处理，不要打扰用户；处理完在最终汇报里说一句即可。`,
    `3) 只是进度信息 → 合并成一条 shout_for_user（category="progress" 或 "milestone"），不要一条条发。`,
    `喊完之后：被卡住的那件事已交接，其他不依赖用户的工作继续推进。`,
  ].join("\n");
}

function indent(text: string, pad: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => pad + l)
    .join("\n");
}

/** 子 Agent 调用 shout_for_user 时拿到的回执（告诉模型发生了什么，别重复交） */
export function buildRelayAckText(input: {
  from: string;
  queued: boolean;
  parentSessionId?: string;
  reason?: string;
}): string {
  if (!input.queued) {
    return (
      `未转达：${input.reason ?? "无法确定父 Agent 会话"}。\n` +
      `你现在是子 Agent，不能直接呼喊用户。请把需要用户处理的内容**写进你的最终结果**，` +
      `父 Agent 会在收到结果后转达。不要再重复调用 shout_for_user。`
    );
  }
  return (
    `已转达给父 Agent（它会决定是否呼喊用户——真正响铃的是父 Agent，不是你）。\n` +
    `- 发起者：${input.from}\n` +
    (input.parentSessionId ? `- 目标父会话：${input.parentSessionId}\n` : "") +
    `注意：\n` +
    `1) 这不等于用户已经知道了，父 Agent 可能判断后决定先不打扰用户。\n` +
    `2) **不要重复提交同一条请求**；有更新就等父 Agent 追问。\n` +
    `3) 同时把这段交接内容写进你的最终结果，父 Agent 收到结果时还会再看一遍。\n` +
    `4) 被卡住的那件事已交接，其他不依赖用户的工作继续推进。`
  );
}
