// 手机推送通道测试：resolveValue / pushPhone（mock fetch） / pushWebhook（mock fetch）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { resolveValue, pushPhone, pushWebhook } from "../extensions/i-am-cooking/lib/push.ts";
import type { Alert, Config } from "../extensions/i-am-cooking/lib/config.ts";
import { DEFAULTS } from "../extensions/i-am-cooking/lib/config.ts";

// mock fetch：记录请求，返回固定 response
let fetchCalls: { url: string; opts: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

function setupFetchMock(): void {
  fetchCalls = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({ url: String(input), opts: init ?? {} });
    return new Response(null, { status: 200 });
  };
}
function teardownFetchMock(): void { globalThis.fetch = originalFetch; }
after(teardownFetchMock);

const fakeAlert: Alert = {
  id: "test-1",
  time: Date.now(),
  message: "测试消息",
  urgency: "normal",
  category: "test",
  repeatCount: 0,
  acked: false,
};

test("resolveValue 普通字符串原样返回", () => {
  assert.equal(resolveValue("hello"), "hello");
  assert.equal(resolveValue(""), "");
  assert.equal(resolveValue(null as never), "");
});

test("resolveValue 读取环境变量", () => {
  process.env._COOK_TEST_VAR = "secret";
  assert.equal(resolveValue("${_COOK_TEST_VAR}"), "secret");
  assert.equal(resolveValue("$_COOK_TEST_VAR"), "secret");
  // 带前缀后缀的字符串不整体替换（只识别纯占位符，避免误伤）
  assert.equal(resolveValue("prefix_${_COOK_TEST_VAR}_suffix"), "prefix_${_COOK_TEST_VAR}_suffix");
  delete process.env._COOK_TEST_VAR;
});

test("pushPhone 未配置 topic → false（不发请求）", async () => {
  setupFetchMock();
  const cfg: Config = { ...DEFAULTS, ntfyTopic: "" };
  const ok = await pushPhone(cfg, fakeAlert);
  assert.equal(ok, false);
  assert.equal(fetchCalls.length, 0);
  teardownFetchMock();
});

test("pushPhone 成功路径 → POST 到 server/topic，含 Authorization header", async () => {
  setupFetchMock();
  const cfg: Config = {
    ...DEFAULTS,
    ntfyTopic: "test-topic",
    ntfyServer: "https://ntfy.example.com",
    ntfyToken: "tok123",
  };
  const ok = await pushPhone(cfg, fakeAlert);
  assert.equal(ok, true);
  assert.equal(fetchCalls.length, 1);
  const [call] = fetchCalls;
  assert.equal(call.url, "https://ntfy.example.com/test-topic");
  assert.equal(call.opts.method, "POST");
  assert.equal((call.opts.headers as Record<string,string>).Authorization, "Bearer tok123");
  teardownFetchMock();
});

test("pushWebhook 未配置 URL → false（不发请求）", async () => {
  setupFetchMock();
  const cfg: Config = { ...DEFAULTS, webhookUrl: "" };
  const ok = await pushWebhook(cfg, fakeAlert);
  assert.equal(ok, false);
  assert.equal(fetchCalls.length, 0);
  teardownFetchMock();
});

test("pushWebhook 成功路径 → JSON body + token header", async () => {
  setupFetchMock();
  const cfg: Config = {
    ...DEFAULTS,
    webhookUrl: "https://api.day.app/abc123",
    webhookToken: "wh-token",
    webhookTokenHeader: "Authorization",
  };
  const ok = await pushWebhook(cfg, fakeAlert);
  assert.equal(ok, true);
  assert.equal(fetchCalls.length, 1);
  const [call] = fetchCalls;
  assert.equal(call.url, "https://api.day.app/abc123");
  const body = JSON.parse(String(call.opts.body));
  assert.equal(body.message, "测试消息");
  assert.equal(body.urgency, "normal");
  assert.equal((call.opts.headers as Record<string,string>).Authorization, "Bearer wh-token");
  teardownFetchMock();
});