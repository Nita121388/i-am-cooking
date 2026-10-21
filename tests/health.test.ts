// 健康巡检测试：状态机迁移 / 滴答判定 / 催问上限 / 文案
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyHealthDecision,
  buildHealthPrompt,
  buildStallAlert,
  decideHealthTick,
  formatIdle,
  markRealWork,
  markUserInput,
  newHealthState,
  setPhase,
  shouldSkipReportTick,
  touchActivity,
} from "../extensions/i-am-cooking/lib/health.ts";
import type { HealthState, HealthTickProbe } from "../extensions/i-am-cooking/lib/health.ts";

const MIN = 60_000;

function probe(over: Partial<HealthTickProbe> = {}): HealthTickProbe {
  return {
    cooking: true,
    enabled: true,
    now: 1_000 * MIN,
    agentBusy: false,
    runningTools: 0,
    activeSubagents: 0,
    pendingMessages: false,
    blockingAlerts: 0,
    idleMinutes: 10,
    maxNudges: 5,
    muteEscalation: false,
    ...over,
  };
}

/** 造一个「已空闲 N 分钟」的 working 状态 */
function idleState(idleMin: number, nudges = 0): HealthState {
  const now = 1_000 * MIN;
  return { ...newHealthState(now - idleMin * MIN), nudges };
}

// ── 基础状态机 ─────────────────────────────────────────────────────────

test("newHealthState 默认 working 且不计催问", () => {
  const s = newHealthState(123);
  assert.equal(s.phase, "working");
  assert.equal(s.nudges, 0);
  assert.equal(s.idleSince, 123);
});

test("touchActivity 刷新空闲起点但不清催问计数（防自问自答死循环）", () => {
  const s = idleState(20, 3);
  const before = s.idleSince;
  touchActivity(s, 2_000 * MIN);
  assert.equal(s.idleSince, 2_000 * MIN);
  assert.notEqual(s.idleSince, before);
  assert.equal(s.nudges, 3, "自己注入的巡检消息触发回合，不能把计数清零");
});

test("markUserInput：done → working（需求③：会话里继续 = 重新追问）", () => {
  const s = newHealthState(0);
  setPhase(s, "done", 100);
  markUserInput(s, 500);
  assert.equal(s.phase, "working");
  assert.equal(s.nudges, 0);
  assert.equal(s.idleSince, 500);
  assert.equal(s.note, undefined);
});

test("markUserInput：stalled → working", () => {
  const s = newHealthState(0);
  setPhase(s, "stalled", 100);
  markUserInput(s, 600);
  assert.equal(s.phase, "working");
});

test("markRealWork 保留 done（报完完成再补几句总结，别翻回 working）", () => {
  const s = newHealthState(0);
  setPhase(s, "done", 100);
  markRealWork(s, 900);
  assert.equal(s.phase, "done");
  assert.equal(s.idleSince, 900);
});

test("markRealWork：stalled → working（真实工具活动说明还活着）", () => {
  const s = newHealthState(0);
  setPhase(s, "stalled", 100);
  markRealWork(s, 1_000);
  assert.equal(s.phase, "working");
  assert.equal(s.nudges, 0);
});

test("touchActivity：stalled 下出现动静 → 回到 working 并清计数", () => {
  const s = newHealthState(0);
  setPhase(s, "stalled", 100);
  touchActivity(s, 300);
  assert.equal(s.phase, "working");
  assert.equal(s.nudges, 0);
});

// ── 滴答判定 ───────────────────────────────────────────────────────────

test("不在离开模式 / 巡检关闭 → skip", () => {
  const s = idleState(60);
  assert.deepEqual(decideHealthTick(s, probe({ cooking: false })), { action: "skip", reason: "not-cooking" });
  assert.deepEqual(decideHealthTick(s, probe({ enabled: false })), { action: "skip", reason: "disabled" });
});

test("阶段不是 working（done/waiting_user/stalled）→ skip，不再追问", () => {
  for (const phase of ["done", "waiting_user", "stalled"] as const) {
    const s = idleState(60);
    s.phase = phase;
    assert.deepEqual(decideHealthTick(s, probe()), { action: "skip", reason: "phase" });
  }
});

test("回合进行中 / 工具在跑 / 子代理在跑 → skip（还在干活）", () => {
  const s = idleState(60);
  assert.deepEqual(decideHealthTick(s, probe({ agentBusy: true })), { action: "skip", reason: "busy" });
  assert.deepEqual(decideHealthTick(s, probe({ runningTools: 1 })), { action: "skip", reason: "busy" });
  assert.deepEqual(decideHealthTick(s, probe({ activeSubagents: 2 })), { action: "skip", reason: "busy" });
});

test("有消息压在队列里 → skip（别堆重复催促）", () => {
  const s = idleState(60);
  assert.deepEqual(decideHealthTick(s, probe({ pendingMessages: true })), { action: "skip", reason: "queued" });
});

test("有未处理的阻塞呼喊 + 已空闲 → waiting（它在等我，不是卡死）", () => {
  const s = idleState(60);
  assert.deepEqual(decideHealthTick(s, probe({ blockingAlerts: 1 })), { action: "waiting" });
});

test("有阻塞呼喊但刚动过 → 先不静默（not-idle）", () => {
  const s = idleState(3);
  assert.deepEqual(decideHealthTick(s, probe({ blockingAlerts: 1 })), { action: "skip", reason: "not-idle" });
});

test("空闲不够久 → not-idle", () => {
  const s = idleState(3);
  assert.deepEqual(decideHealthTick(s, probe()), { action: "skip", reason: "not-idle" });
});

test("空闲够久且没在跑 → nudge 第 1 次", () => {
  const s = idleState(12);
  assert.deepEqual(decideHealthTick(s, probe()), { action: "nudge", nudge: 1 });
});

test("催问累计到上限（默认 5 次）→ escalate", () => {
  const s = idleState(12, 4);
  assert.deepEqual(decideHealthTick(s, probe()), { action: "nudge", nudge: 5 });
  const maxed = idleState(12, 5);
  assert.deepEqual(decideHealthTick(maxed, probe()), { action: "escalate" });
});

test("用户说了别喊（muteEscalation）→ 只催不升级，到 30 次上限后停止追问", () => {
  // 催到上限之前：一直 nudge，永不 escalate
  const s = idleState(12, 29);
  const d = decideHealthTick(s, probe({ muteEscalation: true }));
  assert.deepEqual(d, { action: "nudge", nudge: 30 });

  // 正好到上限：不升级喊人，而是 exhausted（尊重「别喊了」）
  const maxed = idleState(12, 30);
  assert.deepEqual(decideHealthTick(maxed, probe({ muteEscalation: true })), { action: "exhausted" });

  // 上限可配：不传 silenceMaxNudges 时默认 30
  const capped = idleState(12, 5);
  assert.equal(
    decideHealthTick(capped, probe({ muteEscalation: true, silenceMaxNudges: 5 })).action,
    "exhausted",
  );
  // 0 = 不限制（退回旧行为，用于测试/调试）
  assert.deepEqual(
    decideHealthTick(idleState(12, 999), probe({ muteEscalation: true, silenceMaxNudges: 0 })),
    { action: "nudge", nudge: 1000 },
  );
});

test("exhausted 之后不再追问：phase 不是 working 就直接 skip", () => {
  const s = idleState(12, 30);
  applyHealthDecision(s, { action: "exhausted" }, 3_000 * MIN);
  assert.equal(s.phase, "exhausted");
  assert.equal(s.escalatedAt, undefined, "不喊人，不该有升级时间戳");
  // 第 31 次及以后：返回 skip（phase 闸门），行为有明确断言
  assert.deepEqual(decideHealthTick(s, probe({ muteEscalation: true })), { action: "skip", reason: "phase" });
});

test("静默模式 exhausted 后用户开口 → 回 working、重新计数、继续催", () => {
  const s = idleState(60, 30);
  applyHealthDecision(s, { action: "exhausted" }, 1_100 * MIN);
  markUserInput(s, 2_000 * MIN);
  assert.equal(s.phase, "working");
  assert.equal(s.nudges, 0);
  assert.deepEqual(decideHealthTick(s, probe({ now: 2_011 * MIN, muteEscalation: true })), {
    action: "nudge",
    nudge: 1,
  });
});

// ── R3：统一的「忙」判定（reportTimer 与 healthTick 共用一份数）────────

test("shouldSkipReportTick：休息/长工具/队列有货都跳过，只有工作回合的空隙才发", () => {
  const base = { agentBusy: true, runningTools: 0, activeSubagents: 0, pendingMessages: false };
  assert.equal(shouldSkipReportTick(base), false, "工作回合 + 无长工具 + 队列干净 → 该发");
  assert.equal(shouldSkipReportTick({ ...base, agentBusy: false }), true, "回合已结束 → 无进度可报");
  assert.equal(shouldSkipReportTick({ ...base, runningTools: 1 }), true, "卡在长工具里 → 不插话（否则堆积）");
  assert.equal(shouldSkipReportTick({ ...base, pendingMessages: true }), true, "队列有货 → 不再压一条");
});

test("同一状态快照下 reportTimer 与 healthTick 对「忙」结论一致（消掉两套口径）", () => {
  const snap = { agentBusy: false, runningTools: 1, activeSubagents: 0, pendingMessages: false };
  // reportTimer 说「别插话」（因为 busy/长工具）→ 跳过
  assert.equal(shouldSkipReportTick(snap), true);
  // healthTick 也认为 busy → 跳过
  assert.deepEqual(
    decideHealthTick(idleState(60), probe({ runningTools: snap.runningTools, agentBusy: snap.agentBusy })),
    { action: "skip", reason: "busy" },
  );
});

// ── 判定落回状态 ───────────────────────────────────────────────────────

test("applyHealthDecision(nudge) 计数 +1 并给一个完整空闲窗口", () => {
  const s = idleState(30);
  applyHealthDecision(s, { action: "nudge", nudge: 2 }, 2_000 * MIN);
  assert.equal(s.nudges, 2);
  assert.equal(s.lastNudgeAt, 2_000 * MIN);
  assert.equal(s.idleSince, 2_000 * MIN, "给 agent 时间接话，下一轮从此刻重新计空闲");
});

test("applyHealthDecision(waiting) → waiting_user；escalate → stalled", () => {
  const a = idleState(30);
  applyHealthDecision(a, { action: "waiting" }, 0);
  assert.equal(a.phase, "waiting_user");

  const b = idleState(30);
  applyHealthDecision(b, { action: "escalate" }, 7);
  assert.equal(b.phase, "stalled");
  assert.equal(b.escalatedAt, 7);
});

test("完整闭环：催 5 次后升级喊人，然后静默；用户开口后重新开始", () => {
  const s = newHealthState(0);
  let now = 0;
  const steps: string[] = [];
  for (let i = 0; i < 8; i++) {
    now += 11 * MIN; // 每轮空闲 11 分钟
    const d = decideHealthTick(s, probe({ now }));
    steps.push(d.action);
    applyHealthDecision(s, d, now);
    if (d.action === "skip") s.idleSince = now; // 模拟它没接话（不刷新窗口）
  }
  // 前 5 次 nudge，第 6 次 escalate，之后全是 phase skip
  assert.deepEqual(steps.slice(0, 6), ["nudge", "nudge", "nudge", "nudge", "nudge", "escalate"]);
  assert.ok(steps.slice(6).every((a) => a === "skip"));
  assert.equal(s.phase, "stalled");

  markUserInput(s, now); // 用户开口
  assert.equal(s.phase, "working");
  assert.equal(decideHealthTick(s, probe({ now: now + 11 * MIN })).action, "nudge");
});

// ── 文案 ────────────────────────────────────────────────────────────────

test("formatIdle", () => {
  assert.equal(formatIdle(0), "0 秒");
  assert.equal(formatIdle(12_000), "12 秒");
  assert.equal(formatIdle(12 * MIN), "12 分钟");
  assert.equal(formatIdle(65 * MIN), "1 小时 5 分");
  assert.equal(formatIdle(120 * MIN), "2 小时");
});

test("buildHealthPrompt 包含三选一 + stopReason=error 特别提示", () => {
  const t = buildHealthPrompt({
    idleMinutes: 10,
    nudge: 2,
    maxNudges: 5,
    muteEscalation: false,
    lastStopReason: "error",
    lastText: "正在安装依赖然后报错中断",
  });
  assert.match(t, /\[健康巡检 #2\]/);
  assert.match(t, /set_task_state\(state="done"/);
  assert.match(t, /state="waiting_user"/);
  assert.match(t, /报错中断/);
  assert.match(t, /正在安装依赖/);
  assert.match(t, /共 5 次/);
});

test("buildHealthPrompt 在「别喊」模式下说明不会升级", () => {
  const t = buildHealthPrompt({
    idleMinutes: 10,
    nudge: 7,
    maxNudges: 5,
    muteEscalation: true,
  });
  assert.match(t, /不会升级为响铃/);
});

test("buildStallAlert 带上最后一句", () => {
  assert.match(buildStallAlert({ nudges: 5, idleMinutes: 10 }), /连续 5 次/);
  assert.match(
    buildStallAlert({ nudges: 5, idleMinutes: 10, lastText: "我在跑测试" }),
    /它最后说的话：「我在跑测试」/,
  );
});
