/**
 * 规则加载与 system prompt 构成（纯逻辑 + 文件操作，可测试）。
 * 规则文件是"唯一且完整可编辑"的：出厂默认只作首次创建的种子，之后完全由用户接管。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AutonomyLevel } from "./config.ts";
import { CONFIG_DIR, DEFAULT_RULES_PATH, RULES_PATH } from "./config.ts";

// 底线规则（不可删除，永远追加在用户规则后面）
export const GUARD_RAIL = "- 要么遇到阻塞呼喊后暂停，要么完成，绝不要默默结束回合等用户回复。";

// ── 自主等级指南（按当前等级动态注入 system prompt） ───────────────────────
export const AUTONOMY_GUIDE: Record<AutonomyLevel, string> = {
  conservative: `## 当前自主等级：谨慎（conservative）—— 遇到阻塞就喊我
- 遇到任何必须人工处理的阻塞（人类墙：验证码 / 登录 / 手动点击 / 真实设备操作等）→ 立即调用 shout_for_user 喊我。
- 需要决策 / 审批 / 凭据 / 澄清时，先喊我确认，不要擅自选择。
- 需求模糊、假设不确定时，先问清楚。
- 自主只做完全确定、无风险的部分。
- 保证质量：拿不准的方案宁可不做，也不要用降低质量的方式推进。`,
  balanced: `## 当前自主等级：平衡（balanced）—— 有点难度才喊我（默认）
- 遇到必须人工处理的阻塞（人类墙：验证码 / 登录 / 手动点击 / 真实设备操作等）→ 调用 shout_for_user 喊我。
- 普通决策 / 模糊处 / 小选择 → 用最合理的默认方案自主推进，并在回复里注明你的假设。
- 只有"自主尝试后仍无法推进"或"选错代价很大"时才喊我。
- 保证质量：自主推进不等于降低标准，拿不准时选最稳妥方案。`,
  autonomous: `## 当前自主等级：放手（autonomous）—— 能不喊就不喊
- 尽量不喊我。所有决策、假设、选择自己定，记录在案即可。
- 只有任务彻底无法继续（无权限 / 外部服务故障 / 违反硬性约束）才调用 shout_for_user 喊我。
- 保证质量：自主不等于降低标准，拿不准时选最稳妥方案，并在回复里说明。`,
};

/**
 * 剥掉规则文本中的 HTML 注释块（`<!-- ... -->`，用于放开发说明，不等同于规则），
 * 并去除首尾空白，只保留实际生效的规则内容。
 */
function stripMeta(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/**
 * 读取出厂默认规则文件（仓库内 rules.default.md，进 git，随版本更新）。
 * 文件缺失（异常情况）时回退到内联兜底文本。
 */
export async function loadDefaultRules(defaultPath = DEFAULT_RULES_PATH): Promise<string> {
  try {
    const raw = await readFile(defaultPath, "utf8");
    return stripMeta(raw);
  } catch {
    return (
      "## 自主推进\n" +
      "- 能自己决断的就自己决断，采用最合理的默认方案，并在回复里注明你的假设。\n" +
      "- 不要停下来等，除非真的被卡住。\n\n" +
      "## 什么时候需要喊我\n" +
      "- 需要决策 / 凭据 / 审批 / 澄清 / 人类验证墙 /关键配置，且只有我能解决时。\n\n" +
      "## 完成通知\n" +
      "- 任务全部完成或达到重要里程碑时通知我（category=completion, urgency=info）。\n" +
      "- 普通小步骤不值得喊。"
    );
  }
}

/**
 * 规则现在是「唯一且完整可编辑」的，用户改的就是唯一生效的那份。
 * 出厂默认只作为首次创建时的"种子"填入 `rules.md`，之后完全由用户接管。
 * 已存在则直接读取；文件缺失（异常情况）才回退出厂默认。
 */
export async function loadRules(rulesPath = RULES_PATH): Promise<string> {
  try {
    const raw = await readFile(rulesPath, "utf8");
    return raw.trim();
  } catch {
    return loadDefaultRules();
  }
}

/** 组装注入 system prompt 的规则文本（生效规则 + 自主等级指南 + 机制提示 + 底线） */
export async function buildRulesPrompt(level: AutonomyLevel, rulesPath = RULES_PATH): Promise<string> {
  const rules = await loadRules(rulesPath);
  // 每个区块之间用 \n\n 分隔，末尾保留 \n 防止与后续文本粘连
  return (
    // ── 前置强分隔符：无论 systemPrompt 末尾是什么内容，\n\n--- 能断开上文 ──
    `\n\n---\n` +
    `# [IAM COOKING MODE] 用户不在电脑前（去做饭了）\n\n` +

    `## 生效规则（来自 ${rulesPath}，首次创建时以出厂默认填充，之后完全由你接管）\n${rules}\n\n` +

    `## 自主等级指南（当前等级：${level}，由机制控制，用户可在 rules 之外单独设置）\n${AUTONOMY_GUIDE[level]}\n\n` +

    `## 机制提示\n` +
    `- 用户明确表达偏好时（如“别喊了”“完成后喊我”“只有紧急才找我”“随时汇报”），调用 set_calling_preference 调整呼喊方式。\n` +
    `- 用户明确表达自主程度时（如“拿不准就问我”→谨慎 / “能不喊就不喊”→放手），调用 set_autonomy_level 调整自主等级。\n\n` +

    `## 底线规则（系统强制，无法从规则文件删除）\n${GUARD_RAIL}\n` +
    `---\n`  // ── 后置分隔符：标记注入区域结束 ──
  );
}

/** 确保规则文件存在（首次创建时从出厂默认拷贝；之后完全由用户接管） */
export async function ensureRulesFile(rulesPath = RULES_PATH): Promise<void> {
  try {
    await readFile(rulesPath, "utf8");
  } catch {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(rulesPath, await loadDefaultRules(), "utf8");
  }
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p, "utf8");
    return true;
  } catch {
    return false;
  }
}