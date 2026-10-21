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
