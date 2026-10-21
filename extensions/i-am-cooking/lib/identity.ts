/**
 * Agent 身份识别（多 Agent 场景：看出是谁在喊你 / 拦截子 Agent 直接呼喊）。
 *
 * 问题一：用户同时开着很多个 Agent。每条呼喊长得一模一样，看不出是哪个 Agent 发的。
 * 问题二：子 Agent（pi-subagents 起的那批）不许直接呼喊——它可能在"Zen 镜像"这种
 *        藏在后台的会话里，直接喊了用户也回不去它那个界面。正确路径是它把话交给父 Agent，
 *        由父 Agent 代喊。
 *
 * 身份来源（全部来自环境变量，pi-subagents 明确约定）：
 *   PI_SUBAGENT_CHILD=1              本进程是子 Agent
 *   PI_SUBAGENT_CHILD_AGENT          子 Agent 的 agent 名（如 trellis-implement）
 *   PI_SUBAGENT_SESSION_NAME         父 Agent 在启动时算好的可读名（"agent: 任务摘要"）
 *   PI_SUBAGENT_PARENT_SESSION       父（根）会话 id —— 子 Agent 交话的目标
 *   PI_SUBAGENT_DEPTH                嵌套深度（1 = 直接子级）
 *
 * 本模块纯函数；不写文件、不碰 ctx。
 */

export interface AgentIdentity {
  /** parent = 用户直接面对的那个会话；subagent = 被派出去的子环 */
  kind: "parent" | "subagent";
  /** 给用户看的短标签（呼喊文案前缀） */
  label: string;
  /** 父会话 id（子 Agent 交话的目标；父 Agent 自己的会话 id） */
  sessionId?: string;
  parentSessionId?: string;
  /** 子 Agent 的 agent 名（如 trellis-implement / zen-mirror） */
  agentName?: string;
  depth?: number;
}

/** 标签最长多少字符（横幅一行放得下；但 pi-subagents 的会话名已经压到 80，
 *  这里留 40 足够装下 "trellis-implement: 修长脚本超时" 这类常见名。 */
export const AGENT_LABEL_MAX = 40;

/** 把任意文本压成一行、去引号、限长（会话名可能带换行/长任务摘要） */
export function sanitizeLabel(raw: string | undefined, max = AGENT_LABEL_MAX): string {
  if (!raw) return "";
  const one = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * 从环境变量 + 会话名推断身份。
 *
 * 优先用 `sessionName`（pi 的会话显示名，pi-subagents 会把 "agent: 任务摘要" 塞进去），
 * 因为它是人最认得出的那个。拿不到再退回 agent 名 / 会话 id 短码。
 */
export function resolveAgentIdentity(input: {
  env?: NodeJS.ProcessEnv;
  sessionName?: string;
  sessionId?: string;
} = {}): AgentIdentity {
  const env = input.env ?? {};
  const isChild = env.PI_SUBAGENT_CHILD === "1";
  const agentName = sanitizeLabel(env.PI_SUBAGENT_CHILD_AGENT, 20) || undefined;
  const envSessionName = sanitizeLabel(env.PI_SUBAGENT_SESSION_NAME);
  const parentSessionId = env.PI_SUBAGENT_PARENT_SESSION?.trim() || undefined;
  const depthRaw = Number(env.PI_SUBAGENT_DEPTH ?? "");
  const depth = Number.isFinite(depthRaw) && depthRaw > 0 ? depthRaw : undefined;

  if (!isChild) {
    return {
      kind: "parent",
      label: sanitizeLabel(input.sessionName) || sanitizeLabel(envSessionName) || shortSessionLabel(input.sessionId) || "主会话",
      sessionId: input.sessionId?.trim() || undefined,
    };
  }

  // 子 Agent：会话名 → agent 名 → 会话 id 短码 → 兜底
  const label =
    sanitizeLabel(input.sessionName) ||
    envSessionName ||
    agentName ||
    shortSessionLabel(input.sessionId) ||
    "子Agent";

  return {
    kind: "subagent",
    label,
    sessionId: input.sessionId?.trim() || undefined,
    parentSessionId,
    agentName,
    depth,
  };
}

/** 会话 id → 可读短码（session-abcdef… → abcdef；直接硬截，不加省略号） */
export function shortSessionLabel(sessionId: string | undefined): string {
  const id = sessionId?.trim();
  if (!id) return "";
  const base = id.split(/[\\/]/).pop() ?? id;
  const stripped = base.replace(/^session-/, "").replace(/\.jsonl?$/, "");
  return stripped.slice(0, 8);
}

/**
 * 呼喊文案前缀。父会话不加"子Agent"标记（默认那个就是用户自己的会话），
 * 子 Agent 明确标出来，免得用户以为是自己那个会话在喊。
 */
export function agentTag(id: AgentIdentity): string {
  return id.kind === "subagent" ? `【${id.label} · 子Agent】` : `【${id.label}】`;
}

/** 给消息加 Agent 标签（已经在最前面带了同一标签就不重复加） */
export function tagMessage(id: AgentIdentity, message: string): string {
  const tag = agentTag(id);
  if (message.startsWith(tag)) return message;
  return `${tag} ${message}`;
}

/** TTS 前缀：口头说"子 Agent"比文字括号自然，而且要短 */
export function ttsAgentPrefix(id: AgentIdentity): string {
  return id.kind === "subagent" ? `${id.label} 子代理，` : `${id.label}，`;
}

/**
 * 子 Agent 是否必须走父 Agent 转达。
 * 没有 parentSessionId 时**仍然拦截**（宁可转不出去也不能让用户去一个打不开的界面），
 * 由调用方在 ack 文案里明确告诉它"直接写进最终结果"。
 */
export function mustRelayViaParent(id: AgentIdentity): boolean {
  return id.kind === "subagent";
}
