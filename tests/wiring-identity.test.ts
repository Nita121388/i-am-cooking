// 接线级：多 Agent 身份标签 + 子 Agent 呼喊转达（真跑入口的事件/工具，不真响铃）
//
// 验的是两条用户需求：
//   ① 呼喊要能看出是哪个 Agent 在喊（多 Agent 共存时）
//   ② 子 Agent 不许直接喊，必须交给父 Agent 转达
//
// 与 wiring.test.ts 同套路：捉住 setInterval、假 Date.now，状态目录指到临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE_DIR = await mkdtemp(join(tmpdir(), "iac-ident-"));
process.env.I_AM_COOKING_HOME = STATE_DIR;
process.env.I_AM_COOKING_DEV = "";
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_PARENT_SESSION;
delete process.env.PI_SUBAGENT_CHILD_AGENT;
delete process.env.PI_SUBAGENT_SESSION_NAME;

const realNow = Date.now;
let fakeNow = 1_000_000_000_000;
Date.now = () => fakeNow;

// 拦住 setInterval：turnOn 会起真实的进度心跳/巡检定时器（5/15 分钟），
// 不拦的话 node --test 进程永远不退出（实测卡死 40s+，子代理复核因此超时）。
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
// scheduleRepeats 对 normal 呼喊会挂一个真实的 3 分钟 setTimeout —— 同样会吊住事件循环
const fakeTimeouts: { cleared: boolean }[] = [];
globalThis.setTimeout = ((_fn: () => void, _ms: number) => {
  const t = { cleared: false };
  fakeTimeouts.push(t);
  return t as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;
// 注意：flush() 用的是真实 setImmediate，不受影响
globalThis.clearTimeout = ((t: any) => {
  if (t && typeof t === "object" && "cleared" in t) t.cleared = true;
}) as typeof clearTimeout;
const fakeIntervals: { cleared: boolean }[] = [];
globalThis.setInterval = ((_fn: () => void, _ms: number) => {
  const t = { cleared: false };
  fakeIntervals.push(t);
  return t as unknown as ReturnType<typeof setInterval>;
}) as typeof setInterval;
globalThis.clearInterval = ((t: any) => {
  if (t && typeof t === "object" && "cleared" in t) t.cleared = true;
}) as typeof clearInterval;

const { default: extension } = await import("../extensions/i-am-cooking/index.ts");
const { readConfig, writeConfig, DEFAULTS, TMP_DIR } = await import("../extensions/i-am-cooking/lib/config.ts");
const { relayFilePath } = await import("../extensions/i-am-cooking/lib/relay.ts");

type Notify = { message: string; level?: string };
const notifies: Notify[] = [];
const sent: { content: string; deliverAs?: string }[] = [];
const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
const tools = new Map<string, any>();

const api: any = {
  on(event: string, handler: (e: any, c: any) => any) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerTool(tool: any) { tools.set(tool.name, tool); },
  registerCommand() {},
  registerShortcut() {},
  registerFlag() {},
  registerMessageRenderer() {},
  getSessionName: () => currentSessionName,
  sendUserMessage(content: string, options?: { deliverAs?: string }) {
    sent.push({ content, deliverAs: options?.deliverAs });
    return Promise.resolve();
  },
};

let currentSessionName: string | undefined;
let currentSessionId = "session-parent-1";

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
    abort: () => {},
    compact: () => {},
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 1 }),
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => currentSessionId,
      getSessionId: () => currentSessionId,
    },
    ...over,
  };
}

async function fire(event: string, payload: any, ctx: any) {
  for (const h of handlers.get(event) ?? []) await h(payload, ctx);
}

/** 断言辅助：从呼喊列表里挑出必需的一条（找不到时给出可读失败信息） */
function mustFind<T>(list: T[], pred: (x: T) => boolean, what: string): T {
  const found = list.find(pred);
  assert.ok(found, `找不到${what}`);
  return found as T;
}

function flush(): Promise<void> {
  // queueAlert / pumpRelayQueue 都是 fire-and-forget，而且里面有 2-3 次真实文件 IO。
  // 单个 setImmediate 不够（实测转达消息还没投递就断言了），给足 40ms 真实时间。
  return new Promise((r) => realSetTimeout(r, 40));
}

/** 以「父会话」或「子 Agent」身份装载一次扩展（身份靠 env + 会话名决定）。
 *  `preserveConfig`：保留磁盘上已有的 config（用于验证子 Agent 启动不会洗掉父会话状态）。 */
async function bootAs(opts: {
  subagent?: { agent: string; name: string; parentSession: string };
  sessionName?: string;
  sessionId?: string;
  config?: Record<string, unknown>;
  preserveConfig?: boolean;
}) {
  // 重置 env
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_PARENT_SESSION;
  delete process.env.PI_SUBAGENT_CHILD_AGENT;
  delete process.env.PI_SUBAGENT_SESSION_NAME;
  if (opts.subagent) {
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_CHILD_AGENT = opts.subagent.agent;
    process.env.PI_SUBAGENT_SESSION_NAME = opts.subagent.name;
    process.env.PI_SUBAGENT_PARENT_SESSION = opts.subagent.parentSession;
  }
  currentSessionName = opts.sessionName;
  currentSessionId = opts.sessionId ?? "session-parent-1";

  handlers.clear();
  tools.clear();
  extension(api);

  const ctx = makeCtx();
  if (!opts.preserveConfig) {
    await writeConfig({ ...DEFAULTS, ...(opts.config ?? {}) } as any);
  }
  await fire("session_start", { type: "session_start" }, ctx);
  notifies.length = 0;
  sent.length = 0;
  return ctx;
}

/** 以父会话身份打开离开模式（走真实命令路径） */
async function onCooking(ctx: any) {
  const cmd = commands.get("i-am-cooking");
  assert.ok(cmd, "找不到 /i-am-cooking 命令");
  await cmd.handler("on", ctx);
  await flush();
  notifies.length = 0;
  sent.length = 0;
}

const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();

// 需要捕获命令处理器：先装一次专用的 registerCommand，再装正式的
const bootstrapApi: any = { ...api, registerCommand: (name: string, opts: any) => { commands.set(name, opts); } };
extension(bootstrapApi);

// ── ① 每条呼喊都带 Agent 标签 ─────────────────────────────────────────

test("父会话呼喊：message 前缀是本会话的标签", async () => {
  const ctx = await bootAs({ sessionName: "主会话A", sessionId: "session-a" });
  await onCooking(ctx);
  const res = await tools.get("shout_for_user").execute("c1", { message: "方案 A/B 你选哪个", urgency: "normal", category: "decision" }, undefined, undefined, ctx);
  await flush();
  const cfg = await readConfig();
  const alert = cfg.alerts.find((a) => a.category === "decision");
  assert.ok(alert, "应该有呼喊入队，实际：" + res.content[0].text);
  assert.match(alert.message, /^【主会话A】 方案 A\/B 你选哪个$/);
  assert.equal(alert.agent, "主会话A", "alert 要记下是谁发的");
});

test("两个不同会话喊同样内容：不会因为去重合并成一条（能分辨是两个 Agent 在喊）", async () => {
  const ctxA = await bootAs({ sessionName: "会话A", sessionId: "session-a" });
  await onCooking(ctxA);
  await tools.get("shout_for_user").execute("c1", { message: "需要你确认", urgency: "normal", category: "decision" }, undefined, undefined, ctxA);
  await flush();

  // A 喊完，磁盘上应有它的呼喊 + 独立离开状态
  const afterA = await readConfig();
  assert.equal(afterA.alerts.length, 1, "A 喊完磁盘上应有一条呼喊");
  assert.ok(afterA.cookingAgents?.["session-a"], "每个 Agent 的离开状态要按会话 id 分开存");

  // 另一个 Agent 进程启动（真实多 Agent 场景 = 多个 pi 进程共享一份 config）：
  // 它启动时读到 A 的待处理呼喊，不能洗掉；然后它自己也 on 一次并发呼喊。
  const ctxB = await bootAs({
    sessionName: "会话B",
    sessionId: "session-b",
    preserveConfig: true, // 保留 A 的离开状态与呼喊
  });
  await onCooking(ctxB); // 每个 Agent 独立 on（cookingAgents 按会话分）
  await tools.get("shout_for_user").execute("c2", { message: "需要你确认", urgency: "normal", category: "decision" }, undefined, undefined, ctxB);
  await flush();

  const cfg = await readConfig();
  const mine = cfg.alerts.filter((a) => a.category === "decision" && !a.acked);
  assert.equal(mine.length, 2, "两条呼喊都要在，且各自带自己的标签");
  assert.deepEqual(mine.map((a) => a.agent).sort(), ["会话A", "会话B"].sort());
});

test("TTS 也带 Agent 名（厨房里靠耳朵分辨是哪个 Agent）", async () => {
  const ctx = await bootAs({ sessionName: "调研助手", sessionId: "session-s" });
  await onCooking(ctx);
  await tools.get("shout_for_user").execute("c1", {
    message: "需要你授权",
    urgency: "normal",
    category: "approval",
    ttsText: "需要你点一下授权",
  }, undefined, undefined, ctx);
  await flush();
  const cfg = await readConfig();
  const alert = mustFind(cfg.alerts, (a) => a.category === "approval", "approval 呼喊");
  assert.equal(alert.ttsText, "调研助手，需要你点一下授权");
});

// ── ② 子 Agent 不许直接喊，必须转达 ────────────────────────────────────

test("子 Agent 调 shout_for_user：不入队、不响铃，而是写转达文件给父会话", async () => {
  const ctx = await bootAs({
    subagent: { agent: "zen-mirror", name: "Zen 镜像", parentSession: "session-root-9" },
    sessionId: "session-child-9",
    // 父会话已经开着离开模式：config 是共享的，子 Agent 读出来就是 true
    config: { cooking: true },
  });
  await fire("agent_start", { type: "agent_start" }, ctx);

  const res = await tools.get("shout_for_user").execute("c1", {
    message: "需要你在后台点一下登录",
    urgency: "normal",
    category: "credential",
  }, undefined, undefined, ctx);
  await flush();

  // ① 没有在本地入队（子 Agent 不响铃）
  const cfg = await readConfig();
  assert.equal(cfg.alerts.filter((a) => !a.acked && a.category === "credential").length, 0, "子 Agent 不该自己入队呼喊");

  // ② 写进了以父会话 id 命名的转达文件
  const path = relayFilePath(join(TMP_DIR, "relay"), "session-root-9");
  const raw = await readFile(path, "utf8");
  const reqs = raw.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].from, "Zen 镜像");
  assert.equal(reqs[0].fromAgent, "zen-mirror");
  assert.match(reqs[0].message, /需要你在后台点一下登录/);

  // ③ 回执明确告诉模型：真正喊人的是父 Agent，别重复提交
  const text = res.content[0].text;
  assert.match(text, /已转达给父 Agent/);
  assert.match(text, /真正响铃的是父 Agent/);
  assert.match(text, /不要重复提交/);
  assert.equal(res.details.fired, false);
});

test("子 Agent 自动触发类呼喊（报错/问号）也走转达，绝不自己响铃", async () => {
  const ctx = await bootAs({
    subagent: { agent: "zen-mirror", name: "Zen 镜像", parentSession: "session-root-8" },
    sessionId: "session-child-8",
    config: { cooking: true, errorRetryMaxAttempts: 0 }, // 关掉重试：直接走呼喊分支
  });
  void ctx;
  const ctx2 = makeCtx({
    sessionManager: {
      getEntries: () => [
        { type: "message", message: { role: "user", content: "干活" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "挂了" }], stopReason: "error", errorMessage: "boom" } },
      ],
      getSessionFile: () => "session-child-8",
      getSessionId: () => "session-child-8",
    },
  });
  await fire("agent_settled", { type: "agent_settled" }, ctx2);
  await flush();

  const cfg = await readConfig();
  assert.equal(cfg.alerts.length, 0, "子 Agent 的报错呼喊不该在本地入队");
  const raw = await readFile(relayFilePath(join(TMP_DIR, "relay"), "session-root-8"), "utf8");
  assert.match(raw, /回合报错|自动重试|zen-mirror|Zen 镜像/, "应转达给父会话：" + raw.slice(0, 200));
  void ctx;
});

test("子 Agent 不能开启/关闭离开模式（否则会把父会话的共享状态洗掉）", async () => {
  const ctx = await bootAs({
    subagent: { agent: "zen-mirror", name: "Zen 镜像", parentSession: "session-root-7" },
    sessionId: "session-child-7",
  });
  const cmd = commands.get("i-am-cooking");
  assert.ok(cmd);
  await cmd.handler("on", ctx);
  await flush();
  assert.ok(notifies.some((n) => /子 Agent/.test(n.message) && /不能开关离开模式/.test(n.message)));
  const cfg = await readConfig();
  assert.equal(cfg.cooking, false, "子 Agent 打开离开模式必须被拒绝");
});

test("子 Agent 启动不重置共享状态（不能把父会话的待处理呼喊洗掉）", async () => {
  // 先在共享 config 里造出父会话的离开状态 + 待处理呼喊
  await writeConfig({
    ...DEFAULTS,
    cooking: true,
    cookingAgents: { "session-root-6": { since: 1, label: "主会话" } },
    alerts: [{ id: "a1", time: 1, message: "【主会话】等你授权", urgency: "normal", category: "decision", repeatCount: 0, acked: false, agent: "主会话", agentKey: "session-root-6" }],
  } as any);

  await bootAs({
    subagent: { agent: "zen-mirror", name: "Zen 镜像", parentSession: "session-root-6" },
    sessionId: "session-child-6",
    preserveConfig: true, // 不能覆盖掉刚造的共享状态
  });
  await flush();

  const cfg = await readConfig();
  assert.equal(cfg.cooking, true, "子 Agent 启动不该关闭父会话的离开模式");
  assert.equal(cfg.alerts.length, 1, "子 Agent 启动不该清空父会话的待处理呼喊");
});

// ── 父 Agent 侧：取走转达并交给自己判断 ────────────────────────────────

test("父 Agent 收尾时会取走转达请求，并作为「由你决定是否喊」的消息投给自己", async () => {
  const ctx = await bootAs({ sessionName: "主会话", sessionId: "session-root-5" });
  await onCooking(ctx); // 必须真的在离开模式，pump 才会跑
  // 模拟子 Agent 写了请求
  const dir = join(TMP_DIR, "relay");
  await mkdir(dir, { recursive: true });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    relayFilePath(dir, "session-root-5"),
    JSON.stringify({ id: "z1", ts: Date.now(), from: "Zen 镜像", fromAgent: "zen-mirror", message: "后台登录过期了，需要你重新登", urgency: "normal", category: "credential" }) + "\n",
    "utf8",
  );

  await fire("agent_settled", { type: "agent_settled" }, ctx);
  await flush();

  const relayMsg = sent.find((s) => s.content.includes("子Agent 转达"));
  assert.ok(relayMsg, "应把转达请求投给父 Agent，实际发了：" + sent.map((s) => s.content.slice(0, 40)).join(" | "));
  assert.match(relayMsg.content, /Zen 镜像/);
  assert.match(relayMsg.content, /后台登录过期了/);
  assert.match(relayMsg.content, /由你决定怎么处理/);
  assert.equal(relayMsg.deliverAs, "followUp");
  assert.ok(notifies.some((n) => n.message.includes("收到 1 条子 Agent 呼喊转达")));

  // 取走后文件被清空 —— 同一请求不会转达两遍
  const again = await readFile(relayFilePath(dir, "session-root-5"), "utf8");
  assert.equal(again.trim(), "", "取走后应清空，防止重复转达");
});

test("父 Agent 不会取走别人的转达（按会话 id 分文件）", async () => {
  const ctx = await bootAs({ sessionName: "主会话", sessionId: "session-root-4" });
  await onCooking(ctx);
  const dir = join(TMP_DIR, "relay");
  await mkdir(dir, { recursive: true });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    relayFilePath(dir, "some-other-session"),
    JSON.stringify({ id: "x1", ts: 1, from: "别的会话的子Agent", message: "这条不该被拿走", urgency: "normal", category: "other" }) + "\n",
    "utf8",
  );

  await fire("agent_settled", { type: "agent_settled" }, ctx);
  await flush();

  assert.ok(!sent.some((s) => s.content.includes("这条不该被拿走")), "别人的转达不能被这个父会话取走");
  const still = await readFile(relayFilePath(dir, "some-other-session"), "utf8");
  assert.match(still, /这条不该被拿走/, "别人的请求文件必须原样保留");
});

test("/i-am-cooking agent <名字>：设置标签后呼喊前缀跟着变", async () => {
  const ctx = await bootAs({ sessionName: "自动名", sessionId: "session-named" });
  await onCooking(ctx);
  const cmd = commands.get("i-am-cooking");
  assert.ok(cmd);

  // 不带参数 = 只查看
  await cmd.handler("agent", ctx);
  assert.ok(notifies.some((n) => n.message.includes("本会话的呼喊标签")));

  // 设自定义名
  await cmd.handler("agent 审核助手", ctx);
  await flush();
  await tools.get("shout_for_user").execute("c1", { message: "请批准", urgency: "normal", category: "approval" }, undefined, undefined, ctx);
  await flush();
  const cfg = await readConfig();
  assert.equal(cfg.agentAlias, "审核助手");
  const alert = mustFind(cfg.alerts, (a) => a.category === "approval", "approval 呼喊");
  assert.match(alert.message, /^【审核助手】 请批准$/);

  // reset = 回到自动推断（会话名）
  await cmd.handler("agent reset", ctx);
  await flush();
  assert.equal((await readConfig()).agentAlias, "");
});

test("cleanup", async () => {
  Date.now = realNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  await rm(STATE_DIR, { recursive: true, force: true });
});