// 配置模型测试：默认值 / 读取深合并 / 缺失兜底 / 写后读回
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULTS, isDevMode, readConfig, resolveStateDir, writeConfig } from "../extensions/i-am-cooking/lib/config.ts";
import type { Config } from "../extensions/i-am-cooking/lib/config.ts";

const dirs: string[] = [];
async function freshConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cook-config-"));
  dirs.push(dir);
  return join(dir, "config.json");
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

test("DEFAULTS 是完整 Config（含渠道/行为全部字段）", () => {
  const c: Config = { ...DEFAULTS };
  assert.equal(c.cooking, false);
  assert.equal(c.beeps, 4);
  assert.equal(c.shoutPhrase, "agent 需要你");
  assert.equal(c.autonomyLevel, "balanced");
  assert.deepEqual(c.alerts, []);
});

test("文件不存在 → 返回默认并落盘", async () => {
  const p = await freshConfigPath();
  const cfg = await readConfig(p);
  assert.deepEqual(cfg, { ...DEFAULTS, alerts: [] });
  const raw = await readFile(p, "utf8");
  assert.ok(raw.includes('"shoutPhrase"'));
});

test("已有文件 → 深合并（部分字段覆盖，其余保持默认）", async () => {
  const p = await freshConfigPath();
  await writeConfig({ ...DEFAULTS, beeps: 9, shoutPhrase: "厨房见" }, p);
  const cfg = await readConfig(p);
  assert.equal(cfg.beeps, 9);
  assert.equal(cfg.shoutPhrase, "厨房见");
  assert.equal(cfg.tts, true); // 未覆盖字段用默认
});

test("alerts 缺失时兜底为空数组", async () => {
  const p = await freshConfigPath();
  await writeConfig({ ...DEFAULTS, alerts: undefined as never } as Config, p);
  const cfg = await readConfig(p);
  assert.deepEqual(cfg.alerts, []);
});

test("损坏的 config.json **不会被默认值覆盖**（多 Agent 共享时不能被洗掉）", async () => {
  const p = await freshConfigPath();
  // 模拟「另一个进程写到一半」的半截 JSON
  await writeFile(p, '{"cooking": true, "alerts": [', "utf8");
  const cfg = await readConfig(p);
  assert.equal(cfg.cooking, false, "解析失败时给内存默认值");
  // 关键：文件内容必须原样保留，不能被写回默认值 —— 否则别的会话的状态就没了
  const raw = await readFile(p, "utf8");
  assert.equal(raw, '{"cooking": true, "alerts": [', "损坏文件不该被静默覆盖");
});

test("并发写同一份 config：不会互相截断，最后一次一定完整可读", async () => {
  const p = await freshConfigPath();
  // 20 个 fire-and-forget 写入同时排队（真实场景：多个 Agent 会话同时写）
  const writes = Array.from({ length: 20 }, (_, i) =>
    writeConfig({ ...DEFAULTS, beeps: i + 1, shoutPhrase: `第${i + 1}次` }, p),
  );
  await Promise.all(writes);
  const cfg = await readConfig(p);
  assert.equal(cfg.shoutPhrase, "第20次", "最后排队的写入应生效");
  assert.equal(cfg.beeps, 20);
  // 文件必须是完整 JSON（没有残留的半截文件）
  const raw = await readFile(p, "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
});

test("原子写：不会在目标路径留下 .tmp 残片", async () => {
  const p = await freshConfigPath();
  await writeConfig({ ...DEFAULTS, beeps: 7 }, p);
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(join(p, ".."));
  assert.ok(!files.some((f) => f.includes(".tmp-")), "临时文件应被 rename 掉，实际：" + files.join(","));
});

// ── 状态目录隔离：dev / release / 多实例各用一份 ──
test("resolveStateDir：未设 I_AM_COOKING_HOME 时维持历史默认路径", () => {
  const home = "/home/u";
  assert.equal(resolveStateDir({}, home), join("/home/u", ".pi", "i-am-cooking"));
  assert.equal(resolveStateDir({ I_AM_COOKING_HOME: "   " }, home), join(home, ".pi", "i-am-cooking"));
});

test("resolveStateDir：I_AM_COOKING_HOME 覆盖为独立目录", () => {
  assert.equal(resolveStateDir({ I_AM_COOKING_HOME: "/tmp/iac-dev" }, "/home/u"), resolve("/tmp/iac-dev"));
  // 相对路径也解析成绝对路径，不依赖 cwd 之外的偶合
  assert.ok(resolveStateDir({ I_AM_COOKING_HOME: "iac-dev" }, "/home/u").endsWith("iac-dev"));
});

test("resolveStateDir：~ 展开到 home，不误用真实 homedir", () => {
  assert.equal(resolveStateDir({ I_AM_COOKING_HOME: "~/.pi/iac-dev" }, "/home/u"), resolve("/home/u/.pi/iac-dev"));
});
// ── 构建身份：dev / release 必须能一眼分开 ──
test("isDevMode：只有明确的真值才进 DEV", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
    assert.equal(isDevMode({ I_AM_COOKING_DEV: v }), true, `"${v}" 应判定为 DEV`);
  }
  for (const v of [undefined, "", "  ", "0", "false", "no", "off", "dev"]) {
    assert.equal(isDevMode({ I_AM_COOKING_DEV: v }), false, `"${v}" 不应判定为 DEV`);
  }
});
