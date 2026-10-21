/**
 * 配置模型：类型 + 出厂默认值 + 路径常量 + 读写（路径参数化，可测试）。
 * 全局 config 单例仍由入口 index.ts 持有（本模块只提供纯数据结构与文件操作）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ── 路径常量（本地开发 / pi install / git clone 任何安装方式都能正确定位） ──
export const HOME = homedir();
export const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));
// 出厂默认规则文件（仓库内，进 git）：随插件版本更新，运行时首次创建用户文件时从它拷贝
export const DEFAULT_RULES_PATH = fileURLToPath(new URL("../rules.default.md", import.meta.url));

/**
 * 状态目录解析（纯函数，可测试）。
 * 默认 `~/.pi/i-am-cooking`（与历史行为完全一致）。
 * 设 `I_AM_COOKING_HOME` 可指向独立目录 —— 本地开发/验证时用它把 config.json、
 * rules.md、tmp、audio.lock 与日常在用的那份彻底隔开，避免互相踩。
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env, home: string = HOME): string {
  const raw = env.I_AM_COOKING_HOME?.trim();
  if (!raw) return join(home, ".pi", "i-am-cooking");
  return resolve(raw.replace(/^~\//, `${home}/`));
}

export const CONFIG_DIR = resolveStateDir();

/**
 * 构建身份：区分「本地开发版」与「发布版」。
 * 设 `I_AM_COOKING_DEV=1` 即进入开发版：
 *   - 命令注册为 `/i-am-cooking-dev`（并保留 `/i-am-cooking` 别名，避免误导文案）
 *   - 状态栏/横幅/`status` 头部都带 `DEV` 标记
 *   - 加载提示总是打印（不只首次），带版本与源码路径
 * 它不影响任何功能逻辑，只影响「你能不能一眼看出在跑哪份代码」。
 */
export function isDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.I_AM_COOKING_DEV?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** 构建来源（源码目录）：开发时是仓库，安装后是包根 */
export const BUILD_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const DEV_MODE = isDevMode();
export const COMMAND_NAME = DEV_MODE ? "i-am-cooking-dev" : "i-am-cooking";
/** 命令行前缀（用于日志/提示；以 "" 开头宁可让调用方自己拼） */
export const COMMAND_TAG = `/${COMMAND_NAME}`;

/** 读取包版本号（开发态/安装态都能定位：均为 ../../package.json） */
async function readPkgVersion(): Promise<string> {
  try {
    const raw = await readFile(join(BUILD_ROOT, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

let cachedVersion: string | null = null;
/** 构建身份的完整描述（给启动提示 / status 用） */
export async function describeBuild(): Promise<string> {
  cachedVersion ??= await readPkgVersion();
  const tag = DEV_MODE ? "DEV" : "release";
  return `${tag} v${cachedVersion} · 源码 ${BUILD_ROOT} · 状态 ${CONFIG_DIR}`;
}
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const RULES_PATH = join(CONFIG_DIR, "rules.md");
export const TMP_DIR = join(CONFIG_DIR, "tmp");
export const AUDIO_LOCK_PATH = join(CONFIG_DIR, "audio.lock"); // 跨 Agent 音频互斥锁

export type Urgency = "info" | "normal" | "urgent";

export type CallingMode = "normal" | "silence" | "completion_only" | "urgent_only" | "eager";

// 自主等级：遇到阻塞时「该不该喊用户」的阈值
//   conservative —— 遇墙就喊（人类墙：验证码/登录/手动点击等必须人手动的阻塞）
//   balanced     —— 有点难度才喊（默认；普通决策自主推进，人类墙/代价大才喊）
//   autonomous   —— 能不喊就不喊（尽量自决，只有彻底无法继续才喊）
export type AutonomyLevel = "conservative" | "balanced" | "autonomous";

export interface Alert {
  id: string;
  time: number;
  message: string;
  urgency: Urgency;
  category: string;
  repeatCount: number;
  acked: boolean;
  ttsText?: string; // Agent 自由语音：非空则 TTS 原样念这段，不走模板
}

export interface Config {
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
  remoteStop: boolean; // 呼喊推送带「停止响铃」按钮（本地小端点，仅局域网可达；off/关会话即停服）
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

  // health watch（健康巡检）：离开模式开着但 agent 可能意外停住时，定时探测并催问
  healthCheck: boolean;          // 巡检总开关
  healthCheckMinutes: number;    // 巡检滴答间隔（分钟，默认 5）
  healthIdleMinutes: number;     // 空闲多久判定「没在运行」（分钟，默认 10）
  healthMaxNudges: number;       // 同一段空闲最多催几次（默认 5），之后升级喊用户一次
  healthMuteEscalation: boolean; // true = 只催不喊，一直催（用户说过别喊时自动置位）
}

export const DEFAULTS: Config = {
  cooking: false,
  alerts: [],
  sound: true,
  beeps: 4,
  soundPath: "",
  soundSeconds: 60,
  tts: true,
  ttsTemplate: "叮咚！快来！{shoutPhrase}！{message}",
  shoutPhrase: "agent 需要你",
  toast: true,
  tuiBanner: true,
  phonePush: false,
  pushProvider: "ntfy",
  ntfyTopic: "",
  ntfyServer: "https://ntfy.sh",
  ntfyToken: "",
  remoteStop: true,
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
  ttsTemplateCompletion: "叮咚！好消息！任务完成了！{message}",
  progressReporting: "milestone", // 默认：小阶段完成时汇报
  reportIntervalMinutes: 15,
  ttsTemplateMilestone: "小进展：{message}",
  milestoneBeeps: 1,
  healthCheck: true,
  healthCheckMinutes: 5,
  healthIdleMinutes: 10,
  healthMaxNudges: 5,
  healthMuteEscalation: false,
};

/**
 * 读取配置：磁盘文件缺失/损坏 → 返回出厂默认并落盘。
 * 语义与旧入口内实现一致（文件存在则深合并，缺失则写默认）。
 */
export async function readConfig(path: string = CONFIG_PATH): Promise<Config> {
  try {
    const raw = await readFile(path, "utf8");
    const cfg = { ...DEFAULTS, ...JSON.parse(raw) as Partial<Config> };
    cfg.alerts = cfg.alerts ?? [];
    return cfg;
  } catch {
    const fresh = { ...DEFAULTS };
    await writeConfig(fresh, path);
    return fresh;
  }
}

/** 写配置（失败只记日志，不抛——配置保存是 best effort） */
export async function writeConfig(cfg: Config, path: string = CONFIG_PATH): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    console.error("[i-am-cooking] save config failed:", e);
  }
}