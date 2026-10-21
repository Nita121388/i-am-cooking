// 收尾判定（TODO-2）测试：判官提示词 / 结论解析 / 何时才值得起判官 / 命令模板渲染
// 核心安全要求：解析必须宽容但**含糊一律当 UNKNOWN**，宁可多问一轮也不要错标完成。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEndJudgePrompt,
  parseEndJudgeVerdict,
  renderEndJudgeCommand,
  shouldUseEndJudge,
} from "../extensions/i-am-cooking/lib/end-judge.ts";

// ── 提示词 ─────────────────────────────────────────────────────────────

test("判官提示词：包含三种结论约定 + 用户最后一句话", () => {
  const p = buildEndJudgePrompt("已完成 X，正在做 Y。");
  assert.match(p, /DONE/);
  assert.match(p, /NOT_DONE/);
  assert.match(p, /UNKNOWN/);
  assert.match(p, /已完成 X，正在做 Y。/);
  assert.match(p, /只输出一个词/, "必须压住判官的自由发挥，才好在本地解析");
});

test("判官提示词：超长文本截断（不把整段上下文塞给判官）", () => {
  const long = "啊".repeat(5000);
  const p = buildEndJudgePrompt(long);
  assert.ok(p.length < 1800, `提示词不该超过约 1.8k 字符，实际 ${p.length}`);
  assert.match(p, /…/);
});

test("判官提示词：空白压缩（多行总结压成一行，省 token）", () => {
  const p = buildEndJudgePrompt("第一行\n\n第二行   第三行");
  assert.match(p, /第一行 第二行 第三行/);
});

// ── 结论解析 ───────────────────────────────────────────────────────────

test("解析：干净输出", () => {
  assert.equal(parseEndJudgeVerdict("DONE"), "done");
  assert.equal(parseEndJudgeVerdict("NOT_DONE"), "not-done");
  assert.equal(parseEndJudgeVerdict("UNKNOWN"), "unknown");
});

test("解析：NOT_DONE 里包含 DONE，必须先判 not-done 再判 done（顺序陷阱）", () => {
  assert.equal(parseEndJudgeVerdict("NOT_DONE"), "not-done");
  assert.equal(parseEndJudgeVerdict("NOT DONE"), "not-done");
  assert.equal(parseEndJudgeVerdict("not-done"), "not-done");
  // 带解释时也只看结论
  assert.equal(parseEndJudgeVerdict("NOT_DONE\n因为它还在等用户确认"), "not-done");
});

test("解析：宽容格式（markdown / 标点 / 大小写 / 前置客套）", () => {
  assert.equal(parseEndJudgeVerdict("**DONE**"), "done");
  assert.equal(parseEndJudgeVerdict("`DONE`"), "done");
  assert.equal(parseEndJudgeVerdict("Done."), "done");
  assert.equal(parseEndJudgeVerdict("结论：DONE"), "done");
  assert.equal(parseEndJudgeVerdict("Verdict: not_done"), "not-done");
  assert.equal(parseEndJudgeVerdict("好的，DONE"), "done");
});

test("解析：空输出 / 无结论 / 中文 → unknown（绝不猜「完成」）", () => {
  assert.equal(parseEndJudgeVerdict(undefined), "unknown");
  assert.equal(parseEndJudgeVerdict(""), "unknown");
  assert.equal(parseEndJudgeVerdict("   \n\n  "), "unknown");
  assert.equal(parseEndJudgeVerdict("这个我看不出来"), "unknown");
});

test("解析：只看前 5 个非空行（后面长解释里的词不该翻案）", () => {
  const out = ["客套一句", "", "DONE", "补充", "补充", "补充", "NOT_DONE"];
  assert.equal(parseEndJudgeVerdict(out.join("\n")), "done");
});

// ── 何时起判官 ─────────────────────────────────────────────────────────

const base = {
  mode: "cli" as const,
  command: "opencode run '{prompt}'",
  regexSaidDone: false,
  text: "这一轮把三个文件都改完了，等你回来看。",
};

test("shouldUseEndJudge：正则漏判 + cli 模式 + 有命令 + 有实质文本 → 才起", () => {
  assert.equal(shouldUseEndJudge(base), true);
});

test("shouldUseEndJudge：正则已经说是收尾 → 不白花一次调用", () => {
  assert.equal(shouldUseEndJudge({ ...base, regexSaidDone: true }), false);
});

test("shouldUseEndJudge：off 模式 / 空命令 / 最后还在干活 → 都不起", () => {
  assert.equal(shouldUseEndJudge({ ...base, mode: "off" }), false);
  assert.equal(shouldUseEndJudge({ ...base, command: "   " }), false);
  assert.equal(shouldUseEndJudge({ ...base, trailingWork: true }), false);
});

test("shouldUseEndJudge：空文本或太短（「好的」「收到」）没有判断信息 → 不起", () => {
  assert.equal(shouldUseEndJudge({ ...base, text: "" }), false);
  assert.equal(shouldUseEndJudge({ ...base, text: "好的" }), false);
  assert.equal(shouldUseEndJudge({ ...base, text: "  收到！  " }), false);
});

// ── 命令模板渲染 ───────────────────────────────────────────────────────

test("renderEndJudgeCommand：替换 {prompt} / {text} 占位符", () => {
  assert.equal(renderEndJudgeCommand("judge '{prompt}'", "hello"), "judge 'hello'");
  assert.equal(renderEndJudgeCommand("judge '{text}'", "hi"), "judge 'hi'");
  // 没有占位符就原样返回（比如固定命令）
  assert.equal(renderEndJudgeCommand("judge fixed", "x"), "judge fixed");
});

test("renderEndJudgeCommand：单引号转义（判官文本里的引号不能把 shell 命令打断）", () => {
  const out = renderEndJudgeCommand("judge '{prompt}'", "it's fine");
  assert.equal(out, "judge 'it'\\''s fine'");
});

test("renderEndJudgeCommand：空模板返回空串（调用方据此跳过）", () => {
  assert.equal(renderEndJudgeCommand("", "x"), "");
  assert.equal(renderEndJudgeCommand("   ", "x"), "");
});