// 跨 Agent 状态广播测试：原子写 / 读 / 联动关闭判定条件
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeSharedState, readSharedState } from "../extensions/i-am-cooking/lib/state-sync.ts";

const dirs: string[] = [];
async function freshState(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cook-state-"));
  dirs.push(dir);
  return { dir, path: join(dir, "state.json") };
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

test("写 cooking=true 后可读回", async () => {
  const { dir, path } = await freshState();
  await writeSharedState(path, dir, true);
  const st = await readSharedState(path);
  assert.ok(st, "应能读到状态");
  assert.equal(st.cooking, true);
  assert.ok(st.since, "since 应存在");
  assert.ok(st.updatedAt > 0, "updatedAt 应存在");
});

test("写 cooking=false 后可读回（since 为空）", async () => {
  const { dir, path } = await freshState();
  await writeSharedState(path, dir, false);
  const st = await readSharedState(path);
  assert.ok(st);
  assert.equal(st.cooking, false);
  assert.equal(st.since, undefined);
});

test("覆盖写：true → false 生效且 updatedAt 更新", async () => {
  const { dir, path } = await freshState();
  await writeSharedState(path, dir, true);
  const t1 = (await readSharedState(path))!.updatedAt;
  await new Promise((r) => setTimeout(r, 10));
  await writeSharedState(path, dir, false);
  const st = await readSharedState(path);
  assert.equal(st!.cooking, false);
  assert.ok(st!.updatedAt >= t1, "updatedAt 应单调递增");
});

test("联动关闭判定条件：st.cooking=false 且 updatedAt > 本 Agent since", async () => {
  const { dir, path } = await freshState();
  // Agent A 开启
  await writeSharedState(path, dir, true);
  const aSince = (await readSharedState(path))!.since!;
  // Agent A 回来
  await new Promise((r) => setTimeout(r, 10));
  await writeSharedState(path, dir, false);
  const st = await readSharedState(path)! as any;
  // 判定（与 index.ts checkSharedState 一致）
  const shouldClose = !st.cooking && st.updatedAt > aSince;
  assert.equal(shouldClose, true, "其他 Agent 回来 → 应触发联动关闭");
});

test("文件不存在时 readSharedState 返回 null", async () => {
  const { dir, path } = await freshState();
  const st = await readSharedState(path);
  assert.equal(st, null);
});
