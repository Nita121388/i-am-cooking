// Agent 身份识别测试（多 Agent 场景：看出是谁在喊你 / 子 Agent 一律转达）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentTag,
  mustRelayViaParent,
  resolveAgentIdentity,
  sanitizeLabel,
  shortSessionLabel,
  tagMessage,
  ttsAgentPrefix,
} from "../extensions/i-am-cooking/lib/identity.ts";

// ── sanitizeLabel ──────────────────────────────────────────────────────

test("sanitizeLabel：换行/多余空白/引号压掉（横幅一行放得下）", () => {
  assert.equal(sanitizeLabel("trellis-implement:\n  修 R1\t超时"), "trellis-implement: 修 R1 超时");
  assert.equal(sanitizeLabel(`他说"别喊了"`), "他说别喊了");
  assert.equal(sanitizeLabel(undefined), "");
});

test("sanitizeLabel：超长截断加省略号，不超上限", () => {
  const s = sanitizeLabel("啊".repeat(80));
  assert.ok(s.length <= 40, `应截到 40 字符内，实际 ${s.length}`);
  assert.ok(s.endsWith("…"));
  // 自定义上限也要生效
  assert.equal(sanitizeLabel("abcdefghij", 5), "abcd…");
});

// ── shortSessionLabel ──────────────────────────────────────────────────

test("shortSessionLabel：会话文件路径 → 可读短码", () => {
  assert.equal(shortSessionLabel("session-3f7a9c2b1d.jsonl"), "3f7a9c2b");
  assert.equal(shortSessionLabel("session-abc"), "abc");
  assert.equal(shortSessionLabel(undefined), "");
  assert.equal(shortSessionLabel(""), "");
});

// ── 父会话身份 ─────────────────────────────────────────────────────────

test("父会话（无 PI_SUBAGENT_CHILD）：kind=parent，标签取会话名", () => {
  const id = resolveAgentIdentity({
    env: {},
    sessionName: "主会话 · R1 收尾",
    sessionId: "session-abc123",
  });
  assert.equal(id.kind, "parent");
  assert.equal(id.label, "主会话 · R1 收尾");
  assert.equal(mustRelayViaParent(id), false);
});

test("父会话：没会话名时退回会话 id 短码，再退回「主会话」", () => {
  assert.equal(resolveAgentIdentity({ env: {}, sessionId: "session-abc123" }).label, "abc123");
  assert.equal(resolveAgentIdentity({ env: {} }).label, "主会话");
});

test("父会话：agentAlias（配置）优先于会话名", () => {
  const id = resolveAgentIdentity({
    env: {},
    sessionName: "session-abc",
    sessionId: "session-abc",
  });
  // alias 在入口层拼进来，这里验证的是「非子进程时 sessionName 直接当标签」
  assert.equal(id.label, "session-abc");
});

// ── 子 Agent 身份 ──────────────────────────────────────────────────────

const CHILD_ENV = {
  PI_SUBAGENT_CHILD: "1",
  PI_SUBAGENT_CHILD_AGENT: "trellis-implement",
  PI_SUBAGENT_SESSION_NAME: "trellis-implement: 修长脚本超时",
  PI_SUBAGENT_PARENT_SESSION: "session-parent-xyz",
  PI_SUBAGENT_DEPTH: "1",
};

test("子 Agent：kind=subagent，拿得到 agent 名 / 父会话 id / 深度", () => {
  const id = resolveAgentIdentity({
    env: CHILD_ENV,
    sessionName: "trellis-implement: 修长脚本超时",
    sessionId: "session-child-1",
  });
  assert.equal(id.kind, "subagent");
  assert.equal(id.label, "trellis-implement: 修长脚本超时");
  assert.equal(id.agentName, "trellis-implement");
  assert.equal(id.parentSessionId, "session-parent-xyz");
  assert.equal(id.depth, 1);
  assert.equal(mustRelayViaParent(id), true);
});

test("子 Agent：会话名缺失时依次退回 env 名 → agent 名 → 会话 id 短码", () => {
  assert.equal(
    resolveAgentIdentity({ env: CHILD_ENV, sessionId: "session-child-1" }).label,
    "trellis-implement: 修长脚本超时",
    "PI_SUBAGENT_SESSION_NAME 兜底",
  );
  const { PI_SUBAGENT_SESSION_NAME: _drop, ...noName } = CHILD_ENV;
  assert.equal(resolveAgentIdentity({ env: noName, sessionId: "session-child-1" }).label, "trellis-implement");
  const { PI_SUBAGENT_CHILD_AGENT: _drop2, ...noAgent } = noName;
  assert.equal(resolveAgentIdentity({ env: noAgent, sessionId: "session-child-1" }).label, "child-1");
  assert.equal(resolveAgentIdentity({ env: noAgent }).label, "子Agent");
});

test("子 Agent：嵌套深度 >1 仍然判为子 Agent（孙会话也不许直接喊）", () => {
  const id = resolveAgentIdentity({ env: { ...CHILD_ENV, PI_SUBAGENT_DEPTH: "3" } });
  assert.equal(id.kind, "subagent");
  assert.equal(id.depth, 3);
  assert.equal(mustRelayViaParent(id), true);
});

test("子 Agent：PI_SUBAGENT_CHILD 非 \"1\" 一律当父会话（保守：认不出就不拦）", () => {
  for (const v of ["", "0", "true", "yes", undefined]) {
    const env = { ...CHILD_ENV, PI_SUBAGENT_CHILD: v } as Record<string, string>;
    assert.equal(resolveAgentIdentity({ env }).kind, "parent", `PI_SUBAGENT_CHILD=${v} 应视为父会话`);
  }
});

// ── 标签 / 文案 ────────────────────────────────────────────────────────

test("agentTag：父会话不带子Agent 标记，子会话明确标出", () => {
  assert.equal(agentTag(resolveAgentIdentity({ env: {}, sessionName: "主会话" })), "【主会话】");
  assert.equal(agentTag(resolveAgentIdentity({ env: CHILD_ENV })), "【trellis-implement: 修长脚本超时 · 子Agent】");
});

test("tagMessage：加标签 + 幂等（已带同一标签不重复加）", () => {
  const child = resolveAgentIdentity({ env: CHILD_ENV });
  const once = tagMessage(child, "需要你登录");
  assert.match(once, /^【.*子Agent】 需要你登录$/);
  assert.equal(tagMessage(child, once), once, "同一标签不该叠两层");
});

test("tagMessage：不同 Agent 的相同内容不会因为去重而合并", () => {
  const a = tagMessage(resolveAgentIdentity({ env: {}, sessionName: "会话A" }), "同一个问题");
  const b = tagMessage(resolveAgentIdentity({ env: {}, sessionName: "会话B" }), "同一个问题");
  assert.notEqual(a, b, "前缀不同 → 内容不同 → 不会被当成重复呼喊");
});

test("ttsAgentPrefix：口头先报是谁（厨房里听不出看的是哪个）", () => {
  assert.equal(ttsAgentPrefix(resolveAgentIdentity({ env: {}, sessionName: "主会话" })), "主会话，");
  assert.equal(ttsAgentPrefix(resolveAgentIdentity({ env: CHILD_ENV })), "trellis-implement: 修长脚本超时 子代理，");
});

test("mustRelayViaParent：没有 parentSessionId 时仍然拦截（转不出去也不让喊）", () => {
  const id = resolveAgentIdentity({ env: { PI_SUBAGENT_CHILD: "1" } });
  assert.equal(id.parentSessionId, undefined);
  assert.equal(mustRelayViaParent(id), true, "宁可让父 Agent 从结果里转，也不许喊到打不开的会话");
});