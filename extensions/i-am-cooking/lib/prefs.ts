/**
 * 偏好检测（纯逻辑，可测试）：
 * - 呼喊偏好/自主等级的"文字匹配保险丝"——保证"别喊了""能不喊就不喊"这类直接指令一定生效
 * - shouldSuppress：根据 callingMode 决定是否抑制响铃（降级为仅 TUI 横幅）
 */
import type { Alert, AutonomyLevel, CallingMode } from "./config.ts";

export const CALLING_MODE_LABEL: Record<CallingMode, string> = {
  normal: "默认（需要你 + 完成都喊）",
  silence: "安静模式（全部静音，只留横幅）",
  completion_only: "只在完成时喊",
  urgent_only: "只在紧急时喊",
  eager: "随时汇报（需要你/完成/进度都喊）",
};

export const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
  conservative: "谨慎（遇墙就喊）",
  balanced: "平衡（有点难度才喊，默认）",
  autonomous: "放手（能不喊就不喊）",
};

// ── 呼喊偏好文字匹配规则（保险丝：保证"别喊了"这类直接指令一定生效） ──────
const PREFERENCE_PATTERNS: { mode: CallingMode; patterns: RegExp[] }[] = [
  {
    mode: "silence",
    patterns: [
      /别喊|别叫|别吵|安静|静音|别打扰|别通知|不用喊|不用叫|quiet|silence|stop\s+(calling|notify|bother)|shut\s*up/i,
    ],
  },
  {
    mode: "completion_only",
    patterns: [
      /完成后?(喊|叫|通知|告诉|提醒)|干完(喊|叫|通知)|好了(喊|叫|通知|叫我)|搞完(喊|叫|通知)|完工(喊|叫|通知)|结束时(喊|叫|通知)|notify\s+(me\s+)?when\s+(done|finished|complete)|tell\s+me\s+when\s+done/i,
    ],
  },
  {
    mode: "urgent_only",
    patterns: [
      /只有紧急才|紧急才(喊|找|通知)|只(有)?紧急(时)?(才)?(喊|找|通知)|重要的事才|only\s+(if\s+)?urgent|only\s+when\s+urgent/i,
    ],
  },
  {
    mode: "eager",
    patterns: [
      /随时(汇报|通知|喊|告诉我)|每步(告诉|通知|汇报)|全程(汇报|通知)|有进展就(说|通知|喊)|keep\s+me\s+posted|report\s+progress|update\s+me\s+(often|frequently)/i,
    ],
  },
  {
    mode: "normal",
    patterns: [
      /需要(你|我)?(时)?再喊|恢复默认|恢复正常|need\s+you\s+when|back\s+to\s+normal|reset/i,
    ],
  },
];

/** 从用户原话中文字匹配偏好，命中返回模式，否则 null */
export function detectPreference(text: string): CallingMode | null {
  for (const rule of PREFERENCE_PATTERNS) {
    if (rule.patterns.some((p) => p.test(text))) return rule.mode;
  }
  return null;
}

// ── 自主等级文字匹配（保险丝："遇墙就喊/能不喊就不喊"这类直接指令一定生效） ──
const AUTONOMY_PATTERNS: { level: AutonomyLevel; patterns: RegExp[] }[] = [
  {
    level: "conservative",
    patterns: [
      /遇(到|见)?(人类墙|墙|阻塞|卡住|难关|problem\s+wall|human\s+wall).*?(喊|叫我|问我|找我|通知)/i,
      /谨慎(点|一些)?|小心(点|些)?|保守(点|些)?|拿不准就(喊|问|找)我|不确定就(喊|问|找)我|先问我|问清楚再(做|干)|重要的事先(问|喊)我/i,
    ],
  },
  {
    level: "balanced",
    patterns: [
      /平衡(点|一些)?|恢复默认|默认就好|正常做|balanced|back\s+to\s+normal/i,
      /有(点)?难度才(喊|找|叫)我|难度大?才(喊|找|叫)我/i,
    ],
  },
  {
    level: "autonomous",
    patterns: [
      /能不喊就不喊|尽量(别|不要)(喊|吵|打扰)我|少喊(我)?|非(常|常)?紧要勿扰|自主(处理|解决|推进|决定|搞定)|自己搞定|别来烦我|除非(真|彻底|完全)?没法(继续|推进)才(喊|叫|找)我/i,
    ],
  },
];

/** 从用户原话中文字匹配自主等级，命中返回等级，否则 null */
export function detectAutonomyLevel(text: string): AutonomyLevel | null {
  for (const rule of AUTONOMY_PATTERNS) {
    if (rule.patterns.some((p) => p.test(text))) return rule.level;
  }
  return null;
}

/**
 * 偏好拦截：根据 callingMode 判断是否抑制响铃（降级为仅 TUI 横幅）。
 * 返回 true = 不响铃/不推送，只留 widget + TUI notify。
 */
export function shouldSuppress(mode: CallingMode, alert: Pick<Alert, "category" | "urgency">): boolean {
  if (mode === "silence") return true;                        // 全部静音
  if (mode === "completion_only") return alert.category !== "completion"; // 只有完成才响
  if (mode === "urgent_only") return alert.urgency !== "urgent";         // 只有紧急才响
  if (mode === "eager") return false;                        // 全喊
  return false; // normal
}