/**
 * I am cooking 🍳
 *
 * 你离开电脑去做饭时，pi 代理继续自主干活；
 * 它真正卡住需要你时，会"大声呼喊"你 —— 多路通知：
 *   ① 声音（哔哔/自定义 wav） ② 中文 TTS ③ Windows Toast
 *   ④ 手机推送（ntfy.sh，人在厨房的关键通道） ⑤ TUI 横幅常驻
 *
 * 命令:
 *   /i-am-cooking on [备注]    — 开启离开模式（agent 收到指令自主推进）
 *   /i-am-cooking off          — 我回来了（agent 收到"我不在时喊了你X件事"的汇报）
 *   /i-am-cooking status       — 查看模式/待处理呼喊/通道/音量/偏好/等级/防打扰参数
 *   /i-am-cooking setup        — 交互式配置向导（手机推送 + 音量 + 自主等级）
 *   /i-am-cooking test         — 测试所有通道（不用先开模式）
 *   /i-am-cooking stop-sound   — 停止本次播放（只停当前，下次照常；同 Ctrl+Alt+M）
 *   /i-am-cooking rules        — 查看当前生效规则
 *   /i-am-cooking edit-rules   — 编辑规则文件（保存即生效）
 *   /i-am-cooking reset-rules  — 规则恢复出厂默认（内置规则）
 *   /i-am-cooking level        — 自主等级（conservative/balanced/autonomous）
 *   /i-am-cooking limits       — 查看/调整防打扰参数（交互式中文）
 *   /i-am-cooking sound        — 自定义呼喊铃声（歌曲/试听/总时长，交互式中文）
 *   /i-am-cooking volume       — 音量控制（查看/手动调整/离开自动拉高，交互式中文）
 *   /i-am-cooking health        — 健康巡检（开关/频率/空闲判定/催问上限/立刻巡检一次）
 *   /i-am-cooking agent [名字]  — 查看/设置本会话的呼喊标签（多 Agent 时分辨是谁在喊你）
 *
 * 工具 (LLM 调用):
 *   shout_for_user            — 卡住且只有用户能解决时调用
 *   set_task_state            — 向健康巡检表态：已完成 / 在等你 / 仍在推进
 *   set_calling_preference    — 根据用户原话调整呼喊偏好（别喊了/完成后喊我/…）
 *   set_autonomy_level        — 根据用户原话调整自主等级（遇墙就喊/能不喊就不喊/…）
 *   enter_cooking_mode        — 用户明确说"去做饭了"时自动开启离开模式
 *   set_shout_sound           — 用户要求换铃声时设置自定义歌曲
 *   set_volume                — 用户明确要求时调整系统音量/解除静音
 *   exit_cooking_mode         — 用户明确回来时关闭离开模式
 *
 * 自动检测:
 *   agent_settled 后若回合以"？"结尾且没有后续工具调用 → 自动呼喊（安全网）
 *   健康巡检: 定时检查 agent 是否真的在运行（回合/工具/子代理/队列）；停住就催它表态，
 *             催满上限还没动静才升级喊用户；用户一开口自动恢复追问
 *
 * 配置: ~/.pi/i-am-cooking/config.json （可热改，/reload 生效）
 */
import type { ExtensionAPI, ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui"; // 快捷键（停止本次播放）
import { mkdir, readFile, writeFile, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
// 纯逻辑模块（可测试）
import { suggestTopic } from "./lib/topic.ts";
import { renderTts as renderTtsImpl } from "./lib/tts.ts";
import { buildStallAlert, buildHealthPrompt, decideHealthTick, applyHealthDecision, formatHealthLine, formatIdle, markRealWork, markUserInput, newHealthState, setPhase, touchActivity, isBusy, shouldSkipReportTick } from "./lib/health.ts";
import type { ActivitySnapshot, HealthPhase, HealthState } from "./lib/health.ts";
import { newToolWatch, startToolWatch, endToolWatch, runningToolCount, clearToolWatch, overdueTools, buildToolTimeoutSteer, formatRunningTools } from "./lib/tool-watch.ts";
import type { ToolWatch } from "./lib/tool-watch.ts";
import { classifyTurnError, isRetryable, shouldCompactFirst, backoffMs, shouldEscalate, buildRetrySteer, describeErrorKind } from "./lib/errors.ts";
import type { TurnErrorKind } from "./lib/errors.ts";
import { buildEndJudgePrompt, parseEndJudgeVerdict, shouldUseEndJudge, renderEndJudgeCommand } from "./lib/end-judge.ts";
import { agentTag, mustRelayViaParent, resolveAgentIdentity, sanitizeLabel, tagMessage, ttsAgentPrefix } from "./lib/identity.ts";
import type { AgentIdentity } from "./lib/identity.ts";
import { buildRelayAckText, buildRelayPrompt, dedupeRelayRequests, parseRelayRequests, relayFilePath, serializeRelayRequest } from "./lib/relay.ts";
import type { RelayRequest } from "./lib/relay.ts";
import { CONFIG_DIR, CONFIG_PATH, DEFAULT_RULES_PATH, RULES_PATH, SCRIPTS, TMP_DIR, DEV_MODE, COMMAND_NAME, describeBuild } from "./lib/config.ts";
import type { Alert, AutonomyLevel, CallingMode, Config, Urgency } from "./lib/config.ts";
import { DEFAULTS, readConfig, writeConfig } from "./lib/config.ts";
import { hasActiveAudio, playSound, stopAllAudio } from "./lib/audio.ts";
import { AUTONOMY_LABEL, CALLING_MODE_LABEL, detectAutonomyLevel, detectPreference, detectTaskFinale, isProgressCategory, shouldSuppress as shouldSuppressLib, userInputNotice } from "./lib/prefs.ts";
import { pushPhone, pushWebhook, resolveValue } from "./lib/push.ts";
import { startRemoteStopServer, type RemoteStopHandle } from "./lib/remote-stop.ts";
import { boostVolume, getSystemVolume, restoreVolume, setSystemVolume, toggleMute } from "./lib/volume.ts";
import { runCommand, runPowerShellScript, execFile } from "./lib/platform.ts";
import { buildRulesPrompt, ensureRulesFile, fileExists, GUARD_RAIL, loadDefaultRules, loadRules } from "./lib/rules.ts";

// 全局状态（单例，由入口持有）：
// config 读写逻辑在 lib/config.ts（readConfig/writeConfig），此处只保留内存单例。
let config: Config = { ...DEFAULTS };

/**
 * 统一入口上下文：pi 命令/工具注入的 ctx 的最小化类型（消灭各处 `{ ui: any }`）。
 * UI 来自官方 ExtensionUIContext；theme 是 TUI 附加能力（状态栏高亮用，非 TUI 下可缺省）。
 */
/**
 * 统一入口上下文：pi 命令/工具注入的 ctx 的最小化类型（消灭各处 `{ ui: any }`）。
 * UI 来自官方 ExtensionUIContext；
 * - select 扩展 footer（pi 实际支持，官方类型声明缺失）
 * - theme 是 TUI 附加能力（状态栏高亮用，非 TUI 下可缺省）。
 */
type CookingUI = Omit<ExtensionUIContext, "select"> & {
  select(title: string, options: string[], opts?: ExtensionUIDialogOptions & { footer?: string }): Promise<string | undefined>;
  theme?: { fg(color: string, text: string): string };
};
type CookingCtx = {
  ui: CookingUI;
  mode?: string;
  hasUI?: boolean;
  /** 是否有消息正排队待投递给 agent（steer/followUp 队列非空）——定时汇报守卫用 */
  hasPendingMessages?: () => boolean;
  /** 代理是否空闲（未在流式输出）——健康巡检守卫用 */
  isIdle?: () => boolean;
  /** 中断当前回合（工具超时拦截用） */
  abort?: () => void;
  /** 触发上下文压缩（上下文超限的退避重试用） */
  compact?: () => void;
  /** 当前上下文占用（判断是不是接近超限） */
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  /** 只读会话管理器（健康巡检读上一回合结束原因 / 会话 id 用） */
  sessionManager?: {
    getEntries?: () => readonly any[];
    getSessionFile?: () => string | undefined;
    getSessionId?: () => string;
  };
};

// ── state ────────────────────────────────────────────────────────────────
let api: ExtensionAPI; // set by factory; needed by turnOn/turnOff
/** 会话级定时器（进度心跳 / 健康巡检 / 响铃重复 / 退避重试）。
 *  原先叫 repeatTimers，但它早就不是「响铃重复」专用——改名避免误读。 */
let sessionTimers: ReturnType<typeof setInterval>[] = [];
// 当前是否正在响铃播放（状态栏/横幅指示用；仅反映本实例，多 Agent 间互不影响）
let shoutingState = false;

// ── health watch（健康巡检）─────────────────────────────────────────────
// 离开模式开着但 agent 可能意外停住（报错/上下文超限/进程抖动）：
// 定时探测「是否真的在运行」，没在运行就催它表态（done / waiting_user / 继续），
// 催到上限还没动静才升级喊用户。用户一开口就回到 working，下次继续问。
let health: HealthState = newHealthState(Date.now());
let healthTimer: ReturnType<typeof setInterval> | null = null;
/** 正在执行中的工具（key = toolCallId）：记录起始时间，超时才能真正识别出来。
 *  此前只有一个裸计数器 runningTools，脚本永不结束时 end 永不到来，
 *  巡检把「还有工具在跑」读作「它正在干活」→ 永远跳过，一次都不催。 */
let runningTools = newToolWatch();
/** 已因超时中断过的 toolCallId（保证一个长脚本只 abort 一次） */
const abortedToolCalls = new Set<string>();
/** 本会话已因工具超时中断几次（到配置上限后不再自动中断，防无限 abort 循环） */
let toolAbortCount = 0;
/** 退避重试：本段连续可重试异常的次数（真实工作恢复时清零） */
let retryAttempt = 0;
/** 退避重试定时器（单独持有，便于取消） */
let retryTimerRef: ReturnType<typeof setTimeout> | null = null;
/** 收尾判定幂等：用「同一回合」的签名去重——agent_settled 可能因内部重试多次触发，
 *  但只有条目数量与最后一句都一样的才是同一个回合。新一轮工作会改变条目数 → 重新进入判定。 */
let lastSettleSignature = "";
/** 最近一次事件里的 ctx（定时器回调里拿不到事件 ctx，超时 abort / 巡检需要它） */
/** 本进程的 Agent 身份（父会话 / 子 Agent）。
 *  子 Agent 不能直接呼喊：它可能跑在用户没打开的会话里（如 Zen 镜像），
 *  喊了也回不去。它的呼喊请求交给父会话，由父 Agent 转达。 */
let agentIdentity: AgentIdentity = resolveAgentIdentity({ env: process.env });
/** 最近一次事件里的 ctx（定时器回调里拿不到事件 ctx，超时 abort / 巡检需要它） */
let lastCtx: CookingCtx | undefined;
/** 已读过的转达请求 id（防止父会话把同一条转达两遍） */
const seenRelayIds = new Set<string>();
/** 当前会话里还在跑的 async 子代理 id（事件驱动；registry 探测兜底） */
const activeSubagents = new Set<string>();
/** 上一回合结束原因（health 巡检文案用：判断是不是「意外终止」） */
let lastStopReason: string | undefined;
/** 上一回合最后一条 agent 文本（健康巡检 / stalled 升级喊人时带上） */
let lastAssistantText = "";

function pendingAlerts(): Alert[] {
  return config.alerts.filter((a) => !a.acked);
}

/** 需要用户处理的行动项（完成/进度等纯告知类不计入“待处理”） */
function pendingActionAlerts(): Alert[] {
  return config.alerts.filter((a) => !a.acked && !isProgressCategory(a.category) && a.category !== "completion");
}

// ── Agent 身份 & 呼喊标签 ────────────────────────────────
// 问题：同时开很多个 Agent，每条呼喊长得一模一样，看不出是谁在喊你。
// 做法：每条呼喊都带上本会话的标签（优先级：配置 ai alias > 会话名 > 会话 id 短码）。

/** 启动/新会话时刷新身份（会话名可能在这时才可用） */
function refreshAgentIdentity(ctx?: CookingCtx): AgentIdentity {
  let sessionName: string | undefined;
  let sessionId: string | undefined;
  try {
    sessionName = api?.getSessionName?.();
    sessionId = ctx?.sessionManager?.getSessionFile?.() ?? ctx?.sessionManager?.getSessionId?.();
  } catch { /* best effort */ }
  const resolved = resolveAgentIdentity({
    env: process.env,
    sessionName: sanitizeLabel(config.agentAlias) || sessionName,
    sessionId,
  });
  agentIdentity = resolved;
  return resolved;
}

/** 当前呼喊标签（横幅 / TTS / 手机 / status 用） */
function currentAgentTag(): string {
  return agentTag(agentIdentity);
}

// ── 多 Agent 的离开状态（每会话独立）───────────────────────────
// config.json 是同一台机器上所有 pi 会话共享的。之前只要任何会话启动，
// resetCookingState 就把 cooking / alerts / 偏好全清掉 —— 另一个正在离开中的 Agent
// 就被静默“清理”了。现在把「谁在离开中」存成 map，并按 Agent 键清自己的。

/** 本 Agent 的状态键（优先会话 id：同名会话不会互相覆盖） */
function myAgentKey(): string {
  return agentIdentity.sessionId || `label:${agentIdentity.label}`;
}

/** 本会话是否在离开模式（旧配置没有 cookingAgents 时退回全局开关） */
function isMyCooking(): boolean {
  const map = config.cookingAgents;
  if (!map) return !!config.cooking;
  const key = myAgentKey();
  if (map[key]) return true;
  // 标签匹配也算：会话 id 变了（/resume 后重建）但同一个 Agent 重新 on 过
  return Object.values(map).some((v) => v.label === agentIdentity.label);
}

/** 改本会话的离开状态，并同步全局布尔（供子 Agent / 旧代码判断“是否至少有一个在离开”） */
function setMyCooking(on: boolean): void {
  const key = myAgentKey();
  const map: Record<string, { since: number; label: string }> = { ...(config.cookingAgents ?? {}) };
  if (on) {
    map[key] = { since: Date.now(), label: agentIdentity.label };
    config.since = Date.now();
  } else {
    // 把同一个 Agent 的旧键（会话 id 换过）一并清掉
    for (const [k, v] of Object.entries(map)) {
      if (v.label === agentIdentity.label) delete map[k];
    }
    delete map[key];
    config.since = undefined;
  }
  config.cookingAgents = map;
  config.cooking = Object.keys(map).length > 0;
}

/** 还有别的 Agent 在离开中吗（新会话启动时别把它们的偏好清掉） */
function otherAgentsCooking(): boolean {
  const map = config.cookingAgents ?? {};
  const mine = agentIdentity.label;
  return Object.values(map).some((v) => v.label !== mine);
}

// ── 子 Agent 呼喊转达（子 Agent 不许直接喊）────────────────

function relayDir(): string {
  return join(TMP_DIR, "relay");
}

/** 子 Agent 路径：把呼喊请求追写到以父会话 id 命名的文件 */
async function writeRelayRequest(req: RelayRequest): Promise<{ ok: boolean; reason?: string }> {
  const parentId = agentIdentity.parentSessionId;
  if (!parentId) {
    return { ok: false, reason: "找不到父会话 id（PI_SUBAGENT_PARENT_SESSION 为空）——可能父进程不是 pi-subagents 起的" };
  }
  try {
    await mkdir(relayDir(), { recursive: true });
    await appendFile(relayFilePath(relayDir(), parentId), `${serializeRelayRequest(req)}\n`, "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `写入转达文件失败：${(e as Error).message}` };
  }
}

/**
 * 父 Agent 路径：取走交给自己的子 Agent 呼喊请求（读完即清空，避免重复转达）。
 * 文件不存在 / 内容空 / 全坏行 → 返回空数组，不报错。
 */
async function drainRelayRequests(): Promise<RelayRequest[]> {
  if (agentIdentity.kind !== "parent") return []; // 子 Agent 不取转达
  const sessionId = agentIdentity.sessionId;
  if (!sessionId) return [];
  const path = relayFilePath(relayDir(), sessionId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return []; // 文件不存在 = 没人在交请求，正常
  }
  try {
    await writeFile(path, "", "utf8"); // 先清空再解析：新请求不会丢，旧请求不会重放
  } catch { /* best effort */ }
  const parsed = dedupeRelayRequests(parseRelayRequests(raw));
  const fresh = parsed.filter((r) => !seenRelayIds.has(r.id));
  for (const r of fresh) seenRelayIds.add(r.id);
  // 防止长会话无限长大（只留最近 500 个 id）
  if (seenRelayIds.size > 500) {
    const keep = [...seenRelayIds].slice(-500);
    seenRelayIds.clear();
    for (const id of keep) seenRelayIds.add(id);
  }
  return fresh;
}

/**
 * 把子 Agent 的请求投递给父 Agent 自己（作为一条成员消息）。
 * 注意：这条消息**不直接响铃**——由父 Agent 判断后自己调 shout_for_user，
 * 这样父 Agent 有上下文，能决定要不要此刻打扰用户。
 */
async function deliverRelayToSelf(ctx: CookingCtx, reqs: RelayRequest[]): Promise<void> {
  if (reqs.length === 0) return;
  const label = agentIdentity.label;
  ctx.ui.notify(
    `📨 收到 ${reqs.length} 条子 Agent 呼喊转达（由你决定是否喊用户）`,
    "info",
  );
  void api.sendUserMessage(buildRelayPrompt(reqs, label), { deliverAs: "followUp" });
}

/** 取一次转达队列并投给自己（收尾 / 巡检 / 子代理完成时调） */
async function pumpRelayQueue(ctx: CookingCtx): Promise<void> {
  try {
    const reqs = await drainRelayRequests();
    await deliverRelayToSelf(ctx, reqs);
  } catch (e) {
    console.error("[i-am-cooking] relay pump failed:", e);
  }
}

/**
 * 子 Agent 的 shout_for_user 统一入口：写成转达请求，返回给模型的说明。
 * 拆出来是因为工具路径和 queueAlert 路径都要用同一套逻辑。
 */
async function relayAndAck(
  message: string,
  urgency: "info" | "normal" | "urgent",
  category: string,
  ttsText?: string,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const written = await writeRelayRequest({
    id: randomUUID(),
    ts: Date.now(),
    from: agentIdentity.label,
    fromSessionId: agentIdentity.sessionId,
    fromAgent: agentIdentity.agentName,
    message,
    urgency,
    category,
    ttsText,
  });
  return {
    content: [{
      type: "text",
      text: buildRelayAckText({
        from: agentIdentity.label,
        queued: written.ok,
        parentSessionId: agentIdentity.parentSessionId,
        reason: written.reason,
      }),
    }],
    details: { fired: false, relayed: written.ok, relayReason: written.reason ?? null },
  };
}


// ── 子命令处理函数（handler 注册表引用）────────────────────────────────────

async function cmdRules(ctx: CookingCtx): Promise<void> {
  const rules = await loadRules();
  ctx.ui.notify(
    `📋 当前生效规则：\n\n${rules}\n\n` +
    `[底线规则（系统强制，无法从此文件删除）]\n${GUARD_RAIL}\n\n` +
    `— 来源：${await fileExists(RULES_PATH) ? RULES_PATH : "（尚未创建，首次离开时自动用内置默认填充）"}\n` +
    `— 编辑：/i-am-cooking edit-rules（或直接改该文件）\n— 恢复出厂默认：/i-am-cooking reset-rules\n— 出厂默认模板：仓库内 ${DEFAULT_RULES_PATH}（进 git，随版本更新）`,
    "info",
  );
}

async function cmdResetRules(ctx: CookingCtx): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(RULES_PATH, await loadDefaultRules(), "utf8");
  ctx.ui.notify("♻️ 规则已恢复为出厂默认（来自仓库 rules.default.md）。", "info");
}

async function cmdEditRules(ctx: CookingCtx): Promise<void> {
  await ensureRulesFile();
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(`请直接编辑 ${RULES_PATH}`, "warning");
    return;
  }
  const initial = await readFile(RULES_PATH, "utf8");
  const saved = await ctx.ui.editor(`编辑规则文件（保存后立即生效，这部分就是唯一生效的规则）: ${RULES_PATH}`, initial);
  if (saved !== undefined && saved !== null) {
    await writeFile(RULES_PATH, saved, "utf8");
    ctx.ui.notify("✅ 规则已保存，下次离开模式回合立即生效。", "info");
  } else {
    ctx.ui.notify("已取消编辑，规则未修改。", "info");
  }
}

function cmdLevel(ctx: CookingCtx, fullArg: string): void {
  const cur = config.autonomyLevel || "balanced";
  const arg = fullArg.trim();
  if (!arg.split(/\s+/)[1]) {
    ctx.ui.notify(
      `🚀 当前自主等级：${AUTONOMY_LABEL[cur]}\n\n可选：\n` +
      `  conservative —— 谨慎（遇墙就喊：验证码/登录/手动点击等人类墙，需要决策/审批/澄清先喊我）\n` +
      `  balanced     —— 平衡（有点难度才喊，默认：普通决策自主推进，人类墙/选错代价大才喊）\n` +
      `  autonomous   —— 放手（能不喊就不喊：尽量自决，只有彻底无法继续才喊）\n\n` +
      `用法：/i-am-cooking level conservative|balanced|autonomous\n也可以在 on 备注里说（如：on 谨慎点继续）、或直接说"遇墙就喊我"，我都会听懂。`,
      "info",
    );
    return;
  }
  const target = arg.split(/\s+/)[1].toLowerCase() as AutonomyLevel;
  if (target === "conservative" || target === "balanced" || target === "autonomous") {
    setAutonomyLevel(target, "你执行了 /i-am-cooking level 命令", ctx);
  } else {
    ctx.ui.notify("❌ 未知等级，可选：conservative / balanced / autonomous", "warning");
  }
}

async function cmdLimits(ctx: CookingCtx): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      `防打扰参数（当前）：\n` +
      `  正常呼喊重复间隔: ${config.repeatIntervalMinutes} 分钟\n` +
      `  紧急呼喊重复间隔: ${config.urgentRepeatMinutes} 分钟\n` +
      `  紧急最多重复次数: ${config.maxUrgentRepeats === -1 ? "一直喊到回来" : config.maxUrgentRepeats + " 次"}\n` +
      `  每次离开最多完成通知: ${config.maxCompletionNotices} 次\n` +
      `（TUI 模式下运行 /i-am-cooking limits 可交互调整）`,
      "info",
    );
    return;
  }
  const ui = ctx.ui;
  const choose = await ui.select(
    "🛡️ 防打扰参数（Esc 退出）:",
    [
      `正常呼喊重复间隔（当前 ${config.repeatIntervalMinutes} 分钟）`,
      `紧急呼喊重复间隔（当前 ${config.urgentRepeatMinutes} 分钟）`,
      `紧急最多重复次数（当前 ${config.maxUrgentRepeats === -1 ? "一直喊到回来" : config.maxUrgentRepeats + " 次"}）`,
      `每次离开最多完成通知次数（当前 ${config.maxCompletionNotices} 次）`,
    ],
  );
  if (!choose) { ui.notify("已退出。", "info"); return; }
  const newVal = await ui.input("输入新的数值（分钟/次数）：", "");
  if (newVal === undefined || newVal === null) { ui.notify("已取消。", "info"); return; }
  const num = parseInt(newVal.trim(), 10);
  if (isNaN(num)) { ui.notify("❌ 请输入数字。", "warning"); return; }
  if (choose.includes("正常呼喊")) {
    config.repeatIntervalMinutes = Math.max(1, num);
    ui.notify(`✅ 正常呼喊重复间隔已设为 ${config.repeatIntervalMinutes} 分钟。`, "info");
  } else if (choose.includes("紧急呼喊")) {
    config.urgentRepeatMinutes = Math.max(1, num);
    ui.notify(`✅ 紧急呼喊重复间隔已设为 ${config.urgentRepeatMinutes} 分钟。`, "info");
  } else if (choose.includes("紧急最多")) {
    config.maxUrgentRepeats = num === 0 ? -1 : num;
    ui.notify(`✅ 紧急最多重复次数已设为 ${config.maxUrgentRepeats === -1 ? "一直喊到回来" : config.maxUrgentRepeats + " 次"}。`, "info");
  } else {
    config.maxCompletionNotices = Math.max(1, num);
    ui.notify(`✅ 每次离开最多完成通知已设为 ${config.maxCompletionNotices} 次。`, "info");
  }
  await writeConfig(config);
}

async function cmdSound(ctx: CookingCtx): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      `🔊 当前声音设置：\n` +
      `  哔哔声: ${config.sound ? `${config.beeps} 声` : "关闭"}\n` +
      `  Agent 语音(TTS): ${config.tts ? "开" : "关"}\n` +
      `  自定义歌曲: ${config.soundPath || "（未设置）"}\n` +
      `  总时长上限: ${config.soundSeconds ?? 60} 秒\n` +
      `（TUI 模式下运行 /i-am-cooking sound 可交互设置）`,
      "info",
    );
    return;
  }
  const ui = ctx.ui;
  const choose = await ui.select(
    "🔊 呼喊铃声设置（播放顺序：短铃声 → Agent语音 → 自定义歌曲；总时长到点自动停）:",
    [
      `查看当前设置` +
        (config.soundPath ? `（歌曲：${config.soundPath}）` : "（无自定义歌曲）"),
      `设置自定义歌曲（浏览文件或输入路径，macOS 支持 mp3/wav/m4a）`,
      `开关：哔哔声/Agent语音/桌面弹窗（当前 声${config.sound ? "开" : "关"} 语${config.tts ? "开" : "关"} 弹${config.toast ? "开" : "关"}）`,
      `试听当前设置`,
      `设置总时长上限（当前 ${config.soundSeconds ?? 60} 秒，到点强制停止）`,
      `清除自定义歌曲（回到只用哔哔+语音）`,
    ],
  );
  if (!choose) { ui.notify("已退出。", "info"); return; }
  if (choose.includes("查看当前")) {
    ctx.ui.notify(
      `🔊 当前声音设置：\n` +
      `  哔哔声: ${config.sound ? `${config.beeps} 声` : "关闭"}\n` +
      `  Agent 语音(TTS): ${config.tts ? "开" : "关"}\n` +
      `  自定义歌曲: ${config.soundPath || "（未设置）"}\n` +
      `  总时长上限: ${config.soundSeconds ?? 60} 秒`,
      "info",
    );
    return;
  }
  if (choose.includes("开关")) {
    const toggle = await ui.select("🔘 开关设置（选一个切换）:", [
      `哔哔声：当前 ${config.sound ? "开" : "关"}`,
      `Agent 语音(TTS)：当前 ${config.tts ? "开" : "关"}`,
      `桌面弹窗：当前 ${config.toast ? "开" : "关"}`,
    ]);
    if (!toggle) { ui.notify("已退出。", "info"); return; }
    if (toggle.includes("哔哔声")) {
      config.sound = !config.sound;
      ui.notify(`✅ 哔哔声已${config.sound ? "开启" : "关闭"}。`, "info");
    } else if (toggle.includes("语音")) {
      config.tts = !config.tts;
      ui.notify(`✅ Agent 语音已${config.tts ? "开启" : "关闭"}。`, "info");
    } else {
      config.toast = !config.toast;
      ui.notify(`✅ 桌面弹窗已${config.toast ? "开启" : "关闭"}。`, "info");
    }
    await writeConfig(config);
    return;
  }
  if (choose.includes("设置自定义歌曲")) {
    const browse = await ui.confirm(
      "🔊 选择音频文件",
      `是否从 ~/Music 开始浏览选择音频文件？\n（也可以手动输入路径）`,
    );
    let picked: string | null = null;
    if (browse) {
      picked = await browseAudioFile(ui, join(homedir(), "Music"));
    } else {
      const p = await ui.input("音频文件路径（回车取消）:", config.soundPath);
      if (p && p.trim()) picked = p.trim().replace(/^~\//, `${homedir()}/`);
    }
    if (!picked) { ui.notify("已取消。", "info"); return; }
    config.soundPath = picked;
    await writeConfig(config);
    ui.notify(`✅ 自定义歌曲已设置：${config.soundPath}\n试听：/i-am-cooking sound 选"试听"；或下次呼喊时自动播放。`, "info");
    return;
  }
  if (choose.includes("试听")) {
    ui.notify("🔊 正在试听：哔哔 + Agent语音 + 自定义歌曲（最长 10 秒）…", "info");
    await playSound(
      config,
      config.sound ? config.beeps : 0,
      config.sound ? config.soundPath : "",
      config.tts ? `叮咚，这是测试语音！${config.shoutPhrase || "agent 需要你"}！` : "",
      { force: true },
    );
    return;
  }
  if (choose.includes("总时长")) {
    const v = await ui.input("总时长上限（秒，1-300，回车默认 60）:", String(config.soundSeconds ?? 60));
    if (v === undefined || v === null || v.trim() === "") { ui.notify("已取消。", "info"); return; }
    const n = parseInt(v.trim(), 10);
    if (isNaN(n) || n < 1 || n > 300) { ui.notify("❌ 请输入 1-300 的数字。", "warning"); return; }
    config.soundSeconds = n;
    await writeConfig(config);
    ui.notify(`✅ 总时长上限已设为 ${n} 秒（到点强制停止）。`, "info");
    return;
  }
  if (choose.includes("清除自定义歌曲")) {
    config.soundPath = "";
    await writeConfig(config);
    ui.notify("✅ 已清除自定义歌曲（回到哔哔 + Agent 语音）。", "info");
    return;
  }
}

async function cmdVolume(ctx: CookingCtx): Promise<void> {
  const cur = await getSystemVolume();
  const statusLine = `当前系统音量: ${cur === null ? "（读取失败）" : cur + "%"}\n离开自动拉高: ${config.boostVolume ? `开（拉到 ${config.boostLevel || 80}%）` : "关"}`;
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(`🔊 音量控制\n${statusLine}\n（TUI 模式下运行 /i-am-cooking volume 可交互调整）`, "info");
    return;
  }
  const ui = ctx.ui;
  const choose = await ui.select("🔊 音量控制（Esc 退出）:", [
    `查看当前音量（${cur === null ? "读取失败" : cur + "%"}）`,
    `立即把系统音量调到指定值（0-100）`,
    `设置"离开时自动拉高到多少"（当前 ${config.boostLevel || 80}%）`,
    `开关"离开自动拉高音量"（当前 ${config.boostVolume ? "开" : "关"}）`,
  ]);
  if (!choose) { ui.notify("已退出。", "info"); return; }
  if (choose.includes("查看当前")) {
    ui.notify(`🔊 ${statusLine}`, "info");
    return;
  }
  if (choose.includes("立即")) {
    const v = await ui.input("设置系统音量（0-100）:", "");
    if (v === undefined || v === null || v.trim() === "") { ui.notify("已取消。", "info"); return; }
    const n = parseInt(v.trim(), 10);
    if (isNaN(n) || n < 0 || n > 100) { ui.notify("❌ 请输入 0-100 的数字。", "warning"); return; }
    const ok = await setSystemVolume(n);
    ui.notify(ok ? `✅ 系统音量已设为 ${n}%。` : "⚠️ 设置失败（见日志）。", ok ? "info" : "warning");
    return;
  }
  if (choose.includes("离开时自动拉高到多少")) {
    const v = await ui.input("离开时拉高到多少（1-100，默认 80）:", String(config.boostLevel || 80));
    if (v === undefined || v === null || v.trim() === "") { ui.notify("已取消。", "info"); return; }
    const n = parseInt(v.trim(), 10);
    if (isNaN(n) || n < 1 || n > 100) { ui.notify("❌ 请输入 1-100 的数字。", "warning"); return; }
    config.boostLevel = n;
    config.boostVolume = true;
    await writeConfig(config);
    ui.notify(`✅ 离开时自动拉高到 ${n}%（已自动开启该功能）。`, "info");
    return;
  }
  if (choose.includes("开关")) {
    config.boostVolume = !config.boostVolume;
    await writeConfig(config);
    ui.notify(`✅ "离开自动拉高音量"已${config.boostVolume ? "开启" : "关闭"}。`, "info");
    return;
  }
}

// ── 健康巡检子命令 ───────────────────────────────────────────────────
async function cmdHealth(ctx: CookingCtx, fullArg: string): Promise<void> {
  const sub = fullArg.trim().split(/\s+/)[1]?.toLowerCase() ?? "";
  const now = Date.now();
  const idleFor = formatIdle(now - health.idleSince);
  const nudgeLine = health.lastNudgeAt
    ? `最近一次追问: ${new Date(health.lastNudgeAt).toLocaleTimeString("zh-CN")}（本段已催 ${health.nudges}/${config.healthMaxNudges}）`
    : `本段尚未催过`;
  const summary =
    `🩺 健康巡检\n` +
    `  开关: ${config.healthCheck ? "开" : "关"}\n` +
    `  频率: 每 ${config.healthCheckMinutes} 分钟查一次（空闲 ${config.healthIdleMinutes} 分钟才算「没在运行」）\n` +
    `  催问上限: ${config.healthMuteEscalation ? `用户说了别喊 → 只催不升级，催到 ${config.healthMaxNudgesSilence ?? 30} 次后停止追问（不喊人）` : `${config.healthMaxNudges} 次，之后喊你一次`}\n` +
    `  状态: ${formatHealthLine(health, now, {
      enabled: config.healthCheck,
      checkMinutes: config.healthCheckMinutes,
      idleMinutes: config.healthIdleMinutes,
      maxNudges: config.healthMaxNudges,
      muteEscalation: config.healthMuteEscalation,
    })}\n` +
    `  空闲时长: ${idleFor}\n` +
    `  ${nudgeLine}\n` +
    `  正在运行的子代理: ${isMyCooking() ? countActiveSubagents(ctx) : "—"}\n` +
    (health.note ? `  最后表态: ${health.note}\n` : "") +
    `  模式: ${isMyCooking() ? "离开中（巡检生效）" : "在岗（巡检只在离开模式下工作）"}`;

  // 非交互：支持 health on / off / now / 直接看
  if (sub === "on" || sub === "off") {
    config.healthCheck = sub === "on";
    await writeConfig(config);
    if (isMyCooking()) {
      if (config.healthCheck) startHealthTimer(ctx);
      else stopHealthTimer();
    }
    ctx.ui.notify(`🩺 健康巡检已${config.healthCheck ? "开启" : "关闭"}。`, "info");
    return;
  }
  if (sub === "now") {
    if (!isMyCooking()) { ctx.ui.notify("当前不在离开模式，巡检只在离开模式下工作（先 /i-am-cooking on）。", "warning"); return; }
    // 手动立刻巡一次：把空闲起点推到「刚好超过阈值」，方便测试且文案正常
    forceIdleForCheck();
    ctx.ui.notify("🩺 手动触发一次巡检…", "info");
    healthTick(ctx);
    return;
  }

  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(summary + `\n\n（TUI 模式下运行 /i-am-cooking health 可交互调整；也可用 health on|off|now）`, "info");
    return;
  }
  const ui = ctx.ui;
  const choose = await ui.select("🩺 健康巡检（Esc 退出）:", [
    `开关巡检（当前 ${config.healthCheck ? "开" : "关"}）`,
    `立刻巡检一次（测试用，无需等待）`,
    `检查频率（当前每 ${config.healthCheckMinutes} 分钟）`,
    `空闲多久算没在运行（当前 ${config.healthIdleMinutes} 分钟）`,
    `催问上限（当前 ${config.healthMaxNudges} 次，之后喊你）`,
    `催满后是否喊人（当前 ${config.healthMuteEscalation ? `不喊，催到 ${config.healthMaxNudgesSilence ?? 30} 次后停止` : "喊你一次"}）`,
    `长脚本超时中断（当前 ${config.toolTimeoutMinutes > 0 ? `单次工具超 ${config.toolTimeoutMinutes} 分钟就中断并纠偏（上限 ${config.toolTimeoutMaxAborts} 次）` : "已关闭"}）`,
  ], { footer: summary });
  if (!choose) { ui.notify("已退出。", "info"); return; }

  if (choose.includes("开关巡检")) {
    config.healthCheck = !config.healthCheck;
    await writeConfig(config);
    if (isMyCooking()) {
      if (config.healthCheck) startHealthTimer(ctx);
      else stopHealthTimer();
    }
    ui.notify(`🩺 健康巡检已${config.healthCheck ? "开启" : "关闭"}。`, "info");
    return;
  }
  if (choose.includes("立刻巡检")) {
    if (!isMyCooking()) { ui.notify("当前不在离开模式，巡检只在离开模式下工作（先 /i-am-cooking on）。", "warning"); return; }
    forceIdleForCheck();
    ui.notify("🩺 手动触发一次巡检…", "info");
    healthTick(ctx);
    return;
  }
  if (choose.includes("催满后是否喊人")) {
    config.healthMuteEscalation = !config.healthMuteEscalation;
    await writeConfig(config);
    ui.notify(
      config.healthMuteEscalation
        ? `🔕 已设为「只催不喊」：催满上限也不响铃；催到 ${config.healthMaxNudgesSilence ?? 30} 次后自动停止追问。`
        : `🔔 已设为「催满 ${config.healthMaxNudges} 次后喊你一次」，然后暂停追问。`,
      "info",
    );
    return;
  }

  const isFreq = choose.includes("检查频率");
  const isIdle = choose.includes("空闲多久");
  const isMax = choose.includes("催问上限");
  const label = isFreq ? "检查频率（分钟，1-60）" : isIdle ? "空闲判定（分钟，1-180）" : "催问上限（次，1-20）";
  const cur = isFreq ? config.healthCheckMinutes : isIdle ? config.healthIdleMinutes : config.healthMaxNudges;
  const v = await ui.input(`${label}:`, String(cur));
  if (v === undefined || v === null || !v.trim()) { ui.notify("已取消。", "info"); return; }
  const n = parseInt(v.trim(), 10);
  if (isNaN(n)) { ui.notify("❌ 请输入数字。", "warning"); return; }
  if (isFreq) config.healthCheckMinutes = Math.max(1, Math.min(60, n));
  else if (isIdle) config.healthIdleMinutes = Math.max(1, Math.min(180, n));
  else config.healthMaxNudges = Math.max(1, Math.min(20, n));
  await writeConfig(config);
  if (isMyCooking() && config.healthCheck) startHealthTimer(ctx); // 频率变了：重挂定时器
  ui.notify("✅ 已保存。", "info");
}

// ── Agent 标签子命令 ─────────────────────────────────────────────────
// 多 Agent 共存时，呼喊必须能看出是谁在喊。标签默认自动推断（会话名 → 主会话），
// 也可以显式指定一个短名字（同一台机器上同名会混，建议各会话取不同的）。
async function cmdAgent(ctx: CookingCtx, fullArg: string): Promise<void> {
  const name = fullArg.trim().split(/\s+/).slice(1).join(" ").trim();
  const id = refreshAgentIdentity(ctx);
  if (!name) {
    ctx.ui.notify(
      `🏷️ 本会话的呼喊标签：${currentAgentTag()}\n` +
      `  · 类型: ${id.kind === "subagent" ? "子 Agent（不能直接喊用户，会转达父 Agent）" : "父会话"}\n` +
      (id.agentName ? `  · agent 名: ${id.agentName}\n` : "") +
      (id.sessionId ? `  · 会话: ${id.sessionId}\n` : "") +
      (id.parentSessionId ? `  · 父会话: ${id.parentSessionId}\n` : "") +
      `\n设置自定义名：/${COMMAND_NAME} agent <短名>（例如 /${COMMAND_NAME} agent 主会话）\n` +
      `清除自定义名：/${COMMAND_NAME} agent reset`,
      "info",
    );
    return;
  }
  if (name === "reset" || name === "clear") {
    config.agentAlias = "";
  } else {
    config.agentAlias = sanitizeLabel(name, 20);
  }
  await writeConfig(config);
  refreshAgentIdentity(ctx);
  updateWidget(ctx);
  ctx.ui.notify(
    config.agentAlias
      ? `🏷️ 呼喊标签已设为 ${currentAgentTag()}（以后每条呼喊前面都会带它）`
      : `🏷️ 已清除自定义标签，回到自动推断：${currentAgentTag()}`,
    "info",
  );
}

// 子命令注册表（handler 只做分发，具体逻辑见上面各函数）
const commandHandlers: Record<string, (ctx: CookingCtx, fullArg: string) => Promise<void> | void> = {
  off: (ctx) => { turnOff(ctx, "command"); },
  status: (ctx) => { showStatus(ctx); },
  setup: async (ctx) => { await setupWizard(ctx); },
  test: async (ctx) => { await testShout(ctx); },
  "stop-sound": (ctx) => { stopCurrentSound(ctx); },
  rules: cmdRules,
  "reset-rules": cmdResetRules,
  "edit-rules": cmdEditRules,
  level: cmdLevel,
  limits: async (ctx) => { await cmdLimits(ctx); },
  sound: async (ctx) => { await cmdSound(ctx); },
  volume: async (ctx) => { await cmdVolume(ctx); },
  health: async (ctx, fullArg) => { await cmdHealth(ctx, fullArg); },
  agent: async (ctx, fullArg) => { await cmdAgent(ctx, fullArg); },
};

// ── 音频文件浏览（sound 命令用）──────────────────────────────────────────
const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".aiff", ".aif", ".ogg", ".flac"];

function isAudioFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return AUDIO_EXT.includes(ext);
}

/**
 * 交互式浏览文件夹选择音频文件（TUI）。
 * 从 startDir 开始：显示子文件夹 + 音频文件，选文件夹进入下一级，选文件返回其路径。
 * 支持：返回上级 / 手动输入路径 / Esc 取消。
 * 返回选中的音频文件路径，取消则 null。
 */
async function browseAudioFile(ui: CookingCtx["ui"], startDir: string): Promise<string | null> {
  let dir = startDir;
  for (;;) {
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      const items = await readdir(dir, { withFileTypes: true });
      entries = items
        .filter((d) => d.isDirectory() || isAudioFile(d.name))
        .sort((a, b) => {
          // 文件夹在前，按名称排序
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      ui.notify(`❌ 无法读取目录：${dir}`, "warning");
      return null;
    }

    const options: string[] = [
      ...entries.map((e) => (e.isDir ? `📁 ${e.name}/` : `🔊 ${e.name}`)),
      "📂 手动输入路径",
      "⬆️ 返回上级",
    ];
    const pick = await ui.select(`🔊 选择音频文件（当前：${dir}）:`, options);
    if (!pick) return null; // Esc 取消

    if (pick === "📂 手动输入路径") {
      const p = await ui.input("输入完整路径（回车取消）:", "");
      if (!p || !p.trim()) continue;
      const t = p.trim().replace(/^~\//, `${homedir()}/`);
      if (isAudioFile(t)) return t;
      // 输入的是目录 → 进入该目录
      dir = t;
      continue;
    }
    if (pick === "⬆️ 返回上级") {
      const parent = dir.replace(/\/[^/]+\/?$/, "");
      if (parent && parent !== dir) dir = parent;
      continue;
    }
    // 选中的是文件或文件夹
    const selected = entries.find((e) => (e.isDir ? `📁 ${e.name}/` : `🔊 ${e.name}`) === pick);
    if (!selected) continue;
    if (selected.isDir) {
      dir = `${dir}/${selected.name}`;
    } else {
      return `${dir}/${selected.name}`;
    }
  }
}

// ── notification channels ────────────────────────────────────────────────

/** 本地包装：停止所有音频并复位 UI 响铃状态（lib/audio.ts 只管进程，UI 状态归入口管） */
function stopAudioAll(): void {
  stopAllAudio(); // lib/audio.ts：杀死正在播放的音频进程
  shoutingState = false; // 已安静，状态栏/横幅恢复
}

async function showNotification(title: string, body: string): Promise<void> {
  const p = process.platform;
  try {
    if (p === "win32") {
      await runPowerShellScript(SCRIPTS, TMP_DIR, "toast.ps1", { title, body });
    } else if (p === "darwin") {
      // macOS 原生通知：支持中文、emoji，带提示音 Glass
      await runCommand("osascript", [
        "-e",
        `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`,
      ]);
    } else {
      await runCommand("notify-send", [title, body], { timeoutMs: 5000 });
    }
  } catch { /* best effort */ }
}

// ── 音量控制（逻辑在 lib/volume.ts，可测试）───────────────────────────────

function renderTts(alert: Alert): string {
  // 逻辑在 lib/tts.ts（可测试）
  return renderTtsImpl(
    {
      ttsTemplate: config.ttsTemplate,
      ttsTemplateCompletion: config.ttsTemplateCompletion,
      ttsTemplateMilestone: config.ttsTemplateMilestone,
      shoutPhrase: config.shoutPhrase,
    },
    alert,
  );
}

// ── 手机推送 ──────────────────────────────────────────────────────────────
// 逻辑在 lib/push.ts（ntfy/webhook 双通道，可测试）；此处只提供 config.<channel> 分发。
async function pushAlert(alert: Alert): Promise<boolean> {
  // 远程停止：响铃类推送带「停止响铃」按钮（进度类不响铃，无需按钮）
  const actionUrl = remoteStopSrv && !isProgressCategory(alert.category) ? remoteStopSrv.url : undefined;
  // 兼容旧配置：未走向导但直接填了 webhookUrl
  if (config.phonePush) {
    return config.pushProvider === "ntfy" ? pushPhone(config, alert, actionUrl) : pushWebhook(config, alert);
  }
  if (config.webhookUrl) return pushWebhook(config, alert);
  return true;
}

/**
 * 偏好拦截：根据 callingMode 判断是否抑制响铃（逻辑在 lib/prefs.ts，可测试）。
 * 返回 true = 不响铃/不推送，只留 widget + TUI notify。
 */
function shouldSuppress(alert: Alert): boolean {
  return shouldSuppressLib(config.callingMode || "normal", alert);
}

// completion 通知计数器（每次 turnOn 清零）
let completionNoticeCount = 0;

// ── 远程停止服务（手机推送「停止响铃」按钮的后端）──
// 每次离开会话随机 token；仅 ntfy + phonePush 开启时随离开模式启停
let remoteStopSrv: RemoteStopHandle | null = null;
let remoteStopToken = randomUUID();

/** 启动远程停止端点（已启动则跳过）；失败只记日志不抛——按钮缺失不影响其他功能 */
async function startRemoteStop(ctx: CookingCtx): Promise<void> {
  if (remoteStopSrv || !config.remoteStop) return;
  if (!config.phonePush || config.pushProvider !== "ntfy" || !config.ntfyTopic?.trim()) return;
  try {
    remoteStopSrv = await startRemoteStopServer({
      token: remoteStopToken,
      onStop: () => {
        // 手机点「停止响铃」= 人已知悉：停本次播放 + 旧呼喊标记已处理（不退出离开模式，agent 继续干活）
        stopAudioAll();
        shoutingState = false;
        for (const a of config.alerts) a.acked = true;
        void writeConfig(config);
        updateStatus(ctx, "idle");
        updateWidget(ctx);
        ctx.ui.notify("🔕 手机端已停止本次播放。下次呼喊照常响铃。", "info");
      },
    });
    ctx.ui.notify("📱 呼喊推送已带「🔕 停止响铃」按钮（手机与本机同一局域网时可点击静音）。", "info");
  } catch (e) {
    console.error("[i-am-cooking] remote stop server failed:", (e as Error).message);
    remoteStopSrv = null;
  }
}

/** 关闭远程停止端点（幂等；off / 会话关闭时调用） */
function stopRemoteStop(): void {
  const srv = remoteStopSrv;
  remoteStopSrv = null;
  remoteStopToken = randomUUID(); // 换 token：旧推送里的按钮立即失效
  void srv?.close().catch(() => {});
}

/** 切换自主等级并提示（持久化：跨离开会话保留） */
function setAutonomyLevel(level: AutonomyLevel, reason: string, ctx: CookingCtx): void {
  const prev = config.autonomyLevel || "balanced";
  config.autonomyLevel = level;
  void writeConfig(config);
  if (level !== prev) {
    ctx.ui.notify(`🚀 自主等级已切换：${AUTONOMY_LABEL[level]}（依据：${reason}）`, "info");
  }
}

/** 切换偏好并提示 */
function setCallingMode(mode: CallingMode, reason: string, ctx: CookingCtx): void {
  const prev = config.callingMode || "normal";
  config.callingMode = mode;
  // 「别喊了」= 只催不升级：健康巡检催满上限也不响铃（但有总上限，不会无限追问）
  config.healthMuteEscalation = mode === "silence";
  void writeConfig(config);
  if (mode !== prev) {
    ctx.ui.notify(`🔔 呼喊偏好已切换：${CALLING_MODE_LABEL[mode]}（依据：${reason}）`, "info");
  }
}

/**
 * 发出呼喊（widget + TUI 提示，以及未被偏好静音时的声音/TTS/弹窗/手机推送）。
 * 返回手机推送是否成功：未配置或偏好静音跳过 = true；只有配置了且发送失败才 false。
 * 手机推送按 pushProvider 分发（ntfy / webhook），避免双发；兼容旧配置（未走向导直接填 webhookUrl）。
 */
async function fireAlert(alert: Alert, ctx: CookingCtx, opts: { forceSound?: boolean } = {}): Promise<boolean> {
  config.lastShout = Date.now();
  const suppress = shouldSuppress(alert);
  const isCompletion = alert.category === "completion";
  const isMilestone = alert.category === "milestone";
  const forceSound = opts.forceSound ?? false;

  // ── 进度类（milestone / progress）：只推手机 ──
  // 不响铃 / 不弹窗 / 不进横幅；本地保留一条轻提示（电脑前的人可见），主通道是手机
  if (isProgressCategory(alert.category)) {
    if (ctx?.ui) {
      ctx.ui.notify(`📈 ${isMilestone ? "小阶段完成" : "进度汇报"}（已推手机）：${alert.message}`, "info");
    }
    return suppress ? true : await pushAlert(alert);
  }

  // ── widget + TUI notify（无论是否 suppress 都显示）──
  // 重复触发（repeatCount>0）不再重打 TUI notify：内容用户已看过，响铃/手机推送/桌面弹窗照旧——
  // 否则紧急呼喊每分钟全量重放一条整段警告，人不在时横幅被刷屏（首条 notify 已足够定位问题）
  if (ctx?.ui && alert.repeatCount === 0) {
    const icon = isCompletion ? "✅" : "⚠";
    const label = isCompletion ? "完成通知" : `${config.shoutPhrase || "agent 需要你"}！[${alert.urgency}]`;
    // 首条也只展示摘要：长内容（如 auto-error 带的报错上下文）不进横幅，详情在对话记录 / status 里
    const summary = alert.message.length > 80 ? `${alert.message.slice(0, 80)}…` : alert.message;
    ctx.ui.notify(`🍳 ${icon} ${label} ${summary}`, suppress ? "info" : "warning");
    updateWidget(ctx);
  }

  // ── 响铃 / 推送（suppress 时跳过）──
  if (suppress) return true;
  // 三层音频区分：
  //   🚨 需要你  → 完整三段式（beeps + 语音 + 自定义歌曲），最醒目
  //   ✅ 整个完成 → beeps 2 声 + 完成语音（不播歌曲，安静报喜）
  // 声音不阻塞后续通道：fire-and-forget，最长 soundSeconds 秒后自动停
  if (config.sound || config.tts) {
    // 状态栏/横幅：响铃期间显示“正在广播”，播完自动恢复“🍳 离开中”
    shoutingState = true;
    updateStatus(ctx, "shouting");
    updateWidget(ctx);
    const done = () => { shoutingState = false; updateStatus(ctx, "idle"); updateWidget(ctx); };
    // 音频区分：🚨需要你→完整三段式 / ✅完成→2声+完成语音（都不播自定义歌）
    const beeps = isCompletion ? 2 : config.beeps;
    const playPath = isCompletion ? "" : config.soundPath;
    void playSound(
      config,
      config.sound ? beeps : 0,
      config.sound ? playPath : "",
      config.tts ? renderTts(alert) : "",
      { force: forceSound },
    ).then(done).catch(done);
  }
  if (config.toast) {
    const title = isCompletion ? "任务完成" : config.shoutPhrase || "agent 需要你";
    await showNotification(`🍳 ${title}`, `[${alert.urgency}] ${alert.message}`);
  }

  // ── 手机推送（按 pushProvider 分发；兼容旧配置：未走向导但直接填了 webhookUrl）──
  return await pushAlert(alert);
}

/** 构建标记：开发版在状态栏/横幅上永远带 DEV，避免把 dev 当发布版用 */
const BUILD_TAG = DEV_MODE ? "DEV" : "";

/** 更新状态栏：idle=🍳 离开中（带待处理计数）/ shouting=📢 正在广播中（带停止提示） */
function updateStatus(ctx: CookingCtx, phase: "idle" | "shouting"): void {
  if (!ctx?.ui) return;
  if (!isMyCooking()) { ctx.ui.setStatus("i-am-cooking", DEV_MODE ? "🧪 DEV 待机" : ""); return; }
  if (phase === "shouting") {
    const text = `📢 正在广播中${BUILD_TAG ? ` [${BUILD_TAG}]` : ""}...（Ctrl+Alt+M 静音）`;
    ctx.ui.setStatus("i-am-cooking", ctx.ui.theme?.fg ? ctx.ui.theme.fg("warning", text) : text);
  } else {
    ctx.ui.setStatus("i-am-cooking", `🍳 ${agentIdentity.label}${BUILD_TAG ? ` [${BUILD_TAG}]` : ""} · ⚠${pendingActionAlerts().length} 待处理`);
  }
}

function updateWidget(ctx: CookingCtx): void {
  if (!ctx?.ui) return;
  if (!config.tuiBanner) { ctx.ui.setWidget("i-am-cooking", []); return; }
  const n = pendingActionAlerts().length;
  const subs = isMyCooking() && config.healthCheck ? countActiveSubagents(ctx) : 0;
  const healthTag = isMyCooking() && config.healthCheck
    ? health.phase === "done"
      ? " · 🩺 已完成"
      : health.phase === "waiting_user"
        ? " · 🩺 在等你"
        : health.phase === "stalled"
          ? " · 🩺 无响应（已喊人）"
          : health.phase === "exhausted"
            ? " · 🩺 已停止追问"
            : health.nudges > 0
              ? ` · 🩺 已催 ${health.nudges}/${config.healthMaxNudges}`
              : ""
    : "";
  const tools = isMyCooking() ? runningToolsLabel(Date.now()) : "";
  const subTag = subs > 0 ? ` · 🤖 子代理 ${subs} 个在跑` : "";
  const toolTag = tools ? ` · 🔧 ${tools}` : "";
  const lines = isMyCooking()
    ? [
        `🍳 离开中${BUILD_TAG ? ` [${BUILD_TAG}]` : ""} · ⚠${n} 待处理${subTag}${toolTag}${healthTag} · /status 看全部`,
        ...(shoutingState ? ["  📢 正在广播中...（Ctrl+Alt+M 静音）"] : []),
      ]
    : [];
  ctx.ui.setWidget("i-am-cooking", lines);
}

/** 停止本次播放：只掐当前音频，不改配置、不清待处理呼喊、不影响下次呼喊 */
function stopCurrentSound(ctx: CookingCtx): void {
  const hadAudio = shoutingState || hasActiveAudio();
  stopAudioAll();
  updateStatus(ctx, "idle");
  updateWidget(ctx);
  ctx.ui.notify(
    hadAudio
      ? "🔕 已停止本次播放。下次呼喊照常响铃。"
      : "🔕 当前没有正在播放的声音。下次呼喊照常响铃。",
    "info",
  );
}

// ── alert queue & escalation ─────────────────────────────────────────────
function scheduleRepeats(alert: Alert, ctx: CookingCtx): void {
  // completion 通知只喊一次，不进入重复逻辑
  if (alert.category === "completion") return;

  if (alert.urgency === "urgent") {
    const iv = Math.max(1, config.urgentRepeatMinutes) * 60_000;
    const timer = setInterval(() => {
      if (!isMyCooking()) return;
      if (alert.acked) { clearInterval(timer); return; } // 已被用户响应，停止重复喊
      alert.repeatCount++;
      void writeConfig(config);
      void fireAlert(alert, ctx);
      if (config.maxUrgentRepeats > 0 && alert.repeatCount >= config.maxUrgentRepeats) {
        clearInterval(timer);
      }
    }, iv);
    sessionTimers.push(timer);
  } else if (alert.urgency === "normal") {
    const timer = setTimeout(() => {
      if (!isMyCooking()) return;
      if (alert.acked) return; // 已被用户响应，不再重喊
      alert.repeatCount++;
      void writeConfig(config);
      void fireAlert(alert, ctx);
    }, Math.max(1, config.repeatIntervalMinutes) * 60_000);
    sessionTimers.push(timer as unknown as ReturnType<typeof setInterval>);
  }
}

/** 清除会话级定时器（含退避重试） */
function clearRepeatTimers(): void {
  for (const t of sessionTimers) clearInterval(t);
  sessionTimers = [];
  if (retryTimerRef) { clearTimeout(retryTimerRef); retryTimerRef = null; }
  reportTimer = null;
  healthTimer = null;
}

/**
 * 唯一的「忙」判定入口（TODO-3）。
 * reportTimer 与 healthTick 都从这里取数，消除「同一时刻 A 判不忙、B 判忙」。
 * 原来两处 `ctx.hasPendingMessages?.()` 的重复守卫也收在这里。
 */
function activitySnapshot(ctx: CookingCtx): ActivitySnapshot {
  return {
    agentBusy: agentActive || (typeof ctx.isIdle === "function" ? !ctx.isIdle() : false),
    runningTools: runningToolCount(runningTools),
    activeSubagents: countActiveSubagents(ctx),
    pendingMessages: ctx.hasPendingMessages?.() ?? false,
  };
}

/** 并发一个长 bash / 同步 subagent() 时，状态栏要能看见它 */
function runningToolsLabel(now: number): string {
  return formatRunningTools(runningTools, now);
}

// ── 进度心跳（interval=定时汇报 / milestone=小阶段自查），两种模式共用一套启停 ──
let reportTimer: ReturnType<typeof setInterval> | null = null;
/** 回合是否进行中：before_agent_start 置 true，agent_settled 置 false。
 *  心跳只在回合进行中触发——回合结束（含任务收尾正则漏判的情况）自然停催，新回合自动恢复。 */
let agentActive = false;

/** 启动进度心跳：每 N 分钟给 agent 注入一条提醒（steer，只推手机不响铃）。
 *  - interval 模式：三问定时汇报（category="progress"）
 *  - milestone 模式：单行自查，有无值得报的小阶段（category="milestone"） */
function startReportTimer(ctx: CookingCtx): void {
  if (mustRelayViaParent(agentIdentity)) return; // 子 Agent 不跑进度心跳
  stopReportTimer();
  const minutes = Math.max(1, Math.min(120, config.reportIntervalMinutes || 15));
  reportTimer = setInterval(() => {
    if (!isMyCooking()) return;
    // 「忙」的统一口径：回合结束 / 卡在长工具里 / 队列里已有话没投递 → 都不插话
    // （长工具调用中插话只会堆积成重复催促，这是本次行为变化，见 CHANGELOG）
    if (shouldSkipReportTick(activitySnapshot(ctx))) return;
    const msg = config.progressReporting === "milestone"
      ? `[milestone check] 一句话自查：当前是否有值得让用户知道的小阶段？\n` +
        `有 → 调用 shout_for_user（category="milestone", urgency="info"）只推手机；没有 → 忽略本条，不要回复提醒本身。\n` +
        `若任务已全部完成：调用 shout_for_user（category="completion", urgency="info"）收尾（或在总结里明确说明任务结束），本提醒会随之停止。`
      : `[定时汇报] 到点了，请汇报当前进度：\n` +
        `- 已完成什么？\n- 正在做什么？\n- 有无进展（没有新进展就如实说明原因，卡住了就说卡在哪、是否需要用户）。\n` +
        `汇报方式：调用 shout_for_user（category="progress", urgency="info"），内容只会推送到手机（不响铃不弹窗）。\n` +
        `若任务已全部完成：调用 shout_for_user（category="completion", urgency="info"）收尾（或在总结里明确说明任务结束），进度汇报会随之停止，不要再发进度。`;
    // steer：agent 干活途中在下一次 LLM 调用前投递，不等整个回合结束（followUp 会压队列等到 settle）
    void api.sendUserMessage(msg, { deliverAs: "steer" });
  }, minutes * 60_000);
  sessionTimers.push(reportTimer); // 并入重复计时器，随 off/会话结束一起清理
}

function stopReportTimer(): void {
  if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
}

// ── 健康巡检（health watch）：定时探测 agent 是否真的在运行 ────────────────

/**
 * 当前会话 id（用于子代理过滤）：优先会话文件路径，否则用 session id。
 * 与 pi-subagents 的记录方式一致（getSessionFile() ?? getSessionId()）。
 */
function currentSessionId(ctx: CookingCtx): string | undefined {
  try {
    const sm = (ctx as { sessionManager?: { getSessionFile?(): string | undefined; getSessionId?(): string } }).sessionManager;
    return sm?.getSessionFile?.() ?? sm?.getSessionId?.();
  } catch {
    return undefined;
  }
}

/**
 * 探测当前会话里还在跑的 async 子代理数量。
 * 双路：① 事件计数（快、准）；② pi-subagents 的进程内 background-work 注册表（兜底，防 /reload 后丢事件）。
 * 未安装 pi-subagents 则恒为 0，不报错。
 */
function countActiveSubagents(ctx: CookingCtx): number {
  const fromEvents = activeSubagents.size;
  const sessionId = currentSessionId(ctx);
  if (!sessionId) return fromEvents;
  try {
    const reg = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents.background-work.v1")] as
      | { providers?: Map<string, { listActiveWork?: (c?: { sessionId: string; nowMs: number }) => unknown }> }
      | undefined;
    if (!reg?.providers || !(reg.providers instanceof Map)) return fromEvents;
    let n = 0;
    for (const provider of reg.providers.values()) {
      if (typeof provider?.listActiveWork !== "function") continue;
      try {
        const items = provider.listActiveWork({ sessionId, nowMs: Date.now() });
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const sid = (item as { sessionId?: unknown })?.sessionId;
          if (typeof sid !== "string" || sid === sessionId) n++;
        }
      } catch { /* 单个 provider 异常不影响其他 */ }
    }
    return Math.max(fromEvents, n);
  } catch {
    return fromEvents;
  }
}

/** 用户说了「别喊」类偏好时，巡检只催不升级（到上限后停止追问） */
function healthMuteEscalation(): boolean {
  return !!config.healthMuteEscalation;
}

/**
 * 这些工具只是「表态」，不改变真实工作进度：结束时不刷新健康巡检的空闲窗口、不清催问计数。
 * 否则 agent 每次被催就调一次 set_task_state / shout_for_user 就能把巡检计数洗掉，永远升不了级。
 */
const STATEMENT_ONLY_TOOLS = new Set(["set_task_state", "shout_for_user"]);

/** 订阅 pi-subagents 的子代理生命周期事件（pi-subagents 未装时静默跳过） */
function bindSubagentEvents(onStarted: (payload: unknown) => void, onComplete: (payload: unknown) => void): void {
  try {
    api.events.on("subagent:async-started", onStarted);
    api.events.on("subagent:async-complete", onComplete);
  } catch { /* pi-subagents 未安装：忽略 */ }
}

/** 读上一回合的最后一条 agent 文本与结束原因（巡检文案用） */
function lastTurnSnapshot(ctx: CookingCtx): { stopReason?: string; text: string } {
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type !== "message") continue;
      const m = e.message as { role?: string; content?: unknown; stopReason?: string };
      if (m.role === "toolResult" || m.role === "bashExecution") continue;
      if (m.role === "assistant") {
        return { stopReason: m.stopReason ?? lastStopReason, text: extractText(m as { role: string; content: any }).trim() || lastAssistantText };
      }
    }
  } catch { /* best effort */ }
  return { stopReason: lastStopReason, text: lastAssistantText };
}

/** 手动巡检用：把空闲起点推到「刚好超过阈值」，忽略「空闲不够久」这道门 */
function forceIdleForCheck(): void {
  const minutes = Math.max(1, config.healthIdleMinutes || 10);
  health.idleSince = Date.now() - minutes * 60_000 - 1_000;
}

// ── TODO-1 长脚本超时拦截：abort + 纠偏提示 ────────────────────────────────

/**
 * 检查在飞工具是否超时。超时就 abort 整轮 + 注入纠偏提示。
 *
 * 为什么必须在 healthTick 的 `config.healthCheck` 闸门之前调：
 * 长脚本永不死时 `tool_execution_end` 永不到来，巡检把「有工具在跑」读作「它正在干活」→
 * 永远跳过。这里一旦超时就把那笔从表里摘掉，巡检的「忙」判定立刻恢复正常。
 */
function checkToolTimeouts(ctx: CookingCtx): void {
  const limitMinutes = config.toolTimeoutMinutes ?? 10;
  if (!(limitMinutes > 0)) return;
  const now = Date.now();
  const limitMs = limitMinutes * 60_000;
  const overdue = overdueTools(runningTools, now, limitMs, abortedToolCalls);
  if (overdue.length === 0) return;

  const maxAborts = config.toolTimeoutMaxAborts ?? 3;
  for (const tool of overdue) {
    const elapsed = now - tool.startedAt;
    // 先标记已处理并摘表：两人同时超时也只处理一次，且巡检计数立刻归零
    abortedToolCalls.add(tool.toolCallId);
    endToolWatch(runningTools, tool.toolCallId);

    if (maxAborts > 0 && toolAbortCount >= maxAborts) {
      ctx.ui.notify(
        `⚠️ 工具 ${tool.toolName} 已跑 ${formatIdle(elapsed)}，但本会话自动中断次数已用完` +
        `（${maxAborts} 次），只记日志不再中断。`,
        "warning",
      );
      continue;
    }

    toolAbortCount++;
    ctx.ui.notify(
      `⏱️ 工具 ${tool.toolName} 已跑 ${formatIdle(elapsed)}，超过阈值 ${limitMinutes} 分钟` +
      `→ 中断本轮并注入纠偏提示（第 ${toolAbortCount}/${maxAborts || "∞"} 次）。`,
      "warning",
    );
    // 不推手机、不升级呼喊：放手等级下既定取舍，只记日志 + TUI 提示
    try {
      ctx.abort?.();
    } catch (err) {
      console.error("[i-am-cooking] abort failed:", err);
    }
    // 用 followUp：abort 后本回合即将结束，steer 可能随回合一起被丢掉；
    // followUp 在回合结束后投递，若已空闲则直接开新回合 —— 两条路都能送到。
    void api.sendUserMessage(
      buildToolTimeoutSteer({
        toolName: tool.toolName,
        elapsedMs: elapsed,
        limitMs,
        abortCount: toolAbortCount,
        maxAborts,
      }),
      { deliverAs: "followUp" },
    );
  }
  updateWidget(ctx);
}

// ── L 表：异常分类后的退避重试（429 / 上下文超限不再直接喊人）──────────────

/** 取消正在排队的退避重试（用户回来 / 新会话 / 开关离开模式时用） */
function cancelRetry(): void {
  if (retryTimerRef) {
    clearTimeout(retryTimerRef);
    retryTimerRef = null;
  }
  retryAttempt = 0;
}

/**
 * 排一次退避重试。返回 true = 已排（调用方不要再喊人）；false = 应该升级喊人。
 *
 * 行为：
 *   429 限流 / 5xx / 网络抖动 → 退避重试，不喊
 *   上下文超限 → 先 compact 再退避重试，不喊
 *   永久失败（语法/路径/参数）与未分类 → 返回 false，保持现状直接喊
 */
function scheduleErrorRetry(ctx: CookingCtx, kind: TurnErrorKind, text: string): boolean {
  const maxAttempts = config.errorRetryMaxAttempts ?? 3;
  if (!isRetryable(kind)) return false;
  if (shouldEscalate(kind, retryAttempt, maxAttempts)) return false;

  const compacted = shouldCompactFirst(kind);
  if (compacted) {
    try {
      ctx.compact?.();
    } catch (err) {
      console.error("[i-am-cooking] compact failed:", err);
    }
  }

  const baseMs = Math.max(1, config.errorRetryBaseMinutes || 1) * 60_000;
  const capMs = Math.max(baseMs, (config.errorRetryMaxMinutes || 10) * 60_000);
  const waitMs = backoffMs(retryAttempt + 1, baseMs, capMs);
  retryAttempt++;
  const attemptNo = retryAttempt;
  const snap = lastTurnSnapshot(ctx);

  ctx.ui.notify(
    `🔁 ${describeErrorKind(kind)}：不喊人，${Math.round(waitMs / 60_000)} 分钟后自动重试` +
    `（第 ${attemptNo}/${maxAttempts} 次）。`,
    "info",
  );

  if (retryTimerRef) clearTimeout(retryTimerRef);
  retryTimerRef = setTimeout(() => {
    retryTimerRef = null;
    if (!isMyCooking()) return;
    void api.sendUserMessage(
      buildRetrySteer({
        kind,
        attempt: attemptNo,
        maxAttempts,
        retryInMs: waitMs,
        compacted,
        lastText: snap.text || text,
      }),
      { deliverAs: "followUp" },
    );
  }, waitMs);
  sessionTimers.push(retryTimerRef as unknown as ReturnType<typeof setInterval>);
  return true;
}

// ── TODO-2 收尾独立判定（正则漏判时起一个独立会话问一句）────────────────

/**
 * 跑一次判官命令并拿回 stdout。**失败一律抛**（调用方降级为正则结论）。
 * 判官命令是用户在配置里自己写的模板，不是硬编码路径 —— 本机没装就用 off 模式。
 */
async function runJudgeCommand(cmd: string, timeoutMs: number): Promise<string> {
  const proc = execFile("/bin/sh", ["-c", cmd], { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 });
  return new Promise<string>((resolve, reject) => {
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    proc.once("error", reject);
    proc.once("close", (code) => {
      if (code !== 0) return reject(new Error(`end judge exit ${code}`));
      resolve(out);
    });
  });
}

/** 用独立命令判官判断回合是不是真结束了。**任何失败都返回 unknown**（降级为正则结论） */
async function judgeTurnEnd(
  ctx: CookingCtx,
  text: string,
  trailingWork: boolean,
  regexSaidDone: boolean,
): Promise<"done" | "not-done" | "unknown"> {
  if (
    !shouldUseEndJudge({
      mode: (config.healthEndJudge as "off" | "cli") ?? "off",
      command: config.healthEndJudgeCmd || "",
      regexSaidDone,
      text,
      trailingWork,
    })
  ) {
    return "unknown";
  }
  const cmd = renderEndJudgeCommand(config.healthEndJudgeCmd || "", buildEndJudgePrompt(text));
  if (!cmd) return "unknown";
  const timeoutMs = Math.max(3, config.healthEndJudgeTimeoutSeconds || 20) * 1000;
  try {
    const out = await runJudgeCommand(cmd, timeoutMs);
    const verdict = parseEndJudgeVerdict(out);
    ctx.ui.notify(
      `🧑‍\u200d⚖️ 收尾判定（独立会话）：${verdict === "done" ? "已结束" : verdict === "not-done" ? "还没结束" : "看不出来（降级为默认）"}`,
      "info",
    );
    return verdict;
  } catch (err) {
    // 命令不存在 / 非 0 退出 / 超时 / 输出无法解析 → 绝不阻塞，降级回正则
    console.error("[i-am-cooking] end judge failed (degraded to regex):", err);
    return "unknown";
  }
}

/**
 * 一次巡检滴答（默认每 healthCheckMinutes 分钟）。
 * 顺序很重要：**工具超时检查在 healthCheck 闸门之前** ——
 * 巡检总开关关掉时，长脚本死锁仍然要能救（它由 toolTimeoutMinutes 独立控制）。
 */
function healthTick(ctx: CookingCtx): void {
  if (!isMyCooking()) return;

  checkToolTimeouts(ctx);

  // 子 Agent 的呼喊请求：父会话在巡检时取走并投给自己（由父 Agent 自己决定喊不喊）
  void pumpRelayQueue(ctx);

  if (!config.healthCheck) return;

  const activity = activitySnapshot(ctx);
  const decision = decideHealthTick(health, {
    cooking: isMyCooking(),
    enabled: config.healthCheck,
    now: Date.now(),
    agentBusy: activity.agentBusy,
    runningTools: activity.runningTools,
    activeSubagents: activity.activeSubagents,
    pendingMessages: activity.pendingMessages,
    blockingAlerts: pendingActionAlerts().length,
    idleMinutes: config.healthIdleMinutes || 10,
    maxNudges: config.healthMaxNudges || 5,
    muteEscalation: healthMuteEscalation(),
    silenceMaxNudges: config.healthMaxNudgesSilence ?? 30,
  });

  if (decision.action === "skip") return;

  if (decision.action === "waiting") {
    // 有未处理的阻塞呼喊 = 它在等你，不是在卡死 → 静默，不再追问
    applyHealthDecision(health, decision, Date.now());
    updateWidget(ctx);
    return;
  }

  if (decision.action === "exhausted") {
    // 用户说过别喊 → 催到上限就停，**不喊人**。
    applyHealthDecision(health, decision, Date.now());
    ctx.ui.notify(
      `🩺 健康巡检：静默模式下已催问 ${config.healthMaxNudgesSilence ?? 30} 次仍无动静，` +
      `按你「别喊了」的要求停止追问（不升级响铃）。\n你在会话里说一句话即可重新开始巡检。`,
      "info",
    );
    updateWidget(ctx);
    return;
  }

  if (decision.action === "escalate") {
    applyHealthDecision(health, decision, Date.now());
    const turn = lastTurnSnapshot(ctx);
    ctx.ui.notify(`🚨 健康巡检：催了 ${config.healthMaxNudges || 5} 次都没动静，已升级呼喊用户。`, "warning");
    queueAlert(
      buildStallAlert({
        nudges: config.healthMaxNudges || 5,
        idleMinutes: config.healthIdleMinutes || 10,
        lastText: turn.text,
      }),
      "normal",
      "health-stall",
      ctx,
    );
    updateWidget(ctx);
    return;
  }

  // nudge：注入一条巡检消息，逼 agent 表态（done / waiting_user / 继续）
  const idleFor = formatIdle(health.idleSince ? Date.now() - health.idleSince : 0);
  applyHealthDecision(health, decision, Date.now());
  const turn = lastTurnSnapshot(ctx);
  ctx.ui.notify(
    `🩺 健康巡检：agent 已空闲 ${idleFor}，第 ${decision.nudge} 次追问状态。`,
    "info",
  );
  // 回合已结束（无流）→ sendUserMessage 会自动开新一轮，正是「叫醒它」的目的
  void api.sendUserMessage(
    buildHealthPrompt({
      idleMinutes: config.healthIdleMinutes || 10,
      nudge: decision.nudge,
      maxNudges: config.healthMaxNudges || 5,
      muteEscalation: healthMuteEscalation(),
      lastStopReason: turn.stopReason,
      lastText: turn.text,
    }),
    { deliverAs: "followUp" },
  );
  updateWidget(ctx);
}

/** 启动健康巡检（幂等；随离开模式启停）。
 *  巡检总开关关掉时也要起表 —— 工具超时死锁救不回它，巡检关不掉。 */
function startHealthTimer(ctx: CookingCtx): void {
  if (mustRelayViaParent(agentIdentity)) return; // 子 Agent 不跑巡检（父会话管）
  stopHealthTimer(ctx);
  const toolTimeoutOn = (config.toolTimeoutMinutes ?? 10) > 0;
  if (!config.healthCheck && !toolTimeoutOn) return;
  const minutes = Math.max(1, Math.min(60, config.healthCheckMinutes || 5));
  healthTimer = setInterval(() => healthTick(ctx), minutes * 60_000);
  sessionTimers.push(healthTimer);
}

function stopHealthTimer(_ctx?: CookingCtx): void {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

type QueueResult = "queued" | "not-cooking" | "mode-off" | "limit" | "duplicate" | "subagent";

function queueAlert(message: string, urgency: Urgency, category: string, ctx: CookingCtx, ttsText?: string): QueueResult {
  if (!isMyCooking()) return "not-cooking";
  // 子 Agent 进程绝不允许自己响铃/弹窗/推送：用户可能根本没开它那个会话。
  // 所有自行触发的呼喊（自动问号、报错、巡检升级）也一样透传。
  if (mustRelayViaParent(agentIdentity)) {
    void writeRelayRequest({
      id: randomUUID(),
      ts: Date.now(),
      from: agentIdentity.label,
      fromSessionId: agentIdentity.sessionId,
      fromAgent: agentIdentity.agentName,
      message,
      urgency,
      category,
      ttsText,
    });
    return "subagent";
  }

  // 多 Agent：每条呼喊都带「谁在喊」标签，否则一堆 Agent 同时开着根本分不清
  const tagged = tagMessage(agentIdentity, message);

  // milestone（小阶段完成）仅在 progressReporting = milestone 模式提醒；interval/none 忽略
  if (category === "milestone") {
    if (config.progressReporting !== "milestone") return "mode-off";
  }

  // completion 防打扰：每次离开最多 maxCompletionNotices 次完成通知
  if (category === "completion") {
    stopReportTimer(); // 任务完成：定时汇报不再需要，到此为止（即使达到防打扰上限也要停表）
    setPhase(health, "done", Date.now(), "agent 发出完成通知"); // 健康巡检同步静默（不用再问它完成没）
    const max = config.maxCompletionNotices ?? 3;
    if (completionNoticeCount >= max) return "limit";
    completionNoticeCount++;
  }

  // 进度类（progress/milestone）不参与去重：即使内容相同，每次进度都要推手机
  if (!isProgressCategory(category)) {
    const dup = config.alerts.find(
      (a) => !a.acked && a.message === tagged && Date.now() - a.time < 10 * 60_000,
    );
    if (dup) return "duplicate";
  }

  const alert: Alert = {
    id: randomUUID(),
    time: Date.now(),
    message: tagged,
    urgency,
    category,
    repeatCount: 0,
    acked: false,
    agent: agentIdentity.label,
    agentKey: myAgentKey(), // 会话启动时按这个键只清自己的呼喊，不清别的 Agent 的
    ttsText: ttsText ? `${ttsAgentPrefix(agentIdentity)}${ttsText}` : undefined,
  };
  config.alerts.push(alert);
  void writeConfig(config);
  void fireAlert(alert, ctx);
  scheduleRepeats(alert, ctx);
  return "queued";
}

// ── mode control ─────────────────────────────────────────────────────────
/**
 * 无条件清理离开状态：任何会话启动都从"在岗"开始。
 * 离开是临时/单次状态，不跨会话存活（会话关闭后重开，默认在岗，需要时再 on）。
 */
function resetCookingState(ctx: CookingCtx): void {
  clearRepeatTimers();
  stopAudioAll(); // 用户回来/新会话：立即停止正在播放的音频
  const hadCooking = isMyCooking();
  const hadPending = pendingAlerts().filter((a) => a.agentKey === myAgentKey()).length;
  const othersAway = otherAgentsCooking();
  // 只清本 Agent 的离开状态与呼喊：别的 Agent 可能还在离开中，不能替它收工
  setMyCooking(false);
  const myKey = myAgentKey();
  config.alerts = othersAway
    ? config.alerts.filter((a) => a.agentKey !== myKey && a.agentKey !== undefined)
    : []; // 没有别的 Agent 在离开 → 全部归档（旧数据没 agentKey 也一起清）
  if (!othersAway) {
    config.callingMode = "normal"; // 偏好是会话级的，每次会话重置
    config.healthMuteEscalation = false; // 健康巡检的「只催不喊」也是会话级的
  }
  void writeConfig(config);
  cancelRetry(); // 未执行的退避重试随关闭作废
  // 健康巡检状态也是会话级的：新会话从 working 开始
  health = newHealthState(Date.now());
  clearToolWatch(runningTools);
  abortedToolCalls.clear();
  toolAbortCount = 0;
  cancelRetry();
  lastSettleSignature = "";
  activeSubagents.clear();
  stopHealthTimer();
  ctx.ui.setStatus("i-am-cooking", "");
  ctx.ui.setWidget("i-am-cooking", []);
  void restoreVolume(); // 若上次离开拉高了音量，恢复原值
  if (hadCooking && hadPending) {
    ctx.ui.notify(`🍳 上次会话的离开状态已清理（现在在岗）。上次离开时被喊了 ${hadPending} 次，已随会话结束归档。`, "info");
  }
}

async function turnOn(ctx: CookingCtx, note: string, askMilestone = false): Promise<void> {
  // 子 Agent 不能管理离开模式：config.json 是会话共享的，它一开一关就把父会话的状态涤了
  if (mustRelayViaParent(agentIdentity)) {
    ctx.ui.notify(
      `🤖 本会话是子 Agent「${agentIdentity.label}」，不能开关离开模式（那是父会话的事）。`,
      "warning",
    );
    return;
  }
  // 幂等：已在离开模式则不再重复开启（供 Agent 工具复用，避免重复发指令/拉音量）
  if (isMyCooking()) return;
  setMyCooking(true);
  completionNoticeCount = 0; // 新的一轮离开，重置完成通知计数
  health = newHealthState(Date.now()); // 新的一轮离开：巡检从 working 重新开始
  void writeConfig(config);
  ctx.ui.notify(`🍳 离开模式已开启。${config.shoutPhrase || "agent 需要你"}时我会大声喊你。`, "info");
  updateStatus(ctx, "idle");
  updateWidget(ctx);

  // 远程停止端点：呼喊推送带「停止响铃」按钮（仅 ntfy 推送开启时；off 即停服）
  void startRemoteStop(ctx);

  // 自动提升音量（只在用户允许时生效）
  void boostVolume(config);

  // 备注里带偏好关键词 → 立即切换（如 /i-am-cooking on 完成后喊我）
  if (note) {
    const mode = detectPreference(note);
    if (mode) setCallingMode(mode, `你在 on 备注里说了："${note.slice(0, 40)}"`, ctx);
    // 备注里带自主等级关键词 → 立即切换（如 /i-am-cooking on 谨慎点继续）
    const level = detectAutonomyLevel(note);
    if (level) setAutonomyLevel(level, `你在 on 备注里说了："${note.slice(0, 40)}"`, ctx);
  }

  // 进度汇报模式：每次手动开启时询问用户（TUI 模式）；Agent 开启/非 TUI 用当前配置
  if (askMilestone && ctx.hasUI && ctx.mode === "tui") {
    const pick = await ctx.ui.select("📈 进度汇报·可选-手机通知", [
      "① 小阶段完成时（默认）",
      "② 定时（每15分钟）",
      "③ 不汇报",
    ], {
      footer: "进度类只推手机（不响铃不弹窗）；紧急 / 完成 → 照常声音+弹窗+手机通知",
    });
    if (pick) {
      if (pick.includes("①")) config.progressReporting = "milestone";
      else if (pick.includes("②")) {
        config.progressReporting = "interval";
        const v = await ctx.ui.input("定时汇报间隔（分钟，默认 15）:", String(config.reportIntervalMinutes || 15));
        const n = parseInt((v ?? "").trim(), 10);
        if (!isNaN(n) && n >= 1 && n <= 120) config.reportIntervalMinutes = n;
        else config.reportIntervalMinutes = 15;
      }
      else config.progressReporting = "none";
      await writeConfig(config);
    }
  }

  // interval / milestone 模式：启动进度心跳（milestone=自查提醒，interval=定时汇报；停表逻辑共用）
  if (config.progressReporting === "interval" || config.progressReporting === "milestone") {
    startReportTimer(ctx);
  }

  // 健康巡检：定时探测 agent 是否真的在跑，意外停住就催它表态（催满上限才升级喊人）
  startHealthTimer(ctx);

  const noteText = note ? `备注：${note}` : "";
  const level = config.autonomyLevel || "balanced";
  const progressHint =
    config.progressReporting === "milestone"
      ? `\n小阶段完成提醒已开启：达到重要小节点时，调用 shout_for_user（category="milestone", urgency="info"）只推送手机通知。系统还会每 ${config.reportIntervalMinutes || 15} 分钟发一条 [milestone check] 自查提醒，无值得报的内容就忽略；任务收尾后自动停止。`
      : config.progressReporting === "interval"
        ? `\n定时汇报已开启：每 ${config.reportIntervalMinutes || 15} 分钟，你会收到一条“请汇报当前进度”的消息，届时调用 shout_for_user（category="progress", urgency="info"）汇报（只推手机，不响铃不弹窗）。即使没有新进展也要如实说明，卡住了就说卡在哪。`
        : "";
  void api.sendUserMessage(
    `[I am cooking] 我离开去做饭了，不在电脑前。${noteText}\n` +
    `当前自主等级：${AUTONOMY_LABEL[level]}。具体行动指南见注入的 [自主等级指南]（含人类墙等场景的喊我阈值）。\n` +
    `请自主推进任务：能自己解决的就自己解决（采用最合理的默认方案，并在回复里注明你的假设），保证质量，不要降低标准；` +
    `只有达到当前等级的喊我阈值（见 [自主等级指南]）时才调用 shout_for_user 工具大声喊我。` +
    `调用前先准备好交接内容（刚好够用：决策给选项和推荐，凭据给获取方式，手动操作给步骤），准备好再喊，喊出的消息即最终版。\n` +
    `呼喊后：被卡住的那件事已交接，不再继续处理；但其他不依赖用户的工作照常推进（进度/完成类通知后亦然）。\n` +
    `任务全部完成或达到重要里程碑时，调用 shout_for_user（category="completion", urgency="info"）通知我。` +
    `\n健康巡检：离开期间我会定时检查你是否还在运行；若发现你停住不动（无回合/无工具/无子代理）会给你发一条 [健康巡检]，` +
    `那时先调 set_task_state 表态——任务已完成用 state="done"，在等我用 state="waiting_user"，没完成就继续推进。` +
    progressHint,
    // steer：agent 干活途中在下一次 LLM 调用前投递，让它尽快知道自己已进入离开模式（followUp 会压队列等到 settle）
    { deliverAs: "steer" },
  );
}

function turnOff(ctx: CookingCtx, source: "command" | "tool" = "command"): void {
  if (mustRelayViaParent(agentIdentity)) {
    // 子 Agent 不许关闭父会话的离开模式
    ctx.ui.notify(`🤖 本会话是子 Agent「${agentIdentity.label}」，不能关闭离开模式。`, "warning");
    return;
  }
  clearRepeatTimers();
  stopAudioAll(); // 关闭离开：立即停止正在播放的音频
  stopRemoteStop(); // 关闭远程停止端点 + 作废 token
  stopHealthTimer(); // 关闭离开：健康巡检停表
  const pending = pendingAlerts();
  setMyCooking(false);
  // 只清自己的呼喊：别的 Agent 可能还在离开中
  config.alerts = config.alerts.filter((a) => a.agentKey !== myAgentKey() && a.agentKey !== undefined);
  config.callingMode = "normal"; // 偏好是会话级的，下次离开重新判断
  void writeConfig(config);
  ctx.ui.setStatus("i-am-cooking", "");
  ctx.ui.setWidget("i-am-cooking", []);

  // 恢复音量
  void restoreVolume();

  // 手动 /off 关闭时 agent 不知情（它的上下文仍是"离开中"，还会继续定时汇报等离开模式行为）
  // → 发一条明确消息告知回到在线状态。exit_cooking_mode 工具路径已在工具返回文案里告知，不重复发。
  if (source === "command") {
    void api.sendUserMessage(
      `[I am cooking] 离开模式已关闭，你已回到在线状态：离开模式规则不再生效` +
      `（不再有定时汇报 / 自主等级指南 / 呼喊工具调用），请停止一切离开模式行为，` +
      `按正常方式继续任务，在本会话直接汇报即可。`,
      { deliverAs: "steer" },
    );
  }

  ctx.ui.notify(
    pending.length
      ? `🍳 离开模式已关闭（离开期间喊了你 ${pending.length} 次，内容见对话记录）。`
      : "🍳 离开模式已关闭。",
    "info",
  );
}

function showStatus(ctx: CookingCtx): void {
  const pending = pendingAlerts();
  const phoneState = !config.phonePush
    ? "未启用"
    : config.pushProvider === "ntfy"
      ? `ntfy topic=${config.ntfyTopic || "(未填)"} token=${maskToken(config.ntfyToken)}`
      : `webhook ${config.webhookUrl || "(未填)"} token=${maskToken(config.webhookToken)}`;
  const lines = [
    DEV_MODE ? `🧪 构建: DEV（非发布版）· /${COMMAND_NAME}` : `🍳 构建: 发布版 v(见下方路径)`,
    `模式: ${isMyCooking() ? "🍳 离开中（I am cooking）" : "人类在岗"}`,
    `本会话标签: ${currentAgentTag()}${agentIdentity.kind === "subagent" ? "（子 Agent → 呼喊转达父 Agent）" : ""}`,
    ...(config.since ? [`开启时间: ${new Date(config.since).toLocaleTimeString("zh-CN")}`] : []),
    `待处理呼喊: ${pending.length}`,
    ...pending.map(
      (a, i) => `  ${i + 1}. [${a.urgency}] ${a.agent ? `[${a.agent}] ` : ""}${a.message}（${new Date(a.time).toLocaleTimeString("zh-CN")}，已喊 ${a.repeatCount} 次）`,
    ),
    `通道: 声音${config.sound ? "✓" : "✗"} TTS${config.tts ? "✓" : "✗"} Toast${config.toast ? "✓" : "✗"} 手机推送(${phoneState})`,
    `音量: ${config.boostVolume ? `离开自动拉高到 ${config.boostLevel}%` : "未启用"}`,
    `呼喊偏好: ${CALLING_MODE_LABEL[config.callingMode || "normal"]}`,
    `自主等级: ${AUTONOMY_LABEL[config.autonomyLevel || "balanced"]}`,
    `🩺 ${formatHealthLine(health, Date.now(), {
      enabled: config.healthCheck,
      checkMinutes: config.healthCheckMinutes,
      idleMinutes: config.healthIdleMinutes,
      maxNudges: config.healthMaxNudges,
      muteEscalation: config.healthMuteEscalation,
    })}${isMyCooking() ? `（子代理 ${countActiveSubagents(ctx)} 个在跑）` : ""}`,
    `防打扰: 正常每 ${config.repeatIntervalMinutes} 分钟重喊 / 紧急每 ${config.urgentRepeatMinutes} 分钟重喊 / 完成通知上限 ${config.maxCompletionNotices} 次（/i-am-cooking limits 可调）`,
    `声音: 哔哔${config.sound ? `${config.beeps}声` : "关"}${config.soundPath ? ` + 自定义歌曲(${config.soundPath})` : ""} / TTS${config.tts ? "开" : "关"} / 总时长${config.soundSeconds ?? 60}秒（/i-am-cooking sound 可调）`,
    `配置: ${CONFIG_PATH}（首次使用请运行 /i-am-cooking setup 配置手机推送）`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

function maskToken(token: string): string {
  const t = resolveValue(token);
  if (!t) return "未配置";
  if (t.length <= 8) return "已配置(***)";
  return `已配置(${t.slice(0, 3)}***${t.slice(-3)})`;
}

/**
 * 配置预览确认：
 *   confirm 显示完整预览 → 是=确认保存(true) / 否=再选(重新填写|取消)。
 * 返回：true=确认，false=重新填写，null=取消。
 */
async function confirmPreview(ui: CookingCtx["ui"], title: string, preview: string): Promise<boolean | null> {
  for (;;) {
    const ok = await ui.confirm(title, preview + "\n\n确认无误？");
    if (ok === true) return true;
    if (ok === false) {
      const next = await ui.select("不满意的话：", ["🔁 重新填写", "❌ 取消"]);
      if (!next) return null;
      if (next.includes("重新填写")) return false;
      return null;
    }
    return null;
  }
}

/**
 * 初次使用配置向导：/i-am-cooking setup
 * 交互式选择推送服务 → 引导说明 → 填 server/topic/token → 自动测试推送。
 */
/**
 * 推送配置保存后的共同尾声：确认自动音量 + 测试推送（ntfy/webhook 共用）。
 * 调用前调用方已把该 provider 的配置写入 config。
 */
async function finishPushSetup(ctx: CookingCtx, provider: "ntfy" | "webhook"): Promise<void> {
  const ui = ctx.ui;
  config.phonePush = true;
  config.setupDone = true;
  await writeConfig(config);

  // ── 自动提升音量（需用户明确允许）──
  const volOk = await ui.confirm(
    "🔊 自动提升系统音量？",
    "离开时如果系统音量低于 80%，自动拉高，回来时恢复。\n" +
    "防止静音状态下听不到呼喊。\n\n允许？",
  );
  config.boostVolume = volOk === true;
  await writeConfig(config);

  // ── 测试推送 ──
  const subscribeHint = provider === "ntfy"
    ? `请先在手机 ntfy app 里订阅：${config.ntfyTopic}\n然后选「是」发送测试。`
    : "是 / 否";
  const test = await ui.confirm("配置已保存！现在测试手机推送？", subscribeHint);
  if (test) {
    const ok = await testPush(provider, ctx);
    ui.notify(
      ok
        ? "✅ 手机推送发送成功，请查看手机。"
        : `⚠️ 发送失败，请检查${provider === "ntfy" ? " topic/token/网络" : " URL/token/网络"}（详情见 pi 日志）。`,
      ok ? "info" : "warning",
    );
  } else {
    ui.notify("配置已保存。随时可用 /i-am-cooking test 测试全部通道。", "info");
  }
}

async function setupWizard(ctx: CookingCtx): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("配置向导需要 TUI 交互模式。请直接编辑 " + CONFIG_PATH, "warning");
    return;
  }
  const ui = ctx.ui;

  // 0) 总览引导
  const start = await ui.confirm(
    "🍳 I am cooking 手机推送配置向导",
    "目的：你离开电脑时（比如做饭），agent 卡住需要你时，通过手机通知提醒你。\n\n" +
    "支持两种推送服务：\n" +
    "① ntfy — 免费开源推送服务，Android/iOS 都有 app（推荐）\n" +
    "② Webhook — 接入 Bark（iOS）/ 企业微信机器人 / Server酱 等\n\n" +
    "开始配置？",
  );
  if (!start) { ui.notify("已取消配置。", "info"); return; }

  // 1) 选择推送服务
  const provider = await ui.select("选择手机推送服务（Esc 取消）:", [
    "ntfy（推荐，免费开源，Android/iOS 都有 app）",
    "Webhook（Bark / 企业微信机器人 / Server酱）",
    "暂不配置手机推送",
  ]);
  if (!provider) { ui.notify("已取消配置。", "info"); return; }
  if (provider.includes("暂不")) {
    config.phonePush = false;
    config.setupDone = true;
    await writeConfig(config);
    ui.notify("已关闭手机推送。其他通道（声音/TTS/Toast）不受影响。", "info");
    return;
  }

  if (provider.includes("ntfy")) {
    // ntfy 引导说明（很多人不知道这是什么）
    const guide = await ui.confirm(
      "📱 ntfy 是什么？",
      "ntfy 是免费开源推送服务，原理很简单：\n" +
      "  • 电脑端用 HTTP 请求发消息到某个「频道」\n" +
      "  • 手机装 ntfy app，订阅同一个「频道」即可收到通知\n\n" +
      "「频道」叫 topic，相当于一个名字（类似邮箱地址）。\n" +
      "建议用随机名字，别人猜不到，隐私安全——下一步我们会帮你生成一个。\n\n" +
      "手机先装好 app（建议现在装）：\n" +
      "  Android: https://play.google.com/store/apps/details?id=io.heckel.ntfy\n" +
      "  iOS:     https://apps.apple.com/app/ntfy/id1625396347\n\n" +
      "装好后，在 app 里「+」→ Subscribe 订阅你下一步填的 topic 名即可。继续？",
    );
    if (!guide) { ui.notify("已取消配置。", "info"); return; }

    config.pushProvider = "ntfy";
    for (;;) {
      // ── 收集 ──
      const server = await ui.input("ntfy 服务器（回车用默认）:", config.ntfyServer || "https://ntfy.sh");
      if (server === undefined) { ui.notify("已取消配置。", "info"); return; }
      const suggested = config.ntfyTopic?.trim() || suggestTopic();
      const topic = await ui.input(`Topic（回车用建议值：${suggested}）`, suggested);
      if (topic === undefined) { ui.notify("已取消配置。", "info"); return; }
      const token = await ui.input("Access Token（可选，私有 topic 用；回车跳过。支持 ${ENV_VAR}）:", config.ntfyToken);
      if (token === undefined) { ui.notify("已取消配置。", "info"); return; }

      // ── 预览确认 ──
      const finalServer = server.trim() || "https://ntfy.sh";
      const finalTopic = topic.trim() || suggested;
      const finalToken = token.trim();
      const decision = await confirmPreview(ui, "📋 配置预览",
        `服务器: ${finalServer}\n` +
        `Topic:  ${finalTopic}\n` +
        `Token:  ${finalToken ? maskToken(finalToken) : "未填（公共 topic）"}`);
      if (decision === null) { ui.notify("已取消配置。", "info"); return; }
      if (decision === false) continue; // 重新填写

      // ── 保存 + 音量 + 测试（公共尾声）──
      config.ntfyServer = finalServer;
      config.ntfyTopic = finalTopic;
      config.ntfyToken = finalToken;
      await finishPushSetup(ctx, "ntfy");
      return;
    }
  }

  // Webhook 引导说明
  const guide = await ui.confirm(
    "🌐 Webhook 是什么？",
    "Webhook 是通用推送接口，可以接入：\n" +
    "  • Bark（iOS 专用）：App Store 搜「Bark」，打开后获得设备码，\n" +
    "    URL 填：https://api.day.app/你的设备码\n" +
    "  • 企业微信机器人：群聊 → 添加机器人 → 复制 webhook URL（带 key=）\n" +
    "  • Server酱：https://sctapi.ftqq.com/你的SendKey.send\n\n" +
    "推送内容为 JSON（title/message/urgency）。\n" +
    "注意：不同服务的 JSON 格式要求可能不同，若失败需检查其文档。继续？",
  );
  if (!guide) { ui.notify("已取消配置。", "info"); return; }

  config.pushProvider = "webhook";
  for (;;) {
    const url = await ui.input("Webhook URL（如 Bark: https://api.day.app/设备码；企业微信: .../send?key=...）:", config.webhookUrl);
    if (url === undefined) { ui.notify("已取消配置。", "info"); return; }
    const token = await ui.input("Token（可选，放指定 header 认证；可填 ${ENV_VAR}）:", config.webhookToken);
    if (token === undefined) { ui.notify("已取消配置。", "info"); return; }
    const header = await ui.input("Token 所在 Header（默认 Authorization，回车跳过）:", config.webhookTokenHeader || "Authorization");
    if (header === undefined) { ui.notify("已取消配置。", "info"); return; }

    const finalUrl = url.trim();
    if (!finalUrl) { ui.notify("URL 不能为空。", "warning"); continue; }
    const finalToken = token.trim();
    const finalHeader = header.trim() || "Authorization";

    const decision = await confirmPreview(ui, "📋 配置预览",
      `URL:    ${finalUrl}\n` +
      `Token:  ${finalToken ? maskToken(finalToken) : "未填"}\n` +
      `Header: ${finalHeader}`);
    if (decision === null) { ui.notify("已取消配置。", "info"); return; }
    if (decision === false) continue; // 重新填写

    config.webhookUrl = finalUrl;
    config.webhookToken = finalToken;
    config.webhookTokenHeader = finalHeader;
    await finishPushSetup(ctx, "webhook");
    return;
  }
}

/** 单独测试手机推送通道（只走 ntfy/webhook，不响声音） */
async function testPush(provider: "ntfy" | "webhook", ctx: CookingCtx): Promise<boolean> {
  const alert: Alert = {
    id: randomUUID(),
    time: Date.now(),
    message: `测试推送：${config.shoutPhrase || "agent 需要你"}！如果你看到这条，说明手机推送通道正常。`,
    urgency: "normal",
    category: "test",
    repeatCount: 0,
    acked: false,
  };
  ctx.ui.notify("⌛️ 正在发送手机测试推送，请留意手机通知…（最长等待 15 秒）", "info");
  const ok = provider === "ntfy" ? await pushPhone(config, alert) : await pushWebhook(config, alert);
  return ok;
}

async function testShout(ctx: CookingCtx): Promise<void> {
  const alert: Alert = {
    id: randomUUID(),
    time: Date.now(),
    message: "测试：这是 pi 的呼喊。如果你能听到声音/看到弹窗/收到手机推送，说明通道正常。",
    urgency: "normal",
    category: "test",
    repeatCount: 0,
    acked: false,
  };

  // ① 先发等待提示，再发出全部通道（声音/TTS/弹窗/手机推送），拿到真实成功/失败
  ctx.ui.notify("⌛️ 正在测试全部通道：声音 / TTS / 桌面通知 / 手机推送…请留意听到的声音与桌面弹窗。", "info");
  const suppress = shouldSuppress(alert);
  const phoneOk = await fireAlert(alert, ctx, { forceSound: true }); // 用户主动测试：声音抢占

  // ② 汇总各通道结果
  const marks: string[] = [];
  if (config.sound) marks.push(suppress ? "声音（偏好跳过）" : `声音 ✓${config.soundPath ? "（自定义音效）" : ""}`);
  if (config.tts) marks.push(suppress ? "TTS（偏好跳过）" : "TTS ✓");
  if (config.toast) marks.push(suppress ? "桌面通知（偏好跳过）" : "桌面通知 ✓");
  const hasPhone = config.phonePush || !!config.webhookUrl;
  marks.push(
    !hasPhone ? "手机推送（未配置）"
      : suppress ? "手机推送（偏好跳过）"
      : phoneOk ? "手机推送 ✓" : "手机推送 ✗",
  );

  // ③ 结果说明
  const failed = hasPhone && !suppress && !phoneOk;
  let note = "";
  if (suppress) note = "ℹ️ 当前呼喊偏好为静音/仅完成模式：声音/弹窗/推送按偏好跳过（横幅已显示）。";
  else if (failed) note = "⚠️ 手机推送失败：请检查 topic/token/网络，日志见 pi 控制台。";
  const body = `测试完成：${marks.join(" | ")}${note ? "\n" + note : ""}`;
  ctx.ui.notify(body, failed ? "warning" : "info");
}

// ── helpers ──────────────────────────────────────────────────────────────
function extractText(msg: { role: string; content: any }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
  }
  return "";
}

// ── extension ────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  api = pi;
  // ── commands ──
  const commandSpec = {
    description: `${DEV_MODE ? "[DEV] " : ""}I am cooking: 离开模式。用法: on [备注] / off / status / setup / test`,
    // 输入命令后按 Tab/空格 弹出子命令菜单
    getArgumentCompletions: (prefix: string) => {
      const subs: { value: string; label: string; description?: string }[] = [
        { value: "on", label: "on", description: "开启离开模式（可加备注，如: on 继续做登录模块）" },
        { value: "off", label: "off", description: "我回来了，让 agent 汇报" },
        { value: "status", label: "status", description: "查看模式 / 待处理呼喊 / 通道 / token 状态" },
        { value: "setup", label: "setup", description: "配置手机推送（首次使用，交互式向导）" },
        { value: "test", label: "test", description: "测试所有通道（声音/TTS/Toast/手机）" },
        { value: "stop-sound", label: "stop-sound", description: "停止本次呼喊播放（只停当前，下次照常）" },
        { value: "rules", label: "rules", description: "查看当前生效规则" },
        { value: "edit-rules", label: "edit-rules", description: "编辑规则文件（保存即生效）" },
        { value: "reset-rules", label: "reset-rules", description: "规则恢复出厂默认（内置规则）" },
        { value: "level", label: "level", description: "自主等级：conservative 谨慎(遇墙就喊) / balanced 平衡(默认) / autonomous 放手(能不喊就不喊)" },
        { value: "limits", label: "limits", description: "查看/调整防打扰参数（交互式中文菜单）" },
        { value: "sound", label: "sound", description: "自定义呼喊铃声：歌曲路径/试听/总时长（交互式中文菜单）" },
        { value: "volume", label: "volume", description: "音量控制：查看/手动调整/离开自动拉高（交互式中文菜单）" },
        { value: "health", label: "health", description: "健康巡检：开关/频率/空闲判定/催问上限/立刻巡检一次（防止 agent 中途意外停住）" },
      ];
      const filtered = subs.filter((s) => s.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: CookingCtx) => {
      const arg = (args ?? "").trim();
      const first = arg.split(/\s+/)[0]?.toLowerCase() ?? "";
      const cmd = commandHandlers[first];
      if (cmd) { await cmd(ctx, arg); return; }
      // 默认：视为 on [备注]（无子命令前缀时整段为备注）
      const note = first === "on" ? arg.slice(2).trim() : arg;
      await turnOn(ctx, note, true); // 手动开启：询问是否开启小阶段提醒
    },
  };

  pi.registerCommand(COMMAND_NAME, commandSpec);

  // 开发版：额外保留 /i-am-cooking 别名（顺手打旧名字也能用），但每次提醒这是 DEV 构建
  if (DEV_MODE) {
    pi.registerCommand("i-am-cooking", {
      ...commandSpec,
      description: `[DEV 别名，正式命令是 /${COMMAND_NAME}] ${commandSpec.description}`,
      handler: async (args: string, ctx: CookingCtx) => {
        ctx.ui.notify(`🧪 你用的是 DEV 构建（不是发布版）。正式命令：/${COMMAND_NAME}`, "warning");
        await commandSpec.handler(args, ctx);
      },
    });
  }

  // 快捷键：停止本次播放（默认 Ctrl+Alt+M；可在 keybindings.json 自定义）
  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "i-am-cooking: 停止本次呼喊播放（仅本次，下次照常）",
    handler: async (ctx) => {
      if (!isMyCooking()) {
        ctx.ui.notify("当前不在离开模式，无播放可停止。", "info");
        return;
      }
      stopCurrentSound(ctx);
    },
  });

  // ── tool (LLM 调用) ──
  pi.registerTool({
    name: "shout_for_user",
    label: "Shout For User",
    description:
      "大声呼喊离开的用户（例如在做饭）。用于两类场景：\n" +
      "① 阻塞类（decision / credential / approval / clarification / help / auto-error / auto-question）：被真正卡住、只有用户能解决时调用；调用前先准备好交接内容。\n" +
      "② 通知类（progress / milestone / completion）：推进中把进度推送手机（只推手机、不响铃不弹窗）；任务全部完成时通知（照常响铃+弹窗+手机）。\n" +
      "**调用时机（重要）**：必须在交接内容准备好之后一次性呼喊，禁止先喊再准备。\n" +
      "**准备标准**：刚好够用——只整理用户立即行动所必需的信息：决策给选项和推荐；凭据给获取方式；手动操作给步骤。不要面面俱到、不要塞无关背景。\n" +
      "喊出的 message 即最终版，事后不再补充。\n" +
      "**喊完之后**：阻塞类——被卡住的那件事已交接，不再继续处理；但其他不依赖用户的工作照常推进。通知类——照常干活或自然收尾，不要停。\n" +
      "若 cooking 模式未开启，它只会告诉你用户就在电脑前，直接在对话里问即可。",
    promptSnippet: "Loudly alert the away user when blocked, or push progress/completion info",
    promptGuidelines: [
      "Call shout_for_user only AFTER the handoff is ready — never shout first and prepare later.",
      "'Ready' means JUST ENOUGH: the minimal info the user needs to act immediately (options + your recommendation for decisions; how to obtain credentials; steps for manual actions). Don't over-collect or pad with irrelevant context.",
      "Shout once with the final message; no preparing-after-shouting. The message is the final version.",
      "After shouting: a blocked item is handed off (stop working on that item only) — other independent work continues normally. Progress/completion shouts are info pushes: keep working (or wrap up naturally on completion).",
    ],
    parameters: Type.Object({
      message: Type.String({
        description: "交接说明（一次性最终版）：用户需做什么 + 必需的材料/凭据/步骤（仅列必要的）。例如：\"需要你登录 example.com（账号 xxx），登录后我需抓取价格页；调研进度已整理\"。",
      }),
      urgency: StringEnum(["info", "normal", "urgent"] as const),
      category: Type.Optional(Type.String({
        description: "分类：decision / credential / approval / clarification / help / completion（全部完成）/ progress（定时进度汇报，只推手机不响铃）/ milestone（小阶段完成，只推手机不响铃）等",
      })),
      ttsText: Type.Optional(Type.String({
        description: "可选：想让用户听到的语音原文（TTS 将原样念出，不走默认模板）。例如：\"叮咚！方案 A 和 B 我拿不准，快回来看看！\" 不填则用默认模板（\"叮咚！agent 需要你！+消息\"）。",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isMyCooking()) {
        return {
          content: [{ type: "text", text: "Cooking 模式未开启——用户就在电脑前，直接在对话里问即可，未发送呼喊。" }],
          details: { fired: false },
        };
      }
      const cat = params.category ?? "other";

      // ── 子 Agent 一律不许直接呼喊用户 ────────────────────────────
      // queueAlert 已统一拦（自动呼喊、巡检升级也走同一条路）；这里只需要解释清楚
      // 发生了什么、别让它重复提交。
      refreshAgentIdentity(ctx);
      if (mustRelayViaParent(agentIdentity)) {
        const relayed = await relayAndAck(params.message, params.urgency, cat, params.ttsText);
        return relayed;
      }

      const result = queueAlert(params.message, params.urgency, cat, ctx, params.ttsText);
      const statusLine = isProgressCategory(cat)
        ? "进度类只推手机（不响铃不弹窗）。"
        : cat === "completion"
          ? "任务完成通知已送达（响铃/推送）。"
          : "等待用户回来处理。";
      const sentText = result === "queued"
        ? `呼喊已发出（${params.urgency}）${params.ttsText ? `，语音：${params.ttsText}` : ""}。${statusLine}`
        : result === "duplicate"
          ? "已有同内容的未确认呼喊，不重复发送。"
          : result === "mode-off"
            ? "当前进度模式不支持小阶段汇报（milestone）。进度模式以开启时的提示为准，本次忽略。"
            : result === "limit"
              ? "本次离开的完成通知已达上限（防打扰），不再发送。"
              : "";
      return {
        content: [{ type: "text", text: sentText }],
        details: { fired: result === "queued", urgency: params.urgency, category: cat, ttsText: params.ttsText ?? null },
      };
    },
  });

  // 工具：根据用户原话动态调整呼喊偏好（agent 语义理解入口）
  pi.registerTool({
    name: "set_calling_preference",
    label: "Set Calling Preference",
    description:
      "根据用户的原话或意图调整呼喊偏好。用户明确表达时（如\"别喊了\"\"完成后喊我\"\"只有紧急才找我\"\"随时汇报\"）必须调用。" +
      "选择模式：normal（默认）/ silence（全部静音只留横幅）/ completion_only（只在完成时喊）/ urgent_only（只在紧急时喊）/ eager（需要你+完成+进度都喊）。",
    promptSnippet: "Adjust how loudly the away user is alerted based on their explicit words",
    promptGuidelines: [
      "Use set_calling_preference when the user explicitly changes their alert preference: \"别喊了\"→silence, \"完成后喊我\"→completion_only, \"只有紧急才找我\"→urgent_only, \"随时汇报\"→eager, \"需要时再喊\"→normal.",
    ],
    parameters: Type.Object({
      mode: StringEnum(["normal", "silence", "completion_only", "urgent_only", "eager"] as const),
      reason: Type.String({ description: "依据的用户原话或推理，例如：\"用户说：完成后喊我\"" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isMyCooking()) {
        return {
          content: [{ type: "text", text: "未在离开模式，偏好不生效。" }],
          details: { mode: params.mode, applied: false },
        };
      }
      setCallingMode(params.mode, params.reason, ctx);
      return {
        content: [{ type: "text", text: `呼喊偏好已切换为：${CALLING_MODE_LABEL[params.mode as CallingMode]}（依据：${params.reason}）` }],
        details: { mode: params.mode, applied: true, reason: params.reason },
      };
    },
  });

  // 工具：agent 向健康巡检表态（完成 / 在等你 / 仍在推进）
  pi.registerTool({
    name: "set_task_state",
    label: "Set Task State",
    description:
      "向健康巡检上报当前任务状态（离开模式下由系统定时追问；不在离开模式时调用无效）。\n" +
      "state=done —— 任务已全部完成、可验收：巡检不再追问（直到用户开口继续，状态自动回到 working）。\n" +
      "state=waiting_user —— 你在等用户（等我登录 / 决策 / 确认 / 手动操作）：巡检不再追问，等用户回来。\n" +
      "state=working —— 仍在推进（默认值）：巡检按原节奏继续。\n" +
      "**调用时机**：收到 [健康巡检] 消息后必须先调用本工具表态，再继续干活；" +
      "任务真的全部完成时也要主动调用（别等系统问）。note 写一句话（交付了什么 / 在等什么 / 正在做什么）。",
    promptSnippet: "Report task state to the health watcher (done / waiting_user / working)",
    promptGuidelines: [
      "Call set_task_state right after receiving a [健康巡检] message — before doing anything else.",
      "Use done only when the task is fully complete and verifiable; use waiting_user when you are blocked on the user; use working while still progressing.",
      "Also call it proactively when the task is fully done, without waiting for the health check.",
    ],
    parameters: Type.Object({
      state: StringEnum(["working", "done", "waiting_user"] as const),
      note: Type.Optional(Type.String({
        description: "一句话说明：交付了什么 / 在等用户做什么 / 正在做什么",
      })),
      reason: Type.Optional(Type.String({ description: "依据（调试用）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isMyCooking()) {
        return {
          content: [{ type: "text", text: "未在离开模式，健康巡检不生效。" }],
          details: { applied: false, state: params.state },
        };
      }
      const now = Date.now();
      const prev = health.phase;
      setPhase(health, params.state as HealthPhase, now, params.note);
      updateWidget(ctx);
      const label =
        params.state === "done"
          ? "✅ 已标记完成，健康巡检不再追问（你在会话里继续后自动恢复追问）"
          : params.state === "waiting_user"
            ? "⏳ 已标记「在等你」，健康巡检不再追问"
            : "🔧 已标记「仍在推进」，健康巡检继续";
      if (prev !== params.state) ctx.ui.notify(`🩺 ${label}${params.note ? `：${params.note}` : ""}`, "info");
      return {
        content: [{ type: "text", text: label }],
        details: { applied: true, state: params.state, previous: prev, note: params.note ?? null },
      };
    },
  });

  // 工具：根据用户原话调整自主等级（agent 语义理解入口）
  pi.registerTool({
    name: "set_autonomy_level",
    label: "Set Autonomy Level",
    description:
      "根据用户的原话或意图调整自主等级：遇到阻塞时「该不该喊用户」的阈值。" +
      "conservative 谨慎：遇墙就喊（人类墙：验证码/登录/手动点击等必须人手动的阻塞；需要决策/审批/凭据/澄清先喊我）。" +
      "balanced 平衡（默认）：有点难度才喊（普通决策自主推进并注明假设，只有人类墙或选错代价大才喊）。" +
      "autonomous 放手：能不喊就不喊（尽量自决，只有任务彻底无法继续才喊）。" +
      "用户明确表达时（如\"拿不准就问我\"→conservative，\"能不喊就不喊\"→autonomous）必须调用。",
    promptSnippet: "Adjust how much autonomy the agent has when the away user is blocked (when to call for them)",
    promptGuidelines: [
      "Use set_autonomy_level when the user explicitly expresses how much they want to be asked/troubled: \"拿不准就问我\"→conservative, \"有难度才喊我\"→balanced, \"能不喊就不喊\"→autonomous.",
    ],
    parameters: Type.Object({
      level: StringEnum(["conservative", "balanced", "autonomous"] as const),
      reason: Type.String({ description: "依据的用户原话或推理，例如：\"用户说：遇墙就喊我\"" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      setAutonomyLevel(params.level, params.reason, ctx);
      return {
        content: [{ type: "text", text: `自主等级已切换为：${AUTONOMY_LABEL[params.level as AutonomyLevel]}（依据：${params.reason}）` }],
        details: { level: params.level, applied: true, reason: params.reason },
      };
    },
  });

  // 工具：用户表达要离开时，Agent 自主开启离开模式（用户无需手输命令）
  pi.registerTool({
    name: "enter_cooking_mode",
    label: "Enter Cooking Mode",
    description:
      "开启离开模式：用户不在电脑前时 agent 自主推进任务，卡住时大声呼喊用户，任务完成时通知。\n" +
      "**仅在用户非常明确地表达要离开电脑时调用**——例如：" +
      "\"我去做饭了，你继续\" / \"我离开一下，有事喊我\" / \"我出门了，你自主处理\" / \"I'm cooking, handle it\" / 语音识别或输入的自然语言明确表示要离开。\n" +
      "**不要误开**：如果用户只是短暂离开话题、问你问题、或让你继续普通对话（没有明确表示要离开电脑/无法即时回复），不要调用。" +
      "不确定时宁可不开——用户会在需要时自己执行 /i-am-cooking on。",
    promptSnippet: "Enter away-mode when the user is clearly leaving the computer (cooking, stepping away, going out)",
    promptGuidelines: [
      "Call enter_cooking_mode ONLY when the user unambiguously says they are leaving the computer and won't be available (e.g. cooking, stepping away, going out) and expects you to keep working autonomously. If unsure, do NOT call it — the user can enable it themselves with /i-am-cooking on.",
    ],
    parameters: Type.Object({
      note: Type.Optional(Type.String({
        description: "用户的离开说明或布置的任务（可选），例如：\"继续做调研，遇到人类墙喊我\"",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (isMyCooking()) {
        return {
          content: [{ type: "text", text: "已在离开模式中，无需重复开启。" }],
          details: { entered: false, alreadyCooking: true },
        };
      }
      await turnOn(ctx, params.note ?? ""); // Agent 开启：不询问，沿用当前配置
      return {
        content: [{ type: "text", text: `已开启离开模式${params.note ? `，备注：${params.note}` : ""}。请按注入的自主规则推进任务，卡住时用 shout_for_user 喊用户，任务完成时通知。` }],
        details: { entered: true, note: params.note ?? "" },
      };
    },
  });

  // 工具：用户要求更换呼喊铃声时，agent 帮助设置自定义歌曲
  pi.registerTool({
    name: "set_shout_sound",
    label: "Set Shout Sound",
    description:
      "设置呼喊铃声的自定义歌曲（用户离开时听到的提醒音频）。\n" +
      "**仅在用户明确要求更换/设置铃声时调用**，例如：\"帮我换个铃声\" / \"把声音设成那首歌\" / \"用 xxx.mp3 当提醒音\"。\n" +
      "path 必须是本机存在的音频文件路径（macOS 支持 mp3/wav/m4a/aiff）。\n" +
      "如果用户没给具体路径，不要猜测——先问用户路径，或建议用户运行 /i-am-cooking sound 用文件浏览器选择。",
    promptSnippet: "Set the custom shout ringtone when the user asks to change the alert sound",
    promptGuidelines: [
      "Call set_shout_sound ONLY when the user explicitly asks to change/set the ringtone and gives a specific audio file path. Do not guess paths — ask the user or suggest /i-am-cooking sound for the file browser.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "音频文件完整路径，例如：\"/Users/name/Music/ring.mp3\"" }),
      soundSeconds: Type.Optional(Type.Number({ description: "可选：总时长上限（秒，1-300）。不填则保持当前值（默认 60）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params.path.trim().replace(/^~\//, `${homedir()}/`);
      // 校验路径存在
      try {
        const st = await import("node:fs/promises").then((m) => m.stat(p));
        if (!st.isFile()) {
          return {
            content: [{ type: "text", text: `路径不是文件：${p}` }],
            details: { set: false, reason: "not-a-file" },
          };
        }
      } catch {
        return {
          content: [{ type: "text", text: `文件不存在：${p}。请确认路径，或建议用户运行 /i-am-cooking sound 用文件浏览器选择。` }],
          details: { set: false, reason: "not-found" },
        };
      }
      if (!isAudioFile(p)) {
        return {
          content: [{ type: "text", text: `不支持的文件类型（支持 mp3/wav/m4a/aiff/ogg/flac）：${p}` }],
          details: { set: false, reason: "unsupported-format" },
        };
      }
      config.soundPath = p;
      if (params.soundSeconds !== undefined) {
        const n = Math.max(1, Math.min(300, Math.round(params.soundSeconds)));
        config.soundSeconds = n;
      }
      void writeConfig(config);
      ctx.ui.notify(`🔊 呼喊铃声已更新：${p}`, "info");
      return {
        content: [{ type: "text", text: `已设置呼喊铃声：${p}${params.soundSeconds !== undefined ? `（总时长 ${config.soundSeconds} 秒）` : ""}。下次呼喊时会先播短铃声+语音，再播这首歌。用户可随时用 /i-am-cooking sound 试听。` }],
        details: { set: true, path: p, soundSeconds: config.soundSeconds },
      };
    },
  });

  // 工具：调整系统音量（用户明确要求，或呼喊前解除静音保障）
  pi.registerTool({
    name: "set_volume",
    label: "Set Volume",
    description:
      "调整系统音量（0-100）。\n" +
      "**何时调用**：① 用户明确要求（如\"把音量调大点\"\"太吵了，小点声\"\"静音\"）；② 呼喊用户前发现系统静音，需解除静音保证用户能听到。\n" +
      "**参数二选一**：给 level=绝对音量（0-100）；给 action=相对动作（raise 调大 / lower 调小 / mute 静音 / unmute 取消静音），amount 为步进（默认 10）。\n" +
      "**不要擅自调整**：用户没要求时不要改音量。",
    promptSnippet: "Adjust system volume when the user asks, or unmute before shouting",
    promptGuidelines: [
      "Use set_volume only when the user explicitly asks to change volume, or when the system is muted and you must shout at the user (unmute first). Do not adjust volume on your own initiative.",
    ],
    parameters: Type.Object({
      level: Type.Optional(Type.Number({ description: "绝对音量（0-100）。与 action 二选一" })),
      action: Type.Optional(StringEnum(["raise", "lower", "mute", "unmute"] as const)),
      amount: Type.Optional(Type.Number({ description: "raise/lower 的步进（默认 10）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return (async () => {
        const action = params.action;
        const amount = Math.max(1, Math.min(50, Math.round(params.amount ?? 10)));

        if (action === "mute") {
          const r = await toggleMute(true);
          return {
            content: [{ type: "text", text: r === null ? "静音设置（当前平台需手动操作或走音量命令）。" : "已静音。" }],
            details: { muted: true, ok: r !== null },
          };
        }
        if (action === "unmute") {
          const r = await toggleMute(false);
          return {
            content: [{ type: "text", text: r === null ? "取消静音设置失败/不支持。" : "已取消静音。" }],
            details: { muted: false, ok: r !== null },
          };
        }

        const cur = await getSystemVolume();
        if (cur === null) {
          return {
            content: [{ type: "text", text: "无法读取当前音量，调整失败（见日志）。" }],
            details: { ok: false, reason: "read-failed" },
          };
        }
        let target: number;
        if (action === "raise") target = cur + amount;
        else if (action === "lower") target = cur - amount;
        else if (typeof params.level === "number") target = params.level;
        else {
          return {
            content: [{ type: "text", text: "参数缺失：请提供 level（0-100）或 action（raise/lower/mute/unmute）。" }],
            details: { ok: false, reason: "bad-params" },
          };
        }
        const ok = await setSystemVolume(target);
        const now = await getSystemVolume();
        ctx.ui.notify(`🔊 音量${ok ? `已调整到 ${now ?? target}%` : "调整失败"}（原 ${cur}%）。`, ok ? "info" : "warning");
        return {
          content: [{ type: "text", text: ok ? `系统音量已调整为 ${now ?? target}%（原 ${cur}%）。` : "音量调整失败（见日志）。" }],
          details: { ok, from: cur, to: now ?? target },
        };
      })();
    },
  });

  // 工具：用户明确表示结束离开时，agent 关闭离开模式（语义关闭，不依赖关键词）
  pi.registerTool({
    name: "exit_cooking_mode",
    label: "Exit Cooking Mode",
    description:
      "关闭离开模式（I am cooking），回到在线状态。\n" +
      "**调用时机**：用户明确表示要结束离开、回到在线时——例如说\"我不离开了\"\"保持在线\"\"别忙了，我回来了\"\"先停一下，不用了\"\"取消离开模式\"，或明显接管任务、表示不再需要你自主干活。\n" +
      "**不要误关**：\n" +
      "  · 用户只是临时看一眼、补充信息、问个问题 → 不要调用，保持离开模式继续工作\n" +
      "  · 用户说\"我先去忙别的，你继续\" → 不要调用\n" +
      "调用后：当前会话退出离开模式，后续按新情况继续；只影响当前这一个 Agent，不影响其他 Agent。",
    promptSnippet: "Exit away-mode when the user clearly returns / wants to be online again",
    promptGuidelines: [
      "Call exit_cooking_mode ONLY when the user clearly says they are ending the away session (e.g. '我不离开了', '保持在线', '先停一下，不用了'). Do NOT call it when the user just adds a note, asks a question, or says 'keep going'. Only affects this session.",
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "依据的用户原话或推理，例如：\"用户说：我不离开了，保持在线\"" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isMyCooking()) {
        return {
          content: [{ type: "text", text: "当前不在离开模式，无需关闭。" }],
          details: { closed: false, alreadyOff: true },
        };
      }
      turnOff(ctx, "tool");
      return {
        content: [{ type: "text", text: `已关闭离开模式（依据：${params.reason}）。你已回到在线状态，离开模式规则不再生效；无需汇报——结束时会自行总结。` }],
        details: { closed: true, reason: params.reason },
      };
    },
  });

  // ── events ──
  pi.on("session_start", async (_event, ctx) => {
    config = await readConfig();
    await ensureRulesFile(); // 首次启动用内置默认创建规则文件，已存在则不动
    // 身份必须先刷新：后面要根据父子关系决定要不要改共享状态
    const me = refreshAgentIdentity(ctx);
    if (me.kind === "subagent") {
      // ❗子 Agent 绝不能 resetCookingState：config.json 是所有会话共享的，
      // 子进程一把火就把父会话的「离开中」状态、待处理呼喊、偏好全涤掉了。
      ctx.ui.notify(
        `🤖 本会话是子 Agent「${me.label}」：不直接呼喊用户，也不管理离开模式。` +
        `需要用户时调用 shout_for_user，会自动转达给父 Agent。`,
        "info",
      );
      return;
    }
    // 离开状态不跨会话存活：任何会话启动都从"在岗"开始（需要时用户或 Agent 再 on）
    resetCookingState(ctx);
    if (DEV_MODE) {
      // 开发版每次启动都报一次身份：命令名、版本、源码路径、状态目录
      ctx.ui.notify(
        `🧪 DEV 构建已加载（不是发布版）\n` +
          `  命令: /${COMMAND_NAME}（/i-am-cooking 为别名，会提醒）\n` +
          `  ${await describeBuild()}`,
        "warning",
      );
    } else if (!config.setupDone) {
      // 初次使用：提醒配置手机推送
      ctx.ui.notify(
        "🍳 I am cooking 插件已加载。首次使用建议运行 /i-am-cooking setup 配置手机推送（人在厨房也能收到呼喊）。",
        "info",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    clearRepeatTimers();
    stopAudioAll(); // 会话关闭：停止正在播放的音频
    stopRemoteStop(); // 会话关闭：停掉远程停止端点
    void restoreVolume(); // 退出时恢复音量
    await writeConfig(config);
  });

  // 离开模式时，每回合注入自主推进规则（buildRulesPrompt 开头有 \n\n--- 强分隔符；
  // 这里额外保证 base prompt 末尾有 \n，双重保险避免粘连）
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!isMyCooking()) return;
    agentActive = true; // 回合开始：进度心跳恢复触发
    touchActivity(health, Date.now()); // 有新动静：巡检空闲窗口重置（不动催问计数）
    const base = event.systemPrompt.endsWith("\n") ? event.systemPrompt : event.systemPrompt + "\n";
    return {
      systemPrompt: base + (await buildRulesPrompt(config.autonomyLevel || "balanced", config.progressReporting || "milestone")),
    };
  });

  // 回合开始/结束：活动信号 + 记住结束原因与最后一句（健康巡检文案用）
  pi.on("agent_start", () => { if (isMyCooking()) touchActivity(health, Date.now()); });
  pi.on("agent_end", (event) => {
    if (!isMyCooking()) return;
    touchActivity(health, Date.now());
    try {
      const last = [...(event.messages ?? [])].reverse().find((m) => m.role === "assistant") as
        | { role: string; content: any; stopReason?: string }
        | undefined;
      if (last) {
        lastStopReason = last.stopReason;
        const text = extractText(last).trim();
        if (text) lastAssistantText = text;
      }
    } catch { /* best effort */ }
  });

  // 工具在飞 = 真的在干活（长 bash / 同步 subagent() 都算）。
  // 记 toolCallId + 起始时间：脚本永不结束时 end 永不到来，靠计时才能识别超时（TODO-1）。
  pi.on("tool_execution_start", (event, ctx) => {
    if (!isMyCooking()) return;
    startToolWatch(runningTools, event.toolCallId, event.toolName, Date.now());
    lastCtx = ctx; // 超时 abort 要用一个新鲜的 ctx
    touchActivity(health, Date.now());
    updateWidget(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!isMyCooking()) return;
    endToolWatch(runningTools, event.toolCallId);
    abortedToolCalls.delete(event.toolCallId); // 已正常结束，不再占着「已中断」名额
    // 本插件自己的表态/呼喊工具不算「真实工作」：否则 agent 只需回一句呼喊
    // 就把催问计数清零，巡检永远升不了级（无限空转）。
    if (STATEMENT_ONLY_TOOLS.has(event.toolName)) return;
    retryAttempt = 0; // 真实工具跑成功了：连续可重试异常计数清零
    markRealWork(health, Date.now());
    updateWidget(ctx);
  });

  pi.on("turn_start", () => { if (isMyCooking()) touchActivity(health, Date.now()); });

  // ── pi-subagents 子代理活动信号（event-bus，进程内）────────────────────
  // 子代理在跑 = 父 agent 在干活 → 巡检不算它「停住」。事件驱动快且准，
  // /reload 后丢失的历史 run 由 countActiveSubagents 的 registry 探测兜底。
  const subStarted = (payload: unknown) => {
    if (!isMyCooking()) return;
    const id = (payload as { id?: unknown })?.id;
    if (typeof id === "string" && id) activeSubagents.add(id);
    touchActivity(health, Date.now());
  };
  const subComplete = (payload: unknown) => {
    const id = (payload as { id?: unknown })?.id;
    if (typeof id === "string" && id) activeSubagents.delete(id);
    if (!isMyCooking()) return;
    // 子代理结束 = 有产出：真实工作信号（父 agent 会接着处理结果）
    markRealWork(health, Date.now());
    // 子代理可能在里面交过呼喊请求：完成时立刻取一次，不要等到下一个巡检滴答
    void pumpRelayQueue(lastCtx ?? ({} as CookingCtx));
  };
  bindSubagentEvents(subStarted, subComplete);


  // 回合收尾检测：定时汇报自动停表 + 自动呼喊安全网（agent 在等用户/报错）
  pi.on("agent_settled", async (_event, ctx) => {
    agentActive = false; // 回合结束：进度心跳暂停（新回合开始时恢复）
    if (!isMyCooking()) return;
    lastCtx = ctx;
    touchActivity(health, Date.now()); // 回合结束也算有动静（刚说完话）
    // 子 Agent 可能在本回合交过呼喊请求：收尾时立刻取一次
    void pumpRelayQueue(ctx);
    try {
      const entries = ctx.sessionManager.getEntries();
      let lastAssistant: { text: string; stopReason?: string; errorMessage?: string; rawStopReason?: string } | undefined;
      let trailingWork = false;

      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type !== "message") continue;
        const m = e.message;
        if (m.role === "toolResult" || m.role === "bashExecution") { trailingWork = true; break; }
        if (m.role === "assistant") {
          const text = extractText(m).trim();
          if (text) {
            lastAssistant = {
              text,
              stopReason: m.stopReason,
              errorMessage: (m as { errorMessage?: string }).errorMessage,
              rawStopReason: (m as { rawStopReason?: string }).rawStopReason,
            };
          }
          break;
        }
        if (m.role === "user") break; // 用户消息在最后 → 不是 agent 在等
      }

      if (!lastAssistant || trailingWork) return;
      const text = lastAssistant.text;
      // TODO-2 幂等：同一回合不重复扫描（agent_settled 可能因内部重试多次触发）。
      // 签名 = 条目数 + 结束原因 + 最后一句摘要：同一回合重放签名相同；新一轮条目数变了就重新判定。
      const signature = `${entries.length}|${lastAssistant.stopReason ?? ""}|${text.slice(0, 120)}`;
      if (signature === lastSettleSignature) return;
      lastSettleSignature = signature;
      const isError = lastAssistant.stopReason === "error";

      // ── 收尾判定（TODO-2）：正则 → 可选独立会话复核 ──────────────────
      // 不管进度汇报开着没，都要同步 health.phase：否则巡检会对已收工的 agent 继续催。
      const regexSaidDone = detectTaskFinale(text);
      let finale = regexSaidDone;
      if (!finale && !isError) {
        const verdict = await judgeTurnEnd(ctx, text, trailingWork, regexSaidDone);
        if (verdict === "done") finale = true;
      }
      if (finale) {
        stopReportTimer(); // 进度心跳不再需要
        setPhase(health, "done", Date.now(), "回合总结表明任务已全部收尾");
      }

      // 它在等我回复（以 ？结尾的短问题）→ 健康巡检标记 waiting_user，不再追问
      const lvl = config.autonomyLevel || "balanced";
      if (!finale && lvl !== "autonomous" && text.length <= 600 && /[?？]\s*$/.test(text)) {
        if (health.phase === "working") setPhase(health, "waiting_user", Date.now(), "回合以问号结尾，在等你回复");
      }

      if (!config.autoDetect) return;

      // ── 回合报错：先分类，再决定喊不喊（L 表 429 / 上下文超限）──────────
      if (isError) {
        const ctxPercent = (() => {
          try { return ctx.getContextUsage?.()?.percent ?? null; } catch { return null; }
        })();
        const kind = classifyTurnError({
          errorMessage: lastAssistant.errorMessage,
          rawStopReason: lastAssistant.rawStopReason,
          contextPercent: ctxPercent,
        });
        // 429 / 5xx / 上下文超限 → 退避重试，不按 urgent 喊人；到上限才升级
        if (scheduleErrorRetry(ctx, kind, text)) return;
        const why = describeErrorKind(kind);
        queueAlert(
          `Agent 回合报错（${why}），可能需要你处理：${text.slice(0, 300)}`,
          "urgent",
          "auto-error",
          ctx,
        );
        return;
      }
      // 非报错回合结束：连续可重试异常计数归零
      retryAttempt = 0;
      // 以"？"结尾的短问题 → 在等你回复（autonomous 放手等级不自动喊：用户已说能不喊就不喊）
      const level = config.autonomyLevel || "balanced";
      if (level === "autonomous") return;
      if (text.length <= 600 && /[?？]\s*$/.test(text)) {
        queueAlert(`Agent 在等你回复：${text.slice(0, 200)}`, "normal", "auto-question", ctx);
      }
    } catch (err) {
      console.error("[i-am-cooking] auto-detect failed:", err);
    }
  });

  // 你直接打字 = 回来了 → 自动退出离开模式并让 agent 汇报
  pi.on("input", async (event, ctx) => {
    if (!isMyCooking()) return;
    if (event.source !== "interactive") return;
    if (event.text.trim().startsWith("/")) return; // 命令已由 command 处理

    // 你在会话里继续 → 健康巡检回到 working：下次巡检还会问它是否完成
    markUserInput(health, Date.now());
    updateWidget(ctx);

    // ① 文字匹配：用户原话里带偏好关键词 → 立即切换（不依赖 agent）
    const mode = detectPreference(event.text);
    if (mode) {
      setCallingMode(mode, `你说了："${event.text.slice(0, 40)}"`, ctx);
    }

    // ①-b 文字匹配：用户原话里带自主等级关键词 → 立即切换（持久化，跨会话保留）
    const level = detectAutonomyLevel(event.text);
    if (level) {
      setAutonomyLevel(level, `你说了："${event.text.slice(0, 40)}"`, ctx);
    }

    // ② 用户打字 = 人在场 + 已响应：停掉正在响的铃声，旧呼喊标记处理，横幅回基础状态
    //    agent 继续自主干活；之后的呼喊是新信号，照常显示/响铃
    const pendingCount = pendingAlerts().length; // 数量，不是布尔——插值进文案会变成 "true 条"
    const hadAudio = shoutingState || hasActiveAudio();
    if (pendingCount > 0 || hadAudio) {
      stopAudioAll(); // 人在场：立即安静
      for (const a of config.alerts) a.acked = true;
      void writeConfig(config);
      updateStatus(ctx, "idle");
      updateWidget(ctx);
      const notice = userInputNotice({ pendingCount, hadAudio });
      if (notice) ctx.ui.notify(notice, "info"); // 0 条且没在响 → 不打扰
    }

    // ③ 关闭离开模式由 agent 语义理解调用 exit_cooking_mode，或用户手动 /off
  });
}
