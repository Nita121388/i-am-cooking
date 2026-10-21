// 配置模型测试：默认值 / 读取深合并 / 缺失兜底 / 写后读回
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULTS, readConfig, resolveStateDir, writeConfig } from "../extensions/i-am-cooking/lib/config.ts";
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