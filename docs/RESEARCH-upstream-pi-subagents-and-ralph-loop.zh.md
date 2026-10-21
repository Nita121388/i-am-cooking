# 调研：pi-subagents 与 Ralph Loop，对我们有什么可抄的

> 调研日期：2026-10-21 ｜ 对象：`npm:@herbertgao/pi-subagents`、`github.com/PageAI-Pro/ralph-loop`
> 结论一句话：**这两个项目都在解决"人不盯着的时候，机器怎么自己跑、怎么把人叫回来"——和我们是同一个问题。**

---

## ⚡ 30 秒版

- `pi-subagents` 是「多个子代理并行干活 + 事件总线」的编排层；`ralph-loop` 是「bash 脚本反复喂同一个 prompt」的无人值守循环。
- 我们（i-am-cooking）是**通知 + 代班层**，不跟它们抢活，但有两样东西可以直接抄：
  - **别人怎么可靠地判断"agent 现在到底在干嘛"**（它们比我们准）
  - **别人怎么把一次长跑翻译成人能看懂的一张账单**
- **只做 3 件事**：① 接 `ui_prompt_start` 事件 ② 兼容子代理事件的另一条血统 ③ 让 agent 用固定标记宣布 DONE/BLOCKED。

---

## 1. 两个项目分别是什么

| | pi-subagents | ralph-loop |
|---|---|---|
| 定位 | pi 扩展：子代理编排 + 工作流 + 事件总线 | 一个 bash 脚本：循环调用 agent CLI |
| 作者 | `@herbertgao/*` 是 `tintinweb/pi-subagents` 的维护分支（我们本机装的是另一条血统 `nicobailon` 版） | PageAI |
| 核心机制 | `Agent` 工具 spawn 子代理，后台跑、可 steer、可恢复 | 每轮发同一个 prompt，靠标签判断进展 |
| 单轮上限 | 并发默认 10 个，可配 | 默认 10 轮，`-n 50` |
| 谁在等人 | 事件总线广播状态，宿主自己决定要不要提醒 | 脚本 grep 出标签 → 响铃 + 桌面通知 |
| 对我们的关系 | **互补**：它生火，我们喊人 | **同构**：它也是"跑完/卡住→叫人" |

⚠️ 注意：`@herbertgao/pi-subagents` 和本机已装的 `pi-subagents` **不是同一个包**，是两条不同血统的 fork，事件名和注册表 key 都不一样（见 §2.4）。

---

## 2. pi-subagents：值得抄的 5 个点

### 2.1 ⭐ `ui_prompt_start` / `ui_prompt_end`——真·"在等你"信号

**我们的现状**：判断"它在等你"全靠猜。
- 回合末尾以 `？` 结尾（`index.ts` 里那条正则）
- 健康巡检催问 → 看它回不回答
- 正则漏判时再起一个**独立判官会话**（`lib/end-judge.ts`）

猜错的代价：白喊（你在厨房跑回来，发现它只是在自言自语）或漏喊（它明明弹了个确认框在等你点）。

**他们怎么做**（`pi-bark`）：直接订阅 pi 原生事件。

```ts
pi.on("ui_prompt_start", ...)  // select / confirm / input / editor / custom 任一阻塞弹窗
pi.on("ui_prompt_end", ...)    // 用户答完了 → 取消刚才的通知
```

细节值得抄：
- **400ms 宽限**：弹窗出现先等 400ms，避免"一闪而过的弹窗"也喊
- **1.5s 去重窗口**：嵌套弹窗只算一次
- **`ui_prompt_end` 撤销**：已经自己关掉了就别喊了

**我们怎么用**：cooking 模式下订阅这两个事件 → 直接走 `queueAlert(..., "urgent", "waiting-ui")`，带上 `event.title`（"agent 弹了个选择框：要不要删掉 xxx"）。

**成本**：低。一个事件 + 复用现有 `queueAlert`。

---

### 2.2 太短的任务不值得响铃（`minDurationMs`）

**我们的现状**：`maxCompletionNotices` 只限制次数，不限制时长。出门前刚开的会话 20 秒干完 → 也响铃。

**他们怎么做**：`minDurationMs`，跑不满这个时长就不发完成通知（默认 0，可配，常用 30_000）。

**我们怎么用**：加 `minCompletionDurationMs`（默认 30s）。不足 → 只更新状态栏 + 记日志，**不响铃、不弹窗、不推手机**。

**成本**：极低。

---

### 2.3 手机上一眼分得清是谁在喊

**我们的现状**：ntfy 标题是纯 ASCII 的三种固定词（`pi alert!` / `task done` / `progress`）。开三个 agent 时，锁屏上是三条一模一样的东西。

**他们怎么做**：`title.source: "session"`——用会话名（没有就用第一条用户消息）当通知标题，40 字截断、**不切断 emoji**；再加一个 `machine` 字段标机器名。

**我们怎么用**：JSON 发布路径本来就支持 UTF-8，标题写成 `<项目名>·<可爱 topic>`（我们的 topic 生成器现成的）；header 路径退回 ASCII slug。「🔕 停止响铃」按钮保留。

**成本**：低。

---

### 2.4 ⚠️ 子代理事件有两条血统，我们只认了一条

**我们现在的代码**（`index.ts` `bindSubagentEvents` + `countActiveSubagents`）：

```ts
api.events.on("subagent:async-started", ...)   // nicobailon 血统
api.events.on("subagent:async-complete", ...)
globalThis[Symbol.for("pi-subagents.background-work.v1")]  // 兜底注册表
```

**事实**：

| | 本机已装（nicobailon 版） | `@herbertgao` / tintinweb 版 |
|---|---|---|
| 生命周期事件 | `subagent:async-started` / `:async-complete` | `subagents:started` / `:completed` / `:failed` / `:steered` |
| 注册表 | `Symbol.for("pi-subagents.background-work.v1")` | `Symbol.for("pi-subagents:manager")` |
| 协议握手 | 无 | `subagents:rpc:ping` → `{version: 2}`，`session_start` 时广播 `subagents:ready` |

**后果很具体**：换装 herbertgao 版 → 子代理计数**恒为 0** → "有子代理在跑就先别催"这条守卫失效 → 会对着还在干活的 agent 催问。

**我们怎么用**：
1. 两组事件名都订阅（重复计入用 `Set` 去重）
2. 两个注册表 key 都试
3. `session_start` 时 ping 一次，状态栏显示「子代理联动：✓ 已连接 / 未安装」——**别静默降级**

**成本**：中低。**价值最高的一条**：修的是隐藏 bug，不是新功能。

---

### 2.5 硬中断前先"喊停"（graceful turn limits）

**我们的现状**：工具超时 → 直接 `ctx.abort()` → 再事后纠偏（`lib/tool-watch.ts` 那套）。

**他们怎么做**：硬 abort 之前先给子代理一条 "wrap up" 警告 → 产出**干净的半成品**，而不是被一刀切断。

**我们怎么用**：超时触发时不立刻 abort，先 `steer` 一句「10 秒内收尾，别开新的长操作」，到点再 abort。

**成本**：中低。收益：回来少看到半截烂摊子。

---

## 3. ralph-loop：值得抄的 4 个点

### 3.1 ⭐ 语义回执：让 agent 自己宣布状态

**他们写死的契约**：

```
<promise>COMPLETE</promise>
<promise>BLOCKED:网络策略拦截，需要你在宿主机改防火墙</promise>
<promise>DECIDE:用 REST 还是 GraphQL？(A vs B)</promise>
<promise>TASK-7:DONE</promise>
```

脚本 grep 出结论 → 映射退出码（`0` 完成 / `2` 阻塞 / `3` 待决策）→ 各自触发不同的通知。

**我们的现状**：`lib/prefs.ts` 的正则 + `lib/end-judge.ts` 的独立判官会话在**猜**"到底完没完"。`end-judge.ts` 的注释自己写了：措辞一变就漏判。

**我们怎么用**（最小改动，最大收益）：
1. `rules.md` 加一条：回合末尾必须写固定标记 `⟦DONE⟧` / `⟦BLOCKED:原因⟧` / `⟦DECIDE:问题⟧`
2. `detectTaskFinale` 判定顺序改成：**先找标记 → 再走正则 → 最后才叫判官**
3. 判官基本就退休了（省一次模型调用 + 省延迟）

**为什么只借"标记"这一层**：不抄它的 `<promise>` 文本标签体系——我们已经有 `shout_for_user` 这个 tool call，比文本标签可靠得多。标记只用来"宣布结束"。

**成本**：极低（改 rules + 加一条前置判断）。

---

### 3.2 环境墙一次就喊，别重试

**他们写死了一条硬规则**：

> 网络策略被拦 / 缺凭据 / 服务不可用 / 硬件不兼容 → **第一次失败就 BLOCKED，禁止 workaround、禁止重试**。"这些不是 bug，重试一万次也没用。"

**我们的现状**：`lib/errors.ts` 有 5 类错误 + 退避重试（429 / 上下文超限 → 不喊人，重试）。方向对，但**缺"这类永远不用重试"的清单** → agent 会对着防火墙刷 token、刷到上下文爆掉。

**我们怎么用**：`errors.ts` 加 `env-wall` 分类（关键词表：`network policy` / `ENOTFOUND` / `credentials` / `unauthorized` / `missing api key` …）。命中 → **直接 urgent 呼喊，不进退避**。

**成本**：低。

---

### 3.3 可观测性三件套：日志 / 存档 / 计时

**他们每轮都做**：
- `.agent/logs/LOG.md` 一行摘要（**新的在上**）
- `.agent/history/` 完整输出存档（洗掉 ANSI 色码）
- 迭代耗时 / 平均耗时 / 与上轮差 / 总时长

**我们的现状**：`config.alerts` 有呼喊列表，`turnOff` 会说"喊了你 N 次"，但**没有"这次离开到底发生了什么"的一页摘要**。

**我们怎么用**：离开结束时出一条**「行程单」**（TUI + 可选推手机）：

```
🍳 本次离开 1h 42m
✅ 完成 3 件事：修了 A、加了 B、跑了 C
📣 喊了你 4 次（2 阻塞 / 1 完成 / 1 进度）
⏳ 最久一次等你 23 分钟
❓ 还有 1 件待你决定：xxx
```

数据全在 `alerts` 里，**不用新采集**。

**成本**：低。**对 ADHD 特别有用**：回来不用翻聊天记录。

---

### 3.4 STEERING.md：插一句话的高优先级通道

**他们怎么做**：循环每轮读 `.agent/STEERING.md`，有内容 → 跳过正常任务先做它 → 做完自己删。

**我们的现状**：`rules.md` 已经是"用户可编辑 + 随改随生效"（同构，而且我们的设计更稳）。但缺"临时插队"语义——rules 是长期规则，不是本轮优先级。

**我们怎么用**（可选）：项目根放一个 `STEERING.md`，每回合注入一次"当前插队任务"。离开前写一行，比打字说清楚省事。

**成本**：中低。**优先级最低**，先不动。

---

## 4. 顺手可抄的三个小东西

| 来自 | 东西 | 我们怎么用 |
|---|---|---|
| pi-subagents | `gate: "npm test"`（用**命令**验证子代理，而不是再叫一个模型判断） | 完成通知前跑一次 `npm run typecheck`，把结果写进呼喊正文：**"✅ 完成，typecheck 通过"** 比"我觉得完成了"强 |
| ralph-loop | `preflight`（必需文件在不在，缺就退出） | `turnOn` 前检查：ntfy 通不通 / TTS 命令在不在 / 铃声文件在不在 → 一行警告「⚠ 手机推送未配置，厨房里可能听不到」 |
| pi-subagents | `subagents:ready` 广播 + 协议版本号 | 我们和子代理扩展的对接加个版本字段，扩展升级后事件改名时不至于静默失效 |

---

## 5. ❌ 明确不抄（防走偏）

- **Docker 沙箱 / git worktree 隔离**——那是编排层的事，我们只管"喊人"。
- **PRD → tasks.json 全流程**——Trellis 已经在做，别重复造轮子。
- **`<promise>` 文本标签体系整套**——我们有 tool call，比文本标签可靠。只借"固定结束标记"这一层。
- **workflow 编排 / FleetView / 会话查看器**——装了就有，自己实现纯属浪费。
- **再加一个 Bark 推送通道**——ntfy 已覆盖，加通道 = 加维护面。

---

## 6. 建议动作（按性价比排序）

| 优先级 | 做什么 | 改哪里 | 预估 |
|---|---|---|---|
| **P0** | 订阅 `ui_prompt_start/end`，弹窗时立刻喊 | `index.ts` 事件接线 + 复用 `queueAlert` | 1-2 小时 |
| **P0** | 双血统兼容：两组事件名 + 两个注册表 key | `bindSubagentEvents` / `countActiveSubagents` | 1 小时 |
| **P0** | 固定结束标记 `⟦DONE⟧⟦BLOCKED⟧⟦DECIDE⟧` | `rules.md` + `detectTaskFinale` | 30 分钟 |
| **P1** | `minCompletionDurationMs`（太快不喊） | `lib/config.ts` + `queueAlert` | 30 分钟 |
| **P1** | 推送标题带项目名/会话名 | `lib/push.ts` `ntfyTitle` | 1 小时 |
| **P1** | 离开结束「行程单」 | `turnOff` + `lib/config.ts` alerts | 2 小时 |
| **P1** | `env-wall` 错误不重试、直接喊 | `lib/errors.ts` | 1 小时 |
| **P2** | graceful abort（先喊停再中断） | `lib/tool-watch.ts` + `checkToolTimeouts` | 2 小时 |
| **P2** | `turnOn` preflight 检查通道 | `index.ts` `turnOn` | 1 小时 |
| **P2** | `STEERING.md` 插队通道 | `lib/rules.ts` | 3 小时 |

---

## 7. 一句话总结

> **它们教我们的不是"再加功能"，而是"别猜"。**
> 别猜 agent 在不在等你（`ui_prompt_start` 是确定信号）、别猜它是不是干完了（让它自己打标记）、别猜是哪个扩展在跑（两条血统都认）。
> 猜错的成本，就是你在厨房白跑一趟。

---

## 附：资料来源

- `@herbertgao/pi-subagents`：https://github.com/HerbertGao/pi-extensions/tree/master/packages/pi-subagents
  - 同仓 `pi-bark`（Bark 推送）：`packages/pi-bark`，`minDurationMs` / `ui_prompt_start` 的范式来源
  - 事件总线 & RPC：`packages/pi-subagents/docs/rpc.md`
- `ralph-loop`：https://github.com/PageAI-Pro/ralph-loop
  - 契约核心：`.agent/PROMPT.md`、`scripts/lib/promise.sh`、`scripts/lib/notify.sh`
- 本机已装的另一血统：`~/.pi/agent/npm/node_modules/pi-subagents`（v0.63.0，nicobailon 版）
