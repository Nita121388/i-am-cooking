// 可爱 Topic 名测试：格式 / 唯一性 / 组合空间
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestTopic, isValidTopic, TOPIC_ADJ, TOPIC_NOUN, TOPIC_COMBOS } from "../extensions/i-am-cooking/lib/topic.ts";

test("suggestTopic 生成格式正确", () => {
  for (let i = 0; i < 50; i++) {
    const t = suggestTopic();
    assert.ok(isValidTopic(t), `格式错误: ${t}`);
    assert.ok(t.startsWith("i-am-cooking-"), `前缀错误: ${t}`);
    assert.match(t, /-\d{6}$/, "应以 6 位数字结尾");
  }
});

test("生成的 topic 全局唯一（100 个无重复）", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const t = suggestTopic();
    assert.ok(!seen.has(t), `重复: ${t}`);
    seen.add(t);
  }
});

test("词池组合空间足够大", () => {
  assert.ok(TOPIC_ADJ.length >= 20, "形容词池应 ≥ 20");
  assert.ok(TOPIC_NOUN.length >= 20, "名词池应 ≥ 20");
  assert.ok(TOPIC_COMBOS >= 100_000_000, "组合空间应 ≥ 1 亿");
});

test("词池不含外来版权名（原创性）", () => {
  const banned = ["胡萝卜", "豌豆", "向日葵", "土豆", "坚果", "樱桃", "僵尸"];
  const all = [...TOPIC_ADJ, ...TOPIC_NOUN].join("");
  for (const b of banned) {
    assert.ok(!all.includes(b), `词池含疑似外来词: ${b}`);
  }
});
