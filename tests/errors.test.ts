// 异常分类与退避测试（L 表 429 / 上下文超限 / 永久失败三类）
// 目标：429 不再触发 urgent 呼喊；上下文超限先 compact；永久失败保持直接喊。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMs,
  buildRetrySteer,
  classifyTurnError,
  describeErrorKind,
  extractStatusCode,
  isRetryable,
  shouldCompactFirst,
  shouldEscalate,
} from "../extensions/i-am-cooking/lib/errors.ts";

// ── 状态码提取 ─────────────────────────────────────────────────────────

test("extractStatusCode：常见写法都能抠出来", () => {
  assert.equal(extractStatusCode("429 Too Many Requests"), 429);
  assert.equal(extractStatusCode("Error: rate limit (429)"), 429);
  assert.equal(extractStatusCode("HTTP 503 Service Unavailable"), 503);
  assert.equal(extractStatusCode("status: 502"), 502);
  assert.equal(extractStatusCode('{"code": 429}'), 429);
});

test("extractStatusCode：不是错误码的数字不误命中（行号 / 端口 / 时间戳）", () => {
  assert.equal(extractStatusCode("line 1234: unexpected token"), undefined);
  assert.equal(extractStatusCode("listening on :8080"), undefined);
  assert.equal(extractStatusCode("took 3500 ms"), undefined);
  assert.equal(extractStatusCode(undefined), undefined);
});

// ── 五类判定 ───────────────────────────────────────────────────────────

test("429 → rate-limit（退避重试，不喊人）", () => {
  assert.equal(classifyTurnError({ errorMessage: "429 Too Many Requests" }), "rate-limit");
  assert.equal(classifyTurnError({ errorMessage: "Rate limit reached for requests" }), "rate-limit");
  assert.equal(classifyTurnError({ errorMessage: "quota exceeded for this billing period" }), "rate-limit");
  assert.equal(classifyTurnError({ statusCode: 429 }), "rate-limit");
});

test("上下文超限 → context-overflow（先 compact 再重试）", () => {
  assert.equal(
    classifyTurnError({ errorMessage: "This model's maximum context length is 128000 tokens" }),
    "context-overflow",
  );
  assert.equal(classifyTurnError({ errorMessage: "prompt is too long: 200000 tokens" }), "context-overflow");
  assert.equal(classifyTurnError({ errorMessage: "context_length_exceeded" }), "context-overflow");
  assert.equal(classifyTurnError({ statusCode: 413 }), "context-overflow");
});

test("5xx / 网络抖动 → transient（退避重试）", () => {
  assert.equal(classifyTurnError({ errorMessage: "503 Service Unavailable" }), "transient");
  assert.equal(classifyTurnError({ errorMessage: "fetch failed: ECONNRESET" }), "transient");
  assert.equal(classifyTurnError({ errorMessage: "socket hang up" }), "transient");
  assert.equal(classifyTurnError({ statusCode: 502 }), "transient");
  assert.equal(classifyTurnError({ statusCode: 408 }), "transient");
});

test("永久失败 → permanent（直接喊，现状不变）", () => {
  assert.equal(classifyTurnError({ errorMessage: "ENOENT: no such file or directory" }), "permanent");
  assert.equal(classifyTurnError({ errorMessage: "SyntaxError: Unexpected token }" }), "permanent");
  assert.equal(classifyTurnError({ errorMessage: "Cannot find module 'foo'" }), "permanent");
  assert.equal(classifyTurnError({ statusCode: 401 }), "permanent");
  assert.equal(classifyTurnError({ statusCode: 400 }), "permanent");
});

test("都认不出 → unknown（宁可误喊，不可漏喊）", () => {
  assert.equal(classifyTurnError({}), "unknown");
  assert.equal(classifyTurnError({ errorMessage: "something weird happened" }), "unknown");
});

test("状态码优先于错误文本：429 文案里带 not found 也按限流处理", () => {
  assert.equal(
    classifyTurnError({ errorMessage: "429: model not found in this region" }),
    "rate-limit",
  );
});

test("上下文占用 ≥95% 且文本无信息 → 判为 context-overflow", () => {
  assert.equal(classifyTurnError({ errorMessage: "Error", contextPercent: 99 }), "context-overflow");
  assert.equal(classifyTurnError({ errorMessage: "Error", contextPercent: 40 }), "unknown");
});

// ── 处置策略 ───────────────────────────────────────────────────────────

test("isRetryable：限流/暂时/超限可重试，永久与未知不重试", () => {
  assert.equal(isRetryable("rate-limit"), true);
  assert.equal(isRetryable("transient"), true);
  assert.equal(isRetryable("context-overflow"), true);
  assert.equal(isRetryable("permanent"), false);
  assert.equal(isRetryable("unknown"), false);
});

test("shouldCompactFirst 只对上下文超限为真", () => {
  assert.equal(shouldCompactFirst("context-overflow"), true);
  assert.equal(shouldCompactFirst("rate-limit"), false);
  assert.equal(shouldCompactFirst("transient"), false);
});

test("backoffMs：指数退避，首次是 base，逐次翻倍，封顶 cap", () => {
  const base = 60_000;
  const cap = 600_000;
  assert.equal(backoffMs(1, base, cap), 60_000);      // 1 分钟
  assert.equal(backoffMs(2, base, cap), 120_000);     // 2 分钟
  assert.equal(backoffMs(3, base, cap), 240_000);     // 4 分钟
  assert.equal(backoffMs(4, base, cap), 480_000);     // 8 分钟
  assert.equal(backoffMs(5, base, cap), 600_000);     // 封顶 10 分钟
  assert.equal(backoffMs(99, base, cap), 600_000);    // 不会溢出到 Infinity
  assert.equal(backoffMs(0, base, cap), 60_000, "0/负数按第 1 次算");
});

test("shouldEscalate：可重试的到上限才升级，不可重试立刻升级", () => {
  // 429：重试 3 次（attempt 0/1/2）都还在重试，第 3 次失败（attempt=3）才升级
  assert.equal(shouldEscalate("rate-limit", 0, 3), false);
  assert.equal(shouldEscalate("rate-limit", 2, 3), false);
  assert.equal(shouldEscalate("rate-limit", 3, 3), true);
  // 永久失败立刻升级
  assert.equal(shouldEscalate("permanent", 0, 3), true);
  assert.equal(shouldEscalate("unknown", 0, 3), true);
  // maxAttempts = 0 → 关掉重试，回到旧行为（立刻喊）
  assert.equal(shouldEscalate("rate-limit", 0, 0), true);
});

test("describeErrorKind：五类都有中文标签（用来拼呼喊文案）", () => {
  for (const k of ["rate-limit", "context-overflow", "transient", "permanent", "unknown"] as const) {
    assert.ok(describeErrorKind(k).length > 0);
  }
});

// ── 重试文案 ───────────────────────────────────────────────────────────

test("buildRetrySteer：429 说明是 provider 限流、放慢节奏、不要原样重放", () => {
  const msg = buildRetrySteer({ kind: "rate-limit", attempt: 1, maxAttempts: 3, retryInMs: 60_000 });
  assert.match(msg, /API 限流/);
  assert.match(msg, /1\/3/);
  assert.match(msg, /1 分钟后会自动重试/);
  assert.match(msg, /不要原样重放/);
});

test("buildRetrySteer：上下文超限提示已 compact、不要凭记忆重做", () => {
  const msg = buildRetrySteer({
    kind: "context-overflow",
    attempt: 2,
    maxAttempts: 3,
    retryInMs: 120_000,
    compacted: true,
  });
  assert.match(msg, /上下文超限/);
  assert.match(msg, /本次已触发 compact/);
  assert.match(msg, /不要凭记忆重做/);
});

test("buildRetrySteer：带上最后一句 + R6 暂停/继续语义", () => {
  const msg = buildRetrySteer({
    kind: "transient",
    attempt: 1,
    maxAttempts: 3,
    retryInMs: 60_000,
    lastText: "正在跑测试套件",
  });
  assert.match(msg, /正在跑测试套件/);
  assert.match(msg, /已完成的部分不要重做/);
  assert.match(msg, /其他不依赖本次失败的工作照常推进/);
});