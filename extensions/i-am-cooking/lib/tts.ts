/**
 * TTS 文案渲染（纯逻辑，可测试）。
 * 三层消息模板 + {shoutPhrase} 占位 + ttsText 优先。
 */

export interface TtsConfig {
  ttsTemplate: string;
  ttsTemplateCompletion?: string;
  ttsTemplateMilestone?: string;
  shoutPhrase?: string;
}

export interface TtsAlert {
  message: string;
  category?: string;
  ttsText?: string;
}

/** 渲染呼喊的 TTS 文案：先替换 {shoutPhrase}，再替换 {message} */
export function renderTts(config: TtsConfig, alert: TtsAlert): string {
  // Agent 提供了自由语音 → 原样念，不走模板
  if (alert.ttsText) return alert.ttsText;
  const template =
    alert.category === "milestone"
      ? (config.ttsTemplateMilestone || "小进展：{message}")
      : alert.category === "completion"
        ? (config.ttsTemplateCompletion || "叮咚！好消息！任务完成了！{message}")
        : config.ttsTemplate;
  return template
    .replaceAll("{shoutPhrase}", config.shoutPhrase || "agent 需要你")
    .replaceAll("{message}", alert.message);
}
