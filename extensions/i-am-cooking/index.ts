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
 *   /i-am-cooking level       — 自主等级（conservative/balanced/autonomous）
 *   /i-am-cooking limits      — 查看/调整防打扰参数（交互式中文）
 *   /i-am-cooking sound       — 自定义呼喊铃声（歌曲/试听/总时长，交互式中文）
 *
 * 工具 (LLM 调用):
 *   shout_for_user           — 卡住且只有用户能解决时调用
 *
 * 自动检测:
 *   agent_settled 后若回合以"？"结尾且没有后续工具调用 → 自动呼喊（安全网）
 *   cooking 模式下你直接打字 → 自动视为"回来了"，退出模式并让 agent 汇报
 *
 * 配置: ~/.pi/i-am-cooking/config.json （可热改，/reload 生效）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui"; // 快捷键（停止本次播放）
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile, readdir, rename } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
// 纯逻辑模块（可测试）
import { suggestTopic as suggestTopicImpl } from "./lib/topic.ts";
import { acquireAudioLock as acquireAudioLockImpl, releaseAudioLock as releaseAudioLockImpl, isProcessAlive as isProcessAliveImpl } from "./lib/audio-lock.ts";
import { renderTts as renderTtsImpl } from "./lib/tts.ts";

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
const AUDIO_LOCK_PATH = join(CONFIG_DIR, "audio.lock"); // 跨 Agent 音频互斥锁

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
  ttsText?: string; // Agent 自由语音：非空则 TTS 原样念这段，不走模板
}

interface Config {
  cooking: boolean;
  since?: number;
  alerts: Alert[];
  lastShout?: number;

  // channels
  sound: boolean;
  beeps: number;
  soundPath: string; // optional .wav/mp3, played AFTER beeps+tts as the user's custom ringtone
  soundSeconds: number; // 声音播放总时长上限（秒），到点强制停止，默认 60
  tts: boolean;
  ttsTemplate: string; // 模板，支持 {message} 和 {shoutPhrase} 占位
  shoutPhrase: string; // 呼喊短语（默认 "agent 需要你"），用户可自定义，用于所有呼喊文案
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
  repeatIntervalMinutes: number; // normal 重复间隔
  urgentRepeatMinutes: number;   // urgent 重复间隔
  maxUrgentRepeats: number;      // -1 = 一直喊到回来
  boostVolume: boolean;          // 离开时自动提升系统音量（需用户允许）
  boostLevel: number;            // 提升到多少（0-100，默认 80）
  callingMode: CallingMode;      // 呼喊偏好（agent 依据用户原话动态设置）
  autonomyLevel: AutonomyLevel;  // 自主等级（持久化；遇到阻塞时该不该喊）
  maxCompletionNotices: number;  // 每次离开最多喊几次完成（防打扰）
  ttsTemplateCompletion: string; // 完成时的 TTS 文案
  progressReporting: "milestone" | "interval" | "none"; // 进度汇报模式：小阶段完成时 / 定时 / 不汇报
  reportIntervalMinutes: number;   // 定时汇报间隔（分钟，默认 15）
  ttsTemplateMilestone: string;  // 小阶段完成时的 TTS 文案
  milestoneBeeps: number;        // 小阶段完成时的提示音次数（默认 1，轻声）
}

const DEFAULTS: Config = {
  cooking: false,
  alerts: [],
  sound: true,
  beeps: 4,
  soundPath: "",
  soundSeconds: 60,
  tts: true,
  ttsTemplate: "主人，快来！{shoutPhrase}！{message}",
  shoutPhrase: "agent 需要你",
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
  repeatIntervalMinutes: 3,
  urgentRepeatMinutes: 1,
  maxUrgentRepeats: -1,
  boostVolume: false, // 默认关，需在 setup 里允许
  boostLevel: 80,
  callingMode: "normal",
  autonomyLevel: "balanced", // 默认：有点难度才喊
  maxCompletionNotices: 3,
  ttsTemplateCompletion: "主人，好消息！任务完成了！{message}",
  progressReporting: "milestone", // 默认：小阶段完成时汇报
  reportIntervalMinutes: 15,
  ttsTemplateMilestone: "小进展：{message}",
  milestoneBeeps: 1,
};

// ── state ────────────────────────────────────────────────────────────────
let api: ExtensionAPI; // set by factory; needed by turnOn/turnOff
let config: Config = { ...DEFAULTS };
let repeatTimers: ReturnType<typeof setInterval>[] = [];
// 当前是否正在响铃播放（状态栏/横幅指示用；仅反映本实例，多 Agent 间互不影响）
let shoutingState = false;

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

// ── 音频文件浏览（sound 命令用）──────────────────────────────────────────
const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".aiff", ".aif", ".ogg", ".flac"];

function isAudioFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return AUDIO_EXT.includes(ext);
}

/**
 * 交互式浏览文件夹选择音频文件（TUI）。
 * 从 startDir 开始：显示子文件夹 + 音频文件，选文件夹进入下一级，选文件返回其路径。
 * 支持：返回上级 / 手动输入路径 / Esc 取消。
 * 返回选中的音频文件路径，取消则 null。
 */
async function browseAudioFile(ui: any, startDir: string): Promise<string | null> {
  let dir = startDir;
  for (;;) {
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      const items = await readdir(dir, { withFileTypes: true });
      entries = items
        .filter((d) => d.isDirectory() || isAudioFile(d.name))
        .sort((a, b) => {
          // 文件夹在前，按名称排序
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      ui.notify(`❌ 无法读取目录：${dir}`, "warning");
      return null;
    }

    const options: string[] = [
      ...entries.map((e) => (e.isDir ? `📁 ${e.name}/` : `🔊 ${e.name}`)),
      "📂 手动输入路径",
      "⬆️ 返回上级",
    ];
    const pick = await ui.select(`🔊 选择音频文件（当前：${dir}）:`, options);
    if (!pick) return null; // Esc 取消

    if (pick === "📂 手动输入路径") {
      const p = await ui.input("输入完整路径（回车取消）:", "");
      if (!p || !p.trim()) continue;
      const t = p.trim().replace(/^~\//, `${homedir()}/`);
      if (isAudioFile(t)) return t;
      // 输入的是目录 → 进入该目录
      dir = t;
      continue;
    }
    if (pick === "⬆️ 返回上级") {
      const parent = dir.replace(/\/[^/]+\/?$/, "");
      if (parent && parent !== dir) dir = parent;
      continue;
    }
    // 选中的是文件或文件夹
    const selected = entries.find((e) => (e.isDir ? `📁 ${e.name}/` : `🔊 ${e.name}`) === pick);
    if (!selected) continue;
    if (selected.isDir) {
      dir = `${dir}/${selected.name}`;
    } else {
      return `${dir}/${selected.name}`;
    }
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

// 全局跟踪正在播放的音频进程（用户回来/关会话时 stopAllAudio 立即掐断）
let activeAudioProcs: ReturnType<typeof spawn>[] = [];

/**
 * spawn 播放器进程，最多播放 maxMs 毫秒后强制 kill（避免超长歌曲一直响）。
 * 返回 Promise（进程退出/出错/被杀 都 resolve）。
 */
function playProcess(cmd: string, args: string[], maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const proc = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    activeAudioProcs.push(proc);
    proc.on("error", () => { activeAudioProcs = activeAudioProcs.filter((p) => p !== proc); finish(); });
    proc.on("exit", () => { activeAudioProcs = activeAudioProcs.filter((p) => p !== proc); finish(); });
    if (maxMs > 0) setTimeout(() => { proc.kill(); finish(); }, maxMs);
  });
}

/** 停止所有正在播放的音频（用户回来/关会话/停止本次播放时调用，立即安静） */
function stopAllAudio(): void {
  for (const proc of activeAudioProcs) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  activeAudioProcs = [];
  shoutingState = false; // 已安静，状态栏/横幅恢复
}

// ── 跨 Agent 音频互斥锁（逻辑在 lib/audio-lock.ts，可测试）────────────────────
function isProcessAlive(pid: number): boolean { return isProcessAliveImpl(pid); }
async function acquireAudioLock(force: boolean): Promise<boolean> {
  return acquireAudioLockImpl(AUDIO_LOCK_PATH, force);
}
async function releaseAudioLock(): Promise<void> {
  await releaseAudioLockImpl(AUDIO_LOCK_PATH);
}


/**
 * 三段式顺序播放：① 短铃声(beeps) → ② Agent 语音(TTS) → ③ 用户自定义歌曲(soundPath)。
 * 共用 soundSeconds 总预算：从开始响到强制停止，到点 kill 掉还在播的歌曲。
 * 跨 Agent 互斥：多个 pi 同时离开时，同一时刻只放一个声音（后到的跳过声音）。
 */
async function playSound(beeps: number, soundPath: string, ttsText: string, opts: { force?: boolean } = {}): Promise<void> {
  // 音频互斥锁：其他 Agent 正在播 → 本次跳过声音（只留弹窗/推送/横幅）
  const acquired = await acquireAudioLock(opts.force ?? false);
  if (!acquired) return;
  try {
    const totalMs = Math.max(5, (config.soundSeconds ?? 60)) * 1000;
    const startedAt = Date.now();
    const remainingMs = () => Math.max(0, totalMs - (Date.now() - startedAt));
    const p = process.platform;

    // ① 短铃声（beeps）
    if (beeps > 0) {
      try {
        if (p === "win32") {
          await runPowerShellScript("shout.ps1", { beeps, soundPath: "", ttsText: "" });
        } else if (p === "darwin") {
          await runCommand("osascript", ["-e", `beep ${Math.min(beeps, 5)}`], { timeoutMs: 3000 });
        } else {
          await runCommand("canberra-gtk-play", ["-i", "message"], { timeoutMs: 3000 }).catch(() => {});
        }
      } catch { /* best effort */ }
    }

    // ② Agent 语音（TTS）
    if (ttsText) {
      await speakTts(ttsText);
    }

    // ③ 用户自定义歌曲（soundPath）— 最多播到总预算剩余
    if (soundPath && remainingMs() > 500) {
      try {
        if (p === "win32") {
          await runPowerShellScript("shout.ps1", { beeps: 0, soundPath, ttsText: "" });
        } else if (p === "darwin") {
          await playProcess("afplay", [soundPath], remainingMs());
        } else {
        await playProcess("paplay", [soundPath], remainingMs()).catch(() =>
          playProcess("aplay", [soundPath], remainingMs()),
        );
      }
    } catch { /* best effort */ }
  }
  } finally {
    await releaseAudioLock(); // 播放完/被中断都释放锁
  }
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
let savedMuted: boolean | null = null;    // macOS：离开前的静音标志（restore 时还原）

/** 读取当前系统音量（0-100）；失败返回 null */
async function getSystemVolume(): Promise<number | null> {
  const p = process.platform;
  try {
    if (p === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", join(SCRIPTS, "volume.ps1"), "-Action", "get",
      ], { timeout: 15_000, windowsHide: true });
      const m = stdout.match(/volume=([\d.]+)/);
      return m ? Math.round(parseFloat(m[1]) * 100) : null;
    } else if (p === "darwin") {
      const { stdout } = await execFileAsync("osascript", ["-e", "output volume of (get volume settings)"], { windowsHide: true });
      const n = parseInt(stdout.trim(), 10);
      return isNaN(n) ? null : n;
    } else {
      const { stdout } = await execFileAsync("pactl", ["get-sink-volume", "@DEFAULT_SINK@"], { windowsHide: true });
      const m = stdout.match(/(\d+)%/);
      return m ? parseInt(m[1], 10) : null;
    }
  } catch {
    return null;
  }
}

/** 设置系统音量（0-100）；返回是否成功 */
async function setSystemVolume(level: number): Promise<boolean> {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  const p = process.platform;
  try {
    if (p === "win32") {
      await runPowerShellScript("volume.ps1", { action: "set", level: clamped / 100 });
    } else if (p === "darwin") {
      // macOS：设置音量会自动解除静音
      await execFileAsync("osascript", ["-e", `set volume output volume ${clamped}`], { windowsHide: true });
    } else {
      await execFileAsync("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${clamped}%`], { windowsHide: true });
    }
    return true;
  } catch (e) {
    console.error("[i-am-cooking] setSystemVolume failed:", (e as Error).message);
    return false;
  }
}

/** 切换静音（macOS/Linux 支持）；返回操作后的静音状态，失败返回 null */
async function toggleMute(mute: boolean): Promise<boolean | null> {
  const p = process.platform;
  try {
    if (p === "darwin") {
      await execFileAsync("osascript", ["-e", `set volume output muted ${mute}`], { windowsHide: true });
      return mute;
    } else if (p === "linux") {
      const arg = mute ? "mute" : "unmute";
      await execFileAsync("pactl", ["set-sink-mute", "@DEFAULT_SINK@", arg], { windowsHide: true });
      return mute;
    } else if (p === "win32") {
      // Windows：走 volume.ps1 的 mute/unmute action（Core Audio API）
      await runPowerShellScript("volume.ps1", { action: mute ? "mute" : "unmute" });
      return mute;
    }
    return null;
  } catch (e) {
    console.error("[i-am-cooking] toggleMute failed:", (e as Error).message);
    return null;
  }
}

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
      // 同时记录音量和静音标志：macOS 的 `set volume output volume N` 会自动取消静音，
      // 所以离开前若是静音（或 Mute 键触发的 muted=true 但音量非 0），回来时必须还原 muted。
      const { stdout } = await execFileAsync("osascript", ["-e", "get volume settings"], { windowsHide: true });
      const mutedMatch = stdout.match(/output\s+muted:(true|false)/);
      const volMatch = stdout.match(/output\s+volume:(\d+)/);
      savedMuted = mutedMatch ? mutedMatch[1] === "true" : null;
      const cur = volMatch ? parseInt(volMatch[1], 10) : NaN;
      savedVolumePct = isNaN(cur) ? null : cur;
      const newLevel = Math.max(isNaN(cur) ? 0 : cur, target);
      // 设置音量（会自动取消静音，保证能喊醒你）
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
    savedMuted = null;
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
      // 恢复音量和静音状态（离开前若是静音，这里必须还原 muted）
      await execFileAsync("osascript", ["-e", `set volume output volume ${savedVolumePct}`], { windowsHide: true });
      if (savedMuted !== null) {
        await execFileAsync("osascript", ["-e", `set volume output muted ${savedMuted}`], { windowsHide: true });
      }
    } else {
      await execFileAsync("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${savedVolumePct}%`], { windowsHide: true });
    }
  } catch (e) {
    console.error("[i-am-cooking] restoreVolume failed:", (e as Error).message);
  }
  savedVolumePct = null;
  savedMuted = null;
}

async function pushPhone(alert: Alert): Promise<boolean> {
  // 返回是否发送成功（未配置 topic / 网络失败均视为失败）
  const topic = config.ntfyTopic?.trim();
  if (!topic) return false;
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
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      body: `[${alert.urgency}] ${alert.message}`,
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[i-am-cooking] ntfy push failed: HTTP ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[i-am-cooking] ntfy push failed:", (e as Error).message);
    return false;
  }
}

async function pushWebhook(alert: Alert): Promise<boolean> {
  // 返回是否发送成功（未配置 URL / 网络失败均视为失败）
  const url = config.webhookUrl?.trim();
  if (!url) return false;
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
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `🍳 ${config.shoutPhrase || "agent 需要你"}！`,
        message: alert.message,
        urgency: alert.urgency,
        category: alert.category,
        time: new Date(alert.time).toISOString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[i-am-cooking] webhook push failed: HTTP ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[i-am-cooking] webhook push failed:", (e as Error).message);
    return false;
  }
}

function renderTts(alert: Alert): string {
  // 逻辑在 lib/tts.ts（可测试）
  return renderTtsImpl(
    {
      ttsTemplate: config.ttsTemplate,
      ttsTemplateCompletion: config.ttsTemplateCompletion,
      ttsTemplateMilestone: config.ttsTemplateMilestone,
      shoutPhrase: config.shoutPhrase,
    },
    alert,
  );
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

/**
 * 发出呼喊（widget + TUI 提示，以及未被偏好静音时的声音/TTS/弹窗/手机推送）。
 * 返回手机推送是否成功：未配置或偏好静音跳过 = true；只有配置了且发送失败才 false。
 * 手机推送按 pushProvider 分发（ntfy / webhook），避免双发；兼容旧配置（未走向导直接填 webhookUrl）。
 */
async function fireAlert(alert: Alert, ctx: { ui: any }, opts: { forceSound?: boolean } = {}): Promise<boolean> {
  config.lastShout = Date.now();
  const suppress = shouldSuppress(alert);
  const isCompletion = alert.category === "completion";
  const isMilestone = alert.category === "milestone";
  const forceSound = opts.forceSound ?? false;

  // ── widget + TUI notify（无论是否 suppress 都显示）──
  if (ctx?.ui) {
    const icon = isCompletion ? "✅" : isMilestone ? "📈" : "⚠";
    const label = isCompletion ? "完成通知" : isMilestone ? "小阶段完成" : `${config.shoutPhrase || "agent 需要你"}！[${alert.urgency}]`;
    ctx.ui.notify(`🍳 ${icon} ${label} ${alert.message}`, suppress ? "info" : "warning");
    updateWidget(ctx);
  }

  // ── 响铃 / 推送（suppress 时跳过）──
  if (suppress) return true;
  // 三层音频区分：
  //   🚨 需要你  → 完整三段式（beeps + 语音 + 自定义歌曲），最醒目
  //   ✅ 整个完成 → beeps 2 声 + 完成语音（不播歌曲，安静报喜）
  //   📈 小阶段   → beeps 1 声 + 简短语音（轻声，不打断思路）
  // 声音不阻塞后续通道：fire-and-forget，最长 soundSeconds 秒后自动停
  if (config.sound || config.tts) {
    // 状态栏/横幅：响铃期间显示“正在喊你”，播完自动恢复“🍳 离开中”
    shoutingState = true;
    updateStatus(ctx, "shouting", alert.urgency);
    updateWidget(ctx);
    const done = () => { shoutingState = false; updateStatus(ctx, "idle"); updateWidget(ctx); };
    if (isMilestone) {
      void playSound(config.sound ? config.milestoneBeeps : 0, "", config.tts ? renderTts(alert) : "", { force: forceSound }).then(done).catch(done);
    } else if (isCompletion) {
      void playSound(config.sound ? 2 : 0, "", config.tts ? renderTts(alert) : "", { force: forceSound }).then(done).catch(done);
    } else {
      void playSound(
        config.sound ? config.beeps : 0,
        config.sound ? config.soundPath : "",
        config.tts ? renderTts(alert) : "",
        { force: forceSound },
      ).then(done).catch(done);
    }
  }
  if (config.toast) {
    const title = isCompletion ? "任务完成" : isMilestone ? "小阶段完成" : config.shoutPhrase || "agent 需要你";
    await showNotification(`🍳 ${title}`, `[${alert.urgency}] ${alert.message}`);
  }

  // ── 手机推送（按 pushProvider 分发；兼容旧配置：未走向导但直接填了 webhookUrl）──
  if (config.phonePush) {
    return config.pushProvider === "ntfy" ? await pushPhone(alert) : await pushWebhook(alert);
  }
  if (config.webhookUrl) return await pushWebhook(alert);
  return true;
}

/** 更新状态栏：idle=🍳 离开中 / shouting=📣 正在喊你（带本次停止提示） */
function updateStatus(ctx: { ui: any }, phase: "idle" | "shouting", urgency?: string): void {
  if (!ctx?.ui) return;
  if (!config.cooking) { ctx.ui.setStatus("i-am-cooking", ""); return; }
  ctx.ui.setStatus(
    "i-am-cooking",
    phase === "shouting"
      ? ctx.ui.theme.fg("warning", `📣 正在喊你！[${urgency ?? ""}]（Ctrl+Alt+M 停止本次播放）`)
      : "🍳 离开中（I am cooking）",
  );
}

function updateWidget(ctx: { ui: any }): void {
  if (!ctx?.ui) return;
  if (!config.tuiBanner) { ctx.ui.setWidget("i-am-cooking", []); return; }
  const pending = pendingAlerts();
  const lines = config.cooking
    ? [
        "🍳 离开中（I am cooking）— 需要你时我会大声喊你。",
        ...(shoutingState ? ["  🔕 正在响铃 — 按 Ctrl+Alt+M 停止本次播放（下次照常）"] : []),
        ...pending.map((a, i) => `  ⚠ ${i + 1}. [${a.urgency}] ${a.message}`),
      ]
    : [];
  ctx.ui.setWidget("i-am-cooking", lines);
}

/** 停止本次播放：只掐当前音频，不改配置、不清待处理呼喊、不影响下次呼喊 */
function stopCurrentSound(ctx: { ui: any }): void {
  const hadAudio = shoutingState || activeAudioProcs.length > 0;
  stopAllAudio();
  updateStatus(ctx, "idle");
  updateWidget(ctx);
  ctx.ui.notify(
    hadAudio
      ? "🔕 已停止本次播放。下次呼喊照常响铃。"
      : "🔕 当前没有正在播放的声音。下次呼喊照常响铃。",
    "info",
  );
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

// ── 定时汇报（progressReporting = interval）──────────────────────────────
let reportTimer: ReturnType<typeof setInterval> | null = null;

/** 启动定时汇报：每 N 分钟给 agent 发"请汇报进度"，agent 响应后汇报到本地+手机 */
function startReportTimer(ctx: { ui: any }): void {
  stopReportTimer();
  const minutes = Math.max(1, Math.min(120, config.reportIntervalMinutes || 15));
  reportTimer = setInterval(() => {
    if (!config.cooking) return;
    const msg = `[定时汇报] 到点了，请汇报当前进度：\n` +
      `- 已完成什么？\n- 正在做什么？\n- 有无进展（没有新进展就如实说明原因，卡住了就说卡在哪、是否需要用户）`;
    void api.sendUserMessage(msg, { deliverAs: "followUp" });
  }, minutes * 60_000);
  repeatTimers.push(reportTimer); // 并入重复计时器，随 off/会话结束一起清理
}

function stopReportTimer(): void {
  if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
}

function queueAlert(message: string, urgency: Urgency, category: string, ctx: { ui: any }, ttsText?: string): boolean {
  if (!config.cooking) return false;

  // milestone（小阶段完成）仅在 progressReporting = milestone 模式提醒；interval/none 忽略
  if (category === "milestone") {
    if (config.progressReporting !== "milestone") return false;
  }

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
    ttsText,
  };
  config.alerts.push(alert);
  void saveConfig();
  void fireAlert(alert, ctx);
  scheduleRepeats(alert, ctx);
  return true;
}

// ── mode control ─────────────────────────────────────────────────────────
/**
 * 无条件清理离开状态：任何会话启动都从"在岗"开始。
 * 离开是临时/单次状态，不跨会话存活（会话关闭后重开，默认在岗，需要时再 on）。
 */
function resetCookingState(ctx: { ui: any }): void {
  clearRepeatTimers();
  stopAllAudio(); // 用户回来/新会话：立即停止正在播放的音频
  const hadCooking = config.cooking;
  const hadPending = pendingAlerts().length;
  config.cooking = false;
  config.since = undefined;
  config.alerts = [];
  config.callingMode = "normal"; // 偏好是会话级的，每次会话重置
  void saveConfig();
  ctx.ui.setStatus("i-am-cooking", "");
  ctx.ui.setWidget("i-am-cooking", []);
  void restoreVolume(); // 若上次离开拉高了音量，恢复原值
  if (hadCooking && hadPending) {
    ctx.ui.notify(`🍳 上次会话的离开状态已清理（现在在岗）。上次离开时被喊了 ${hadPending} 次，已随会话结束归档。`, "info");
  }
}

async function turnOn(ctx: { ui: any; hasUI?: boolean; mode?: string }, note: string, askMilestone = false): Promise<void> {
  // 幂等：已在离开模式则不再重复开启（供 Agent 工具复用，避免重复发指令/拉音量）
  if (config.cooking) return;
  config.cooking = true;
  config.since = Date.now();
  completionNoticeCount = 0; // 新的一轮离开，重置完成通知计数
  void saveConfig();
  ctx.ui.notify(`🍳 离开模式已开启。${config.shoutPhrase || "agent 需要你"}时我会大声喊你。`, "info");
  updateStatus(ctx, "idle");
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

  // 进度汇报模式：每次手动开启时询问用户（TUI 模式）；Agent 开启/非 TUI 用当前配置
  if (askMilestone && ctx.hasUI && ctx.mode === "tui") {
    const pick = await ctx.ui.select("📈 进度汇报·可选-手机通知", [
      "① 小阶段完成时（默认）",
      "② 定时（每15分钟）",
      "③ 不汇报",
    ], {
      footer: "紧急 / 完成 → 照常声音+弹窗+手机通知",
    });
    if (pick) {
      if (pick.includes("①")) config.progressReporting = "milestone";
      else if (pick.includes("②")) {
        config.progressReporting = "interval";
        const v = await ctx.ui.input("定时汇报间隔（分钟，默认 15）:", String(config.reportIntervalMinutes || 15));
        const n = parseInt((v ?? "").trim(), 10);
        if (!isNaN(n) && n >= 1 && n <= 120) config.reportIntervalMinutes = n;
        else config.reportIntervalMinutes = 15;
      }
      else config.progressReporting = "none";
      await saveConfig();
    }
  }

  // interval 模式：启动定时汇报定时器
  if (config.progressReporting === "interval") {
    startReportTimer(ctx);
  }

  const noteText = note ? `备注：${note}` : "";
  const level = config.autonomyLevel || "balanced";
  const progressHint =
    config.progressReporting === "milestone"
      ? `\n小阶段完成提醒已开启：达到重要小节点时，调用 shout_for_user（category="milestone", urgency="info"）轻声通知我。`
      : config.progressReporting === "interval"
        ? `\n定时汇报已开启：每 ${config.reportIntervalMinutes || 15} 分钟，你会收到一条“请汇报当前进度”的消息，届时汇报当前进展（即使没有新进展也要如实说明，卡住了就说卡在哪）。`
        : "";
  void api.sendUserMessage(
    `[I am cooking] 我离开去做饭了，不在电脑前。${noteText}\n` +
    `当前自主等级：${AUTONOMY_LABEL[level]}。具体行动指南见注入的 [自主等级指南]（含人类墙等场景的喊我阈值）。\n` +
    `请自主推进任务：能自己解决的就自己解决（采用最合理的默认方案，并在回复里注明你的假设），保证质量，不要降低标准；` +
    `只有达到当前等级的喊我阈值（见 [自主等级指南]）时才调用 shout_for_user 工具大声喊我。` +
    `调用前先准备好交接内容（刚好够用：决策给选项和推荐，凭据给获取方式，手动操作给步骤），准备好再喊，喊出的消息即最终版。\n` +
    `任务全部完成或达到重要里程碑时，调用 shout_for_user（category="completion", urgency="info"）通知我。` +
    progressHint,
    { deliverAs: "followUp" },
  );
}

function turnOff(ctx: { ui: any }, source: "command" | "agent-exit", userText?: string): void {
  clearRepeatTimers();
  stopAllAudio(); // 关闭离开：立即停止正在播放的音频
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
  const followUp =
    source === "command"
      ? `[I am cooking] 我回来了（执行 off 命令）。\n我不在的时候你喊了我这些事：\n${summary}\n请简要汇报当前进度，然后继续处理这些事项。`
      : `[I am cooking] 用户结束了离开模式（agent 理解判定）。\n我不在的时候你喊了我这些事：\n${summary}\n请简要汇报当前进度，然后继续处理这些事项。`;
  void api.sendUserMessage(followUp, { deliverAs: "followUp" });
}

function showStatus(ctx: { ui: any }): void {
  const pending = pendingAlerts();
  const phoneState = !config.phonePush
    ? "未启用"
    : config.pushProvider === "ntfy"
      ? `ntfy topic=${config.ntfyTopic || "(未填)"} token=${maskToken(config.ntfyToken)}`
      : `webhook ${config.webhookUrl || "(未填)"} token=${maskToken(config.webhookToken)}`;
  const lines = [
    `模式: ${config.cooking ? "🍳 离开中（I am cooking）" : "人类在岗"}`,
    ...(config.since ? [`开启时间: ${new Date(config.since).toLocaleTimeString("zh-CN")}`] : []),
    `待处理呼喊: ${pending.length}`,
    ...pending.map(
      (a, i) => `  ${i + 1}. [${a.urgency}] ${a.message}（${new Date(a.time).toLocaleTimeString("zh-CN")}，已喊 ${a.repeatCount} 次）`,
    ),
    `通道: 声音${config.sound ? "✓" : "✗"} TTS${config.tts ? "✓" : "✗"} Toast${config.toast ? "✓" : "✗"} 手机推送(${phoneState})`,
    `音量: ${config.boostVolume ? `离开自动拉高到 ${config.boostLevel}%` : "未启用"}`,
    `呼喊偏好: ${CALLING_MODE_LABEL[config.callingMode || "normal"]}`,
    `自主等级: ${AUTONOMY_LABEL[config.autonomyLevel || "balanced"]}`,
    `防打扰: 正常每 ${config.repeatIntervalMinutes} 分钟重喊 / 紧急每 ${config.urgentRepeatMinutes} 分钟重喊 / 完成通知上限 ${config.maxCompletionNotices} 次（/i-am-cooking limits 可调）`,
    `声音: 哔哔${config.sound ? `${config.beeps}声` : "关"}${config.soundPath ? ` + 自定义歌曲(${config.soundPath})` : ""} / TTS${config.tts ? "开" : "关"} / 总时长${config.soundSeconds ?? 60}秒（/i-am-cooking sound 可调）`,
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

/**
 * 生成建议的随机 topic 名：可爱词池（编程/算法/LLM 风）+ 6 位随机数字。
 * 逻辑在 lib/topic.ts（可测试）。
 */
function suggestTopic(): string {
  return suggestTopicImpl();
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
async function testPush(provider: "ntfy" | "webhook", ctx: { ui: any }): Promise<boolean> {
  const alert: Alert = {
    id: randomUUID(),
    time: Date.now(),
    message: `测试推送：${config.shoutPhrase || "agent 需要你"}！如果你看到这条，说明手机推送通道正常。`,
    urgency: "normal",
    category: "test",
    repeatCount: 0,
    acked: false,
  };
  ctx.ui.notify("⌛️ 正在发送手机测试推送，请留意手机通知…（最长等待 15 秒）", "info");
  const ok = provider === "ntfy" ? await pushPhone(alert) : await pushWebhook(alert);
  return ok;
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

  // ① 先发等待提示，再发出全部通道（声音/TTS/弹窗/手机推送），拿到真实成功/失败
  ctx.ui.notify("⌛️ 正在测试全部通道：声音 / TTS / 桌面通知 / 手机推送…请留意听到的声音与桌面弹窗。", "info");
  const suppress = shouldSuppress(alert);
  const phoneOk = await fireAlert(alert, ctx, { forceSound: true }); // 用户主动测试：声音抢占

  // ② 汇总各通道结果
  const marks: string[] = [];
  if (config.sound) marks.push(suppress ? "声音（偏好跳过）" : `声音 ✓${config.soundPath ? "（自定义音效）" : ""}`);
  if (config.tts) marks.push(suppress ? "TTS（偏好跳过）" : "TTS ✓");
  if (config.toast) marks.push(suppress ? "桌面通知（偏好跳过）" : "桌面通知 ✓");
  const hasPhone = config.phonePush || !!config.webhookUrl;
  marks.push(
    !hasPhone ? "手机推送（未配置）"
      : suppress ? "手机推送（偏好跳过）"
      : phoneOk ? "手机推送 ✓" : "手机推送 ✗",
  );

  // ③ 结果说明
  const failed = hasPhone && !suppress && !phoneOk;
  let note = "";
  if (suppress) note = "ℹ️ 当前呼喊偏好为静音/仅完成模式：声音/弹窗/推送按偏好跳过（横幅已显示）。";
  else if (failed) note = "⚠️ 手机推送失败：请检查 topic/token/网络，日志见 pi 控制台。";
  const body = `测试完成：${marks.join(" | ")}${note ? "\n" + note : ""}`;
  ctx.ui.notify(body, failed ? "warning" : "info");
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
        { value: "stop-sound", label: "stop-sound", description: "停止本次呼喊播放（只停当前，下次照常）" },
        { value: "rules", label: "rules", description: "查看当前生效规则" },
        { value: "edit-rules", label: "edit-rules", description: "编辑规则文件（保存即生效）" },
        { value: "reset-rules", label: "reset-rules", description: "规则恢复出厂默认（内置规则）" },
        { value: "level", label: "level", description: "自主等级：conservative 谨慎(遇墙就喊) / balanced 平衡(默认) / autonomous 放手(能不喊就不喊)" },
        { value: "limits", label: "limits", description: "查看/调整防打扰参数（交互式中文菜单）" },
        { value: "sound", label: "sound", description: "自定义呼喊铃声：歌曲路径/试听/总时长（交互式中文菜单）" },
        { value: "volume", label: "volume", description: "音量控制：查看/手动调整/离开自动拉高（交互式中文菜单）" },
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
      if (arg === "stop-sound") { stopCurrentSound(ctx); return; }
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
      if (arg === "limits") {
        // 交互式查看/调整防打扰参数（中文菜单，无需记忆英文参数）
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify(
            `防打扰参数（当前）：\n` +
            `  正常呼喊重复间隔: ${config.repeatIntervalMinutes} 分钟\n` +
            `  紧急呼喊重复间隔: ${config.urgentRepeatMinutes} 分钟\n` +
            `  紧急最多重复次数: ${config.maxUrgentRepeats === -1 ? "一直喊到回来" : config.maxUrgentRepeats + " 次"}\n` +
            `  每次离开最多完成通知: ${config.maxCompletionNotices} 次\n` +
            `（TUI 模式下运行 /i-am-cooking limits 可交互调整）`,
            "info",
          );
          return;
        }
        const ui = ctx.ui;
        const choose = await ui.select(
          "🛡️ 防打扰参数（Esc 退出）:",
          [
            `正常呼喊重复间隔（当前 ${config.repeatIntervalMinutes} 分钟）`,
            `紧急呼喊重复间隔（当前 ${config.urgentRepeatMinutes} 分钟）`,
            `紧急最多重复次数（当前 ${config.maxUrgentRepeats === -1 ? "一直喊到回来" : config.maxUrgentRepeats + " 次"}）`,
            `每次离开最多完成通知次数（当前 ${config.maxCompletionNotices} 次）`,
          ],
        );
        if (!choose) { ui.notify("已退出。", "info"); return; }
        const newVal = await ui.input("输入新的数值（分钟/次数）：", "");
        if (newVal === undefined || newVal === null) { ui.notify("已取消。", "info"); return; }
        const num = parseInt(newVal.trim(), 10);
        if (isNaN(num)) { ui.notify("❌ 请输入数字。", "warning"); return; }
        if (choose.includes("正常呼喊")) {
          config.repeatIntervalMinutes = Math.max(1, num);
          ui.notify(`✅ 正常呼喊重复间隔已设为 ${config.repeatIntervalMinutes} 分钟。`, "info");
        } else if (choose.includes("紧急呼喊")) {
          config.urgentRepeatMinutes = Math.max(1, num);
          ui.notify(`✅ 紧急呼喊重复间隔已设为 ${config.urgentRepeatMinutes} 分钟。`, "info");
        } else if (choose.includes("紧急最多")) {
          config.maxUrgentRepeats = num === 0 ? -1 : num; // 0 = 一直喊
          ui.notify(`✅ 紧急最多重复次数已设为 ${config.maxUrgentRepeats === -1 ? "一直喊到回来" : config.maxUrgentRepeats + " 次"}。`, "info");
        } else {
          config.maxCompletionNotices = Math.max(1, num);
          ui.notify(`✅ 每次离开最多完成通知已设为 ${config.maxCompletionNotices} 次。`, "info");
        }
        await saveConfig();
        return;
      }
      if (arg === "sound") {
        // 自定义呼喊铃声（高级设置，交互式中文菜单）
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify(
            `🔊 当前声音设置：\n` +
            `  哔哔声: ${config.sound ? `${config.beeps} 声` : "关闭"}\n` +
            `  Agent 语音(TTS): ${config.tts ? "开" : "关"}\n` +
            `  自定义歌曲: ${config.soundPath || "（未设置）"}\n` +
            `  总时长上限: ${config.soundSeconds ?? 60} 秒\n` +
            `（TUI 模式下运行 /i-am-cooking sound 可交互设置）`,
            "info",
          );
          return;
        }
        const ui = ctx.ui;
        const choose = await ui.select(
          "🔊 呼喊铃声设置（播放顺序：短铃声 → Agent语音 → 自定义歌曲；总时长到点自动停）:",
          [
            `查看当前设置` +
              (config.soundPath ? `（歌曲：${config.soundPath}）` : "（无自定义歌曲）"),
            `设置自定义歌曲（浏览文件或输入路径，macOS 支持 mp3/wav/m4a）`,
            `开关：哔哔声/Agent语音/桌面弹窗（当前 声${config.sound ? "开" : "关"} 语${config.tts ? "开" : "关"} 弹${config.toast ? "开" : "关"}）`,
            `试听当前设置`,
            `设置总时长上限（当前 ${config.soundSeconds ?? 60} 秒，到点强制停止）`,
            `清除自定义歌曲（回到只用哔哔+语音）`,
          ],
        );
        if (!choose) { ui.notify("已退出。", "info"); return; }
        if (choose.includes("查看当前")) {
          ctx.ui.notify(
            `🔊 当前声音设置：\n` +
            `  哔哔声: ${config.sound ? `${config.beeps} 声` : "关闭"}\n` +
            `  Agent 语音(TTS): ${config.tts ? "开" : "关"}\n` +
            `  自定义歌曲: ${config.soundPath || "（未设置）"}\n` +
            `  总时长上限: ${config.soundSeconds ?? 60} 秒`,
            "info",
          );
          return;
        }
        if (choose.includes("开关")) {
          const toggle = await ui.select("🔘 开关设置（选一个切换）:", [
            `哔哔声：当前 ${config.sound ? "开" : "关"}`,
            `Agent 语音(TTS)：当前 ${config.tts ? "开" : "关"}`,
            `桌面弹窗：当前 ${config.toast ? "开" : "关"}`,
          ]);
          if (!toggle) { ui.notify("已退出。", "info"); return; }
          if (toggle.includes("哔哔声")) {
            config.sound = !config.sound;
            ui.notify(`✅ 哔哔声已${config.sound ? "开启" : "关闭"}。`, "info");
          } else if (toggle.includes("语音")) {
            config.tts = !config.tts;
            ui.notify(`✅ Agent 语音已${config.tts ? "开启" : "关闭"}。`, "info");
          } else {
            config.toast = !config.toast;
            ui.notify(`✅ 桌面弹窗已${config.toast ? "开启" : "关闭"}。`, "info");
          }
          await saveConfig();
          return;
        }
        if (choose.includes("设置自定义歌曲")) {
          // 先提供文件浏览（从 ~/Music 开始，可逐级进入），也支持手动输入路径
          const browse = await ui.confirm(
            "🔊 选择音频文件",
            `是否从 ~/Music 开始浏览选择音频文件？\n（也可以手动输入路径）`,
          );
          let picked: string | null = null;
          if (browse) {
            picked = await browseAudioFile(ui, join(homedir(), "Music"));
          } else {
            const p = await ui.input("音频文件路径（回车取消）:", config.soundPath);
            if (p && p.trim()) picked = p.trim().replace(/^~\//, `${homedir()}/`);
          }
          if (!picked) { ui.notify("已取消。", "info"); return; }
          config.soundPath = picked;
          await saveConfig();
          ui.notify(`✅ 自定义歌曲已设置：${config.soundPath}\n试听：/i-am-cooking sound 选"试听"；或下次呼喊时自动播放。`, "info");
          return;
        }
        if (choose.includes("试听")) {
          ui.notify("🔊 正在试听：哔哔 + Agent语音 + 自定义歌曲（最长 10 秒）…", "info");
          await playSound(
            config.sound ? config.beeps : 0,
            config.sound ? config.soundPath : "",
            config.tts ? `主人，这是测试语音！${config.shoutPhrase || "agent 需要你"}！` : "",
            { force: true }, // 用户主动试听：抢占其他 Agent 的声音
          );
          return;
        }
        if (choose.includes("总时长")) {
          const v = await ui.input("总时长上限（秒，1-300，回车默认 60）:", String(config.soundSeconds ?? 60));
          if (v === undefined || v === null || v.trim() === "") { ui.notify("已取消。", "info"); return; }
          const n = parseInt(v.trim(), 10);
          if (isNaN(n) || n < 1 || n > 300) { ui.notify("❌ 请输入 1-300 的数字。", "warning"); return; }
          config.soundSeconds = n;
          await saveConfig();
          ui.notify(`✅ 总时长上限已设为 ${n} 秒（到点强制停止）。`, "info");
          return;
        }
        if (choose.includes("清除自定义歌曲")) {
          config.soundPath = "";
          await saveConfig();
          ui.notify("✅ 已清除自定义歌曲（回到哔哔 + Agent 语音）。", "info");
          return;
        }
        return;
      }
      if (arg === "volume") {
        // 音量控制：查看 / 手动调整 / 设置离开自动拉高
        const cur = await getSystemVolume();
        const statusLine = `当前系统音量: ${cur === null ? "（读取失败）" : cur + "%"}\n离开自动拉高: ${config.boostVolume ? `开（拉到 ${config.boostLevel || 80}%）` : "关"}`;
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify(`🔊 音量控制\n${statusLine}\n（TUI 模式下运行 /i-am-cooking volume 可交互调整）`, "info");
          return;
        }
        const ui = ctx.ui;
        const choose = await ui.select("🔊 音量控制（Esc 退出）:", [
          `查看当前音量（${cur === null ? "读取失败" : cur + "%"}）`,
          `立即把系统音量调到指定值（0-100）`,
          `设置"离开时自动拉高到多少"（当前 ${config.boostLevel || 80}%）`,
          `开关"离开自动拉高音量"（当前 ${config.boostVolume ? "开" : "关"}）`,
        ]);
        if (!choose) { ui.notify("已退出。", "info"); return; }
        if (choose.includes("查看当前")) {
          ui.notify(`🔊 ${statusLine}`, "info");
          return;
        }
        if (choose.includes("立即")) {
          const v = await ui.input("设置系统音量（0-100）:", "");
          if (v === undefined || v === null || v.trim() === "") { ui.notify("已取消。", "info"); return; }
          const n = parseInt(v.trim(), 10);
          if (isNaN(n) || n < 0 || n > 100) { ui.notify("❌ 请输入 0-100 的数字。", "warning"); return; }
          const ok = await setSystemVolume(n);
          ui.notify(ok ? `✅ 系统音量已设为 ${n}%。` : "⚠️ 设置失败（见日志）。", ok ? "info" : "warning");
          return;
        }
        if (choose.includes("离开时自动拉高到多少")) {
          const v = await ui.input("离开时拉高到多少（1-100，默认 80）:", String(config.boostLevel || 80));
          if (v === undefined || v === null || v.trim() === "") { ui.notify("已取消。", "info"); return; }
          const n = parseInt(v.trim(), 10);
          if (isNaN(n) || n < 1 || n > 100) { ui.notify("❌ 请输入 1-100 的数字。", "warning"); return; }
          config.boostLevel = n;
          config.boostVolume = true;
          await saveConfig();
          ui.notify(`✅ 离开时自动拉高到 ${n}%（已自动开启该功能）。`, "info");
          return;
        }
        if (choose.includes("开关")) {
          config.boostVolume = !config.boostVolume;
          await saveConfig();
          ui.notify(`✅ "离开自动拉高音量"已${config.boostVolume ? "开启" : "关闭"}。`, "info");
          return;
        }
        return;
      }
      const note = arg.startsWith("on") ? arg.slice(2).trim() : arg;
      await turnOn(ctx, note, true); // 手动开启：询问是否开启小阶段提醒
    },
  });

  // 快捷键：停止本次播放（默认 Ctrl+Alt+M；可在 keybindings.json 自定义）
  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "i-am-cooking: 停止本次呼喊播放（仅本次，下次照常）",
    handler: async (ctx) => {
      if (!config.cooking) {
        ctx.ui.notify("当前不在离开模式，无播放可停止。", "info");
        return;
      }
      stopCurrentSound(ctx);
    },
  });

  // ── tool (LLM 调用) ──
  pi.registerTool({
    name: "shout_for_user",
    label: "Shout For User",
    description:
      "大声呼喊离开的用户（例如在做饭）。仅当你被真正卡住、且只有用户能解决时调用。\n" +
      "**调用时机（重要）**：必须在交接内容准备好之后一次性呼喊，禁止先喊再准备。\n" +
      "**准备标准**：刚好够用——只整理用户立即行动所必需的信息：决策给选项和推荐；凭据给获取方式；手动操作给步骤。不要面面俱到、不要塞无关背景。\n" +
      "喊出的 message 即最终版，事后不再补充。若 cooking 模式未开启，它只会告诉你用户就在电脑前，直接在对话里问即可。",
    promptSnippet: "Loudly alert the away user when you are blocked and need their input",
    promptGuidelines: [
      "Call shout_for_user only AFTER the handoff is ready — never shout first and prepare later.",
      "'Ready' means JUST ENOUGH: the minimal info the user needs to act immediately (options + your recommendation for decisions; how to obtain credentials; steps for manual actions). Don't over-collect or pad with irrelevant context.",
      "Use shout_for_user only when truly blocked and only the user can unblock you. Shout once with the final message; no preparing-after-shouting.",
    ],
    parameters: Type.Object({
      message: Type.String({
        description: "交接说明（一次性最终版）：用户需做什么 + 必需的材料/凭据/步骤（仅列必要的）。例如：\"需要你登录 example.com（账号 xxx），登录后我需抓取价格页；调研进度已整理\"。",
      }),
      urgency: StringEnum(["info", "normal", "urgent"] as const),
      category: Type.Optional(Type.String({
        description: "分类：decision / credential / approval / clarification / help / completion（全部完成）/ milestone（小阶段完成，仅当用户开启了小阶段提醒时用）等",
      })),
      ttsText: Type.Optional(Type.String({
        description: "可选：想让用户听到的语音原文（TTS 将原样念出，不走默认模板）。例如：\"主人！方案 A 和 B 我拿不准，快回来看看！\" 不填则用默认模板（\"主人，快来！agent 需要你！+消息\"）。",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!config.cooking) {
        return {
          content: [{ type: "text", text: "Cooking 模式未开启——用户就在电脑前，直接在对话里问即可，未发送呼喊。" }],
          details: { fired: false },
        };
      }
      const queued = queueAlert(params.message, params.urgency, params.category ?? "other", ctx, params.ttsText);
      return {
        content: [{ type: "text", text: queued
          ? `呼喊已发出（${params.urgency}）${params.ttsText ? `，语音：${params.ttsText}` : ""}。\n交接内容已包含在呼喊消息里。**现在请停止自主推进，暂停当前回合，等待用户回来处理**——不要再继续处理其他任务，也不要再次调用本工具；用户回来后会自动收到你的汇报并给你新指令。`
          : "已有同内容的未确认呼喊，不重复发送。" }],
        details: { fired: queued, urgency: params.urgency, category: params.category ?? "other", ttsText: params.ttsText ?? null },
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

  // 工具：用户表达要离开时，Agent 自主开启离开模式（用户无需手输命令）
  pi.registerTool({
    name: "enter_cooking_mode",
    label: "Enter Cooking Mode",
    description:
      "开启离开模式：用户不在电脑前时 agent 自主推进任务，卡住时大声呼喊用户，任务完成时通知。\n" +
      "**仅在用户非常明确地表达要离开电脑时调用**——例如：" +
      "\"我去做饭了，你继续\" / \"我离开一下，有事喊我\" / \"我出门了，你自主处理\" / \"I'm cooking, handle it\" / 语音识别或输入的自然语言明确表示要离开。\n" +
      "**不要误开**：如果用户只是短暂离开话题、问你问题、或让你继续普通对话（没有明确表示要离开电脑/无法即时回复），不要调用。" +
      "不确定时宁可不开——用户会在需要时自己执行 /i-am-cooking on。",
    promptSnippet: "Enter away-mode when the user is clearly leaving the computer (cooking, stepping away, going out)",
    promptGuidelines: [
      "Call enter_cooking_mode ONLY when the user unambiguously says they are leaving the computer and won't be available (e.g. cooking, stepping away, going out) and expects you to keep working autonomously. If unsure, do NOT call it — the user can enable it themselves with /i-am-cooking on.",
    ],
    parameters: Type.Object({
      note: Type.Optional(Type.String({
        description: "用户的离开说明或布置的任务（可选），例如：\"继续做调研，遇到人类墙喊我\"",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (config.cooking) {
        return {
          content: [{ type: "text", text: "已在离开模式中，无需重复开启。" }],
          details: { entered: false, alreadyCooking: true },
        };
      }
      await turnOn(ctx, params.note ?? ""); // Agent 开启：不询问，沿用当前配置
      return {
        content: [{ type: "text", text: `已开启离开模式${params.note ? `，备注：${params.note}` : ""}。请按注入的自主规则推进任务，卡住时用 shout_for_user 喊用户，任务完成时通知。` }],
        details: { entered: true, note: params.note ?? "" },
      };
    },
  });

  // 工具：用户要求更换呼喊铃声时，agent 帮助设置自定义歌曲
  pi.registerTool({
    name: "set_shout_sound",
    label: "Set Shout Sound",
    description:
      "设置呼喊铃声的自定义歌曲（用户离开时听到的提醒音频）。\n" +
      "**仅在用户明确要求更换/设置铃声时调用**，例如：\"帮我换个铃声\" / \"把声音设成那首歌\" / \"用 xxx.mp3 当提醒音\"。\n" +
      "path 必须是本机存在的音频文件路径（macOS 支持 mp3/wav/m4a/aiff）。\n" +
      "如果用户没给具体路径，不要猜测——先问用户路径，或建议用户运行 /i-am-cooking sound 用文件浏览器选择。",
    promptSnippet: "Set the custom shout ringtone when the user asks to change the alert sound",
    promptGuidelines: [
      "Call set_shout_sound ONLY when the user explicitly asks to change/set the ringtone and gives a specific audio file path. Do not guess paths — ask the user or suggest /i-am-cooking sound for the file browser.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "音频文件完整路径，例如：\"/Users/name/Music/ring.mp3\"" }),
      soundSeconds: Type.Optional(Type.Number({ description: "可选：总时长上限（秒，1-300）。不填则保持当前值（默认 60）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params.path.trim().replace(/^~\//, `${homedir()}/`);
      // 校验路径存在
      try {
        const st = await import("node:fs/promises").then((m) => m.stat(p));
        if (!st.isFile()) {
          return {
            content: [{ type: "text", text: `路径不是文件：${p}` }],
            details: { set: false, reason: "not-a-file" },
          };
        }
      } catch {
        return {
          content: [{ type: "text", text: `文件不存在：${p}。请确认路径，或建议用户运行 /i-am-cooking sound 用文件浏览器选择。` }],
          details: { set: false, reason: "not-found" },
        };
      }
      if (!isAudioFile(p)) {
        return {
          content: [{ type: "text", text: `不支持的文件类型（支持 mp3/wav/m4a/aiff/ogg/flac）：${p}` }],
          details: { set: false, reason: "unsupported-format" },
        };
      }
      config.soundPath = p;
      if (params.soundSeconds !== undefined) {
        const n = Math.max(1, Math.min(300, Math.round(params.soundSeconds)));
        config.soundSeconds = n;
      }
      void saveConfig();
      ctx.ui.notify(`🔊 呼喊铃声已更新：${p}`, "info");
      return {
        content: [{ type: "text", text: `已设置呼喊铃声：${p}${params.soundSeconds !== undefined ? `（总时长 ${config.soundSeconds} 秒）` : ""}。下次呼喊时会先播短铃声+语音，再播这首歌。用户可随时用 /i-am-cooking sound 试听。` }],
        details: { set: true, path: p, soundSeconds: config.soundSeconds },
      };
    },
  });

  // 工具：调整系统音量（用户明确要求，或呼喊前解除静音保障）
  pi.registerTool({
    name: "set_volume",
    label: "Set Volume",
    description:
      "调整系统音量（0-100）。\n" +
      "**何时调用**：① 用户明确要求（如\"把音量调大点\"\"太吵了，小点声\"\"静音\"）；② 呼喊用户前发现系统静音，需解除静音保证用户能听到。\n" +
      "**参数二选一**：给 level=绝对音量（0-100）；给 action=相对动作（raise 调大 / lower 调小 / mute 静音 / unmute 取消静音），amount 为步进（默认 10）。\n" +
      "**不要擅自调整**：用户没要求时不要改音量。",
    promptSnippet: "Adjust system volume when the user asks, or unmute before shouting",
    promptGuidelines: [
      "Use set_volume only when the user explicitly asks to change volume, or when the system is muted and you must shout at the user (unmute first). Do not adjust volume on your own initiative.",
    ],
    parameters: Type.Object({
      level: Type.Optional(Type.Number({ description: "绝对音量（0-100）。与 action 二选一" })),
      action: Type.Optional(StringEnum(["raise", "lower", "mute", "unmute"] as const)),
      amount: Type.Optional(Type.Number({ description: "raise/lower 的步进（默认 10）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return (async () => {
        const action = params.action;
        const amount = Math.max(1, Math.min(50, Math.round(params.amount ?? 10)));

        if (action === "mute") {
          const r = await toggleMute(true);
          return {
            content: [{ type: "text", text: r === null ? "静音设置（当前平台需手动操作或走音量命令）。" : "已静音。" }],
            details: { muted: true, ok: r !== null },
          };
        }
        if (action === "unmute") {
          const r = await toggleMute(false);
          return {
            content: [{ type: "text", text: r === null ? "取消静音设置失败/不支持。" : "已取消静音。" }],
            details: { muted: false, ok: r !== null },
          };
        }

        const cur = await getSystemVolume();
        if (cur === null) {
          return {
            content: [{ type: "text", text: "无法读取当前音量，调整失败（见日志）。" }],
            details: { ok: false, reason: "read-failed" },
          };
        }
        let target: number;
        if (action === "raise") target = cur + amount;
        else if (action === "lower") target = cur - amount;
        else if (typeof params.level === "number") target = params.level;
        else {
          return {
            content: [{ type: "text", text: "参数缺失：请提供 level（0-100）或 action（raise/lower/mute/unmute）。" }],
            details: { ok: false, reason: "bad-params" },
          };
        }
        const ok = await setSystemVolume(target);
        const now = await getSystemVolume();
        ctx.ui.notify(`🔊 音量${ok ? `已调整到 ${now ?? target}%` : "调整失败"}（原 ${cur}%）。`, ok ? "info" : "warning");
        return {
          content: [{ type: "text", text: ok ? `系统音量已调整为 ${now ?? target}%（原 ${cur}%）。` : "音量调整失败（见日志）。" }],
          details: { ok, from: cur, to: now ?? target },
        };
      })();
    },
  });

  // 工具：用户明确表示结束离开时，agent 关闭离开模式（语义关闭，不依赖关键词）
  pi.registerTool({
    name: "exit_cooking_mode",
    label: "Exit Cooking Mode",
    description:
      "关闭离开模式（I am cooking），回到在线状态。\n" +
      "**调用时机**：用户明确表示要结束离开、回到在线时——例如说\"我不离开了\"\"保持在线\"\"别忙了，我回来了\"\"先停一下，不用了\"\"取消离开模式\"，或明显接管任务、表示不再需要你自主干活。\n" +
      "**不要误关**：\n" +
      "  · 用户只是临时看一眼、补充信息、问个问题 → 不要调用，保持离开模式继续工作\n" +
      "  · 用户说\"我先去忙别的，你继续\" → 不要调用\n" +
      "调用后：当前会话退出离开模式，agent 收到汇报并继续按新情况处理；只影响当前这一个 Agent，不影响其他 Agent。",
    promptSnippet: "Exit away-mode when the user clearly returns / wants to be online again",
    promptGuidelines: [
      "Call exit_cooking_mode ONLY when the user clearly says they are ending the away session (e.g. '我不离开了', '保持在线', '先停一下，不用了'). Do NOT call it when the user just adds a note, asks a question, or says 'keep going'. Only affects this session.",
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "依据的用户原话或推理，例如：\"用户说：我不离开了，保持在线\"" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!config.cooking) {
        return {
          content: [{ type: "text", text: "当前不在离开模式，无需关闭。" }],
          details: { closed: false, alreadyOff: true },
        };
      }
      turnOff(ctx, "agent-exit");
      return {
        content: [{ type: "text", text: `已关闭离开模式（依据：${params.reason}）。汇报已发送给用户。` }],
        details: { closed: true, reason: params.reason },
      };
    },
  });

  // ── events ──
  pi.on("session_start", async (_event, ctx) => {
    await loadConfig();
    await ensureRulesFile(); // 首次启动用内置默认创建规则文件，已存在则不动
    // 离开状态不跨会话存活：任何会话启动都从"在岗"开始（需要时用户或 Agent 再 on）
    resetCookingState(ctx);
    if (!config.setupDone) {
      // 初次使用：提醒配置手机推送
      ctx.ui.notify(
        "🍳 I am cooking 插件已加载。首次使用建议运行 /i-am-cooking setup 配置手机推送（人在厨房也能收到呼喊）。",
        "info",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    clearRepeatTimers();
    stopAllAudio(); // 会话关闭：停止正在播放的音频
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

    // ② 用户打字 = 正常输入：不触发任何关闭，交给 agent 处理
    //    关闭离开模式由 agent 语义理解调用 exit_cooking_mode，或用户手动 /off
  });
}
