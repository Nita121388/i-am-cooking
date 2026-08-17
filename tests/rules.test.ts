// 规则加载测试：默认规则 / 缺失回退 / prompt 构成 / HTML 注释剥离
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTONOMY_GUIDE, GUARD_RAIL, buildRulesPrompt, loadDefaultRules, loadRules } from "../extensions/i-am-cooking/lib/rules.ts";
import { DEFAULT_RULES_PATH } from "../extensions/i-am-cooking/lib/config.ts";

const dirs: string[] = [];
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cook-rules-"));
  dirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

test("loadDefaultRules 返回非空规则（仓库内 rules.default.md）", async () => {
  const rules = await loadDefaultRules(DEFAULT_RULES_PATH);
  assert.ok(rules.length > 0);
  assert.ok(rules.includes("自主推进"));
});

test("loadRules 文件缺失 → 回退到默认规则", async () => {
  const dir = await freshDir();
  const rules = await loadRules(join(dir, "missing.md"));
  assert.ok(rules.length > 0);
});

test("loadRules 已有文件 → 原样返回（用户接管）", async () => {
  const dir = await freshDir();
  const p = join(dir, "rules.md");
  await writeFile(p, "  我的自定义规则  \n", "utf8");
  const rules = await loadRules(p);
  assert.equal(rules, "我的自定义规则");
});

test("buildRulesPrompt 包含等级指南与底线规则", async () => {
  const prompt = await buildRulesPrompt("autonomous");
  assert.ok(prompt.includes("放手（autonomous）"));
  assert.ok(prompt.includes(GUARD_RAIL));
  assert.ok(prompt.includes("IAM COOKING MODE"));
});

test("AUTONOMY_GUIDE 覆盖全部三个等级", () => {
  assert.ok(AUTONOMY_GUIDE.conservative.includes("谨慎"));
  assert.ok(AUTONOMY_GUIDE.balanced.includes("平衡"));
  assert.ok(AUTONOMY_GUIDE.autonomous.includes("放手"));
});

test("buildRulesPrompt 机制提示反映当前进度模式", async () => {
  const milestone = await buildRulesPrompt("balanced", "milestone");
  assert.ok(milestone.includes("当前进度汇报模式：小阶段（milestone）"));
  const interval = await buildRulesPrompt("balanced", "interval");
  assert.ok(interval.includes("当前进度汇报模式：定时（interval）"));
  const none = await buildRulesPrompt("balanced", "none");
  assert.ok(none.includes("当前进度汇报模式：关闭（none）"));
});