// 装载冒烟测试：用 mock ExtensionAPI 真跑一遍扩展入口。
// 目的：单测只覆盖 lib/ 纯逻辑，"入口能不能在真实 API 下装载、注册了哪些工具/命令/事件"没人管——
// 而这类错误（peer 版本漂移、漏注册、装载期抛异常）恰恰是 typecheck 最容易放过、运行时最先炸的。
import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/i-am-cooking/index.ts";

type Call = { kind: string; name: string };

function makeMockApi(): { api: any; calls: Call[]; handlers: Map<string, unknown[]> } {
  const calls: Call[] = [];
  const handlers = new Map<string, unknown[]>();
  const api: any = {
    on(event: string, handler: unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: { name: string }) {
      calls.push({ kind: "tool", name: tool.name });
    },
    registerCommand(name: string) {
      calls.push({ kind: "command", name });
    },
    registerShortcut(shortcut: string) {
      calls.push({ kind: "shortcut", name: shortcut });
    },
    registerFlag(flag: string) {
      calls.push({ kind: "flag", name: flag });
    },
    registerMessageRenderer(kind: string) {
      calls.push({ kind: "renderer", name: kind });
    },
  };
  return { api, calls, handlers };
}

test("扩展入口在 mock API 下可装载，不抛异常", () => {
  const { api } = makeMockApi();
  assert.doesNotThrow(() => extension(api));
});

test("注册全部 8 个工具（工具名是与模型交互的契约，缺一个就等于功能消失）", () => {
  const { api, calls } = makeMockApi();
  extension(api);
  const tools = calls.filter((c) => c.kind === "tool").map((c) => c.name).sort();
  assert.deepEqual(tools, [
    "enter_cooking_mode",
    "exit_cooking_mode",
    "set_autonomy_level",
    "set_calling_preference",
    "set_shout_sound",
    "set_task_state",
    "set_volume",
    "shout_for_user",
  ]);
});

test("注册 /i-am-cooking 命令与停止播放快捷键", () => {
  const { api, calls } = makeMockApi();
  extension(api);
  assert.ok(calls.some((c) => c.kind === "command" && c.name === "i-am-cooking"));
  assert.ok(calls.some((c) => c.kind === "shortcut"), "停止响铃快捷键未注册");
});

test("订阅了健康巡检依赖的关键事件", () => {
  const { api, handlers } = makeMockApi();
  extension(api);
  for (const ev of ["session_start", "before_agent_start", "agent_settled", "input"]) {
    assert.ok(handlers.has(ev), `未订阅 ${ev} 事件`);
  }
});

test("工具名不重复注册", () => {
  const { api, calls } = makeMockApi();
  extension(api);
  const names = calls.map((c) => `${c.kind}:${c.name}`);
  assert.equal(new Set(names).size, names.length, "存在重复注册");
});

// ── 构建身份：命令名随 I_AM_COOKING_DEV 切换 ──
// DEV_MODE / COMMAND_NAME 是模块级常量（导入时读 env），所以只能在子进程里验证。
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_URL = pathToFileURL(join(REPO_ROOT, "extensions/i-am-cooking/lib/config.ts")).href;
const PROBE = [
  "const m = await import(" + JSON.stringify(CONFIG_URL) + ");",
  "process.stdout.write(JSON.stringify({",
  "  dev: m.DEV_MODE,",
  "  cmd: m.COMMAND_NAME,",
  "  cfg: m.CONFIG_DIR,",
  "  tag: await m.describeBuild(),",
  "}));",
].join("\n");

function probeBuild(env: Record<string, string>) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out) as { dev: boolean; cmd: string; cfg: string; tag: string };
}

test("未设 DEV：命令名是 i-am-cooking，构建描述为 release", () => {
  const r = probeBuild({ I_AM_COOKING_DEV: "" });
  assert.equal(r.dev, false);
  assert.equal(r.cmd, "i-am-cooking");
  assert.match(r.tag, /^release v/);
});

test("设了 DEV：命令名切到 i-am-cooking-dev，构建描述为 DEV", () => {
  const r = probeBuild({ I_AM_COOKING_DEV: "1" });
  assert.equal(r.dev, true);
  assert.equal(r.cmd, "i-am-cooking-dev");
  assert.match(r.tag, /^DEV v/);
});

test("DEV 与状态目录是两个独立开关，可单独生效", () => {
  const r = probeBuild({ I_AM_COOKING_DEV: "1", I_AM_COOKING_HOME: "/tmp/iac-probe-x" });
  assert.equal(r.dev, true);
  assert.ok(r.cfg.endsWith("iac-probe-x"), "状态目录应跟随 I_AM_COOKING_HOME，实际 " + r.cfg);
});
