// 工具执行计时测试：TODO-1 长脚本死锁修复的纯逻辑层
// 关键场景：脚本永不结束 → end 事件永不到来 → 必须靠计时识别超时，否则巡检永远跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildToolTimeoutSteer,
  clearToolWatch,
  endToolWatch,
  formatRunningTools,
  newToolWatch,
  overdueTools,
  runningToolCount,
  startToolWatch,
} from "../extensions/i-am-cooking/lib/tool-watch.ts";

const SEC = 1_000;
const MIN = 60_000;

test("startToolWatch 记录 toolCallId / toolName / 起始时间", () => {
  const w = newToolWatch();
  startToolWatch(w, "call-1", "bash", 1_000);
  assert.equal(w.size, 1);
  assert.deepEqual(w.get("call-1"), { toolCallId: "call-1", toolName: "bash", startedAt: 1_000 });
  assert.equal(runningToolCount(w), 1);
});

test("endToolWatch 按 id 清除，返回被清除的那笔；重复 end 不报错", () => {
  const w = newToolWatch();
  startToolWatch(w, "call-1", "bash", 1_000);
  const removed = endToolWatch(w, "call-1");
  assert.equal(removed?.toolName, "bash");
  assert.equal(w.size, 0);
  // 幂等：end 两次（内部重试 / 事件重复）不该炸也不该变负
  assert.equal(endToolWatch(w, "call-1"), undefined);
  assert.equal(runningToolCount(w), 0);
});

test("同一工具并发多次：按 toolCallId 分别记账，不能用 toolName 当 key", () => {
  const w = newToolWatch();
  startToolWatch(w, "call-a", "bash", 0);
  startToolWatch(w, "call-b", "bash", 30 * SEC);
  assert.equal(runningToolCount(w), 2);
  endToolWatch(w, "call-a");
  assert.equal(runningToolCount(w), 1, "结束一个不该把另一个也算掉");
  assert.equal(w.get("call-b")?.startedAt, 30 * SEC);
});

test("overdueTools：未到阈值不报，到了就报；按起始时间升序", () => {
  const w = newToolWatch();
  startToolWatch(w, "old", "bash", 0);
  startToolWatch(w, "new", "bash", 5 * MIN);
  // 阈值 10 分钟，now=9 分钟 → 都没到
  assert.deepEqual(overdueTools(w, 9 * MIN, 10 * MIN), []);
  // now=11 分钟 → 只有 old 超时
  assert.deepEqual(overdueTools(w, 11 * MIN, 10 * MIN).map((t) => t.toolCallId), ["old"]);
  // now=16 分钟 → 两个都超时，先跑的先返回
  assert.deepEqual(overdueTools(w, 16 * MIN, 10 * MIN).map((t) => t.toolCallId), ["old", "new"]);
});

test("overdueTools：limitMs <= 0 表示关闭超时判定（配置项 0 = off）", () => {
  const w = newToolWatch();
  startToolWatch(w, "call-1", "bash", 0);
  assert.deepEqual(overdueTools(w, 999 * MIN, 0), []);
  assert.deepEqual(overdueTools(w, 999 * MIN, -1), []);
});

test("overdueTools：skip 集合里的 id 不再报（保证一个长脚本只 abort 一次）", () => {
  const w = newToolWatch();
  startToolWatch(w, "call-1", "bash", 0);
  const skip = new Set(["call-1"]);
  assert.deepEqual(overdueTools(w, 60 * MIN, 10 * MIN, skip), []);
  assert.equal(overdueTools(w, 60 * MIN, 10 * MIN).length, 1, "不传 skip 时仍会被识别");
});

test("边界：正好等于阈值就算超时（>=），避免差 1ms 永远不触发", () => {
  const w = newToolWatch();
  startToolWatch(w, "call-1", "bash", 0);
  assert.equal(overdueTools(w, 10 * MIN, 10 * MIN).length, 1);
  assert.equal(overdueTools(w, 10 * MIN - 1, 10 * MIN).length, 0);
});

test("clearToolWatch 清空（新会话/off 时重置）", () => {
  const w = newToolWatch();
  startToolWatch(w, "a", "bash", 0);
  startToolWatch(w, "b", "grep", 0);
  clearToolWatch(w);
  assert.equal(runningToolCount(w), 0);
});

test("纠偏提示必须讲清三件事：已中断 / 交 async 子代理 / 自查终止条件", () => {
  const msg = buildToolTimeoutSteer({
    toolName: "bash",
    elapsedMs: 12 * MIN,
    limitMs: 10 * MIN,
    abortCount: 1,
    maxAborts: 3,
  });
  // ① 已中断，不要原样重试
  assert.match(msg, /已经连续执行了 12 分钟/);
  assert.match(msg, /已把它中断/);
  assert.match(msg, /不要原样重试/);
  // ② 耗时操作交 async 子代理，带 async + timeoutMs
  assert.match(msg, /async 子代理/);
  assert.match(msg, /async: true/);
  assert.match(msg, /timeoutMs/);
  // ③ 自查终止条件
  assert.match(msg, /终止条件/);
  assert.match(msg, /永远跑不完/);
  // R6 暂停/继续语义
  assert.match(msg, /已完成的部分不要重做/);
});

test("纠偏提示：中断次数用完时明确警告「不会再自动中断」", () => {
  const msg = buildToolTimeoutSteer({
    toolName: "bash",
    elapsedMs: 15 * MIN,
    limitMs: 10 * MIN,
    abortCount: 3,
    maxAborts: 3,
  });
  assert.match(msg, /已因工具超时中断 3 次/);
  assert.match(msg, /不会再自动中断/);
  assert.match(msg, /必须换做法/);
});

test("纠偏提示：未到上限时不该出现「不会再中断」的警告", () => {
  const msg = buildToolTimeoutSteer({
    toolName: "bash",
    elapsedMs: 11 * MIN,
    limitMs: 10 * MIN,
    abortCount: 1,
    maxAborts: 3,
  });
  assert.doesNotMatch(msg, /不会再自动中断/);
});

test("formatRunningTools：空表返回空串（横幅不显示多余分隔符）", () => {
  assert.equal(formatRunningTools(newToolWatch(), 0), "");
});

test("formatRunningTools：显示数量、工具名、最久那个跑了多久", () => {
  const w = newToolWatch();
  startToolWatch(w, "a", "bash", 0);
  startToolWatch(w, "b", "bash", 5 * MIN);
  startToolWatch(w, "c", "grep", 7 * MIN);
  const label = formatRunningTools(w, 12 * MIN);
  assert.match(label, /3 个在跑/);
  assert.match(label, /bash\/grep/, "同名工具去重后再拼");
  assert.match(label, /最久已 12 分钟/, "最久 = 12 分钟前那个（now - 0）");
});