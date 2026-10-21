/**
 * 健康巡检（health watch）纯逻辑。
 *
 * 问题：离开模式开着，但 agent 可能因为报错/上下文超限/进程抖动**意外停住**，
 * 既没完成、也没喊人 —— 用户以为它在干活，回来发现什么都没发生。
 *
 * 办法：定时（tick）检查「是否真的在运行」；判定为「没在运行」就注入一条
 * [健康巡检] 消息，逼 agent 自己表态：
 *   ① 已完成   → set_task_state(done)      → 之后不再问
 *   ② 在等你   → set_task_state(waiting_user) → 之后不再问
 *   ③ 没完成也不是在等你 → 从上次停下的地方继续
 * 用户一旦开口（input），状态立即回到 working，下次还会再问。
 *
 * 本模块只做状态机与文案，不碰定时器 / 配置 / 事件（那些在 index.ts）。
 */

export type HealthPhase =
  | "working" // 认为它还在干活（默认）
  | "done" // agent 自报已完成 → 巡检静默
  | "waiting_user" // agent 在等用户（决策/凭据/审批）→ 巡检静默
  | "stalled" // 催了 N 次都没动静，已升级喊人 → 巡检静默
  | "exhausted"; // 用户说过别喊 → 催到上限后停止追问（不升级、不喊人）

// ── 「忙」的统一判定（TODO-3）────────────────────────────────────────────
// reportTimer 与 healthTick 曾经各判各的（一个只看 agentActive，一个还看工具/子代理/队列），
// 结果同一时刻 A 判不忙、B 判忙。现在两条线都从这里取数。

export interface ActivitySnapshot {
  /** 回合进行中（agentActive || !ctx.isIdle()） */
  agentBusy: boolean;
  /** 正在执行中的工具数（长 bash / 同步 subagent 都算） */
  runningTools: number;
  /** 当前会话里还在跑的 async 子代理数 */
  activeSubagents: number;
  /** 有消息压在投递队列里 */
  pendingMessages: boolean;
}

/** 忙 = 回合在跑 或 有工具/子代理在干活。队列不算「忙」，它只是「别插话」。 */
export function isBusy(s: ActivitySnapshot): boolean {
  return s.agentBusy || s.runningTools > 0 || s.activeSubagents > 0;
}

/**
 * 进度心跳这次该不该插话。
 * 与 healthTick 的区别只是方向：心跳要「回合在跑」才有进度可报，巡检要「没在跑」才催。
 * 但对「什么叫忙」的判断完全一致 —— 这就是 TODO-3 要消掉的漂移。
 *
 * 长工具调用中不插话：steer 会压在队列里等这次工具结束才投递，堆积成重复催促。
 */
export function shouldSkipReportTick(s: ActivitySnapshot): boolean {
  if (!s.agentBusy) return true; // 回合已结束 → 无进度可报
  if (s.runningTools > 0) return true; // 卡在长工具里 → 插话只会堆积
  if (s.pendingMessages) return true; // 队列里已有话没投递 → 别再压一条
  return false;
}

export interface HealthState {
  phase: HealthPhase;
  /** 最后一次「有动静」的时间（回合/工具/子代理/回合结束都算） */
  idleSince: number;
  /** 本段连续空闲已催次数（只有用户输入或真实工具活动才清零） */
  nudges: number;
  lastNudgeAt?: number;
  escalatedAt?: number;
  /** agent 自报的一句话说明 */
  note?: string;
}

export function newHealthState(now: number): HealthState {
  return { phase: "working", idleSince: now, nudges: 0 };
}

/**
 * 有任何动静（回合开始/工具执行/子代理进展/回合结束）→ 刷新空闲起点。
 * 注意：**不动 nudges**。否则我们自己注入的巡检消息会触发回合，
 * 回合一动就把计数清零，永远催不到上限。
 * stalled 状态下出现动静 = 它其实还活着 → 回到 working。
 */
export function touchActivity(state: HealthState, now: number): void {
  state.idleSince = now;
  if (state.phase === "stalled") {
    state.phase = "working";
    state.nudges = 0;
    state.lastNudgeAt = undefined;
    state.escalatedAt = undefined;
  }
}

/**
 * 真实工作恢复（用户输入 / 真正的工具调用）→ 本段空闲的催问计数清零。
 * 用户打字 = 会话继续，即使之前是 done 也要回到 working（需求③）。
 */
export function markUserInput(state: HealthState, now: number): void {
  state.phase = "working";
  state.idleSince = now;
  state.nudges = 0;
  state.lastNudgeAt = undefined;
  state.escalatedAt = undefined;
  state.note = undefined;
}

/**
 * 真实工作恢复（排除了 set_task_state 这类纯表态工具的调用）。
 * done 保持不变：agent 报完完成再补几句总结，不该被翻回 working。
 */
export function markRealWork(state: HealthState, now: number): void {
  state.idleSince = now;
  state.nudges = 0;
  state.lastNudgeAt = undefined;
  state.escalatedAt = undefined;
  if (state.phase === "stalled") state.phase = "working";
}

export function setPhase(state: HealthState, phase: HealthPhase, now: number, note?: string): void {
  state.phase = phase;
  if (note !== undefined) state.note = note;
  if (phase === "working") {
    state.idleSince = now;
    state.nudges = 0;
    state.lastNudgeAt = undefined;
    state.escalatedAt = undefined;
  }
}

// ── 一次巡检滴答的判定 ───────────────────────────────────────────────────

export type HealthSkipReason =
  | "not-cooking"
  | "disabled"
  | "phase"
  | "busy"
  | "queued"
  | "not-idle";

export interface HealthTickProbe {
  cooking: boolean;
  enabled: boolean;
  now: number;
  /** !ctx.isIdle() || agentActive —— 回合进行中 */
  agentBusy: boolean;
  /** 正在执行中的工具数（长 bash / 同步 subagent 调用也算） */
  runningTools: number;
  /** 当前会话里还在跑的 async 子代理数 */
  activeSubagents: number;
  /** 有消息压在投递队列里 */
  pendingMessages: boolean;
  /** 未处理的阻塞呼喊数量（说明它在等你，不是在卡死） */
  blockingAlerts: number;
  /** 空闲多久算「没在运行」（分钟） */
  idleMinutes: number;
  /** 同一段空闲最多催几次 */
  maxNudges: number;
  /** 用户明确说了别喊 → 只催不升级，催到这个次数才停止（0 = 不限制） */
  muteEscalation: boolean;
  /** muteEscalation 下的催问上限（默认 30） */
  silenceMaxNudges?: number;
}

export type HealthTickDecision =
  | { action: "skip"; reason: HealthSkipReason }
  /** 它在等用户（有未处理的阻塞呼喊）→ 标记 waiting_user */
  | { action: "waiting" }
  /** 注入一次巡检询问，nudge 是本次序号（从 1 开始） */
  | { action: "nudge"; nudge: number }
  /** 催到上限仍没动静 → 升级喊人一次，之后静默 */
  | { action: "escalate" }
  /** 静默模式催到上限 → 尊重「别喊了」，停止追问但不喊人 */
  | { action: "exhausted" };

/** 判定本次滴答该做什么（纯函数，不改状态） */
export function decideHealthTick(state: HealthState, probe: HealthTickProbe): HealthTickDecision {
  if (!probe.cooking) return { action: "skip", reason: "not-cooking" };
  if (!probe.enabled) return { action: "skip", reason: "disabled" };
  if (state.phase !== "working") return { action: "skip", reason: "phase" };
  if (probe.agentBusy || probe.runningTools > 0 || probe.activeSubagents > 0) {
    return { action: "skip", reason: "busy" };
  }
  if (probe.pendingMessages) return { action: "skip", reason: "queued" };
  // 先看是否真的空闲了：有阻塞呼喊但 agent 刚刚还在动，就再等等（别过早静默）
  if (probe.now - state.idleSince < Math.max(1, probe.idleMinutes) * 60_000) {
    return { action: "skip", reason: "not-idle" };
  }
  // 已经空闲且还有未处理的阻塞呼喊 = 它在等你（不是在卡死）→ 静默
  if (probe.blockingAlerts > 0) return { action: "waiting" };
  // 用户说了"别喊了"这类：不升级。但仍要有上限（默认 30 次），
  // 否则一个真死掉的会话会被无限追问下去，白烧 token。
  if (probe.muteEscalation) {
    const cap = probe.silenceMaxNudges ?? 30;
    if (cap > 0 && state.nudges >= cap) return { action: "exhausted" };
    return { action: "nudge", nudge: state.nudges + 1 };
  }
  if (state.nudges >= Math.max(1, probe.maxNudges)) return { action: "escalate" };
  return { action: "nudge", nudge: state.nudges + 1 };
}

/** 把判定结果落回状态（nudge 计数 / 阶段迁移） */
export function applyHealthDecision(state: HealthState, decision: HealthTickDecision, now: number): void {
  if (decision.action === "nudge") {
    state.nudges = decision.nudge;
    state.lastNudgeAt = now;
    state.idleSince = now; // 给它一个完整的空闲窗口来接话
    return;
  }
  if (decision.action === "waiting") {
    state.phase = "waiting_user";
    return;
  }
  if (decision.action === "escalate") {
    state.phase = "stalled";
    state.escalatedAt = now;
    return;
  }
  if (decision.action === "exhausted") {
    // 注意：这里**不喊人**，只是停止追问。用户说了别喊，就真的不喊。
    state.phase = "exhausted";
    state.escalatedAt = undefined;
  }
}

// ── 文案 ────────────────────────────────────────────────────────────────

/** 人类可读的时长：3 秒 / 12 分钟 / 1 小时 5 分 */
export function formatIdle(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

const PHASE_LABEL: Record<HealthPhase, string> = {
  working: "进行中",
  done: "已完成（不再追问）",
  waiting_user: "在等你（不再追问）",
  stalled: "无响应（已喊人，暂停追问）",
  exhausted: "已按你要求停止追问（不喊人）",
};

/** 一行摘要（状态栏 / status 用） */
export function formatHealthLine(
  state: HealthState,
  now: number,
  cfg: { enabled: boolean; checkMinutes: number; idleMinutes: number; maxNudges: number; muteEscalation: boolean },
): string {
  if (!cfg.enabled) return "健康巡检: 关";
  const cap = state.phase === "working"
    ? cfg.muteEscalation
      ? "（你说了别喊 → 一直催不升级）"
      : `（最多催 ${cfg.maxNudges} 次后喊你）`
    : "";
  const idle = state.phase === "working" ? `，空闲 ${formatIdle(now - state.idleSince)}` : "";
  const nudge = state.nudges > 0 ? `，已催 ${state.nudges} 次` : "";
  return `健康巡检: 开 · 每 ${cfg.checkMinutes} 分钟查一次 / 空闲 ${cfg.idleMinutes} 分钟判定${cap} · 🩺 ${PHASE_LABEL[state.phase]}${idle}${nudge}`;
}

export interface HealthPromptOptions {
  idleMinutes: number;
  nudge: number;
  maxNudges: number;
  muteEscalation: boolean;
  /** 上一回合结束原因（error / aborted / stop …），用于判断是不是意外终止 */
  lastStopReason?: string;
  /** 上一回合最后一条 agent 文本（摘要用） */
  lastText?: string;
}

/**
 * 构造注入给 agent 的巡检消息：逼它三选一，不要含糊其辞。
 * 带上「上次结束原因 / 最后一句」是为了治「因为问题意外终止」的场景。
 */
export function buildHealthPrompt(o: HealthPromptOptions): string {
  const lines: string[] = [];
  lines.push(
    `[健康巡检 #${o.nudge}] 你已经没有任何动静（无回合、无工具调用、无子代理在跑），` +
    `空闲超过 ${o.idleMinutes} 分钟。请先自查，然后**只做下面三件事中的一件**：`,
  );
  lines.push(
    `1) 任务已全部完成 → 立即调用 set_task_state(state="done", note="一句话交付结论")；` +
    `如果还没发完成通知，可同时调用 shout_for_user(category="completion", urgency="info")。`,
  );
  lines.push(
    `2) 你其实是在等我（等我登录 / 等我决策 / 等我确认 / 等我手动操作）→ ` +
    `调用 set_task_state(state="waiting_user", note="在等我做什么")。已经有未处理的呼喊就不必重复喊。`,
  );
  lines.push(
    `3) 任务没完成、也不是在等我 → 从你上次停下的地方**继续推进**：` +
    `先核对已完成的部分（不要重做），说明下一步，然后接着干。`,
  );
  if (o.lastStopReason === "error") {
    lines.push(
      `⚠️ 上一回合是**报错中断**（stopReason=error）：先判断错误是否已消失，不要原样重试同样的步骤；` +
      `如果错误是外部原因（网络/额度/服务故障），如实说明并把任务标记为 waiting_user 或先做不依赖它的部分。`,
    );
  } else if (o.lastStopReason && o.lastStopReason !== "stop") {
    lines.push(`📌 上一回合结束原因：${o.lastStopReason}（可能是意外中断，注意别丢上下文）。`);
  }
  if (o.lastText) {
    const t = o.lastText.replace(/\s+/g, " ").trim();
    lines.push(`📄 你上一回合最后一句话：「${t.length > 160 ? `${t.slice(0, 160)}…` : t}」`);
  }
  lines.push(`第 ${o.nudge} 次询问${o.muteEscalation ? "（用户说过别喊，不会升级为响铃，我会一直问下去）" : `，共 ${o.maxNudges} 次`}。`);
  return lines.join("\n");
}

/** 催到上限后升级给用户的呼喊文案 */
export function buildStallAlert(o: { nudges: number; idleMinutes: number; lastText?: string }): string {
  const core =
    `Agent 连续 ${o.nudges} 次被追问都没有响应（每次间隔约 ${o.idleMinutes} 分钟的判定窗口），` +
    `可能卡死或已意外终止。建议回来看一眼。`;
  if (!o.lastText) return core;
  const t = o.lastText.replace(/\s+/g, " ").trim();
  return `${core}\n它最后说的话：「${t.length > 200 ? `${t.slice(0, 200)}…` : t}」`;
}