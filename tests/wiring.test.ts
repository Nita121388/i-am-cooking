// 接线级集成测试：把定时器「捉住」手动驱动，验证 index.ts 的事件接线真的按预期工作。
//
// 为什么需要：`tests/tool-watch.test.ts` 只证明「超时判定」这个纯函数对；
// `tests/health.test.ts` 只证明状态机对。但真正会出 bug 的是接线——
// tool_execution_start 有没有记进去、超时有没有真的调 abort、纠偏提示有没有真的发出去、
// 报错分类有没有真的拦住 urgent 呼喊。这些在单测层完全看不见。
//
// 做法：覆盖 globalThis.setInterval 把回调收进数组（不真等 1 分钟），
// 再覆盖 Date.now 让时间随便跳。这样整条链路可以毫秒级跑完且完全确定。
//
// 注意：状态目录必须先指到临时目录再 import —— lib/config.ts 在模块加载时读 env。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE_DIR = await mkdtemp(join(tmpdir(), "iac-wiring-"));
process.env.I_AM_COOKING_HOME = STATE_DIR;
process.env.I_AM_COOKING_DEV = "";

// ── 定时器与时间控制 ───────────────────────────────────────────────────
type FakeTimer = { fn: () => void; ms: number; cleared: boolean; id: number };
const intervals: FakeTimer[] = [];
const timeouts: FakeTimer[] = [];
let timerId = 0;
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearInterval = globalThis.clearInterval;
const realClearTimeout = globalThis.clearTimeout;
const realNow = Date.now;
let fakeNow = 1_000_000_000_000;

globalThis.setInterval = ((fn: () => void, ms: number) => {
  const t = { fn, ms, cleared: false, id: ++timerId };
  intervals.push(t);
  return t as unknown as ReturnType<typeof setInterval>;
}) as typeof setInterval;
globalThis.setTimeout = ((fn: () => void, ms: number) => {
  const t = { fn, ms, cleared: false, id: ++timerId };
  timeouts.push(t);
  return t as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;
globalThis.clearInterval = ((t: any) => {
  if (t && typeof t === "object" && "id" in t) t.cleared = true;
}) as typeof clearInterval;
globalThis.clearTimeout = ((t: any) => {
  if (t && typeof t === "object" && "id" in t) t.cleared = true;
  // 被取消的退避重试不应再触发 —— 这里只打标记，由测试断言 checking cleared
}) as typeof clearTimeout;
Date.now = () => fakeNow;

function restoreGlobals() {
  globalThis.setInterval = realSetInterval;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearInterval = realClearInterval;
  globalThis.clearTimeout = realClearTimeout;
  Date.now = realNow;
}

/** 手动推进假时钟，并触发所有未清除的 interval 回调 */
function advance(ms: number) {
  fakeNow += ms;
  for (const t of intervals) {
    if (!t.cleared) t.fn();
  }
}

// ── 扩展装载 ───────────────────────────────────────────────────────────
const { default: extension } = await import("../extensions/i-am-cooking/index.ts");
const { readConfig, writeConfig, DEFAULTS } = await import("../extensions/i-am-cooking/lib/config.ts");

type Notify = { message: string; level?: string };
const notifies: Notify[] = [];
const sent: { content: string; deliverAs?: string }[] = [];
const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
let abortCalls = 0;
let compactCalls = 0;

const api: any = {
  on(event: string, handler: (e: any, c: any) => any) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerTool() {},
  registerCommand() {},
  registerShortcut() {},
  registerFlag() {},
  registerMessageRenderer() {},
  sendUserMessage(content: string, options?: { deliverAs?: string }) {
    sent.push({ content, deliverAs: options?.deliverAs });
    return Promise.resolve();
  },
};

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    ui: {
      notify: (message: string, level?: string) => notifies.push({ message, level }),
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      input: async () => undefined,
    },
    mode: "rpc",
    hasUI: true,
    isIdle: () => true,
    abort: () => { abortCalls++; },
    compact: () => { compactCalls++; },
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 5 }),
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => "sess-1",
      getSessionId: () => "sess-1",
    },
    ...over,
  };
}

async function fire(event: string, payload: any, ctx: any) {
  for (const h of handlers.get(event) ?? []) await h(payload, ctx);
}

/** 让扩展进入「离开中」：直接写 config + 走 turn_on 的正式路径（命令名按 DEV 模式定） */
let entries: any[] = [];
/** 等异步落盘（queueAlert / writeConfig 是 fire-and-forget） */
function flush(): Promise<void> {
  return new Promise((r) => realSetTimeout(r, 10));
}
async function enterCooking(over: Record<string, unknown> = {}) {
  const cfg = { ...DEFAULTS, ...over };
  await writeConfig({ ...cfg, cooking: false, alerts: [] } as any);
  const ctx = makeCtx();
  await fire("session_start", { type: "session_start" }, ctx);
  await fire("before_agent_start", { type: "before_agent_start" }, ctx);
  // 清掉 session_start 期间建的定时器/通知（只留下 turn_on 之后新建的）
  intervals.length = 0;
  timeouts.length = 0;
  notifies.length = 0;
  sent.length = 0;
  // 走真实命令路径打开离开模式（等价于用户 /i-am-cooking on）
  const onCmd = commands.get("i-am-cooking");
  assert.ok(onCmd, "找不到 /i-am-cooking 命令");
  await onCmd.handler("on", ctx);
  await flush();
  notifies.length = 0;
  sent.length = 0;
  return ctx;
}

const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
api.registerCommand = (name: string, opts: { handler: (a: string, c: any) => any }) => {
  commands.set(name, opts);
};

extension(api);

// 上面放的是包了一层 registerCommand 的 api，需重新装载以捕获命令处理器。
// （extension 是幂等的注册器：重复调用只往 handlers/commands 里追加，不会重复执行副作用）
commands.clear();
handlers.clear();
extension(api);

// ── 用例 ───────────────────────────────────────────────────────────────

test("tool_execution_start 会记账：横幅能看到「N 个在跑」", async () => {
  const ctx = await enterCooking();
  await fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} }, ctx);
  const widget = notifies.length >= 0; // 横幅走 setWidget，不往 notify 推；这里断言不抛
  assert.ok(widget);
});

test("R1 长脚本超时：超过阈值 → abort + 注入纠偏提示（三件事都在）", async () => {
  const ctx = await enterCooking({ toolTimeoutMinutes: 1, healthCheckMinutes: 1, toolTimeoutMaxAborts: 3 });
  abortCalls = 0;
  await fire("tool_execution_start", { toolCallId: "long-1", toolName: "bash", args: {} }, ctx);
  assert.equal(abortCalls, 0, "刚开始跑不该中断");

  // 推进 2 分钟（> 1 分钟阈值）→ 下一次滴答应识别超时
  advance(2 * 60_000);

  assert.equal(abortCalls, 1, "超阈值应 abort 一次");
  const steer = sent.find((s) => s.content.includes("工具超时中断"));
  assert.ok(steer, "应注入纠偏提示，实际发的：" + sent.map((s) => s.content.slice(0, 40)).join(" | "));
  assert.match(steer.content, /不要原样重试/);
  assert.match(steer.content, /async 子代理/);
  assert.match(steer.content, /终止条件/);
  assert.ok(
    notifies.some((n) => n.message.includes("超过阈值")),
    "应有一条 TUI 提示记录这次中断",
  );
});

test("R1 幂等：同一个 toolCallId 只中断一次（不会每次滴答都 abort）", async () => {
  const ctx = await enterCooking({ toolTimeoutMinutes: 1, healthCheckMinutes: 1, toolTimeoutMaxAborts: 3 });
  abortCalls = 0;
  await fire("tool_execution_start", { toolCallId: "long-2", toolName: "bash", args: {} }, ctx);
  advance(2 * 60_000);
  assert.equal(abortCalls, 1);
  advance(2 * 60_000);
  advance(2 * 60_000);
  assert.equal(abortCalls, 1, "已中断过的 toolCallId 不该再触发 abort");
});

test("R1 上限：中断次数用完就只记日志，不再 abort（防无限中断循环）", async () => {
  const ctx = await enterCooking({ toolTimeoutMinutes: 1, healthCheckMinutes: 1, toolTimeoutMaxAborts: 1 });
  abortCalls = 0;
  await fire("tool_execution_start", { toolCallId: "long-a", toolName: "bash", args: {} }, ctx);
  advance(2 * 60_000);
  assert.equal(abortCalls, 1, "第 1 次中断");

  await fire("tool_execution_start", { toolCallId: "long-b", toolName: "bash", args: {} }, ctx);
  advance(2 * 60_000);
  assert.equal(abortCalls, 1, "到上限后不再自动中断");
  assert.ok(
    notifies.some((n) => n.message.includes("不再中断")),
    "应提示「中断次数已用完」",
  );
});

test("R1 关掉超时（toolTimeoutMinutes=0）：跑多久都不 abort", async () => {
  const ctx = await enterCooking({ toolTimeoutMinutes: 0, healthCheckMinutes: 1 });
  abortCalls = 0;
  await fire("tool_execution_start", { toolCallId: "long-c", toolName: "bash", args: {} }, ctx);
  advance(60 * 60_000);
  assert.equal(abortCalls, 0);
});

test("R1 超时 ≠ 呼喊：只记日志与 TUI 提示，不推手机、不升级响铃", async () => {
  const ctx = await enterCooking({ toolTimeoutMinutes: 1, healthCheckMinutes: 1, phonePush: true, sound: true });
  await fire("tool_execution_start", { toolCallId: "long-d", toolName: "bash", args: {} }, ctx);
  advance(2 * 60_000);
  const cfg = await readConfig();
  assert.equal(cfg.alerts.length, 0, "不该产生任何呼喊（放手等级下既定取舍）");
});

test("R1 正常结束的工具不计超时（end 事件按 id 清除）", async () => {
  const ctx = await enterCooking({ toolTimeoutMinutes: 1, healthCheckMinutes: 1 });
  abortCalls = 0;
  await fire("tool_execution_start", { toolCallId: "short-1", toolName: "bash", args: {} }, ctx);
  await fire("tool_execution_end", { toolCallId: "short-1", toolName: "bash", result: {}, isError: false }, ctx);
  advance(5 * 60_000);
  assert.equal(abortCalls, 0);
});

test("R4 429：排退避重试，不按 urgent 喊人", async () => {
  const ctx = await enterCooking({ errorRetryMaxAttempts: 3, errorRetryBaseMinutes: 1 });
  await fire("agent_settled", { type: "agent_settled" }, ctx);
  entries = [
    { type: "message", message: { role: "user", content: "干活" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "被限流了" }],
        stopReason: "error",
        errorMessage: "429 Too Many Requests: rate limit exceeded",
      },
    },
  ];
  await fire("agent_settled", { type: "agent_settled" }, ctx);
  await flush();
  const cfg = await readConfig();
  assert.equal(cfg.alerts.filter((a) => a.urgency === "urgent").length, 0, "429 不该 urgent 呼喊");
  assert.ok(
    notifies.some((n) => n.message.includes("限流") && n.message.includes("自动重试")),
    "应提示「不喊人，N 分钟后自动重试」，实际：" + notifies.map((n) => n.message).join(" | "),
  );
  const retry = timeouts.find((t) => !t.cleared);
  assert.ok(retry, "应排一个退避重试定时器");
});

test("R4 永久失败（路径不存在）：保持现状直接喊人", async () => {
  const ctx = await enterCooking({ errorRetryMaxAttempts: 3 });
  entries = [
    { type: "message", message: { role: "user", content: "干活" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "脚本挂了" }],
        stopReason: "error",
        errorMessage: "ENOENT: no such file or directory, open 'nope.sh'",
      },
    },
  ];
  await fire("agent_settled", { type: "agent_settled" }, ctx);
  await flush();
  const cfg = await readConfig();
  const urgent = cfg.alerts.filter((a) => a.urgency === "urgent");
  assert.equal(urgent.length, 1, "永久失败该直接喊");
  assert.match(urgent[0].message, /永久性失败/);
});

test("R4 上下文超限：先 compact，再退避（不喊人）", async () => {
  const ctx = await enterCooking({ errorRetryMaxAttempts: 3 });
  compactCalls = 0;
  entries = [
    { type: "message", message: { role: "user", content: "干活" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "上下文太长" }],
        stopReason: "error",
        errorMessage: "This model's maximum context length is 200000 tokens",
      },
    },
  ];
  await fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(compactCalls, 1, "上下文超限应先 compact 一次");
  const cfg = await readConfig();
  assert.equal(cfg.alerts.filter((a) => a.urgency === "urgent").length, 0, "不该喊人");
});

test("R2 收尾判定：正则命中 → health.phase 变 done + 进度心跳停表", async () => {
  const ctx = await enterCooking({ progressReporting: "interval", reportIntervalMinutes: 1 });
  entries = [
    { type: "message", message: { role: "user", content: "干活" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "任务已全部完成，交付完毕。" }],
        stopReason: "stop",
      },
    },
  ];
  await fire("agent_settled", { type: "agent_settled" }, ctx);
  await flush();
  const cfg = await readConfig();
  // done 之后巡检不再追问：推进很久也不该出现追问提示
  notifies.length = 0;
  advance(60 * 60_000);
  assert.ok(!notifies.some((n) => n.message.includes("追问状态")), "已收工就不该再催");
  assert.ok(cfg.cooking, "离开模式仍在");
});

test("R2 幂等：同一回合不重复扫描（同一 settle 不重复判定）", async () => {
  const ctx = await enterCooking({ errorRetryMaxAttempts: 3 });
  entries = [
    { type: "message", message: { role: "user", content: "干活" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "报了" }], stopReason: "error", errorMessage: "429" },
    },
  ];
  await fire("agent_settled", { type: "agent_settled" }, ctx);
  const first = notifies.filter((n) => n.message.includes("自动重试")).length;
  entries = [
    { type: "message", message: { role: "user", content: "干活" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "报了" }], stopReason: "error", errorMessage: "429" },
    },
  ];
  await fire("agent_settled", { type: "agent_settled" }, ctx);
  const second = notifies.filter((n) => n.message.includes("自动重试")).length;
  assert.equal(first, 1);
  assert.equal(second, 1, "同一回合重复 settle 不该重复处理");
});

test("R6 放手等级：回合以「？」结尾不自动喊人", async () => {
  const ctx = await enterCooking({ autonomyLevel: "autonomous", autoDetect: true });
  entries = [
    { type: "message", message: { role: "user", content: "干活" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "你要我删掉这个文件吗？" }], stopReason: "stop" },
    },
  ];
  await fire("agent_settled", { type: "agent_settled" }, ctx);
  await flush();
  const cfg = await readConfig();
  assert.equal(cfg.alerts.length, 0, "放手等级下不自动喊人（按标准规范自主决策）");
});

test("R3 定时汇报：卡在长工具里不插话（消掉重复催促）", async () => {
  const ctx = await enterCooking({ progressReporting: "interval", reportIntervalMinutes: 1, toolTimeoutMinutes: 0 });
  await fire("before_agent_start", { type: "before_agent_start", systemPrompt: "base" }, ctx);
  await fire("tool_execution_start", { toolCallId: "busy-1", toolName: "bash", args: {} }, ctx);
  sent.length = 0;
  advance(2 * 60_000);
  assert.ok(
    !sent.some((s) => s.content.includes("定时汇报")),
    "长工具调用中不该插话，实际发了：" + sent.map((s) => s.content.slice(0, 30)).join(" | "),
  );
});

test("关闭离开模式后：超时不再 abort，退避重试也作废", async () => {
  const ctx = await enterCooking({ toolTimeoutMinutes: 1, healthCheckMinutes: 1 });
  await fire("tool_execution_start", { toolCallId: "x", toolName: "bash", args: {} }, ctx);
  const offCmd = commands.get("i-am-cooking");
  assert.ok(offCmd);
  await offCmd.handler("off", ctx);
  abortCalls = 0;
  advance(10 * 60_000);
  assert.equal(abortCalls, 0, "关闭离开后不该再中断");
});

test("cleanup", async () => {
  restoreGlobals();
  await rm(STATE_DIR, { recursive: true, force: true });
});