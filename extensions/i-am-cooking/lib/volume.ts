/**
 * 系统音量控制（macOS osascript / Linux pactl / Windows volume.ps1）。
 * 离开时拉高 + 回来恢复：原值状态在本模块内保存（savedVolumePct/savedMuted）。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileAsync, runPowerShellScript } from "./platform.ts";
import { SCRIPTS, TMP_DIR } from "./config.ts";
import type { Config } from "./config.ts";

let savedVolumePct: number | null = null; // 离开前的原始音量（0-100）
let savedMuted: boolean | null = null;    // macOS：离开前的静音标志（restore 时还原）

/** 读取当前系统音量（0-100）；失败返回 null */
export async function getSystemVolume(): Promise<number | null> {
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
export async function setSystemVolume(level: number): Promise<boolean> {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  const p = process.platform;
  try {
    if (p === "win32") {
      await runPowerShellScript(SCRIPTS, TMP_DIR, "volume.ps1", { action: "set", level: clamped / 100 });
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
export async function toggleMute(mute: boolean): Promise<boolean | null> {
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
      await runPowerShellScript(SCRIPTS, TMP_DIR, "volume.ps1", { action: mute ? "mute" : "unmute" });
      return mute;
    }
    return null;
  } catch (e) {
    console.error("[i-am-cooking] toggleMute failed:", (e as Error).message);
    return null;
  }
}

/** 离开时提升音量到 boostLevel（只升不降），并记住原值 */
export async function boostVolume(cfg: Config): Promise<void> {
  if (!cfg.boostVolume) return;
  const target = Math.max(1, Math.min(100, cfg.boostLevel || 80));
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
export async function restoreVolume(): Promise<void> {
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