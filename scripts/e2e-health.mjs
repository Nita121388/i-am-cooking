// 健康巡检端到端验证（不进 npm 包：package.json 的 files 白名单不含 scripts/）
//
// 为什么需要它：lib/health.ts 的状态机有单测，入口有装载冒烟，但「定时器真的在滴答 →
// 真往会话里注入 [健康巡检] → 横幅真的变成 🩺 已催 N/M」这一段只能真跑一个 pi 进程。
// 交互式 TUI 没法自动化，RPC 模式可以：它把扩展的 setStatus/setWidget/notify 和
// 会话事件都当 JSON 行吐出来，正好可以断言。
//
// 用法: node scripts/e2e-health.mjs [--keep]
// 前置: 已在仓库根目录执行过 npm install（不需要 LLM 凭据——巡检消息注入后即使下一轮
//       LLM 调用失败也不影响本次断言，我们要验的是「注入发生了」而不是「模型答得对」）

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(REPO, "extensions", "i-am-cooking", "index.ts");
const HOME_DIR = join(tmpdir(), "iac-e2e");
const CHECK_MINUTES = 1; // 滴答间隔
const IDLE_MINUTES = 1; // 空闲多久算「没在运行」
const TIMEOUT_MS = 150_000;

const lines = [];
const seen = {
  devBanner: false,
  cookingOn: false,
  tickNotify: [],
  nudgeMessage: null,
  widgetNudged: null,
  errors: [],
};

function onLine(raw) {
  const line = raw.trim();
  if (!line) return;
  lines.push(line);
  let j;
  try { j = JSON.parse(line); } catch { return; }

  if (j.type === "extension_ui_request") {
    if (j.method === "notify") {
      const m = j.message ?? "";
      if (m.includes("DEV 构建已加载")) seen.devBanner = true;
      if (m.includes("健康巡检") && m.includes("追问状态")) seen.tickNotify.push(m);
      if (m.includes("离开模式已开启") || m.includes("⏱")) seen.cookingOn = true;
    }
    if (j.method === "setWidget" && j.widgetKey === "i-am-cooking") {
      const text = (j.widgetLines ?? []).join("\n");
      if (text.includes("🩺 已催")) seen.widgetNudged = text;
    }
  }
  if (j.type === "extension_error") seen.errors.push(JSON.stringify(j).slice(0, 300));

  // 巡检消息以 user message 形式注入（sendUserMessage + deliverAs followUp）。
  // 注意：注入的 rules 文本里本身也含「健康巡检」字样，所以必须用 buildHealthPrompt
  // 独有的开头「[健康巡检 #N]」来识别，否则会被规则文本误匹配。
  const text = JSON.stringify(j);
  if (/\[健康巡检 #\d+\]/.test(text)) {
    seen.nudgeMessage ??= text.slice(0, 400);
  }
}

async function main() {
  await rm(HOME_DIR, { recursive: true, force: true });
  await mkdir(HOME_DIR, { recursive: true });
  // 预置：小阈值 + 关掉响铃/TTS/弹窗，避免验证时吵人
  await writeFile(
    join(HOME_DIR, "config.json"),
    JSON.stringify({
      healthCheck: true,
      healthCheckMinutes: CHECK_MINUTES,
      healthIdleMinutes: IDLE_MINUTES,
      healthMaxNudges: 5,
      sound: false,
      tts: false,
      toast: false,
      phonePush: false,
      tuiBanner: true,
      setupDone: true,
      progressReporting: "none",
    }, null, 2),
    "utf8",
  );

  const child = spawn(process.env.PI_BIN ?? "pi", [
    "-ne",
    "-e", EXT,
    "--mode", "rpc",
    "--no-session",
  ], {
    cwd: REPO,
    env: { ...process.env, I_AM_COOKING_HOME: HOME_DIR, I_AM_COOKING_DEV: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const p of parts) onLine(p);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    if (s.includes("conflict") || s.includes("Failed to load")) seen.errors.push(s.trim().slice(0, 300));
  });

  const started = Date.now();
  const tick = () => `[+${((Date.now() - started) / 1000).toFixed(0)}s]`;

  // 等扩展装载完，再开离开模式
  await new Promise((r) => setTimeout(r, 6000));
  child.stdin.write(JSON.stringify({ type: "prompt", message: "/i-am-cooking-dev on" }) + "\n");
  console.log(`${tick()} 已发送 /i-am-cooking-dev on，等待滴答（每 ${CHECK_MINUTES} 分钟 / 空闲 ${IDLE_MINUTES} 分钟）…`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && !seen.nudgeMessage) {
    await new Promise((r) => setTimeout(r, 1000));
    if (seen.widgetNudged && seen.nudgeMessage) break;
  }

  try { child.kill(); } catch {}

  const pass = [];
  const fail = [];
  const check = (ok, label, detail) => (ok ? pass : fail).push(detail ? `${label} — ${detail}` : label);

  check(seen.devBanner, "DEV 构建身份标识出现");
  check(seen.tickNotify.length > 0, "巡检真的按间隔触发", seen.tickNotify[0] ?? "未收到「第 N 次追问状态」提示");
  check(!!seen.nudgeMessage, "[健康巡检] 消息真的注入会话", seen.nudgeMessage ?? "超时未注入");
  check(!!seen.widgetNudged, "横幅出现 🩺 已催 N/M", seen.widgetNudged ?? "未观察到");
  check(seen.errors.length === 0, "无扩展装载错误", seen.errors.join(" | "));

  console.log("\n=== 通过 ===");
  for (const p of pass) console.log("  ✅ " + p);
  if (fail.length) {
    console.log("\n=== 失败 ===");
    for (const f of fail) console.log("  ❌ " + f);
  }
  console.log(`\n状态目录: ${HOME_DIR}（--keep 可保留以便手动检查）`);
  console.log(`事件行数: ${lines.length}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
