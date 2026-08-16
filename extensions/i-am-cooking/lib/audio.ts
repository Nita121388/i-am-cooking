/**
 * 音频播放（三段式：短铃声 → Agent 语音 → 自定义歌曲）。
 * 跨 Agent 音频互斥锁（lib/audio-lock.ts）：同一时刻只放一个声音，后到的跳过。
 * 播放进程表（activeAudioProcs）在本模块内管理，stopAllAudio 立即掐断全部。
 */
import { spawn } from "node:child_process";
import { acquireAudioLock, releaseAudioLock } from "./audio-lock.ts";
import { AUDIO_LOCK_PATH, SCRIPTS, TMP_DIR } from "./config.ts";
import type { Config } from "./config.ts";
import { runCommand, runPowerShellScript } from "./platform.ts";

// 全局跟踪正在播放的音频进程（用户回来/关会话时 stopAllAudio 立即掐断）
let activeAudioProcs: ReturnType<typeof spawn>[] = [];

/**
 * spawn 播放器进程，最多播放 maxMs 毫秒后强制 kill（避免超长歌曲一直响）。
 * 返回 Promise（进程退出/出错/被杀 都 resolve）。
 */
function playProcessInternal(cmd: string, args: string[], maxMs: number): Promise<void> {
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

/** 是否有正在播放的音频（停止播放命令用来判断提示文案） */
export function hasActiveAudio(): boolean {
  return activeAudioProcs.length > 0;
}

/** 停止所有正在播放的音频（用户回来/关会话/停止本次播放时调用，立即安静） */
export function stopAllAudio(): void {
  for (const proc of activeAudioProcs) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  activeAudioProcs = [];
}

/** Agent 语音（TTS）：macOS say(Tingting) / Linux espeak / Windows shout.ps1；失败静默降级 */
async function speakTts(text: string): Promise<void> {
  if (!text) return;
  const p = process.platform;
  try {
    if (p === "win32") {
      await runPowerShellScript(SCRIPTS, TMP_DIR, "shout.ps1", { beeps: 0, soundPath: "", ttsText: text });
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

/**
 * 三段式顺序播放：① 短铃声(beeps) → ② Agent 语音(TTS) → ③ 用户自定义歌曲(soundPath)。
 * 共用 soundSeconds 总预算：从开始响到强制停止，到点 kill 掉还在播的歌曲。
 * 跨 Agent 互斥：多个 pi 同时离开时，同一时刻只放一个声音（后到的跳过声音）。
 */
export async function playSound(
  cfg: Config,
  beeps: number,
  soundPath: string,
  ttsText: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  // 音频互斥锁：其他 Agent 正在播 → 本次跳过声音（只留弹窗/推送/横幅）
  const acquired = await acquireAudioLock(AUDIO_LOCK_PATH, opts.force ?? false);
  if (!acquired) return;
  try {
    const totalMs = Math.max(5, (cfg.soundSeconds ?? 60)) * 1000;
    const startedAt = Date.now();
    const remainingMs = () => Math.max(0, totalMs - (Date.now() - startedAt));
    const p = process.platform;

    // ① 短铃声（beeps）
    if (beeps > 0) {
      try {
        if (p === "win32") {
          await runPowerShellScript(SCRIPTS, TMP_DIR, "shout.ps1", { beeps, soundPath: "", ttsText: "" });
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
          await runPowerShellScript(SCRIPTS, TMP_DIR, "shout.ps1", { beeps: 0, soundPath, ttsText: "" });
        } else if (p === "darwin") {
          await playProcessInternal("afplay", [soundPath], remainingMs());
        } else {
          await playProcessInternal("paplay", [soundPath], remainingMs()).catch(() =>
            playProcessInternal("aplay", [soundPath], remainingMs()),
          );
        }
      } catch { /* best effort */ }
    }
  } finally {
    await releaseAudioLock(AUDIO_LOCK_PATH); // 播放完/被中断都释放锁
  }
}