/**
 * 工具执行计时（health watch 的 TODO-1 死锁修复）。
 *
 * 问题：`tool_execution_start` 让 `runningTools` 变成 1，而脚本永不结束时
 * `tool_execution_end` 永远不会来。健康巡检把 `runningTools > 0` 读作「它正在干活」，
 * 于是每次滴答都跳过 —— agent 真卡死了，巡检一次都不催。这不是「催得慢」，是「永远不催」。
 *
 * 办法：按 `toolCallId` 记下起始时间。单次工具执行超过阈值就判定超时，
 * 由入口调 `ctx.abort()` 中断整轮，再 steer 一条纠偏提示（见 buildToolTimeoutSteer）。
 *
 * 本模块只做纯计时与文案，不碰定时器 / ctx / 配置（那些在 index.ts）。
 */

export interface RunningTool {
  toolCallId: string;
  toolName: string;
  /** 起始时间（ms epoch） */
  startedAt: number;
}

/** 在飞工具表：key = toolCallId（同一工具可并发多次，不能用 toolName 做 key） */
export type ToolWatch = Map<string, RunningTool>;

export function newToolWatch(): ToolWatch {
  return new Map();
}

/** `tool_execution_start`：记一笔。同一 id 重复 start（内部重试）覆盖起始时间更接近现实 */
export function startToolWatch(
  watch: ToolWatch,
  toolCallId: string,
  toolName: string,
  now: number,
): void {
  watch.set(toolCallId, { toolCallId, toolName, startedAt: now });
}

/** `tool_execution_end`：按 id 清除，返回被清除的那笔（没有则 undefined） */
export function endToolWatch(watch: ToolWatch, toolCallId: string): RunningTool | undefined {
  const found = watch.get(toolCallId);
  if (found) watch.delete(toolCallId);
  return found;
}

/** 当前在飞工具数（替代独占的 runningTools 计数器，避免两套状态漂移） */
export function runningToolCount(watch: ToolWatch): number {
  return watch.size;
}

export function clearToolWatch(watch: ToolWatch): void {
  watch.clear();
}

/**
 * 找出已超时的工具（startedAt + limitMs <= now）。
 * `skip` 用于排除已中断过的 toolCallId，保证「一个长脚本只 abort 一次」。
 * 结果按起始时间升序（先跑的先处理，日志顺序符合直觉）。
 */
export function overdueTools(
  watch: ToolWatch,
  now: number,
  limitMs: number,
  skip?: ReadonlySet<string>,
): RunningTool[] {
  if (!(limitMs > 0)) return []; // 0/负数 = 关闭超时判定
  const out: RunningTool[] = [];
  for (const tool of watch.values()) {
    if (skip?.has(tool.toolCallId)) continue;
    if (now - tool.startedAt >= limitMs) out.push(tool);
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

export interface ToolTimeoutSteerOptions {
  toolName: string;
  /** 已经跑了多久（ms） */
  elapsedMs: number;
  /** 阈值（ms），用于文案里对比 */
  limitMs: number;
  /** 本会话第几次超时中断（从 1 开始） */
  abortCount: number;
  /** 达到这个次数后不再自动中断（0 = 不限制） */
  maxAborts: number;
}

/** 时长：90 秒 / 12 分钟 / 1 小时 5 分（与 health.formatIdle 同口径，独立实现避免循环依赖） */
function humanDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/**
 * 超时中断后的纠偏提示（steer）。必须讲清三件事，缺一件 agent 就会原样重试：
 *   ① 刚才那次执行已被中断，不要原样重试
 *   ② 耗时操作交给 async 子代理（async: true + timeoutMs），不要阻塞主会话
 *   ③ 长脚本先自查终止条件，确认它不是永远跑不完
 */
export function buildToolTimeoutSteer(o: ToolTimeoutSteerOptions): string {
  const lines = [
    `[健康巡检 · 工具超时中断] 你刚才的 \`${o.toolName}\` 已经连续执行了 ${humanDuration(o.elapsedMs)}，` +
    `超过阈值 ${humanDuration(o.limitMs)}，系统已把它中断（本轮剩余步骤不会执行）。`,
    ``,
    `现在按顺序做三件事，**不要原样重试同一个命令**：`,
    `1) 先判断这次执行是不是真的需要这么久。**长脚本先自查终止条件**：有没有 ` +
    `\`timeout\` / 最大轮次 / 明确的退出分支？确认它不是永远跑不完的（等文件、死循环、等网络、` +
    `交互式命令等输入都算）。`,
    `2) 耗时操作**交给 async 子代理**，不要阻塞主会话：用 \`subagent\` 并把 \`async: true\` 与 ` +
    `\`timeoutMs\` 一起传（例如 \`{ async: true, timeoutMs: 600000 }\`），主会话继续做别的部分，` +
    `子代理完成时会收到通知。同步 \`subagent()\` 与长 \`bash\` 一样会阻塞主会话。`,
    `3) 如果是脚本本身的问题（死循环 / 少终止条件 / 少超时），**先改脚本再跑**；` +
    `如果只是慢，改成分批、加 \`--timeout\`、或者先跑一个小样验证。`,
    ``,
    `这是「暂停并纠偏」的交接提示：从你停下的地方继续，已完成的部分不要重做；` +
    `其他不依赖这条长命令的工作照常推进。`,
  ];
  if (o.abortCount >= 1 && o.maxAborts > 0 && o.abortCount >= o.maxAborts) {
    lines.push(
      ``,
      `⚠️ 本会话已因工具超时中断 ${o.abortCount} 次。**后续超时不会再自动中断**（阈值 ${o.maxAborts} 次已用完），` +
      `如果你继续跑长命令，整个会话会被它锁住、健康巡检救不回来。` +
      `必须换做法：交 async 子代理、或把命令拆小、或先和用户确认要跑多久。`,
    );
  }
  return lines.join("\n");
}

/** 状态栏/日志用的一行摘要（在跑的工具名 + 最久那个跑了多久） */
export function formatRunningTools(watch: ToolWatch, now: number): string {
  if (watch.size === 0) return "";
  const tools = [...watch.values()];
  const longest = tools.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
  const names = [...new Set(tools.map((t) => t.toolName))].join("/");
  return `${tools.length} 个在跑（${names}，最久已 ${humanDuration(now - longest.startedAt)}）`;
}
