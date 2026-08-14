/**
 * 跨 Agent 音频互斥锁（纯逻辑，路径参数化，可测试）。
 * 多个 pi 进程同时离开时，同一时刻只放一个声音。
 * 锁文件含 pid + createdAt：pid 死了立即抢占；超时(75s)兜底防 pid 复用。
 */
import { open, readFile, rm } from "node:fs/promises";

export const AUDIO_LOCK_MAX_MS = 75_000;

export interface AudioLock {
  pid: number;
  createdAt: number;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 尝试获取音频锁。force=true 抢占（用户主动 test 优先）。返回是否拿到锁。 */
export async function acquireAudioLock(lockPath: string, force: boolean): Promise<boolean> {
  try {
    if (force) await rm(lockPath, { force: true });
    const handle = await open(lockPath, "wx"); // 原子创建：只有一个进程能成功
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() } satisfies AudioLock), "utf8");
    await handle.close();
    return true;
  } catch {
    // 锁已存在 → 检查是否 stale（崩溃/超时）
    try {
      const raw = await readFile(lockPath, "utf8");
      const lock = JSON.parse(raw) as AudioLock;
      const stale = !isProcessAlive(lock.pid) || Date.now() - lock.createdAt > AUDIO_LOCK_MAX_MS;
      if (stale) {
        await rm(lockPath, { force: true });
        return acquireAudioLock(lockPath, false); // 抢占后重试一次
      }
      return false; // 其他 Agent 正在播 → 本 Agent 跳过声音
    } catch {
      return false;
    }
  }
}

/** 释放音频锁（仅当锁还属于本进程时才删，避免误删别人新拿到的锁） */
export async function releaseAudioLock(lockPath: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const lock = JSON.parse(raw) as AudioLock;
    if (lock.pid === process.pid) await rm(lockPath, { force: true });
  } catch { /* 锁已不存在或被抢占，无需处理 */ }
}
