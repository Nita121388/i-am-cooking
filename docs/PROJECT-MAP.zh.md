# i-am-cooking 项目全图（代码路径 + 全部状态）

> **这份文件的用途**：给 `project-explainer` Agent 当唯一权威底稿，也给人当"顺藤摸瓜"的索引。
> 目标是**任意一个行为，都能顺着路径追到代码行；任意一个状态，都能说出它的全部取值、迁移条件、谁写谁读**。
>
> **锚点**：分支 `feat/health-watch-robustness`，工作区快照（含未提交改动）。
> - `extensions/i-am-cooking/index.ts` = 2458 行
> - `lib/` = 15 个模块，合计 1921 行
> - 行号会随改动漂移。**引用行号前先用 `grep -n` 复核**，本文件末尾有复核命令。
>
> **状态图例**：`[已实现]` = 当前工作区代码确实做了；`[缺口]` = 没做或做错了，附证据；`[取舍]` = 有意为之，别当 bug。

---

## 0. 一句话定位与三层机制

它不是"通知插件"，是**代班机制**。三层，缺一层都不成立：

| 层 | 干什么 | 关键代码 |
|---|---|---|
| ① 改行为 | 离开期间每回合往 systemPrompt 注入自主规则 + 等级指南 | `before_agent_start` → `buildRulesPrompt()` |
| ② 多路呼喊 | 卡住/完成时五路广播：声音、TTS、Toast、TUI 横幅、手机推送 | `queueAlert()` → `fireAlert()` |
| ③ 兜失败 | 定时探活 + 工具超时中断 + 异常退避 + 收尾判定 | `healthTick()` / `checkToolTimeouts()` / `scheduleErrorRetry()` / `judgeTurnEnd()` |

**核心不变量**：用户回来打字 ≠ 退出离开模式（只是"响应呼喊"）；只有 `exit_cooking_mode` 工具或 `/off` 才退出。

---

## 1. 文件清单与职责

| 文件 | 行数 | 职责 | 谁依赖它 |
|---|---:|---|---|
| `extensions/i-am-cooking/index.ts` | 2458 | **唯一接线层**：命令、工具、快捷键、事件钩子、定时器、呼喊编排 | pi 运行时 |
| `lib/config.ts` | 236 | 配置类型 + 默认值 + 路径常量 + 读写；`resolveStateDir` / `isDevMode` | 几乎所有模块 |
| `lib/health.ts` | 315 | 健康巡检**纯状态机**：5 个 phase、滴答判定、忙判定、文案 | index |
| `lib/tool-watch.ts` | 140 | 在飞工具计时表（`Map<toolCallId,{toolName,startedAt}>`）+ 超时挑选 + 纠偏文案 | index |
| `lib/errors.ts` | 195 | 回合异常分类（5 类）+ 退避计算 + 升级判定 + 重试文案 | index |
| `lib/end-judge.ts` | 103 | 收尾判官：提示词生成、判官输出解析、该不该起判官 | index |
| `lib/prefs.ts` | 144 | 偏好/等级**文字匹配保险丝**、收尾正则、进度类判定、偏好抑制 | index |
| `lib/rules.ts` | 114 | 规则加载 + systemPrompt 拼装 + 底线规则 + 等级指南 | index |
| `lib/audio.ts` | 119 | 三段式播放（beeps → TTS → 自定义歌曲），总时长预算 | index |
| `lib/audio-lock.ts` | 56 | 跨进程音频互斥锁（`wx` 原子创建 + pid 存活 + 75s stale） | audio |
| `lib/push.ts` | 131 | ntfy / webhook 双通道推送，`${ENV}` token 解析 | index |
| `lib/remote-stop.ts` | 94 | 手机"停止响铃"按钮的本地 HTTP 端点 | index |
| `lib/volume.ts` | 149 | 音量读取/设置/静音/离开拉高/恢复（三平台） | index |
| `lib/platform.ts` | 54 | 跨平台命令执行；Windows 走 PS1 + JSON 数据文件 | audio/volume/index |
| `lib/topic.ts` | 39 | ntfy 可爱 topic 名生成/校验 | setup 向导 |
| `lib/tts.ts` | 32 | TTS 文案三层模板渲染（`ttsText` 优先） | index |
| `rules.default.md` | 61 | 出厂规则（只做首次播种，之后用户那份接管） | rules.ts |
| `scripts/shout.ps1` `toast.ps1` `volume.ps1` | — | Windows 三件套 | platform.ts |

**分层原则**：`lib` 里全是纯函数或窄接口（路径参数化、时间参数化），所以 `tests/` 能在不碰 pi 运行时的情况下测完。`index.ts` 独占"读事件 → 改状态 → 调副作用"。

---

## 2. 运行时对象图

```
pi 运行时
  │  ExtensionAPI (pi)
  ├─ registerCommand(/i-am-cooking)      → commandHandlers 表 (12 个子命令) 或 默认 turnOn
  ├─ registerShortcut(Ctrl+Alt+M)        → stopCurrentSound
  ├─ registerTool ×8                     → 工具 execute
  └─ on(event) ×9                        → 事件钩子
        ↓
   index.ts 模块级单例（进程内，每个 pi 进程一份）
        ├─ config: Config         ←→ ~/.pi/i-am-cooking/config.json
        ├─ health: HealthState
        ├─ runningTools: ToolWatch
        ├─ sessionTimers[] / reportTimer / healthTimer / retryTimerRef
        ├─ agentActive / shoutingState / completionNoticeCount
        ├─ abortedToolCalls:Set / toolAbortCount / retryAttempt
        ├─ settleSeq / lastJudgedSettleSeq / lastStopReason / lastAssistantText / lastCtx
        ├─ activeSubagents:Set
        └─ remoteStopSrv / remoteStopToken
        ↓
   lib 纯函数 ─→ 副作用：文件 / 进程 / HTTP / TUI
```

---

## 3. 接入点全表（pi 扩展 API）

### 3.1 事件钩子（9 个，`index.ts:2224-2438`）

| 事件 | 行 | 触发时机 | 做了什么 | 影响的状态 |
|---|---:|---|---|---|
| `session_start` | 2224 | 会话启动 | `readConfig()`、`ensureRulesFile()`、**无条件 `resetCookingState()`**；DEV 每次打印构建身份，非 DEV 首次提示 setup | 重置全部会话级状态 |
| `session_shutdown` | 2246 | 会话关闭 | `clearRepeatTimers()`、`stopAudioAll()`、`stopRemoteStop()`、异步 `restoreVolume()`、落盘 config | 清定时器/音频/音量 |
| `before_agent_start` | 2256 | 每回合构建 prompt 前 | 非离开模式直接 return；否则 `agentActive=true`、`touchActivity`、追加 `buildRulesPrompt()` | agentActive、health.idleSince、systemPrompt |
| `agent_start` | 2267 | 回合开始 | `touchActivity` | health.idleSince；stalled→working |
| `agent_end` | 2268 | 回合结束 | `touchActivity`；从 `event.messages` 倒序找 assistant，记 `stopReason` 与最后文本 | lastStopReason、lastAssistantText |
| `tool_execution_start` | 2285 | 工具开始 | `startToolWatch(id,name,now)`、`lastCtx=ctx`、`touchActivity`、`updateWidget` | runningTools、lastCtx、health |
| `tool_execution_end` | 2292 | 工具结束 | `endToolWatch`、`abortedToolCalls.delete`；**表态类工具直接 return**；否则 `retryAttempt=0` + `markRealWork` + `updateWidget` | runningTools、retryAttempt、health |
| `turn_start` | 2304 | 每轮开始 | `touchActivity` | health.idleSince |
| `subagent:async-started` / `async-complete` | 绑于 `1003` | **pi-subagents 事件总线**（`api.events.on`，非 pi 原生事件） | add/delete `activeSubagents`；started 时 touch，complete 时 `markRealWork` | activeSubagents、health |

> ⚠️ **这一行与上面 8 行不同源**：上面 8 个是 pi 原生 `pi.on()` 事件；这一对是 `api.events.on()` 的扩展间事件总线，**只有装了 pi-subagents 才存在**，未装时 `bindSubagentEvents`（`index.ts:1003-1010`）整个 try/catch 静默跳过。
> 事件丢失不会报错，只会让 `activeSubagents` 少计或残留 —— 这正是 G-02。
> 另：`countActiveSubagents`（`index.ts:964-991`）还有一条注册表兜底，读的是 pi-subagents 的私有内部契约（G-15）。
| `agent_settled` | 2326 | 回合彻底静止 | 详见 §6.4：收尾判定、报错分类/重试、自动呼喊 | agentActive、health.phase、重试、呼喊 |
| `input` | 2421 | 用户输入 | 详见 §6.3：markUserInput、文字匹配偏好/等级、ack 全部呼喊、停音频 | health、callingMode、autonomyLevel、alerts |

> ⚠️ **`agent_settled` 的幂等守卫是死代码** `[缺口]`（见 §9 G-01）：
> ```ts
> const mySeq = ++settleSeq;
> if (mySeq === lastJudgedSettleSeq) return;   // 永假：mySeq 每次递增，lastJudgedSettleSeq ≤ settleSeq-1
> lastJudgedSettleSeq = mySeq;
> ```
> 同一回合如果 `agent_settled` 重复触发，会重复扫描（重复 `stopReportTimer`/`setPhase`，自动呼喊靠 `queueAlert` 的 10 分钟去重兜底）。

### 3.2 命令（1 个注册，12 个子命令 + 默认 = on）

注册：`index.ts:1842` `pi.registerCommand(COMMAND_NAME, commandSpec)`；DEV 模式额外注册 `/i-am-cooking` 别名并每次提醒（`1846`）。
命令名：`COMMAND_NAME = DEV_MODE ? "i-am-cooking-dev" : "i-am-cooking"`（`lib/config.ts:47`）。

| 子命令 | handler 行 | 入口函数 |
|---|---:|---|
| `on [备注]` / 无子命令 | 1835 | `turnOn(ctx, note, true)` |
| `off` | 522 | `turnOff(ctx,"command")` |
| `status` | 523 | `showStatus` |
| `setup` | 524 | `setupWizard` |
| `test` | 525 | `testShout` |
| `stop-sound` | 526 | `stopCurrentSound` |
| `rules` / `edit-rules` / `reset-rules` | 527-529 | `cmdRules` / `cmdEditRules` / `cmdResetRules` |
| `level [...]` | 530 | `cmdLevel` |
| `limits` / `sound` / `volume` | 531-533 | `cmdLimits` / `cmdSound` / `cmdVolume`（交互式中文菜单） |
| `health [...]` | 534 | `cmdHealth` |

### 3.3 快捷键

`Ctrl+Alt+M` → `stopCurrentSound`（`1857`）。只掐当前音频，不改配置、不清待处理呼喊。

### 3.4 工具（8 个）

| 工具 | 行 | 作用 | 写入状态 | 备注 |
|---|---:|---|---|---|
| `shout_for_user` | 1869 | 呼喊 / 进度 / 完成通知 | `queueAlert` → config.alerts | 核心接口；`category` 决定走哪条通道 |
| `set_calling_preference` | 1931 | 改呼喊偏好 | `config.callingMode` + `healthMuteEscalation` | **表态类**，不计真实工作 |
| `set_task_state` | 1961 | 向巡检表态 | `setPhase(health,...)` | **表态类**，不计真实工作 |
| `set_autonomy_level` | 2010 | 改自主等级 | `config.autonomyLevel` | 持久化，跨会话保留 |
| `enter_cooking_mode` | 2037 | 语义开启离开模式 | `turnOn` | 仅在用户明确离开时 |
| `set_shout_sound` | 2071 | 设置自定义铃声 | `config.soundPath/soundSeconds` | 需本机文件 |
| `set_volume` | 2125 | 调音量 | 系统音量（不改 config） | 用户明确要求或呼喊前解除静音 |
| `exit_cooking_mode` | 2191 | 语义关闭 | `turnOff(ctx,"tool")` | 只在用户明确回来时 |

`STATEMENT_ONLY_TOOLS = {set_task_state, shout_for_user}`（`1000`）：**这两个工具结束时不 `markRealWork`、不清 `nudges`**，否则 agent 一句"收到"就能洗掉催问计数，巡检永远升不了级。

---

## 4. 全部状态（一）：模块级单例

| 变量 | 类型 | 初值 | 谁写 | 谁读 | 生命周期 |
|---|---|---|---|---|---|
| `config` | `Config` | `{...DEFAULTS}` | 几乎所有命令/工具/事件 | 同上 | 会话级，落盘持久 |
| `api` | `ExtensionAPI` | 工厂注入 | `extension()` | `turnOn/turnOff/report/health` | 进程 |
| `sessionTimers` | `Interval[]` | `[]` | `scheduleRepeats`、`startReportTimer`、`startHealthTimer`、`scheduleErrorRetry` | `clearRepeatTimers` | 会话；**清空时整数组重置** |
| `shoutingState` | `boolean` | `false` | `fireAlert`、`stopAudioAll`、`stopCurrentSound`、远程停止 | `updateStatus`、`updateWidget`、`input` | 播放期间 |
| `health` | `HealthState` | `newHealthState(now)` | 见 §5.1 | 见 §5.1 | 会话；`turnOn`/`reset` 重置 |
| `healthTimer` | `Interval\|null` | `null` | `startHealthTimer` / `stopHealthTimer` | `clearRepeatTimers` | 离开期间 |
| `runningTools` | `ToolWatch` | `new Map()` | `tool_execution_start/end`、`checkToolTimeouts` | `activitySnapshot`、`updateWidget` | 会话 |
| `abortedToolCalls` | `Set<string>` | `∅` | `checkToolTimeouts`(add)、`tool_execution_end`(delete) | `overdueTools(skip)` | 会话 |
| `toolAbortCount` | `number` | `0` | `checkToolTimeouts`(++) | `checkToolTimeouts`、纠偏文案 | 会话（**只在 reset 归零**） |
| `retryAttempt` | `number` | `0` | `scheduleErrorRetry`(++)、真实工具结束/非报错收尾(归零) | `shouldEscalate`、文案 | 会话 |
| `retryTimerRef` | `Timeout\|null` | `null` | `scheduleErrorRetry`、`cancelRetry` | `cancelRetry` | 会话 |
| `settleSeq` | `number` | `0` | `agent_settled`(++) | 幂等守卫 | 会话 |
| `lastJudgedSettleSeq` | `number` | `-1` | `agent_settled` | 幂等守卫（**已失效**） | 会话 |
| `lastCtx` | `CookingCtx\|undefined` | `undefined` | `tool_execution_start`、`agent_settled` | 保留给定时器用 | 会话 |
| `activeSubagents` | `Set<string>` | `∅` | subagent 事件 | `countActiveSubagents` | 会话；**事件丢失会残留** `[缺口]` |
| `lastStopReason` | `string\|undefined` | `undefined` | `agent_end`、`lastTurnSnapshot` | 巡检文案 | 会话 |
| `lastAssistantText` | `string` | `""` | `agent_end` | `lastTurnSnapshot` | 会话 |
| `completionNoticeCount` | `number` | `0` | `turnOn`(归零)、`queueAlert`(++) | `queueAlert` 上限判断 | 每次离开 |
| `remoteStopSrv` | `RemoteStopHandle\|null` | `null` | `startRemoteStop` / `stopRemoteStop` | `pushAlert` 拼按钮 | 离开期间 |
| `remoteStopToken` | `string` | `randomUUID()` | 启动/停止时换新 | `startRemoteStopServer` | 会话 |
| `reportTimer` | `Interval\|null` | `null` | `startReportTimer` / `stopReportTimer` | `clearRepeatTimers` | 离开期间 |
| `agentActive` | `boolean` | `false` | `before_agent_start`(true)、`agent_settled`(false) | `activitySnapshot` | 回合 |

---

## 5. 全部状态（二）：状态机

### 5.1 健康巡检 `HealthPhase`（5 态，`lib/health.ts:17`）

```
                  newHealthState / markUserInput / setPhase(working)
        ┌───────────────────────────────► working ◄──────────────┐
        │                                  │                     │
        │  touchActivity(stalled)          │ decideHealthTick    │ markRealWork
        │                                  │                     │ (done 不翻回)
        │        ┌─────────────────────────┼──────────────┐      │
        │        ▼                         ▼              ▼      │
        │   waiting_user                  done          stalled  │
        │   (有未处理阻塞呼喊 + 已空闲)   (收尾判定)     (催满上限)│
        │                                                  │      │
        └──────────────────────────────────────────────────┘      │
                                                                  │
   exhausted（用户说过别喊 + 静默催满 30 次）── 用户开口 ─────────┘
```

| 当前 | 事件 | 下一态 | 代码 |
|---|---|---|---|
| any | `newHealthState(now)` | working, nudges=0 | `health.ts:70` |
| any | `touchActivity` | idleSince=now；**stalled→working**（清计数）；其它不变 | `health.ts:80` |
| any | `markUserInput` | →working，清计数/note | `health.ts:94` |
| 除 done | `markRealWork` | stalled→working，清计数；**done 保持 done** | `health.ts:107` |
| any | `setPhase(working)` | →working，清计数 | `health.ts:115` |
| working | `decideHealthTick` → `waiting` | waiting_user | `health.ts:198` |
| working | `decideHealthTick` → `escalate` | stalled（并 `queueAlert(normal,"health-stall")`） | `health.ts:198` + `index.ts:1222` |
| working | `decideHealthTick` → `exhausted` | exhausted（**不喊人**） | 同上 |
| done | 用户输入 | working（`markUserInput`） | `index.ts:2421` |
| waiting_user | 用户输入 | working | 同上 |
| stalled | 任何真实活动 | working | `touchActivity` |

**谁写 phase（穷举）**：`newHealthState`、`touchActivity`(仅 stalled)、`markUserInput`、`markRealWork`(仅 stalled)、`setPhase`（3 处调用：`queueAlert` completion→done `:1335`；`agent_settled` 收尾→done `:2375`；问号结尾→waiting_user `:2381`）、`applyHealthDecision`（waiting/escalate/exhausted）、`set_task_state` 工具 `:1993`。

**滴答判定顺序**（`decideHealthTick`，顺序即语义，别调换）：
1. `!cooking` → skip(not-cooking)
2. `!enabled` → skip(disabled)
3. `phase !== working` → skip(phase)
4. `agentBusy || runningTools>0 || activeSubagents>0` → skip(busy)
5. `pendingMessages` → skip(queued)
6. `now - idleSince < idleMinutes` → skip(not-idle)  ← **先判空闲，再判阻塞呼喊**
7. `blockingAlerts > 0` → waiting
8. `muteEscalation && nudges >= silenceMaxNudges(30)` → exhausted
9. `nudges >= maxNudges(5)` → escalate
10. 否则 → nudge(nudges+1)

**`nudge` 落状态时的关键语义**（`applyHealthDecision`）：`idleSince = now`，给它一个完整窗口再判——这是防"刚催完立刻又催"的核心。

**统一"忙"判定** `ActivitySnapshot`（`health.ts:28`，`index.ts:895`）：
```ts
agentBusy = agentActive || !ctx.isIdle()
isBusy = agentBusy || runningTools>0 || activeSubagents>0      // 队列不算忙
shouldSkipReportTick = !agentBusy || runningTools>0 || pendingMessages
```
`reportTimer` 与 `healthTick` 都从这里取数（TODO-3 已落地）。**方向相反**：心跳要"回合在跑"才有进度可报，巡检要"没在跑"才催。

### 5.2 离开模式（`config.cooking`）2 态

| 转换 | 触发 | 关键副作用 |
|---|---|---|
| off→on | `/on`、`enter_cooking_mode`、备注默认 | `since=now`、重置 health/completionCount、`startRemoteStop`、`boostVolume`、备注文字匹配偏好/等级、可选询问进度模式、`startReportTimer`、`startHealthTimer`、`steer` 注入交接说明 |
| on→off | `/off`、`exit_cooking_mode` | `clearRepeatTimers`、停音频、`stopRemoteStop`、`config.alerts=[]`、`callingMode=normal`、`restoreVolume`；**命令路径额外 steer 告知 agent 已回在线** |
| on→off（会话级） | `session_start` | `resetCookingState`：连 `health`、`runningTools`、`abortedToolCalls`、`activeSubagents`、`settleSeq`、`retry` 一起重置；仅当上次有离开且有呼喊时提示归档条数 |

`[取舍]` 离开状态**不跨会话**：会话重开默认在岗。

### 5.3 `Alert` 生命周期

```
queueAlert(message, urgency, category, ctx, ttsText?)
 ├─ !!cooking → "not-cooking"            （丢弃）
 ├─ milestone 且 progressReporting!=milestone → "mode-off"
 ├─ completion:
 │    stopReportTimer()  +  setPhase(done)
 │    completionNoticeCount >= maxCompletionNotices(3) → "limit"
 │    completionNoticeCount++
 ├─ 非进度类：10 分钟内相同未 ack 消息 → "duplicate"
 └─ push → writeConfig → fireAlert → scheduleRepeats → "queued"

fireAlert(alert, ctx, {forceSound})
 ├─ 进度类(progress/milestone): 只 ui.notify + pushAlert，绝不响铃/弹窗/横幅
 ├─ 否则：
 │    widget + TUI notify（repeatCount==0 才 notify；摘要截 80 字）
 │    suppress? → 直接 return true（不响铃/不弹窗/不推送）
 │    sound||tts → shoutingState=true → playSound(三段式, fire-and-forget)
 │    toast → showNotification
 │    pushAlert → ntfy(带 actionUrl) / webhook / 旧配置 webhookUrl
 └─ 返回"手机是否发送成功"

scheduleRepeats
 ├─ completion → 不重复
 ├─ urgent → setInterval(urgentRepeatMinutes)；acked 或 maxUrgentRepeats 到 → 停
 └─ normal → setTimeout(repeatIntervalMinutes) 只补 1 次
```

**清除路径（穷举）**：用户 `input`（全部 ack + 停音频）、手机远程停止（全部 ack）、`turnOff` / `resetCookingState`（`alerts=[]`）。

`pendingAlerts()` = 全部未 ack；`pendingActionAlerts()` = 未 ack 且**不是 progress/milestone/completion**（横幅 ⚠ 计数只用它，避免进度把徽标刷成红色）。

### 5.4 进度汇报模式（3 态）

| 值 | 谁驱动 | 注入内容 | category | 去重 |
|---|---|---|---|---|
| `milestone`（默认） | agent + 系统每 N 分钟自查 `[milestone check]` | 有无值得报的小阶段 | `milestone` | **不参与去重** |
| `interval` | 系统每 N 分钟三问 `[定时汇报]` | 已完成/在做/有无进展 | `progress` | **不参与去重** |
| `none` | — | 不注入、`milestone` 调用返回 mode-off | — | — |

投递方式：`steer`（下次 LLM 调用前生效，不等回合结束）。
三种自动停表：`completion` 呼喊（`queueAlert` 内）、`detectTaskFinale` 命中（`agent_settled`）、`agentActive=false` 让心跳自然跳过。

### 5.5 呼喊偏好 `CallingMode`（5 态）× 自主等级 `AutonomyLevel`（3 态）

两轴正交：**偏好管"喊多响"，等级管"该不该喊"**。

`shouldSuppress`（`prefs.ts:139`）：
| mode | 抑制规则 |
|---|---|
| `silence` | 全部抑制（只留横幅/widget） |
| `completion_only` | 非 completion 全抑制 |
| `urgent_only` | 非 urgent 全抑制 |
| `eager` / `normal` | 不抑制 |

**文字匹配保险丝**（`prefs.ts`，毫秒级，不依赖 LLM）：
- `detectPreference`：别喊/安静/静音 → silence；完成后喊我/干完喊 → completion_only；只有紧急才 → urgent_only；随时汇报/有进展就说 → eager；恢复默认/需要时再喊 → normal。
- `detectAutonomyLevel`：遇墙就喊/谨慎/拿不准就问我 → conservative；平衡/默认/有难度才喊 → balanced；能不喊就不喊/自主处理/除非彻底没法继续 → autonomous。
- 调用点：`input` 事件（你说的话）、`turnOn` 的备注、工具显式调用。

**副作用联动**：`setCallingMode(silence)` 会同时置 `config.healthMuteEscalation=true`（巡检只催不升级）。
**持久化差异**：`callingMode` 会话级（reset/off 归 normal）；`autonomyLevel` 跨会话持久。

### 5.6 工具超时（TODO-1，已实现）

```
tool_execution_start → runningTools.set(id,{name,startedAt})
healthTick（每次滴答，且**在 healthCheck 闸门之前**）
  └─ checkToolTimeouts(ctx)
       overdue = overdueTools(runningTools, now, toolTimeoutMinutes*60k, abortedToolCalls)
       for each overdue:
         abortedToolCalls.add(id); endToolWatch(id)      ← 先摘表，巡检"忙"立刻恢复
         toolAbortCount >= maxAborts(3)? → 只通知不中断
         否则: toolAbortCount++ → ctx.abort() → followUp(buildToolTimeoutSteer)
```

**为什么必须在闸门前**：长脚本永不死时 `tool_execution_end` 永不到来，若不摘表，`runningTools>0` 会被读作"正在干活"，巡检**永远不催**（不是催得慢，是永远不催）。
`[取舍]` `ctx.abort()` 中断整轮而非单工具；不推手机、不升级呼喊，只 TUI 提示 + 日志。

### 5.7 异常退避（429 / 上下文超限，已实现）

```
agent_settled 且 stopReason==="error"
  └─ classifyTurnError({errorMessage, rawStopReason, contextPercent})
       优先级：HTTP 状态码 > rawStopReason 语义 > 错误文本正则 > contextPercent>=95
       → rate-limit | context-overflow | transient | permanent | unknown
  └─ scheduleErrorRetry(kind, text)
       !isRetryable(kind) → false（直接喊）
       shouldEscalate(kind, retryAttempt, maxAttempts) → false（到上限喊）
       context-overflow → 先 ctx.compact()
       waitMs = backoffMs(retryAttempt+1, base, cap)  // 1,2,4 分钟，封顶 10
       retryAttempt++ → notify → setTimeout(waitMs) → followUp(buildRetrySteer)
     返回 true 的都不喊人；false → queueAlert(urgent,"auto-error")
```

状态码白名单：429→rate-limit；413→context-overflow；408/500/502/503/504/529→transient；400/401/403/404/409/422→permanent。
`[取舍]` `unknown` 宁可误喊不可漏喊。

### 5.8 收尾判定（TODO-2，已实现）

```
agent_settled（非报错、有最后一句、最后不是 toolResult/bashExecution）
  regexSaidDone = detectTaskFinale(text)          // 任务|全部|整体…完成|收工，排除"未完成/一半"
  if (!regexSaidDone) verdict = await judgeTurnEnd(...)   // 可选，默认 off
  if (finale) { stopReportTimer(); setPhase(done) }
  if (!finale && level!=="autonomous" && text<=600 且以 ？ 结尾) setPhase(waiting_user)
```

判官（`healthEndJudge: "cli"` 才启用）：
- `shouldUseEndJudge`：off/正则为真/最后还在干活/命令空/文本<12 字 → 不起
- `renderEndJudgeCommand`：`{prompt}`/`{text}` 替换，单引号 shell 转义
- `parseEndJudgeVerdict`：只看前 5 个非空行；**先判 NOT_DONE 再判 DONE**（"NOT_DONE" 含 "DONE"）
- 任何失败（命令不存在/非 0/超时/无法解析）→ `unknown`，**降级回正则，绝不阻塞**

### 5.9 音频与音量状态

- `audio-lock`：`audio.lock` 文件 `{pid, createdAt}`；`wx` 原子创建；stale = pid 死 或 超 75s；`force` 抢占（`/test` 用）。
- `playSound` 三段式共用 `soundSeconds` 总预算（默认 60s），到点 kill；拿不到锁 → 本次**跳过声音**，弹窗/推送照常。
- `shoutingState` 只反映本实例；多 Agent 间不共享。
- 音量：`boostVolume` 仅当 `config.boostVolume=true` 且当前音量 < boostLevel；`restoreVolume` 在 off / 会话关闭 / reset 调用。

### 5.10 远程停止

仅 `remoteStop && phonePush && pushProvider==="ntfy" && ntfyTopic` 时启动（`turnOn`）。`onStop` = 停音频 + 全部 ack + 落盘 + 回 idle 状态。`stopRemoteStop` 换新 token → 旧推送按钮立即失效。

---

## 6. 代码路径索引（按触发源追到底）

### 6.1 手动 `/on`

```
commandSpec.handler (1831)
 └ turnOn(ctx, note, askMilestone=true) (1401)
    ├ 幂等：已在离开 → return
    ├ config.cooking=true; since=now; completionNoticeCount=0; health=newHealthState
    ├ writeConfig → notify → updateStatus(idle) → updateWidget
    ├ startRemoteStop (async, 失败仅日志)
    ├ boostVolume(config)
    ├ note 里 detectPreference / detectAutonomyLevel → setCallingMode / setAutonomyLevel
    ├ askMilestone && TUI → ui.select 进度模式（①milestone ②interval+间隔 ③none）→ writeConfig
    ├ progressReporting!=none → startReportTimer
    ├ startHealthTimer
    └ api.sendUserMessage(交接说明, {deliverAs:"steer"})
```

### 6.2 `/off`

```
turnOff(ctx, source) (1483)
 ├ clearRepeatTimers → stopAudioAll → stopRemoteStop → stopHealthTimer
 ├ pending=pendingAlerts(); cooking=false; since=undefined; alerts=[]; callingMode=normal; writeConfig
 ├ setStatus("") / setWidget([]) → restoreVolume
 ├ source==="command" → steer 告知 agent 回到在线状态
 └ notify（带"喊了你 N 次"）
```

### 6.3 用户打字（`input`，2421）

```
非交互 / 以 "/" 开头 → return
markUserInput(health) → updateWidget
detectPreference(text) → setCallingMode     （文字保险丝）
detectAutonomyLevel(text) → setAutonomyLevel
pendingCount=pendingAlerts().length; hadAudio=shoutingState||hasActiveAudio()
if (pending||hadAudio):
    stopAudioAll → 全部 ack → writeConfig → updateStatus(idle) → updateWidget
    userInputNotice({pendingCount,hadAudio}) → notify（0 条且没响 → 不打扰）
```

### 6.4 `agent_settled`（2326，最复杂的一条）

```
agentActive=false；非离开 → return；lastCtx=ctx；touchActivity
幂等守卫（已失效）
倒序扫 entries：
   toolResult/bashExecution → trailingWork=true, break
   assistant 有文本 → 记 {text,stopReason,errorMessage,rawStopReason}, break
   user → break
无最后一句 或 trailingWork → return
最终：finale=正则 or 判官；finale → stopReportTimer + setPhase(done)
      非 finale 且非 autonomous 且短问句 → setPhase(waiting_user)
      !autoDetect → return
      isError → classify → scheduleErrorRetry? return : queueAlert(urgent,"auto-error")
      非报错 → retryAttempt=0
      autonomous → return（不因问号自动喊）
      短问句 → queueAlert(normal,"auto-question")
```

### 6.5 定时器回调

| 定时器 | 创建 | 回调路径 | 投递 |
|---|---|---|---|
| `reportTimer` | `startReportTimer` (918) | `shouldSkipReportTick(activitySnapshot)` → `api.sendUserMessage(msgs, steer)` | steer |
| `healthTimer` | `startHealthTimer` (1309) | `healthTick` (1222) → `checkToolTimeouts` → `decideHealthTick` → `applyHealthDecision` + `notify` + (`followUp` 或 `queueAlert`) | followUp |
| 重复呼喊（urgent/normal） | `scheduleRepeats` (852) | `fireAlert` → `playSound`/`showNotification`/`pushAlert` | — |
| 退避重试 | `scheduleErrorRetry` (1113) | `followUp(buildRetrySteer)` | followUp |

`clearRepeatTimers()`（882）统一清：`sessionTimers` 全清 + `retryTimerRef` + `reportTimer` + `healthTimer`。
`[缺口]` `sessionTimers` 里的重复呼喊定时器**自我 clear 后仍留在数组里**，长期离开会缓慢增长（§9 G-05）。

---

## 7. 外部 I/O 与副作用（全部）

| 类别 | 目标 | 代码 | 失败策略 |
|---|---|---|---|
| 文件 | `~/.pi/i-am-cooking/config.json` | `readConfig`/`writeConfig` | 读写失败只日志 |
| 文件 | `.../rules.md`（首次从 `rules.default.md` 播种） | `ensureRulesFile` | 回退出厂默认 |
| 文件 | `.../audio.lock` | `audio-lock` | 抢不到 = 跳过声音 |
| 文件 | `.../tmp/*.json`（Windows PS1 数据） | `runPowerShellScript` | best effort |
| 网络 | ntfy `POST {server}/{topic}`（header 或 JSON） | `pushPhone` | 返回 false，不抛 |
| 网络 | webhook `POST` + 自定义 token header | `pushWebhook` | 同上 |
| 网络 | 本地 HTTP `/stop?token=` | `startRemoteStopServer` | 启动失败仅日志 |
| 进程 | macOS `osascript beep` / `say -v Tingting` / `afplay` / `display notification` | audio/index | 全部 catch |
| 进程 | Linux `canberra-gtk-play` / `espeak-ng` / `paplay`/`aplay` / `notify-send` / `pactl` | audio/volume | 全部 catch |
| 进程 | Windows `shout.ps1` / `toast.ps1` / `volume.ps1` | platform | 非 win32 直接 resolve |
| 进程 | 判官命令 `/bin/sh -c <templated>` | `runJudgeCommand` | 超时/非 0 → unknown |
| TUI | `setStatus` / `setWidget` / `notify` / `select` / `input` | index | ctx.ui 可能缺省，全部守卫 |
| 环境 | `I_AM_COOKING_HOME`、`I_AM_COOKING_DEV` | `lib/config.ts` | — |

---

## 8. 测试覆盖映射

| 测试文件 | 覆盖对象 | 没覆盖的（风险） |
|---|---|---|
| `config.test.ts` | DEFAULTS 完整性、深合并、`resolveStateDir`、`isDevMode` | — |
| `health.test.ts` | 状态机迁移、滴答判定全分支、文案 | **`healthTick` 接线**（起表/清表/actual abort） |
| `tool-watch.test.ts` | 计时表、超时挑选、纠偏文案 | `checkToolTimeouts` 接线 |
| `errors.test.ts` | 五类分类、状态码优先、退避、升级 | `scheduleErrorRetry` 接线 |
| `end-judge.test.ts` | 提示词、解析顺序陷阱、该不该起 | `judgeTurnEnd` 子进程/超时降级 |
| `prefs.test.ts` | 文字匹配、收尾正则、抑制、输入提示 | — |
| `rules.test.ts` | 规则拼装、底线、播种 | — |
| `push.test.ts` | ntfy/webhook payload、token 解析 | 真实网络 |
| `remote-stop.test.ts` | 端点 + token 校验 | 局域网可达性 |
| `tts.test.ts` / `topic.test.ts` / `audio-lock.test.ts` | 文案 / topic / 跨进程锁 | — |
| `load.test.ts` | 入口可装载、8 工具/命令/快捷键/事件注册数 | 运行时行为 |
| `wiring.test.ts` `[新增，WIP]` | **接线级**：覆盖 `setInterval/setTimeout/Date.now` 后手动驱动，真跑 `tool_execution_start → 超时 → abort`、`429 → 退避`、`正则收尾 → done`、`长工具不插话` | 见下（当前 2 红） |
| `scripts/e2e-health.mjs` | 真实 pi 进程：滴答→注入→横幅 | 需要 ~2 分钟 |

**`wiring.test.ts` 当前状态（运行 `npm test` 实测）**：155 个用例，153 通过、**2 失败**。

| 失败用例 | 现象 | 归属 |
|---|---|---|
| `R2 幂等：同一回合不重复扫描` | 断言 `1`，实际 `2` | **真 bug，即 G-01**：幂等守卫永远为假，同一 settle 被处理两次 |
| `R3 定时汇报：卡在长工具里不插话` | `TypeError: Cannot read properties of undefined (reading 'endsWith')` at `index.ts:2260` | 测试用例发了 `before_agent_start` 但没带 `systemPrompt`（用例侧缺数据）；也暴露 handler 未对 `event.systemPrompt` 做防御 |

> 另：`R4 永久失败` 首轮失败、复跑通过 → 是**测试竞态**：`queueAlert` 的 `writeConfig` 是 `void`（fire-and-forget），用例立刻 `readConfig()` 读盘可能读到旧值。
> 这同时说明 `[缺口]` G-11：**磁盘状态滞后于内存**，外部进程/工具读 `config.json` 可能看到过期数据。

**结论**：`lib/` 纯逻辑覆盖良好；`index.ts` 编排层正在由 `wiring.test.ts` 补（已覆盖超时/退避/收尾/心跳四条主链），
尚未覆盖：`turnOn/turnOff` 全路径、`resetCookingState`、`healthTick` 的 escalate/exhausted、远程停止接线、`countActiveSubagents` 注册表兜底。

---

## 9. 缺口 / 待优化登记（按当前工作区代码核实）

> 旧文档（`HOW-IT-WORKS.zh.md` K 面板）列的 TODO-1/2/3 **已在本工作区实现**：
> 工具超时中断、收尾判官、统一忙判定/队列守卫/定时器改名。
> 下面是**仍然成立**的问题，全部带代码证据。

| 编号 | 严重度 | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|---|
| **G-01** | 中 | `agent_settled` 幂等守卫是死代码 | `index.ts:2333-2335`：`mySeq === lastJudgedSettleSeq` 恒假 | 同一回合重复 settle 会重复扫描/重复 `setPhase`；自动呼喊靠 10 分钟去重兜底，重复 `stopReportTimer` 幂等无害 | 改成"记录本回合最后一条消息指纹"，或比较 `settleSeq` 与上次处理的值（用 `<=` 判断） |
| **G-02** | 高 | `activeSubagents` 事件丢失后永久残留 | `countActiveSubagents` 用 `Math.max(events, registry)`；`Set` 只在 complete 事件里 delete | 一旦漏事件 → 恒判"有子代理在跑" → 巡检永不催（和 TODO-1 同类死锁） | 加时间戳/过期清理，或定期用 registry 全量重建 set |
| **G-03** | 中 | `toolAbortCount` 只在会话重置归零 | `index.ts:1042` 起 | 长会话里前 3 次超时用完后，后续长脚本不再被救 | 成功推进后衰减/归零，或按时间窗计数 |
| **G-04** | 中 | `index.ts` 编排层测试仍在补，未完成 | `tests/wiring.test.ts` 已有 4 条主链，剩余见 §8 结论 | 接线级缺陷（G-01/G-02/G-03/G-05/G-11）缺保护 | 补齐 `turnOn/turnOff/reset`、`escalate/exhausted`、远程停止、注册表兜底 |
| **G-05** | 低 | `sessionTimers` 只增不减 | 重复呼喊 timer 自己 `clearInterval` 后仍留在数组 | 长期离开缓慢内存增长 | 自我清理时从数组摘除，或改用 `Set` |
| **G-06** | 低 | `resetCookingState` 里 `cancelRetry()` 调了两次 | `index.ts:1382` 与 `:1391` | 无功能影响，纯冗余 | 删一处 |
| **G-07** | 中 | 远程停止仅 ntfy | `startRemoteStop` 条件 | webhook 用户没有"手机静音"按钮 | 文档写清限制，或 webhook 也带 action URL |
| **G-08** | 低 | `healthMuteEscalation` 与 `callingMode` 双写 | `setCallingMode` 里联动；手动改 config 会漂移 | 配置漂移后"别喊了"失效 | 改成派生值（`callingMode==="silence"`）而非独立字段 |
| **G-09** | 低 | 判官命令是用户自填 shell 模板 | `healthEndJudgeCmd` | 模板注入风险（仅本机用户可改，可接受） | 文档标注"只填你自己的命令" |
| **G-10** | 低 | ~~巡检间隔改动需 off/on 才生效~~ **已排除（原判有误）** | `index.ts:516` 已重挂 `startHealthTimer(ctx)`；`443`/`478` 同理 | — | 无需改；保留此条以记录排除过程 |
| **G-11** | 低-中 | `writeConfig` 全为 fire-and-forget（`void`） | `index.ts` 所有 `void writeConfig(config)` | 磁盘滞后于内存；外部读 `config.json` 可能过期；测试出现竞态 | 需要强一致的路径（`/status` 后、测试前）改为 `await` |
| **G-12** | 低 | `before_agent_start` 未防御 `event.systemPrompt` 缺省 | `index.ts:2260` `event.systemPrompt.endsWith` | 非常规调用（测试/未来重构）直接抛 | 一行兜底：`const base = event.systemPrompt ?? ""` |
| **G-13** | 中 | **降级回退链是死代码**：`.catch()` 永不执行 | `lib/platform.ts:17-26` 的 `runCommand` 内部 catch 后正常 resolve，**从不 reject**；`lib/audio.ts:53-60`（`say -v Tingting`→`say`、`espeak-ng`→`espeak`）、`96`（`canberra-gtk-play`）、`111-113`（`paplay`→`aplay`）全用 `.catch()` 做回退；`playProcessInternal` 也只 resolve | 缺语音包/播放器的机器上，**TTS 或自定义铃声静默不响**，回退分支一次都走不到 | `runCommand` 返回 `boolean` 表示成功，回退改成 `if (!ok)`；或新增 `runCommandStrict` |
| **G-14** | 低 | `phonePush:false` 挡不住推送 | `index.ts:650-654`：`phonePush` 为假但 `config.webhookUrl` 非空时仍调 `pushWebhook` | 关掉手机推送后仍收 webhook 推送（向导残留的 URL） | 关推送时清 `webhookUrl`，或加显式 `pushEnabled` |
| **G-15** | 中 | `activeSubagents` 依赖 pi-subagents **私有内部契约** | `index.ts:975` 读 `globalThis[Symbol.for("pi-subagents.background-work.v1")]` 的 `providers.listActiveWork`（非公开 API） | 上游改字段名/符号名 → 兜底路径**静默失效**，退回只靠事件计数（G-02 暴露面变大） | 代码注释与底稿标注“上游私有契约，升级需复测”；给探测加一条低频日志 |

**`[取舍]` 不要当 bug**：
- `ctx.abort()` 中断整轮而非单工具（无单工具中断 API）。
- 离开状态不跨会话。
- `markRealWork` 不改 done（报完完成再补总结，不该翻回 working）。
- 巡检用 `followUp`（必须等回合结束才送得出去，长工具卡死靠 `checkToolTimeouts` 救）。

---

## 10. 讲解 Agent 的自检清单（回答任何问题前过一遍）

1. **这是哪个状态轴的？** cooking / health.phase / callingMode / autonomyLevel / progressReporting / alert / timer(4 个) / retry / toolWatch / settleSeq / activeSubagents / audioLock / remoteStop。
2. **谁写它？** 用 `grep -n "<变量名>"` 找出全部写入点，别只凭直觉。
3. **触发源是什么？** 命令 / 工具 / 事件 / 定时器 / 用户输入。
4. **失败降级路径是什么？** 每个副作用都要说清 catch 之后的行为。
5. **有没有第二处重复实现？** 历史上的漂移都出在"同一语义写两遍"。
6. **行号复核**：
   ```bash
   grep -n "function healthTick\|function checkToolTimeouts\|function queueAlert\|function turnOn\|function turnOff\|function fireAlert\|pi.on(" extensions/i-am-cooking/index.ts
   grep -n "^export function" extensions/i-am-cooking/lib/*.ts
   ```
7. **引用格式**：`文件:行号` + 一句话结论；没有行号不下判断。
