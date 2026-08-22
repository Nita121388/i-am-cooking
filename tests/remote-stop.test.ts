// 远程停止服务测试：lanAddress / buildStopUrl / startRemoteStopServer（真实 HTTP，随机端口）
// 覆盖：token 校验（200/403）、路径 404、onStop 回调、close 幂等
import { test } from "node:test";
import assert from "node:assert/strict";
import { lanAddress, buildStopUrl, startRemoteStopServer, type RemoteStopHandle } from "../extensions/i-am-cooking/lib/remote-stop.ts";

test("lanAddress 返回字符串或 null，不抛异常", () => {
  const addr = lanAddress();
  assert.ok(addr === null || (typeof addr === "string" && addr.includes(".")));
});

test("buildStopUrl 含端口与 token；无内网地址时回退 localhost", () => {
  const url = buildStopUrl(12345, "abc");
  assert.ok(url.startsWith("http://"));
  assert.ok(url.endsWith(":12345/stop?token=abc"));
});

test("startRemoteStopServer：正确 token → 200 + onStop 执行", async () => {
  let called = 0;
  const srv: RemoteStopHandle = await startRemoteStopServer({ token: "tok", onStop: () => { called++; } });
  try {
    const res = await fetch(`${srv.url.replace("localhost", "127.0.0.1")}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "stopped");
    assert.equal(called, 1);
    assert.ok(srv.port > 0); // 系统分配了实际端口
    assert.ok(srv.url.includes(`:${srv.port}/stop?token=tok`));
  } finally {
    await srv.close();
  }
});

test("startRemoteStopServer：错误 token → 403，不执行 onStop", async () => {
  let called = 0;
  const srv = await startRemoteStopServer({ token: "tok", onStop: () => { called++; } });
  try {
    const host = new URL(srv.url).host;
    const res = await fetch(`http://${host}/stop?token=bad`);
    assert.equal(res.status, 403);
    assert.equal(called, 0);
  } finally {
    await srv.close();
  }
});

test("startRemoteStopServer：其他路径 → 404", async () => {
  const srv = await startRemoteStopServer({ token: "tok", onStop: () => {} });
  try {
    const host = new URL(srv.url).host;
    const res = await fetch(`http://${host}/other?token=tok`);
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test("close 后端口不再可达（连接被拒绝）", async () => {
  const srv = await startRemoteStopServer({ token: "tok", onStop: () => {} });
  const port = srv.port;
  await srv.close();
  await srv.close(); // 幂等：重复 close 不抛
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/stop?token=tok`, { signal: AbortSignal.timeout(2000) }),
  );
});
