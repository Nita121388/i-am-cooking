// 跨 Agent 音频互斥锁测试：并发互斥 / 崩溃抢占 / force 抢占 / 删锁比对
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { acquireAudioLock, releaseAudioLock } from "../extensions/i-am-cooking/lib/audio-lock.ts";

// 每个测试用独立临时目录，避免锁残留互相干扰
const dirs: string[] = [];
async function freshLockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cook-lock-"));
  dirs.push(dir);
  return join(dir, "audio.lock");
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

test("第一次获取锁成功，第二次（同进程）失败", async () => {
  const lock = await freshLockPath();
  const ok1 = await acquireAudioLock(lock, false);
  const ok2 = await acquireAudioLock(lock, false);
  assert.equal(ok1, true, "第一次应拿到锁");
  assert.equal(ok2, false, "锁已存在时第二次应失败");
  await releaseAudioLock(lock);
  const ok3 = await acquireAudioLock(lock, false);
  assert.equal(ok3, true, "释放后应能再拿到");
});

test("force 抢占：已存在锁时 force 能拿到", async () => {
  const lock = await freshLockPath();
  await acquireAudioLock(lock, false);
  const ok = await acquireAudioLock(lock, true);
  assert.equal(ok, true, "force 应抢占成功");
  await releaseAudioLock(lock);
});

test("崩溃残留锁（pid 不存在）可被抢占", async () => {
  const lock = await freshLockPath();
  // 写入一个不存在的 pid 的锁（模拟崩溃残留）
  await writeFile(lock, JSON.stringify({ pid: 999_999_999, createdAt: Date.now() }), "utf8");
  const ok = await acquireAudioLock(lock, false);
  assert.equal(ok, true, "崩溃锁应被抢占");
  // 锁内容应更新为本进程 pid
  const raw = JSON.parse(await readFile(lock, "utf8"));
  assert.equal(raw.pid, process.pid);
  await releaseAudioLock(lock);
});

test("release 只删自己的锁（pid 不匹配不删）", async () => {
  const lock = await freshLockPath();
  // 别人的锁（pid 不存在）
  await writeFile(lock, JSON.stringify({ pid: 999_999_998, createdAt: Date.now() }), "utf8");
  await releaseAudioLock(lock); // 本进程 pid ≠ 锁 pid → 不应删除
  const exists = await readFile(lock, "utf8").then(() => true).catch(() => false);
  assert.equal(exists, true, "别人的锁不应被删");
});

test("跨进程互斥：两个进程并发，只有一个拿到锁", async () => {
  const lock = await freshLockPath();
  const script = `
    import { acquireAudioLock, releaseAudioLock } from ${JSON.stringify(new URL("../extensions/i-am-cooking/lib/audio-lock.ts", import.meta.url).href)};
    const ok = await acquireAudioLock(${JSON.stringify(lock)}, false);
    if (ok) { await new Promise(r => setTimeout(r, 500)); await releaseAudioLock(${JSON.stringify(lock)}); }
    process.stdout.write(ok ? "GOT" : "SKIP");
  `;
  const runChild = () => new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
  });
  const [a, b] = await Promise.all([runChild(), runChild()]);
  const gotCount = [a, b].filter((x) => x === "GOT").length;
  assert.equal(gotCount, 1, `应恰好一个进程拿到锁，实际: ${a}/${b}`);
});
