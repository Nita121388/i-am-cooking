// 偏好/自主等级检测测试：文字匹配保险丝 + shouldSuppress 抑制逻辑 + 进度类判定
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectPreference,
  detectAutonomyLevel,
  isProgressCategory,
  shouldSuppress,
} from "../extensions/i-am-cooking/lib/prefs.ts";

test("detectPreference 中文场景", () => {
  assert.equal(detectPreference("别喊了"), "silence");
  assert.equal(detectPreference("安静一点"), "silence");
  assert.equal(detectPreference("完成后喊我"), "completion_only");
  assert.equal(detectPreference("干完叫我"), "completion_only");
  assert.equal(detectPreference("只有紧急才找我"), "urgent_only");
  assert.equal(detectPreference("随时汇报"), "eager");
  assert.equal(detectPreference("需要时再喊"), "normal");
  assert.equal(detectPreference("随便聊聊买菜"), null); // 无偏好词 → null
});

test("detectPreference 英文场景", () => {
  assert.equal(detectPreference("keep quiet"), "silence");
  assert.equal(detectPreference("notify me when done"), "completion_only");
  assert.equal(detectPreference("only when urgent"), "urgent_only");
  assert.equal(detectPreference("keep me posted"), "eager");
  assert.equal(detectPreference("back to normal"), "normal");
});

test("detectAutonomyLevel 中文场景", () => {
  assert.equal(detectAutonomyLevel("拿不准就问我"), "conservative");
  assert.equal(detectAutonomyLevel("遇墙就喊我"), "conservative");
  assert.equal(detectAutonomyLevel("有点难度才喊我"), "balanced");
  assert.equal(detectAutonomyLevel("恢复默认"), "balanced");
  assert.equal(detectAutonomyLevel("能不喊就不喊"), "autonomous");
  assert.equal(detectAutonomyLevel("你自主处理"), "autonomous");
  assert.equal(detectAutonomyLevel("去楼下拿快递"), null);
});

test("detectAutonomyLevel 英文场景", () => {
  assert.equal(detectAutonomyLevel("balanced"), "balanced");
  assert.equal(detectAutonomyLevel("back to normal"), "balanced");
});

test("shouldSuppress 按 callingMode 拦截", () => {
  const urgent = { category: "other", urgency: "urgent" as const };
  const completion = { category: "completion", urgency: "info" as const };
  const milestone = { category: "milestone", urgency: "info" as const };

  assert.equal(shouldSuppress("normal", urgent), false);
  assert.equal(shouldSuppress("silence", urgent), true);          // 全静音
  assert.equal(shouldSuppress("completion_only", urgent), true);  // 非完成不响
  assert.equal(shouldSuppress("completion_only", completion), false);
  assert.equal(shouldSuppress("urgent_only", completion), true);  // 非紧急不响
  assert.equal(shouldSuppress("urgent_only", urgent), false);
  assert.equal(shouldSuppress("eager", milestone), false);        // 全喊
});

test("isProgressCategory: progress/milestone 是进度类", () => {
  assert.equal(isProgressCategory("progress"), true);
  assert.equal(isProgressCategory("milestone"), true);
});

test("isProgressCategory: 其他分类不是进度类", () => {
  assert.equal(isProgressCategory("completion"), false);
  assert.equal(isProgressCategory("decision"), false);
  assert.equal(isProgressCategory("credential"), false);
  assert.equal(isProgressCategory("auto-error"), false);
  assert.equal(isProgressCategory(""), false);
});

test("shouldSuppress 对进度类：normal/eager 推手机，silence/completion_only/urgent_only 抑制", () => {
  const progress = { category: "progress", urgency: "info" as const };
  assert.equal(shouldSuppress("normal", progress), false);
  assert.equal(shouldSuppress("eager", progress), false);
  assert.equal(shouldSuppress("silence", progress), true);
  assert.equal(shouldSuppress("completion_only", progress), true);
  assert.equal(shouldSuppress("urgent_only", progress), true);
});