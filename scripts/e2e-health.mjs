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
const HOME_DIR = process.env.I_AM_COOKING_HOME ?? join(tmpdir(), "iac-e2e");
const MODE = (process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1]) ?? "basic";
const CHECK_MINUTES = 1; // 滴答间隔
const IDLE_MINUTES = 1; // 空闲多久算「没在运行」
// basic: 首催就够；escalation: 要催满 5 次再升级（约 6 分钟）；silence: 催过 5 次仍不升级
// tooltimeout: 验证 TODO-1 —— 长工具超阈值后被 abort 且注入了纠偏提示（不需要跑满 10 分钟，
//              预置 toolTimeoutMinutes=1 + 一个 sleep 300 的 bash 调用即可）
// 实测节奏：每轮「回合收尾 → 空闲满 1 分钟 → 下一次滴答」约 70-80 秒，
// 5 轮 ≈ 11 分钟；silence 要看到第 6 次 ≈ 13 分钟。给足余量。
const TIMEOUT_MS =
  MODE === "basic" ? 150_000
  : MODE === "tooltimeout" ? 300_000
  : MODE === "escalation" ? 900_000
  : 1_000_000;

const lines = [];
const seen = {
  devBanner: false,
  cookingOn: false,
  tickNotify: [],
  nudgeMessage: null,
  widgetNudged: null,
  escalation: null,
  stallAlert: null,
  toolTimeoutNotify: null,
  toolTimeoutSteer: null,
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
      if (m.includes("催了") && m.includes("已升级呼喊")) seen.escalation = m;
      if (m.includes("离开模式已开启") || m.includes("⏱")) seen.cookingOn = true;
      // TODO-1：工具超时中断的 TUI 提示（「工具 X 已跑 N 分钟，超过阈值」）
      if (m.includes("超过阈值") && m.includes("中断本轮")) seen.toolTimeoutNotify = m;
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
  // TODO-1 纠偏提示以 user message 形式注入（sendUserMessage + followUp）
  if (/工具超时中断/.test(text)) {
    seen.toolTimeoutSteer ??= text.slice(0, 600);
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
      // TODO-1：超时阈值收到 1 分钟，e2e 里不用真等 10 分钟
      toolTimeoutMinutes: MODE === "tooltimeout" ? 1 : 10,
      toolTimeoutMaxAborts: 3,
      // 注意：callingMode / healthMuteEscalation 是会话级状态，session_start 时会被
      // resetCookingState 洗回 normal。所以 silence 不能靠预置 config 造，必须启动后用真实
      // 原话触发（见下方 MODE === "silence" 分支）。
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
  const onMessage =
    MODE === "silence" ? "/i-am-cooking-dev on 别喊了，安静点"
    : MODE === "tooltimeout" ? "/i-am-cooking-dev on 只做一件事：执行 bash 命令 sleep 300，然后回复我"
    : "/i-am-cooking-dev on";
  child.stdin.write(JSON.stringify({ type: "prompt", message: onMessage }) + String.fromCharCode(10));
  console.log(`${tick()} 已发送 ${onMessage}，等待滴答（每 ${CHECK_MINUTES} 分钟 / 空闲 ${IDLE_MINUTES} 分钟）…`);

  // on 会注入一条 steer 起一轮回合。本机无 LLM 凭据时它会反复重试，而 turn_start 会刷新
  // 健康巡检的 idle 计时 → 巡检永远不认为 agent「停住」→ 一条催都发不出（silence 模式
  // 实测卡了 11 分钟 0 催）。用 RPC 的 abort 断掉回合，让 agent 稳定下来。
  await new Promise((r) => setTimeout(r, 15000));
  child.stdin.write(JSON.stringify({ type: "abort" }) + String.fromCharCode(10));
  console.log(`${tick()} 已发送 abort，断开 on 触发的回合`);

  if (MODE === "silence") {
    // 偏好必须由用户原话触发（input 事件只认 interactive source，RPC 输入不算「人在场打字」，
    // 挡掉是对的），所以走 on 备注这条路径：detectPreference(note)。
    // 别分两条发 on：turnOn 是幂等的（config.cooking 已 true 就 early-return），第二条会被挡掉。
    await new Promise((r) => setTimeout(r, 5000));
    const { readFile: rf } = await import("node:fs/promises");
    const cfgNow = JSON.parse(await rf(join(HOME_DIR, "config.json"), "utf8"));
    console.log(`${tick()} 静默偏好 → callingMode=${cfgNow.callingMode} muteEscalation=${cfgNow.healthMuteEscalation}`);
    if (cfgNow.callingMode !== "silence" || !cfgNow.healthMuteEscalation) {
      console.log("  ⚠️ 静默偏好没生效，本轮 silence 断言无效");
    }
  }

  const deadline = Date.now() + TIMEOUT_MS;
  const done = () => {
    if (MODE === "escalation") return !!seen.escalation;
    if (MODE === "silence") return seen.tickNotify.length >= 6;
    if (MODE === "tooltimeout") return !!seen.toolTimeoutNotify && !!seen.toolTimeoutSteer;
    return !!seen.nudgeMessage;
  };
  let lastReport = 0;
  let nudgesSeen = seen.tickNotify.length;
  while (Date.now() < deadline && !done()) {
    await new Promise((r) => setTimeout(r, 1000));
    // 巡检注入的 [健康巡检] 本身会起一轮回合。本机无 LLM 凭据时它会反复重试，而
    // turn_start 会刷新 idle 计时 → 下一条催永远发不出（实测卡在「已催 1 次」900 秒）。
    // 每出一条新催就 abort 一次，断掉回合，让 agent 回到空闲，下一条催才发得出。
    if (seen.tickNotify.length > nudgesSeen) {
      nudgesSeen = seen.tickNotify.length;
      await new Promise((r) => setTimeout(r, 8000));
      child.stdin.write(JSON.stringify({ type: "abort" }) + String.fromCharCode(10));
      console.log(`${tick()} 第 ${nudgesSeen} 次催已出，abort 断掉它起的回合`);
    }
    if (Date.now() - lastReport > 30_000) {
      lastReport = Date.now();
      console.log(`${tick()} 已催 ${seen.tickNotify.length} 次${seen.escalation ? "，已升级" : ""}…`);
    }
  }

  try { child.kill(); } catch {}
  if (process.argv.includes("--keep")) {
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(HOME_DIR, "events.jsonl"), lines.join(String.fromCharCode(10)), "utf8");
  }

  const pass = [];
  const fail = [];
  const check = (ok, label, detail) => (ok ? pass : fail).push(detail ? `${label} — ${detail}` : label);

  check(seen.devBanner, "DEV 构建身份标识出现");
  if (MODE === "tooltimeout") {
    // TODO-1 专项：真进程里验证「超时 → abort → 纠偏提示注入」
    check(!!seen.toolTimeoutNotify, "工具超阈值→中断本轮提示出现", seen.toolTimeoutNotify ?? "未收到（时长不够或未触发工具）");
    check(!!seen.toolTimeoutSteer, "纠偏提示真的注入会话", seen.toolTimeoutSteer ?? "未观察到 [健康巡检 · 工具超时中断]");
    if (seen.toolTimeoutSteer) {
      const t = seen.toolTimeoutSteer;
      check(/不要原样重试/.test(t), "纠偏提示说了不要原样重试");
      check(/async 子代理/.test(t), "纠偏提示说了交给 async 子代理");
      check(/终止条件/.test(t), "纠偏提示说了自查终止条件");
    }
  } else {
    check(seen.tickNotify.length > 0, "巡检真的按间隔触发", seen.tickNotify[0] ?? "未收到「第 N 次追问状态」提示");
    check(!!seen.nudgeMessage, "[健康巡检] 消息真的注入会话", seen.nudgeMessage ?? "超时未注入");
    check(!!seen.widgetNudged, "横幅出现 🩺 已催 N/M", seen.widgetNudged ?? "未观察到");
  }
  check(seen.errors.length === 0, "无扩展装载错误", seen.errors.join(" | "));

  if (MODE === "escalation") {
    check(seen.tickNotify.length >= 5, "催满 5 次", `实际 ${seen.tickNotify.length} 次`);
    check(!!seen.escalation, "催满后升级呼喊用户一次", seen.escalation ?? "未观察到升级提示");
    const after = seen.escalation ? lines.slice(lines.findIndex((l) => l.includes("已升级呼喊")) + 1) : [];
    const moreNudges = after.filter((l) => /\[健康巡检 #\d+\]/.test(l)).length;
    check(moreNudges === 0, "升级后不再追问（静默止损）", `升级后仍有 ${moreNudges} 条追问`);
  }
  if (MODE === "silence") {
    check(seen.tickNotify.length >= 6, "silence 下催过上限仍继续催", `实际 ${seen.tickNotify.length} 次`);
    check(!seen.escalation, "silence 下绝不升级为响铃呼喊", seen.escalation ? "出现了升级呼喊" : "");
  }

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
