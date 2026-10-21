// 子 Agent → 父 Agent 呼喊转达测试（跨进程文件的格式/解析/文案）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRelayAckText,
  buildRelayPrompt,
  dedupeRelayRequests,
  parseRelayRequests,
  relayFilePath,
  serializeRelayRequest,
} from "../extensions/i-am-cooking/lib/relay.ts";
import type { RelayRequest } from "../extensions/i-am-cooking/lib/relay.ts";

function req(over: Partial<RelayRequest> = {}): RelayRequest {
  return {
    id: "r1",
    ts: 1_000,
    from: "Zen 镜像",
    message: "需要你登录后台点一下",
    urgency: "normal",
    category: "decision",
    ...over,
  };
}

// ── 文件路径 ───────────────────────────────────────────────────────────

test("relayFilePath：按父会话 id 分文件，父会话只读自己那份", () => {
  assert.equal(relayFilePath("/tmp/relay", "session-abc"), "/tmp/relay/session-abc.jsonl");
  assert.equal(relayFilePath("/tmp/relay", "session-xyz"), "/tmp/relay/session-xyz.jsonl");
  assert.notEqual(
    relayFilePath("/tmp/relay", "session-abc"),
    relayFilePath("/tmp/relay", "session-xyz"),
    "不同父会话不能共用文件，否则 A 的呼喊会投给 B",
  );
});

test("relayFilePath：会话 id 里的路径分隔符/冒号压成安全 token（防目录穿越）", () => {
  assert.equal(
    relayFilePath("/tmp/relay", "/Users/nita/.pi/sessions/session-a:b.jsonl"),
    "/tmp/relay/Users-nita-.pi-sessions-session-a-b.jsonl",
  );
  assert.equal(relayFilePath("/tmp/relay", "../etc/passwd"), "/tmp/relay/..-etc-passwd.jsonl");
  assert.equal(relayFilePath("/tmp/relay", "///"), "/tmp/relay/unknown.jsonl");
});

// ── 序列化 / 解析 ──────────────────────────────────────────────────────

test("序列化 → 解析：往返一致", () => {
  const r = req({ ttsText: "叮咚，Zen 镜像找你" });
  const parsed = parseRelayRequests(serializeRelayRequest(r));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], r);
});

test("解析：多行 JSONL 各算一条", () => {
  const content = [serializeRelayRequest(req({ id: "a" })), serializeRelayRequest(req({ id: "b" }))].join("\n");
  assert.deepEqual(parseRelayRequests(content).map((r) => r.id), ["a", "b"]);
});

test("解析：坏行/半截 JSON 直接跳过，不让整批转达失败", () => {
  const content = [
    serializeRelayRequest(req({ id: "good-1" })),
    '{"id":"half","message":"写到一半被杀了', // 子 Agent 中途被杀
    "",
    "not json at all",
    serializeRelayRequest(req({ id: "good-2" })),
  ].join("\n");
  assert.deepEqual(parseRelayRequests(content).map((r) => r.id), ["good-1", "good-2"]);
});

test("解析：缺 id 或缺 message 的记录丢弃（不能凭空造一条呼喊）", () => {
  const content = [
    JSON.stringify({ message: "没 id" }),
    JSON.stringify({ id: "x" }),
    JSON.stringify({ id: "y", message: "   " }),
    serializeRelayRequest(req({ id: "ok" })),
  ].join("\n");
  assert.deepEqual(parseRelayRequests(content).map((r) => r.id), ["ok"]);
});

test("解析：urgency 非法值降级为 info（不能让坏数据触发紧急响铃）", () => {
  const content = JSON.stringify({ id: "a", message: "hi", urgency: "panic" });
  assert.equal(parseRelayRequests(content)[0].urgency, "info");
});

test("解析：超长 message / ttsText 截断（防把整份上下文塞进呼喊）", () => {
  const content = JSON.stringify({ id: "a", message: "x".repeat(20_000), ttsText: "y".repeat(5_000) });
  const r = parseRelayRequests(content)[0];
  assert.equal(r.message.length, 8_000);
  assert.equal(r.ttsText?.length, 2_000);
});

// ── 去重 ───────────────────────────────────────────────────────────────

test("dedupeRelayRequests：同一 id 只留一条（子 Agent 重复调用不会喊两遍）", () => {
  const list = [req({ id: "dup", ts: 2 }), req({ id: "dup", ts: 1 }), req({ id: "other", ts: 3 })];
  const out = dedupeRelayRequests(list);
  assert.deepEqual(out.map((r) => r.id), ["dup", "other"]);
});

test("dedupeRelayRequests：按时间升序（父 Agent 按发生顺序处理）", () => {
  const list = [req({ id: "c", ts: 300 }), req({ id: "a", ts: 100 }), req({ id: "b", ts: 200 })];
  assert.deepEqual(dedupeRelayRequests(list).map((r) => r.id), ["a", "b", "c"]);
});

// ── 父 Agent 转达提示 ──────────────────────────────────────────────────

test("buildRelayPrompt：写明是谁请求的、原文、以及「由你决定怎么处理」", () => {
  const p = buildRelayPrompt([req({ fromAgent: "zen-mirror" })], "主会话");
  assert.match(p, /子Agent 转达/);
  assert.match(p, /Zen 镜像/);
  assert.match(p, /agent: zen-mirror/);
  assert.match(p, /需要你登录后台点一下/);
  assert.match(p, /由你决定怎么处理/);
});

test("buildRelayPrompt：给出三种处置（真需要用户 → 你喊 / 能自己处理 → 别打扰 / 进度 → 合并成一条）", () => {
  const p = buildRelayPrompt([req()], "主会话");
  assert.match(p, /shout_for_user/);
  assert.match(p, /不要原样机械转发/);
  assert.match(p, /直接处理，不要打扰用户/);
  assert.match(p, /合并成一条/);
  assert.match(p, /主会话 转达/);
});

test("buildRelayPrompt：多条请求逐条列出并带序号", () => {
  const p = buildRelayPrompt([req({ id: "a", from: "A" }), req({ id: "b", from: "B" })], "主会话");
  assert.match(p, /2 条/);
  assert.match(p, /1\) 来自「A」/);
  assert.match(p, /2\) 来自「B」/);
});

// ── 子 Agent 回执 ──────────────────────────────────────────────────────

test("回执（成功）：明确告诉模型「真正响铃的是父 Agent，不是你」+ 不要重复提交", () => {
  const t = buildRelayAckText({ from: "Zen 镜像", queued: true, parentSessionId: "session-p" });
  assert.match(t, /已转达给父 Agent/);
  assert.match(t, /真正响铃的是父 Agent/);
  assert.match(t, /不要重复提交/);
  assert.match(t, /session-p/);
  assert.match(t, /写进你的最终结果/);
});

test("回执（失败）：明确说没转达，并给替代做法（写进最终结果）", () => {
  const t = buildRelayAckText({ from: "Zen 镜像", queued: false, reason: "找不到父会话 id" });
  assert.match(t, /未转达/);
  assert.match(t, /找不到父会话 id/);
  assert.match(t, /写进你的最终结果/);
  assert.match(t, /不能直接呼喊用户/);
});