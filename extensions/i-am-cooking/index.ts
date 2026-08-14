/**
 * I am cooking 🍳
 *
 * 你离开电脑去做饭时，pi 代理继续自主干活；
 * 它真正卡住需要你时，会"大声呼喊"你 —— 多路通知：
 *   ① 声音（哔哔/自定义 wav） ② 中文 TTS ③ Windows Toast
 *   ④ 手机推送（ntfy.sh，人在厨房的关键通道） ⑤ TUI 横幅常驻
 *
 * 命令:
 *   /i-am-cooking on [备注]   — 开启离开模式（agent 收到指令自主推进）
 *   /i-am-cooking off         — 我回来了（agent 收到"我不在时喊了你X件事"的汇报）
 *   /i-am-cooking status      — 查看模式/待处理呼喊/通道状态
 *   /i-am-cooking test        — 测试所有通道（不用先开模式）
 *   /i-am-cooking rules       — 查看当前生效规则
 *   /i-am-cooking edit-rules  — 编辑规则文件（保存即生效）
 *   /i-am-cooking reset-rules — 规则恢复出厂默认（内置规则）
 *
 * 工具 (LLM 调用):
 *   shout_for_user           — 卡住且只有用户能解决时调用
 *
 * 自动检测:
 *   agent_settled 后若回合以"？"结尾且没有后续工具调用 → 自动呼喊（安全网）
 *   cooking 模式下你直接打字 → 自动视为"回来了"，退出模式并让 agent 汇报
 *
 * 配置: ~/.pi/i-am-cooking.json （可热改，/reload 生效）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const HOME       = homedir();
// scripts 与 index.ts 同目录：本地开发 / pi install / git clone 任何安装方式都能正确定位
const SCRIPTS    = fileURLToPath(new URL("./scripts", import.meta.url));
// 出厂默认规则文件（仓库内，进 git）：随插件版本更新，运行时首次创建用户文件时从它拷贝
const DEFAULT_RULES_PATH = fileURLToPath(new URL("./rules.default.md", import.meta.url));
const CONFIG_DIR  = join(HOME, ".pi", "i-am-cooking");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const RULES_PATH  = join(CONFIG_DIR, "rules.md");
const TMP_DIR     = join(CONFIG_DIR, "tmp");

// 底线规则（不可删除，永远追加在用户规则后面）
const GUARD_RAIL = "- 绝不要默默结束回合等用户回复。";

// ── 自主等级指南（按当前等级动态注入 system prompt） ───────────────────────
const AUTONOMY_GUIDE: Record<AutonomyLevel, string> = {
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

const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
  conservative: "谨慎（遇墙就喊）",
  balanced: "平衡（有点难度才喊，默认）",
  autonomous: "放手（能不喊就不喊）",
};

type Urgency = "info" | "normal" | "urgent";

type CallingMode = "normal" | "silence" | "completion_only" | "urgent_only" | "eager";

// 自主等级：遇到阻塞时「该不该喊用户」的阈值
//   conservative —— 遇墙就喊（人类墙：验证码/登录/手动点击等必须人手动的阻塞）
//   balanced     —— 有点难度才喊（默认；普通决策自主推进，人类墙/代价大才喊）
//   autonomous   —— 能不喊就不喊（尽量自决，只有彻底无法继续才喊）
type AutonomyLevel = "conservative" | "balanced" | "autonomous";

interface Alert {
  id: string;
  time: number;
  message: string;
  urgency: Urgency;
  category: string;
  repeatCount: number;
  acked: boolean;
}

interface Config {
  cooking: boolean;
  since?: number;
  alerts: Alert[];
  lastShout?: number;

  // channels
  sound: boolean;
  beeps: number;
  soundPath: string; // optional .wav, overrides beeps
  tts: boolean;
  ttsTemplate: string; // "{message}" placeholder
  toast: boolean;
  tuiBanner: boolean;
  phonePush: boolean;
  pushProvider: "ntfy" | "webhook"; // 手机推送服务商
  ntfyTopic: string;
  ntfyServer: string;
  ntfyToken: string; // ntfy 私有 topic 访问 token，支持 ${ENV_VAR} 引用
  webhookUrl: string; // generic webhook (Bark/Server酱...), receives JSON
  webhookToken: string; // webhook 认证 token，支持 ${ENV_VAR} 引用
  webhookTokenHeader: string; // token 放在哪个 header（默认 Authorization）
  setupDone: boolean; // 是否已完成手机推送配置（初次使用提示用）

  // behavior
  autoDetect: boolean;      // agent 以"？"结尾等回复时自动喊
  exitOnUserInput: boolean; // cooking 中你直接打字 = 回来了
  repeatIntervalMinutes: number; // normal 重复间隔
  urgentRepeatMinutes: number;   // urgent 重复间隔
  maxUrgentRepeats: number;      // -1 = 一直喊到回来
  boostVolume: boolean;          // 离开时自动提升系统音量（需用户允许）
  boostLevel: number;            // 提升到多少（0-100，默认 80）
  callingMode: CallingMode;      // 呼喊偏好（agent 依据用户原话动态设置）
  autonomyLevel: AutonomyLevel;  // 自主等级（持久化；遇到阻塞时该不该喊）
  maxCompletionNotices: number;  // 每次离开最多喊几次完成（防打扰）
  ttsTemplateCompletion: string; // 完成时的 TTS 文案
}

const DEFAULTS: Config = {
  cooking: false,
  alerts: [],
  sound: true,
  beeps: 4,
  soundPath: "",
  tts: true,
  ttsTemplate: "主人，快来！pi 需要你！{message}",
  toast: true,
  tuiBanner: true,
  phonePush: false,
  pushProvider: "ntfy",
  ntfyTopic: "",
  ntfyServer: "https://ntfy.sh",
  ntfyToken: "",
  webhookUrl: "",
  webhookToken: "",
  webhookTokenHeader: "Authorization",
  setupDone: false,
  autoDetect: true,
  exitOnUserInput: true,
  repeatIntervalMinutes: 5,
  urgentRepeatMinutes: 3,
  maxUrgentRepeats: -1,
  boostVolume: false, // 默认关，需在 setup 里允许
  boostLevel: 80,
  callingMode: "normal",
  autonomyLevel: "balanced", // 默认：有点难度才喊
  maxCompletionNotices: 3,
  ttsTemplateCompletion: "主人，好消息！任务完成了！{message}",
};

// ── state ────────────────────────────────────────────────────────────────
let api: ExtensionAPI; // set by factory; needed by turnOn/turnOff
let config: Config = { ...DEFAULTS };
let repeatTimers: ReturnType<typeof setInterval>[] = [];

async function loadConfig(): Promise<void> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    config = { ...DEFAULTS, ...JSON.parse(raw) };
    config.alerts = config.alerts ?? [];
  } catch {
    config = { ...DEFAULTS };
    await saveConfig();
  }
}

async function saveConfig(): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  } catch (e) {
    console.error("[i-am-cooking] save config failed:", e);
  }
}

function pendingAlerts(): Alert[] {
  return config.alerts.filter((a) => !a.acked);
}

// ── 规则加载（单一来源）──────────────────────────────────────────────────
/**
 * 剥掉规则文本中的 HTML 注释块（`<!-- ... -->`，用于放开发说明，不等同于规则），
 * 并去除首尾空白，只保留实际生效的规则内容。
 */
function stripMeta(raw: string): string {
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  return withoutComments;
}

/**
 * 读取出厂默认规则文件（仓库内 rules.default.md，进 git，随版本更新）。
 * 文件缺失（异常情况）时回退到内联兜底文本。
 */
async function loadDefaultRules(): Promise<string> {
  try {
    const raw = await readFile(DEFAULT_RULES_PATH, "utf8");
    return stripMeta(raw);
  } catch {
    return (
      "## 自主推进\n" +
      "- 能自己决断的就自己决断，采用最合理的默认方案，并在回复里注明你的假设。\n" +
      "- 不要停下来等，除非真的被卡住。\n\n" +
      "## 什么时候需要喊我\n" +
      "- 需要决策 / 凭据 / 审批 / 澄清，且只有我能解决时。\n\n" +
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
async function loadRules(): Promise<string> {
  try {
    const raw = await readFile(RULES_PATH, "utf8");
    return raw.trim();
  } catch {
    return loadDefaultRules();
  }
}

/** 组装注入 system prompt 的规则文本（生效规则 + 自主等级指南 + 机制提示 + 底线） */
async function buildRulesPrompt(): Promise<string> {
  const rules = await loadRules();
  const level = config.autonomyLevel || "balanced";
  return (
    `\n\n[IAM COOKING MODE] 用户不在电脑前（去做饭了）。\n\n` +
    `[生效规则（来自 ${RULES_PATH}，首次创建时以出厂默认填充，之后完全由你接管）]\n${rules}\n\n` +
    `[自主等级指南（当前等级：${level}，由机制控制，用户可在 rules 之外单独设置）]\n${AUTONOMY_GUIDE[level]}\n\n` +
    `[机制提示]\n- 用户明确表达偏好时（如"别喊了""完成后喊我""只有紧急才找我""随时汇报"），调用 set_calling_preference 调整呼喊方式。\n- 用户明确表达自主程度时（如"拿不准就问我"→谨慎 / "能不喊就不喊"→放手），调用 set_autonomy_level 调整自主等级。\n\n` +
    `[底线规则（系统强制，无法从规则文件删除）]\n${GUARD_RAIL}`
  );
}

/** 确保规则文件存在（首次创建时从出厂默认拷贝；之后完全由用户接管） */
async function ensureRulesFile(): Promise<void> {
  try {
    await readFile(RULES_PATH, "utf8");
  } catch {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(RULES_PATH, await loadDefaultRules(), "utf8");
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ── notification channels ────────────────────────────────────────────────
/**
 * 解析配置值：支持 ${ENV_VAR} 或 $ENV_VAR 引用环境变量（避免 token 明文落盘）。
 * 例："ntfyToken": "${NTFY_TOKEN}" → 从环境变量 NTFY_TOKEN 读取。
 */
function resolveValue(v: string): string {
  if (typeof v !== "string" || !v) return v ?? "";
  const m = v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) ?? v.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) return process.env[m[1]] ?? "";
  return v;
}

function runPowerShellScript(script: string, data: Record<string, unknown>): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  const dataFile = join(TMP_DIR, `${randomUUID()}.json`);
  return (async () => {
    try {
      await mkdir(TMP_DIR, { recursive: true });
      await writeFile(dataFile, JSON.stringify(data), "utf8");
      await execFileAsync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", join(SCRIPTS, script),
        "-DataFile", dataFile,
      ], { timeout: 30_000, windowsHide: true });
    } catch (e) {
      console.error(`[i-am-cooking] ${script} failed:`, (e as Error).message);
    } finally {
      try { await rm(dataFile, { force: true }); } catch { /* ignore */ }
    }
  })();
}

// ── cross-platform helpers ───────────────────────────────────────────────
function runCommand(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
  return execFileAsync(cmd, args, {
    timeout: opts.timeoutMs ?? 30_000,
    windowsHide: true,
  }).catch((e) => {
    console.error(`[i-am-cooking] ${cmd} failed:`, (e as Error).message);
  });
}

async function playSound(beeps: number, soundPath: string): Promise<void> {
  if (!beeps) return;
  const p = process.platform;
  try {
    if (p === "win32") {
      await runPowerShellScript("shout.ps1", { beeps, soundPath: "", ttsText: "" });
    } else if (p === "darwin") {
      // macOS: osascript beep（最简，无需额外文件）；自定义 wav 用 afplay
      if (soundPath) await runCommand("afplay", [soundPath]);
      else await runCommand("osascript", ["-e", `beep ${Math.min(beeps, 5)}`]);
    } else {
      // Linux: canberra 提示音（常见），或 paplay 播文件
      if (soundPath) await runCommand("paplay", [soundPath]).catch(() => runCommand("aplay", [soundPath]));
      else await runCommand("canberra-gtk-play", ["-i", "message"], { timeoutMs: 5000 }).catch(() => {});
    }
  } catch { /* best effort */ }
}

async function speakTts(text: string): Promise<void> {
  if (!text) return;
  const p = process.platform;
  try {
    if (p === "win32") {
      await runPowerShellScript("shout.ps1", { beeps: 0, soundPath: "", ttsText: text });
    } else if (p === "darwin") {
      // macOS say：Tingting 是内置中文普通话语音，失败则用系统默认
      await runCommand("say", ["-v", "Tingting", text]).catch(() =>
        runCommand("say", [text]),
      );
    } else {
      await runCommand("espeak-ng", ["-v", "zh", text]).catch(() =>
        runCommand("espeak", ["-v", "zh", text]),
      );
    }
  } catch { /* best effort */ }
}

async function showNotification(title: string, body: string): Promise<void> {
  const p = process.platform;
  try {
    if (p === "win32") {
      await runPowerShellScript("toast.ps1", { title, body });
    } else if (p === "darwin") {
      // macOS 原生通知：支持中文、emoji，带提示音 Glass
      await runCommand("osascript", [
        "-e",
        `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`,
      ]);
    } else {
      await runCommand("notify-send", [title, body], { timeoutMs: 5000 });
    }
  } catch { /* best effort */ }
}

// ── volume control（需用户允许 boostVolume 才启用） ──────────────────────
let savedVolumePct: number | null = null; // 离开前的原始音量（0-100）

/** 离开时提升音量到 boostLevel（只升不降），并记住原值 */
async function boostVolume(): Promise<void> {
  if (!config.boostVolume) return;
  const target = Math.max(1, Math.min(100, config.boostLevel || 80));
  const p = process.platform;
  try {
    if (p === "win32") {
      await mkdir(TMP_DIR, { recursive: true });
      const saveFile = join(TMP_DIR, "volume.json");
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", join(SCRIPTS, "volume.ps1"),
        "-Action", "save", "-Level", String(target / 100), "-SaveFile", saveFile,
      ], { timeout: 15_000, windowsHide: true });
      const m = stdout.match(/saved=([\d.]+)/);
      if (m) savedVolumePct = Math.round(parseFloat(m[1]) * 100);
    } else if (p === "darwin") {
      const { stdout } = await execFileAsync("osascript", ["-e", "get volume output volume"], { windowsHide: true });
      const cur = parseInt(stdout.trim(), 10);
      savedVolumePct = isNaN(cur) ? null : cur;
      const newLevel = Math.max(isNaN(cur) ? 0 : cur, target);
      await execFileAsync("osascript", ["-e", `set volume output volume ${newLevel}`], { windowsHide: true });
    } else {
      // Linux: pactl (PulseAudio)
      const { stdout } = await execFileAsync("pactl", ["get-sink-volume", "@DEFAULT_SINK@"], { windowsHide: true });
      const m = stdout.match(/(\d+)%/);
      savedVolumePct = m ? parseInt(m[1], 10) : null;
      const newLevel = Math.max(savedVolumePct ?? 0, target);
      await execFileAsync("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${newLevel}%`], { windowsHide: true });
    }
  } catch (e) {
    console.error("[i-am-cooking] boostVolume failed:", (e as Error).message);
    savedVolumePct = null; // 读不到原值就不恢复，避免误改
  }
}

/** 回来时恢复离开前的音量 */
async function restoreVolume(): Promise<void> {
  if (savedVolumePct === null) return;
  const p = process.platform;
  try {
    if (p === "win32") {
      await execFileAsync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", join(SCRIPTS, "volume.ps1"),
        "-Action", "restore", "-SaveFile", join(TMP_DIR, "volume.json"),
      ], { timeout: 15_000, windowsHide: true });
    } else if (p === "darwin") {
      await execFileAsync("osascript", ["-e", `set volume output volume ${savedVolumePct}`], { windowsHide: true });
    } else {
      await execFileAsync("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${savedVolumePct}%`], { windowsHide: true });
    }
  } catch (e) {
    console.error("[i-am-cooking] restoreVolume failed:", (e as Error).message);
  }
  savedVolumePct = null;
}

async function pushPhone(alert: Alert): Promise<void> {
  const topic = config.ntfyTopic?.trim();
  if (!topic) return;
  const server = (config.ntfyServer?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
  const priority = alert.urgency === "urgent" ? 5 : alert.urgency === "normal" ? 3 : 1;
  const headers: Record<string, string> = {
    Title: "[pi] alert!",
    Priority: String(priority),
    Tags: "potable_water",
  };
  // ntfy 私有 topic：携带访问 token（Authorization: Bearer <token>）
  const token = resolveValue(config.ntfyToken).trim();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      body: `[${alert.urgency}] ${alert.message}`,
      headers,
    });
  } catch (e) {
    console.error("[i-am-cooking] ntfy push failed:", (e as Error).message);
  }
}

async function pushWebhook(alert: Alert): Promise<void> {
  const url = config.webhookUrl?.trim();
  if (!url) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // webhook 认证：token 放在指定 header（默认 Authorization: Bearer <token>）
  const token = resolveValue(config.webhookToken).trim();
  if (token) {
    const headerName = config.webhookTokenHeader?.trim() || "Authorization";
    const value = headerName.toLowerCase() === "authorization" && !/^Bearer\s/i.test(token)
      ? `Bearer ${token}`
      : token;
    headers[headerName] = value;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "🍳 pi 需要你！",
        message: alert.message,
        urgency: alert.urgency,
        category: alert.category,
        time: new Date(alert.time).toISOString(),
      }),
    });
  } catch (e) {
    console.error("[i-am-cooking] webhook push failed:", (e as Error).message);
  }
}

function renderTts(alert: Alert): string {
  const isCompletion = alert.category === "completion";
  const template = isCompletion
    ? (config.ttsTemplateCompletion || "主人，好消息！任务完成了！{message}")
    : config.ttsTemplate;
  return template.replaceAll("{message}", alert.message);
}

/**
 * 偏好拦截：根据 callingMode 判断是否抑制响铃（降级为仅 TUI 横幅）。
 * 返回 true = 不响铃/不推送，只留 widget + TUI notify。
 */
function shouldSuppress(alert: Alert): boolean {
  const mode = config.callingMode || "normal";
  if (mode === "silence") return true;                        // 全部静音
  if (mode === "completion_only") return alert.category !== "completion"; // 只有完成才响
  if (mode === "urgent_only") return alert.urgency !== "urgent";         // 只有紧急才响
  if (mode === "eager") return false;                        // 全喊
  return false; // normal
}

// completion 通知计数器（每次 turnOn 清零）
let completionNoticeCount = 0;

// ── 偏好文字匹配规则（保险丝：保证"别喊了"这类直接指令一定生效） ──────────
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
function detectPreference(text: string): CallingMode | null {
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
function detectAutonomyLevel(text: string): AutonomyLevel | null {
  for (const rule of AUTONOMY_PATTERNS) {
    if (rule.patterns.some((p) => p.test(text))) return rule.level;
  }
  return null;
}

/** 切换自主等级并提示（持久化：跨离开会话保留） */
function setAutonomyLevel(level: AutonomyLevel, reason: string, ctx: { ui: any }): void {
  const prev = config.autonomyLevel || "balanced";
  config.autonomyLevel = level;
  void saveConfig();
  if (level !== prev) {
    ctx.ui.notify(`🚀 自主等级已切换：${AUTONOMY_LABEL[level]}（依据：${reason}）`, "info");
  }
}

const CALLING_MODE_LABEL: Record<CallingMode, string> = {
  normal: "默认（需要你 + 完成都喊）",
  silence: "安静模式（全部静音，只留横幅）",
  completion_only: "只在完成时喊",
  urgent_only: "只在紧急时喊",
  eager: "随时汇报（需要你/完成/进度都喊）",
};

/** 切换偏好并提示 */
function setCallingMode(mode: CallingMode, reason: string, ctx: { ui: any }): void {
  const prev = config.callingMode || "normal";
  config.callingMode = mode;
  void saveConfig();
  if (mode !== prev) {
    ctx.ui.notify(`🔔 呼喊偏好已切换：${CALLING_MODE_LABEL[mode]}（依据：${reason}）`, "info");
  }
}

async function fireAlert(alert: Alert, ctx: { ui: any }): Promise<void> {
  config.lastShout = Date.now();
  const suppress = shouldSuppress(alert);
  const isCompletion = alert.category === "completion";

  // ── widget + TUI notify（无论是否 suppress 都显示）──
  if (ctx?.ui) {
    const icon = isCompletion ? "✅" : "⚠";
    const label = isCompletion ? "完成通知" : `pi 需要你！[${alert.urgency}]`;
    ctx.ui.notify(`🍳 ${icon} ${label} ${alert.message}`, suppress ? "info" : "warning");
    updateWidget(ctx);
  }

  // ── 响铃 / 推送（suppress 时跳过）──
  if (!suppress) {
    if (config.sound || config.tts) {
      await Promise.all([
        playSound(config.sound ? config.beeps : 0, config.sound ? config.soundPath : ""),
        speakTts(config.tts ? renderTts(alert) : ""),
      ]);
    }
    if (config.toast) {
      const title = isCompletion ? "任务完成" : "pi 需要你！";
      await showNotification(`🍳 ${title}`, `[${alert.urgency}] ${alert.message}`);
    }
    if (config.phonePush) void pushPhone(alert);
    if (config.webhookUrl) void pushWebhook(alert);
  }
}

function updateWidget(ctx: { ui: any }): void {
  if (!ctx?.ui) return;
  if (!config.tuiBanner) { ctx.ui.setWidget("i-am-cooking", []); return; }
  const pending = pendingAlerts();
  const lines = config.cooking
    ? [
        "🍳 离开中（I am cooking）— 需要你时我会大声喊你。",
        ...pending.map((a, i) => `  ⚠ ${i + 1}. [${a.urgency}] ${a.message}`),
      ]
    : [];
  ctx.ui.setWidget("i-am-cooking", lines);
}

// ── alert queue & escalation ─────────────────────────────────────────────
function scheduleRepeats(alert: Alert, ctx: { ui: any }): void {
  // completion 通知只喊一次，不进入重复逻辑
  if (alert.category === "completion") return;

  if (alert.urgency === "urgent") {
    const iv = Math.max(1, config.urgentRepeatMinutes) * 60_000;
    const timer = setInterval(() => {
      if (!config.cooking) return;
      alert.repeatCount++;
      void saveConfig();
      void fireAlert(alert, ctx);
      if (config.maxUrgentRepeats > 0 && alert.repeatCount >= config.maxUrgentRepeats) {
        clearInterval(timer);
      }
    }, iv);
    repeatTimers.push(timer);
  } else if (alert.urgency === "normal") {
    const timer = setTimeout(() => {
      if (!config.cooking) return;
      alert.repeatCount++;
      void saveConfig();
      void fireAlert(alert, ctx);
    }, Math.max(1, config.repeatIntervalMinutes) * 60_000);
    repeatTimers.push(timer as unknown as ReturnType<typeof setInterval>);
  }
}

function clearRepeatTimers(): void {
  for (const t of repeatTimers) clearInterval(t);
  repeatTimers = [];
}

function queueAlert(message: string, urgency: Urgency, category: string, ctx: { ui: any }): boolean {
  if (!config.cooking) return false;

  // completion 防打扰：每次离开最多 maxCompletionNotices 次完成通知
  if (category === "completion") {
    const max = config.maxCompletionNotices ?? 3;
    if (completionNoticeCount >= max) return false;
    completionNoticeCount++;
  }

  const dup = config.alerts.find(
    (a) => !a.acked && a.message === message && Date.now() - a.time < 10 * 60_000,
  );
  if (dup) return false;

  const alert: Alert = {
    id: randomUUID(),
    time: Date.now(),
    message,
    urgency,
    category,
    repeatCount: 0,
    acked: false,
  };
  config.alerts.push(alert);
  void saveConfig();
  void fireAlert(alert, ctx);
  scheduleRepeats(alert, ctx);
  return true;
}

// ── mode control ─────────────────────────────────────────────────────────
function turnOn(ctx: { ui: any }, note: string): void {
  config.cooking = true;
  config.since = Date.now();
  completionNoticeCount = 0; // 新的一轮离开，重置完成通知计数
  void saveConfig();
  ctx.ui.setStatus("i-am-cooking", "🍳 离开中（I am cooking）");
  ctx.ui.notify("🍳 离开模式已开启。pi 需要你时我会大声喊你。", "info");
  updateWidget(ctx);

  // 自动提升音量（只在用户允许时生效）
  void boostVolume();

  // 备注里带偏好关键词 → 立即切换（如 /i-am-cooking on 完成后喊我）
  if (note) {
    const mode = detectPreference(note);
    if (mode) setCallingMode(mode, `你在 on 备注里说了："${note.slice(0, 40)}"`, ctx);
    // 备注里带自主等级关键词 → 立即切换（如 /i-am-cooking on 谨慎点继续）
    const level = detectAutonomyLevel(note);
    if (level) setAutonomyLevel(level, `你在 on 备注里说了："${note.slice(0, 40)}"`, ctx);
  }

  const noteText = note ? `备注：${note}` : "";
  const level = config.autonomyLevel || "balanced";
  void api.sendUserMessage(
    `[I am cooking] 我离开去做饭了，不在电脑前。${noteText}\n` +
    `当前自主等级：${AUTONOMY_LABEL[level]}。具体行动指南见注入的 [自主等级指南]（含人类墙等场景的喊我阈值）。\n` +
    `请自主推进任务：能自己解决的就自己解决（采用最合理的默认方案，并在回复里注明你的假设），保证质量，不要降低标准；` +
    `只有达到当前等级的喊我阈值（见 [自主等级指南]）时才调用 shout_for_user 工具大声喊我，` +
    `喊完继续用合理默认值推进，绝不要干等我。\n` +
    `任务全部完成或达到重要里程碑时，调用 shout_for_user（category="completion", urgency="info"）通知我。`,
    { deliverAs: "followUp" },
  );
}

function turnOff(ctx: { ui: any }, source: "command" | "user-input"): void {
  clearRepeatTimers();
  const pending = pendingAlerts();
  config.cooking = false;
  config.since = undefined;
  config.alerts = [];
  config.callingMode = "normal"; // 偏好是会话级的，下次离开重新判断
  void saveConfig();
  ctx.ui.setStatus("i-am-cooking", "");
  ctx.ui.setWidget("i-am-cooking", []);

  // 恢复音量
  void restoreVolume();

  const summary = pending.length
    ? pending.map((a, i) => `${i + 1}. [${a.urgency}] ${a.message}`).join("\n")
    : "（无待处理呼喊）";
  void api.sendUserMessage(
    `[I am cooking] 我回来了（${source === "user-input" ? "检测到你打字" : "执行 off 命令"}）。\n` +
    `我不在的时候你喊了我这些事：\n${summary}\n` +
    `请简要汇报当前进度，然后继续处理这些事项。`,
    { deliverAs: "followUp" },
  );
}

function showStatus(ctx: { ui: any }): void {
  const pending = pendingAlerts();
  const phoneState = !config.phonePush
    ? "未启用"
    : config.pushProvider === "ntfy"
      ? `ntfy topic=${config.ntfyTopic || "(未填)"} token=${maskToken(config.ntfyToken)}`
      : `webhook ${config.webhookUrl || "(未填)"} token=${maskToken(config.webhookToken)}`;
  const lines = [
    `模式: ${config.cooking ? "🍳 离开中（I am cooking）" : "在岗"}`,
    ...(config.since ? [`开启时间: ${new Date(config.since).toLocaleTimeString("zh-CN")}`] : []),
    `待处理呼喊: ${pending.length}`,
    ...pending.map(
      (a, i) => `  ${i + 1}. [${a.urgency}] ${a.message}（${new Date(a.time).toLocaleTimeString("zh-CN")}，已喊 ${a.repeatCount} 次）`,
    ),
    `通道: 声音${config.sound ? "✓" : "✗"} TTS${config.tts ? "✓" : "✗"} Toast${config.toast ? "✓" : "✗"} 手机推送(${phoneState})`,
    `音量: ${config.boostVolume ? `离开自动拉高到 ${config.boostLevel}%` : "未启用"}`,
    `呼喊偏好: ${CALLING_MODE_LABEL[config.callingMode || "normal"]}`,
    `自主等级: ${AUTONOMY_LABEL[config.autonomyLevel || "balanced"]}`,
    `配置: ${CONFIG_PATH}（首次使用请运行 /i-am-cooking setup 配置手机推送）`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

function maskToken(token: string): string {
  const t = resolveValue(token);
  if (!t) return "未配置";
  if (t.length <= 8) return "已配置(***)";
  return `已配置(${t.slice(0, 3)}***${t.slice(-3)})`;
}

/** 生成建议的随机 topic 名（隐私安全，别人猜不到） */
function suggestTopic(): string {
  return `i-am-cooking-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * 配置预览确认：
 *   confirm 显示完整预览 → 是=确认保存(true) / 否=再选(重新填写|取消)。
 * 返回：true=确认，false=重新填写，null=取消。
 */
async function confirmPreview(ui: any, title: string, preview: string): Promise<boolean | null> {
  for (;;) {
    const ok = await ui.confirm(title, preview + "\n\n确认无误？");
    if (ok === true) return true;
    if (ok === false) {
      const next = await ui.select("不满意的话：", ["🔁 重新填写", "❌ 取消"]);
      if (!next) return null;
      if (next.includes("重新填写")) return false;
      return null;
    }
    return null;
  }
}

/**
 * 初次使用配置向导：/i-am-cooking setup
 * 交互式选择推送服务 → 引导说明 → 填 server/topic/token → 自动测试推送。
 */
async function setupWizard(ctx: { mode: string; hasUI: boolean; ui: any }): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("配置向导需要 TUI 交互模式。请直接编辑 " + CONFIG_PATH, "warning");
    return;
  }
  const ui = ctx.ui;

  // 0) 总览引导
  const start = await ui.confirm(
    "🍳 I am cooking 手机推送配置向导",
    "目的：你离开电脑时（比如做饭），agent 卡住需要你时，通过手机通知提醒你。\n\n" +
    "支持两种推送服务：\n" +
    "① ntfy — 免费开源推送服务，Android/iOS 都有 app（推荐）\n" +
    "② Webhook — 接入 Bark（iOS）/ 企业微信机器人 / Server酱 等\n\n" +
    "开始配置？",
  );
  if (!start) { ui.notify("已取消配置。", "info"); return; }

  // 1) 选择推送服务
  const provider = await ui.select("选择手机推送服务（Esc 取消）:", [
    "ntfy（推荐，免费开源，Android/iOS 都有 app）",
    "Webhook（Bark / 企业微信机器人 / Server酱）",
    "暂不配置手机推送",
  ]);
  if (!provider) { ui.notify("已取消配置。", "info"); return; }
  if (provider.includes("暂不")) {
    config.phonePush = false;
    config.setupDone = true;
    await saveConfig();
    ui.notify("已关闭手机推送。其他通道（声音/TTS/Toast）不受影响。", "info");
    return;
  }

  if (provider.includes("ntfy")) {
    // ntfy 引导说明（很多人不知道这是什么）
    const guide = await ui.confirm(
      "📱 ntfy 是什么？",
      "ntfy 是免费开源推送服务，原理很简单：\n" +
      "  • 电脑端用 HTTP 请求发消息到某个「频道」\n" +
      "  • 手机装 ntfy app，订阅同一个「频道」即可收到通知\n\n" +
      "「频道」叫 topic，相当于一个名字（类似邮箱地址）。\n" +
      "建议用随机名字，别人猜不到，隐私安全——下一步我们会帮你生成一个。\n\n" +
      "手机先装好 app（建议现在装）：\n" +
      "  Android: https://play.google.com/store/apps/details?id=io.heckel.ntfy\n" +
      "  iOS:     https://apps.apple.com/app/ntfy/id1625396347\n\n" +
      "装好后，在 app 里「+」→ Subscribe 订阅你下一步填的 topic 名即可。继续？",
    );
    if (!guide) { ui.notify("已取消配置。", "info"); return; }

    config.pushProvider = "ntfy";
    for (;;) {
      // ── 收集 ──
      const server = await ui.input("ntfy 服务器（回车用默认）:", config.ntfyServer || "https://ntfy.sh");
      if (server === undefined) { ui.notify("已取消配置。", "info"); return; }
      const suggested = config.ntfyTopic?.trim() || suggestTopic();
      const topic = await ui.input(`Topic（回车用建议值：${suggested}）`, suggested);
      if (topic === undefined) { ui.notify("已取消配置。", "info"); return; }
      const token = await ui.input("Access Token（可选，私有 topic 用；回车跳过。支持 ${ENV_VAR}）:", config.ntfyToken);
      if (token === undefined) { ui.notify("已取消配置。", "info"); return; }

      // ── 预览确认 ──
      const finalServer = server.trim() || "https://ntfy.sh";
      const finalTopic = topic.trim() || suggested;
      const finalToken = token.trim();
      const decision = await confirmPreview(ui, "📋 配置预览",
        `服务器: ${finalServer}\n` +
        `Topic:  ${finalTopic}\n` +
        `Token:  ${finalToken ? maskToken(finalToken) : "未填（公共 topic）"}`);
      if (decision === null) { ui.notify("已取消配置。", "info"); return; }
      if (decision === false) continue; // 重新填写

      // ── 保存 ──
      config.ntfyServer = finalServer;
      config.ntfyTopic = finalTopic;
      config.ntfyToken = finalToken;
      config.phonePush = true;
      config.setupDone = true;
      await saveConfig();

      // ── 自动提升音量（需用户明确允许）──
      const volOk = await ui.confirm(
        "🔊 自动提升系统音量？",
        "离开时如果系统音量低于 80%，自动拉高，回来时恢复。\n" +
        "防止静音状态下听不到呼喊。\n\n允许？",
      );
      config.boostVolume = volOk === true;
      await saveConfig();

      // ── 测试推送 ──
      const test = await ui.confirm(
        "配置已保存！现在测试手机推送？",
        `请先在手机 ntfy app 里订阅：${finalTopic}\n然后选「是」发送测试。`,
      );
      if (test) {
        const ok = await testPush("ntfy", ctx);
        ui.notify(ok ? "✅ 手机推送发送成功，请查看手机。" : "⚠️ 发送失败，请检查 topic/token/网络（详情见 pi 日志）。", ok ? "info" : "warning");
      } else {
        ui.notify("配置已保存。随时可用 /i-am-cooking test 测试全部通道。", "info");
      }
      return;
    }
  }

  // Webhook 引导说明
  const guide = await ui.confirm(
    "🌐 Webhook 是什么？",
    "Webhook 是通用推送接口，可以接入：\n" +
    "  • Bark（iOS 专用）：App Store 搜「Bark」，打开后获得设备码，\n" +
    "    URL 填：https://api.day.app/你的设备码\n" +
    "  • 企业微信机器人：群聊 → 添加机器人 → 复制 webhook URL（带 key=）\n" +
    "  • Server酱：https://sctapi.ftqq.com/你的SendKey.send\n\n" +
    "推送内容为 JSON（title/message/urgency）。\n" +
    "注意：不同服务的 JSON 格式要求可能不同，若失败需检查其文档。继续？",
  );
  if (!guide) { ui.notify("已取消配置。", "info"); return; }

  config.pushProvider = "webhook";
  for (;;) {
    const url = await ui.input("Webhook URL（如 Bark: https://api.day.app/设备码；企业微信: .../send?key=...）:", config.webhookUrl);
    if (url === undefined) { ui.notify("已取消配置。", "info"); return; }
    const token = await ui.input("Token（可选，放指定 header 认证；可填 ${ENV_VAR}）:", config.webhookToken);
    if (token === undefined) { ui.notify("已取消配置。", "info"); return; }
    const header = await ui.input("Token 所在 Header（默认 Authorization，回车跳过）:", config.webhookTokenHeader || "Authorization");
    if (header === undefined) { ui.notify("已取消配置。", "info"); return; }

    const finalUrl = url.trim();
    if (!finalUrl) { ui.notify("URL 不能为空。", "warning"); continue; }
    const finalToken = token.trim();
    const finalHeader = header.trim() || "Authorization";

    const decision = await confirmPreview(ui, "📋 配置预览",
      `URL:    ${finalUrl}\n` +
      `Token:  ${finalToken ? maskToken(finalToken) : "未填"}\n` +
      `Header: ${finalHeader}`);
    if (decision === null) { ui.notify("已取消配置。", "info"); return; }
    if (decision === false) continue; // 重新填写

    config.webhookUrl = finalUrl;
    config.webhookToken = finalToken;
    config.webhookTokenHeader = finalHeader;
    config.phonePush = true;
    config.setupDone = true;
    await saveConfig();

    // ── 自动提升音量（需用户明确允许）──
    const volOk = await ui.confirm(
      "🔊 自动提升系统音量？",
      "离开时如果系统音量低于 80%，自动拉高，回来时恢复。\n" +
      "防止静音状态下听不到呼喊。\n\n允许？",
    );
    config.boostVolume = volOk === true;
    await saveConfig();

    const test = await ui.confirm("配置已保存！现在测试手机推送？", "是 / 否");
    if (test) {
      const ok = await testPush("webhook", ctx);
      ui.notify(ok ? "✅ 推送发送成功，请查看手机。" : "⚠️ 发送失败，请检查 URL/token/网络。", ok ? "info" : "warning");
    } else {
      ui.notify("配置已保存。", "info");
    }
    return;
  }
}

/** 单独测试手机推送通道（只走 ntfy/webhook，不响声音） */
async function testPush(provider: "ntfy" | "webhook", _ctx: { ui: any }): Promise<boolean> {
  const alert: Alert = {
    id: randomUUID(),
    time: Date.now(),
    message: "测试推送：pi 需要你！如果你看到这条，说明手机推送通道正常。",
    urgency: "normal",
    category: "test",
    repeatCount: 0,
    acked: false,
  };
  try {
    if (provider === "ntfy") await pushPhone(alert);
    else await pushWebhook(alert);
    return true;
  } catch (e) {
    console.error("[i-am-cooking] test push failed:", e);
    return false;
  }
}

async function testShout(ctx: { ui: any }): Promise<void> {
  const alert: Alert = {
    id: randomUUID(),
    time: Date.now(),
    message: "测试：这是 pi 的呼喊。如果你能听到声音/看到弹窗/收到手机推送，说明通道正常。",
    urgency: "normal",
    category: "test",
    repeatCount: 0,
    acked: false,
  };
  await fireAlert(alert, ctx);
  ctx.ui.notify("测试呼喊已发出（声音/TTS/Toast/手机推送）。请确认能感知到。", "info");
}

// ── helpers ──────────────────────────────────────────────────────────────
function extractText(msg: { role: string; content: any }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
  }
  return "";
}

// ── extension ────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  api = pi;
  // ── commands ──
  pi.registerCommand("i-am-cooking", {
    description: "I am cooking: 离开模式。用法: on [备注] / off / status / setup / test",
    // 输入 /i-am-cooking 后按 Tab/空格 弹出子命令菜单
    getArgumentCompletions: (prefix: string) => {
      const subs: { value: string; label: string; description?: string }[] = [
        { value: "on", label: "on", description: "开启离开模式（可加备注，如: on 继续做登录模块）" },
        { value: "off", label: "off", description: "我回来了，让 agent 汇报" },
        { value: "status", label: "status", description: "查看模式 / 待处理呼喊 / 通道 / token 状态" },
        { value: "setup", label: "setup", description: "配置手机推送（首次使用，交互式向导）" },
        { value: "test", label: "test", description: "测试所有通道（声音/TTS/Toast/手机）" },
        { value: "rules", label: "rules", description: "查看当前生效规则" },
        { value: "edit-rules", label: "edit-rules", description: "编辑规则文件（保存即生效）" },
        { value: "reset-rules", label: "reset-rules", description: "规则恢复出厂默认（内置规则）" },
        { value: "level", label: "level", description: "自主等级：conservative 谨慎(遇墙就喊) / balanced 平衡(默认) / autonomous 放手(能不喊就不喊)" },
      ];
      const filtered = subs.filter((s) => s.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg === "off") { turnOff(ctx, "command"); return; }
      if (arg === "status") { showStatus(ctx); return; }
      if (arg === "setup") { await setupWizard(ctx); return; }
      if (arg === "test") { await testShout(ctx); return; }
      if (arg === "rules") {
        const rules = await loadRules();
        ctx.ui.notify(
          `📋 当前生效规则：\n\n${rules}\n\n` +
          `[底线规则（系统强制，无法从此文件删除）]\n${GUARD_RAIL}\n\n` +
          `— 来源：${await fileExists(RULES_PATH) ? RULES_PATH : "（尚未创建，首次离开时自动用内置默认填充）"}\n` +
          `— 编辑：/i-am-cooking edit-rules（或直接改该文件）\n— 恢复出厂默认：/i-am-cooking reset-rules\n— 出厂默认模板：仓库内 ${DEFAULT_RULES_PATH}（进 git，随版本更新）`,
          "info",
        );
        return;
      }
      if (arg === "reset-rules") {
        await mkdir(CONFIG_DIR, { recursive: true });
        await writeFile(RULES_PATH, await loadDefaultRules(), "utf8");
        ctx.ui.notify("♻️ 规则已恢复为出厂默认（来自仓库 rules.default.md）。", "info");
        return;
      }
      if (arg === "edit-rules") {
        await ensureRulesFile();
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify(`请直接编辑 ${RULES_PATH}`, "warning");
          return;
        }
        const initial = await readFile(RULES_PATH, "utf8");
        const saved = await ctx.ui.editor(`编辑规则文件（保存后立即生效，这部分就是唯一生效的规则）: ${RULES_PATH}`, initial);
        if (saved !== undefined && saved !== null) {
          await writeFile(RULES_PATH, saved, "utf8");
          ctx.ui.notify("✅ 规则已保存，下次离开模式回合立即生效。", "info");
        } else {
          ctx.ui.notify("已取消编辑，规则未修改。", "info");
        }
        return;
      }
      if (arg === "level") {
        const cur = config.autonomyLevel || "balanced";
        // 无参数 → 查看当前等级和选项
        if (!arg.split(/\s+/)[1]) {
          ctx.ui.notify(
            `🚀 当前自主等级：${AUTONOMY_LABEL[cur]}\n\n可选：\n` +
            `  conservative —— 谨慎（遇墙就喊：验证码/登录/手动点击等人类墙，需要决策/审批/澄清先喊我）\n` +
            `  balanced     —— 平衡（有点难度才喊，默认：普通决策自主推进，人类墙/选错代价大才喊）\n` +
            `  autonomous   —— 放手（能不喊就不喊：尽量自决，只有彻底无法继续才喊）\n\n` +
            `用法：/i-am-cooking level conservative|balanced|autonomous\n也可以在 on 备注里说（如：on 谨慎点继续）、或直接说"遇墙就喊我"，我都会听懂。`,
            "info",
          );
          return;
        }
        const target = arg.split(/\s+/)[1].toLowerCase() as AutonomyLevel;
        if (target === "conservative" || target === "balanced" || target === "autonomous") {
          setAutonomyLevel(target, "你执行了 /i-am-cooking level 命令", ctx);
        } else {
          ctx.ui.notify("❌ 未知等级，可选：conservative / balanced / autonomous", "warning");
        }
        return;
      }
      const note = arg.startsWith("on") ? arg.slice(2).trim() : arg;
      turnOn(ctx, note);
    },
  });

  // ── tool (LLM 调用) ──
  pi.registerTool({
    name: "shout_for_user",
    label: "Shout For User",
    description:
      "大声呼喊离开的用户（例如在做饭）。仅在你被真正卡住、只有用户能解决时调用：需要决策、凭据、审批或澄清。" +
      "给出简短、用户可直接行动的消息。若 cooking 模式未开启，它只会告诉你用户就在电脑前，直接在对话里问即可。",
    promptSnippet: "Loudly alert the away user when you are blocked and need their input",
    promptGuidelines: [
      "Use shout_for_user only when truly blocked and only the user can unblock you. Never end your turn silently waiting for input when cooking mode is active — shout instead, then continue with reasonable defaults.",
    ],
    parameters: Type.Object({
      message: Type.String({
        description: "简短可执行的消息，例如：\"需要你决定方案 A 还是 B；我先按 A 继续\"。",
      }),
      urgency: StringEnum(["info", "normal", "urgent"] as const),
      category: Type.Optional(Type.String({
        description: "分类：decision / credential / approval / clarification / help 等",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!config.cooking) {
        return {
          content: [{ type: "text", text: "Cooking 模式未开启——用户就在电脑前，直接在对话里问即可，未发送呼喊。" }],
          details: { fired: false },
        };
      }
      const queued = queueAlert(params.message, params.urgency, params.category ?? "other", ctx);
      return {
        content: [{ type: "text", text: queued
          ? `呼喊已发出（${params.urgency}）。继续用最合理的默认方案推进，并在回复里注明你的假设；用户回来后会自动收到你的汇报。`
          : "已有同内容的未确认呼喊，不重复发送。" }],
        details: { fired: queued, urgency: params.urgency, category: params.category ?? "other" },
      };
    },
  });

  // 工具：根据用户原话动态调整呼喊偏好（agent 语义理解入口）
  pi.registerTool({
    name: "set_calling_preference",
    label: "Set Calling Preference",
    description:
      "根据用户的原话或意图调整呼喊偏好。用户明确表达时（如\"别喊了\"\"完成后喊我\"\"只有紧急才找我\"\"随时汇报\"）必须调用。" +
      "选择模式：normal（默认）/ silence（全部静音只留横幅）/ completion_only（只在完成时喊）/ urgent_only（只在紧急时喊）/ eager（需要你+完成+进度都喊）。",
    promptSnippet: "Adjust how loudly the away user is alerted based on their explicit words",
    promptGuidelines: [
      "Use set_calling_preference when the user explicitly changes their alert preference: \"别喊了\"→silence, \"完成后喊我\"→completion_only, \"只有紧急才找我\"→urgent_only, \"随时汇报\"→eager, \"需要时再喊\"→normal.",
    ],
    parameters: Type.Object({
      mode: StringEnum(["normal", "silence", "completion_only", "urgent_only", "eager"] as const),
      reason: Type.String({ description: "依据的用户原话或推理，例如：\"用户说：完成后喊我\"" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!config.cooking) {
        return {
          content: [{ type: "text", text: "未在离开模式，偏好不生效。" }],
          details: { mode: params.mode, applied: false },
        };
      }
      setCallingMode(params.mode, params.reason, ctx);
      return {
        content: [{ type: "text", text: `呼喊偏好已切换为：${CALLING_MODE_LABEL[params.mode]}（依据：${params.reason}）` }],
        details: { mode: params.mode, applied: true, reason: params.reason },
      };
    },
  });

  // 工具：根据用户原话调整自主等级（agent 语义理解入口）
  pi.registerTool({
    name: "set_autonomy_level",
    label: "Set Autonomy Level",
    description:
      "根据用户的原话或意图调整自主等级：遇到阻塞时「该不该喊用户」的阈值。" +
      "conservative 谨慎：遇墙就喊（人类墙：验证码/登录/手动点击等必须人手动的阻塞；需要决策/审批/凭据/澄清先喊我）。" +
      "balanced 平衡（默认）：有点难度才喊（普通决策自主推进并注明假设，只有人类墙或选错代价大才喊）。" +
      "autonomous 放手：能不喊就不喊（尽量自决，只有任务彻底无法继续才喊）。" +
      "用户明确表达时（如\"拿不准就问我\"→conservative，\"能不喊就不喊\"→autonomous）必须调用。",
    promptSnippet: "Adjust how much autonomy the agent has when the away user is blocked (when to call for them)",
    promptGuidelines: [
      "Use set_autonomy_level when the user explicitly expresses how much they want to be asked/troubled: \"拿不准就问我\"→conservative, \"有难度才喊我\"→balanced, \"能不喊就不喊\"→autonomous.",
    ],
    parameters: Type.Object({
      level: StringEnum(["conservative", "balanced", "autonomous"] as const),
      reason: Type.String({ description: "依据的用户原话或推理，例如：\"用户说：遇墙就喊我\"" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      setAutonomyLevel(params.level, params.reason, ctx);
      return {
        content: [{ type: "text", text: `自主等级已切换为：${AUTONOMY_LABEL[params.level]}（依据：${params.reason}）` }],
        details: { level: params.level, applied: true, reason: params.reason },
      };
    },
  });

  // ── events ──
  pi.on("session_start", async (_event, ctx) => {
    await loadConfig();
    await ensureRulesFile(); // 首次启动用内置默认创建规则文件，已存在则不动
    if (config.cooking) {
      ctx.ui.setStatus("i-am-cooking", "🍳 离开中（I am cooking）");
      updateWidget(ctx);
      void boostVolume(); // 恢复 session 时重新拉高音量
      // 恢复未确认的 urgent 呼喊的重复提醒
      for (const a of pendingAlerts().filter((x) => x.urgency === "urgent")) {
        scheduleRepeats(a, ctx);
      }
    } else if (!config.setupDone) {
      // 初次使用：提醒配置手机推送
      ctx.ui.notify(
        "🍳 I am cooking 插件已加载。首次使用建议运行 /i-am-cooking setup 配置手机推送（人在厨房也能收到呼喊）。",
        "info",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    clearRepeatTimers();
    void restoreVolume(); // 退出时恢复音量
    await saveConfig();
  });

  // 离开模式时，每回合注入自主推进规则
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!config.cooking) return;
    return {
      systemPrompt: event.systemPrompt + (await buildRulesPrompt()),
    };
  });

  // 自动检测: 回合结束且以"？"结尾 → agent 在等用户 → 自动呼喊（安全网）
  pi.on("agent_settled", async (_event, ctx) => {
    if (!config.cooking || !config.autoDetect) return;
    try {
      const entries = ctx.sessionManager.getEntries();
      let lastAssistant: { text: string; stopReason?: string } | undefined;
      let trailingWork = false;

      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type !== "message") continue;
        const m = e.message;
        if (m.role === "toolResult" || m.role === "bashExecution") { trailingWork = true; break; }
        if (m.role === "assistant") {
          const text = extractText(m).trim();
          if (text) lastAssistant = { text, stopReason: m.stopReason };
          break;
        }
        if (m.role === "user") break; // 用户消息在最后 → 不是 agent 在等
      }

      if (!lastAssistant || trailingWork) return;
      const text = lastAssistant.text;

      // 回合报错 → 需要用户看一眼（任何等级都喊）
      if (lastAssistant.stopReason === "error") {
        queueAlert(`Agent 回合报错，可能需要你处理：${text.slice(0, 300)}`, "urgent", "auto-error", ctx);
        return;
      }
      // 以"？"结尾的短问题 → 在等你回复（autonomous 放手等级不自动喊：用户已说能不喊就不喊）
      const level = config.autonomyLevel || "balanced";
      if (level === "autonomous") return;
      if (text.length <= 600 && /[?？]\s*$/.test(text)) {
        queueAlert(`Agent 在等你回复：${text.slice(0, 200)}`, "normal", "auto-question", ctx);
      }
    } catch (err) {
      console.error("[i-am-cooking] auto-detect failed:", err);
    }
  });

  // 你直接打字 = 回来了 → 自动退出离开模式并让 agent 汇报
  pi.on("input", async (event, ctx) => {
    if (!config.cooking) return;
    if (event.source !== "interactive") return;
    if (event.text.trim().startsWith("/")) return; // 命令已由 command 处理

    // ① 文字匹配：用户原话里带偏好关键词 → 立即切换（不依赖 agent）
    const mode = detectPreference(event.text);
    if (mode) {
      setCallingMode(mode, `你说了："${event.text.slice(0, 40)}"`, ctx);
    }

    // ①-b 文字匹配：用户原话里带自主等级关键词 → 立即切换（持久化，跨会话保留）
    const level = detectAutonomyLevel(event.text);
    if (level) {
      setAutonomyLevel(level, `你说了："${event.text.slice(0, 40)}"`, ctx);
    }

    // ② 用户打字 = 回来了 → 退出离开模式并让 agent 汇报
    if (config.exitOnUserInput) {
      turnOff(ctx, "user-input");
    }
  });
}
