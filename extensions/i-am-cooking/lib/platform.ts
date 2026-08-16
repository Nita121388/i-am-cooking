/**
 * 平台命令执行层（纯执行，无业务逻辑）。
 * - execFileAsync：promisify 的 execFile
 * - runCommand：跨平台命令执行（失败只记日志，不抛——best effort）
 * - runPowerShellScript：Windows 专用——把数据写成 json → powershell 执行 scripts/ 下的 ps1
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const execFileAsync = promisify(execFile);

/** 跨平台执行命令；失败只记日志不抛错（该类操作均为 best effort） */
export async function runCommand(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await execFileAsync(cmd, args, {
      timeout: opts.timeoutMs ?? 30_000,
      windowsHide: true,
    });
  } catch (e) {
    console.error(`[i-am-cooking] ${cmd} failed:`, (e as Error).message);
  }
}

/**
 * Windows PowerShell 脚本执行：数据写入 tmpDir 下临时 json，-DataFile 传给 ps1。
 * scriptsDir 为 scripts/ 目录（ps1 所在）。非 win32 直接跳过。
 */
export function runPowerShellScript(
  scriptsDir: string,
  tmpDir: string,
  script: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  const dataFile = join(tmpDir, `${randomUUID()}.json`);
  return (async () => {
    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(dataFile, JSON.stringify(data), "utf8");
      await execFileAsync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", join(scriptsDir, script),
        "-DataFile", dataFile,
      ], { timeout: 30_000, windowsHide: true });
    } catch (e) {
      console.error(`[i-am-cooking] ${script} failed:`, (e as Error).message);
    } finally {
      try { await rm(dataFile, { force: true }); } catch { /* ignore */ }
    }
  })();
}