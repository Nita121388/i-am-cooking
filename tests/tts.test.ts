// TTS 文案渲染测试：shoutPhrase 占位 / 三层模板 / ttsText 优先
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTts } from "../extensions/i-am-cooking/lib/tts.ts";

const baseCfg = {
  ttsTemplate: "主人，快来！{shoutPhrase}！{message}",
  shoutPhrase: "agent 需要你",
  ttsTemplateCompletion: "主人，好消息！任务完成了！{message}",
  ttsTemplateMilestone: "小进展：{message}",
};

test("默认 shoutPhrase = agent 需要你", () => {
  const out = renderTts(baseCfg, { category: "other", message: "需要你决定 A 还是 B" });
  assert.equal(out, "主人，快来！agent 需要你！需要你决定 A 还是 B");
});

test("自定义 shoutPhrase 生效", () => {
  const out = renderTts({ ...baseCfg, shoutPhrase: "快来救我" }, { category: "other", message: "Y" });
  assert.equal(out, "主人，快来！快来救我！Y");
});

test("shoutPhrase 为空时回退默认", () => {
  const out = renderTts({ ...baseCfg, shoutPhrase: "" }, { category: "other", message: "X" });
  assert.equal(out, "主人，快来！agent 需要你！X");
});

test("completion 用完成模板", () => {
  const out = renderTts(baseCfg, { category: "completion", message: "全部完成" });
  assert.equal(out, "主人，好消息！任务完成了！全部完成");
});

test("milestone 用轻声模板", () => {
  const out = renderTts(baseCfg, { category: "milestone", message: "已下载 3/10" });
  assert.equal(out, "小进展：已下载 3/10");
});

test("ttsText 优先，不走模板", () => {
  const out = renderTts(baseCfg, { category: "other", message: "X", ttsText: "自由语音内容" });
  assert.equal(out, "自由语音内容");
});
