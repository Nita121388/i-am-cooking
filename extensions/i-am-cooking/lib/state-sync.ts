/**
 * 跨 Agent 离开状态广播（纯逻辑，路径参数化，可测试）。
 * 共享 state.json：turnOn 写 true，turnOff 写 false；其他 Agent 监听变化后联动关闭。
 * 用临时文件 + rename 原子写，避免 watcher 读到半写内容。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export interface SharedState {
  cooking: boolean;
  since?: number;
  updatedAt: number;
}

/** 原子写共享状态（临时文件 + rename） */
export async function writeSharedState(statePath: string, dir: string, cooking: boolean): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `${statePath}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ cooking, since: cooking ? Date.now() : undefined, updatedAt: Date.now() } satisfies SharedState),
    "utf8",
  );
  await rename(tmp, statePath);
}

/** 读取共享状态；文件不存在返回 null */
export async function readSharedState(statePath: string): Promise<SharedState | null> {
  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as SharedState;
  } catch {
    return null;
  }
}
