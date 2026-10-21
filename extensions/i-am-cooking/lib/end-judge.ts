/**
 * 回合收尾判定（health watch 的 TODO-2）。
 *
 * 问题：`agent_settled` 里只靠 `detectTaskFinale` 本仓库自制正则判断「任务是不是真结束了」。
 * 措辞一变（"交付完成""全部通过""无其他待办"…）就漏判 → 巡检仍判 working → 多催一轮。
 *
 * 办法：正则漏判时，把一个**独立会话**拿来当判官（用户批注：opencode 的 free 模型）。
 * 独立会话的好处是不占主会话上下文、不带 agent 的自我辩护倾向。
 *
 * 本模块只做两件纯事：生成判官提示词、解析判官结论。
 * 起子进程 / 超时 / 降级都在 index.ts，且**任何失败都降级为正则结论**，绝不阻塞。
 *
 * 约定判官输出：第一行只写一个词 DONE / NOT_DONE / UNKNOWN。
 * 解析是宽容的（去 markdown、去标点、大小写不敏感、只看前几行），
 * 但**含糊一律当 UNKNOWN**——宁可多问一轮，也不要错误地标记完成。
 */

export type EndVerdict = "done" | "not-done" | "unknown";

/** 交给独立判官的提示词（保持极短，省 token、省延迟） */
export function buildEndJudgePrompt(agentText: string): string {
  const text = agentText.replace(/\s+/g, " ").trim();
  const clipped = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  return [
    `你是任务状态判官。下面是一个 AI 编码助手在某个回合结束时说的最后一句话。`,
    `判断：这次对话里的**工作是不是已经全部结束**（用户交代的事都做完了、没有明确待办、没有在等用户回答的问题）。`,
    ``,
    `规则：`,
    `- 只是阶段性汇报、说"接下来我要做 X"、说要继续、说去做了但没结果 → NOT_DONE`,
    `- 在等用户确认 / 决策 / 提供凭据 → NOT_DONE`,
    `- 明确说了任务完成、交付完成、全部通过、没有其他待办、收工 → DONE`,
    `- 看不出来 → UNKNOWN`,
    ``,
    `只输出一个词：DONE 或 NOT_DONE 或 UNKNOWN。不要解释。`,
    ``,
    `--- 最后一句话 ---`,
    clipped,
  ].join("\n");
}

/**
 * 解析判官输出。
 * 顺序很重要：先判 NOT_DONE，再判 DONE —— "NOT_DONE" 里包含 "DONE"，反过来会误判。
 */
export function parseEndJudgeVerdict(output: string | undefined): EndVerdict {
  if (!output) return "unknown";
  // 只看前 5 个非空行：判官偶尔会先吐一句客套，但结论一定在前面
  const head = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(" ")
    .toLowerCase()
    .replace(/[*`"'“”‘’()（）[\]{}:：,，.。!！]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!head) return "unknown";
  if (/\bnot[\s_-]*done\b/.test(head) || /\bunfinished\b/.test(head) || /\b未完成\b/.test(head)) {
    return "not-done";
  }
  if (/\bdone\b/.test(head) || /\bcomplete[d]?\b/.test(head) || /\b已完成\b/.test(head)) {
    return "done";
  }
  if (/\bunknown\b/.test(head) || /\bunsure\b/.test(head) || /\b不确定\b/.test(head)) {
    return "unknown";
  }
  return "unknown";
}

/**
 * 该不该起独立判官？纯判定，便于测试。
 * 只在「正则漏判 + 用户显式开启了 cli 模式 + 有文本 + 有命令」时才起，
 * 避免每回合都白花一次模型调用。
 */
export function shouldUseEndJudge(input: {
  mode: "off" | "cli";
  command: string;
  regexSaidDone: boolean;
  text: string;
  /** 本回合是否已有真实工具活动后紧跟收尾（有的话说明是真干完了，交给正则） */
  trailingWork?: boolean;
}): boolean {
  if (input.mode !== "cli") return false;
  if (input.regexSaidDone) return false; // 正则已经说是收尾了，不需要判官
  if (input.trailingWork) return false; // 最后一步还在干活，谈不上收尾
  if (!input.command.trim()) return false;
  const text = input.text.trim();
  if (!text) return false;
  // 太短的话（"好的""收到"）不含判断信息，别浪费一次调用
  if (text.length < 12) return false;
  return true;
}

/** 把命令模板里的占位符替换掉（`{prompt}` / `{text}` 为提示词本身） */
export function renderEndJudgeCommand(template: string, prompt: string): string {
  if (!template.trim()) return "";
  return template.replace(/\{prompt\}|\{text\}/g, () =>
    // shell 单引号转义：' → '\''
    prompt.replace(/'/g, `'\\''`),
  );
}
