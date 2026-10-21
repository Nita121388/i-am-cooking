---
title: i-am-cooking 是怎么运作的
subtitle: 一个 pi 扩展：你去做饭，agent 继续干活；它真卡住了就大声喊你
cols: 3
source: extensions/i-am-cooking/index.ts (2721 行) + 16 个 lib 模块
---
核心机制只有三件事：**注入规则让 agent 别停下** → **卡住时多路广播喊你** → **定时探活防止它悄悄死掉**。

## A 一句话定位

```callout info 它不是"通知插件"，而是一个"代班机制"
普通完成提醒只在任务结束时响一次。它多做了两件普通插件不做的事：

- **改 agent 的行为**：离开期间每回合往 system prompt 注入自主规则，让 agent 继续推进而不是停下来等你。
- **兜住 agent 的失败**：定时探活，发现它意外停住（报错 / 上下文超限）就催它表态，催不动才升级喊人。
```

## B 会话主流程

```flow
(在岗) -> 离开模式: on / 说"我去做饭了"
离开模式 -> agent自主推进: 每回合注入规则
agent自主推进 -> 可自主解决: 继续干
可自主解决 -> agent自主推进
agent自主推进 -> 需要你: 人类墙 / 决策 / 完成
需要你 -> 多路呼喊
多路呼喊 -> agent自主推进: 你回来打字补充（不断开）
agent自主推进 -> (在岗): 说"我不离开了" / off
```

**关键设计**：你回来打字只是"响应呼喊"，不关闭离开模式——agent 接着干。只有明确说"我不离开了"或执行 `/off` 才真正退出。

## C 一次呼喊走几路

```sequence
用户 -> 离开模式: 说"我去做饭了"
离开模式 -> agent: steer 消息：自主推进，别等
agent -> 队列: shout_for_user（先备好交接内容）
队列 -> 音频: 哔哔 → TTS 语音 → 自定义歌曲
队列 -> 桌面: Toast 弹窗 + TUI 横幅
队列 -> 手机: ntfy.sh 推送（带"停止响铃"）
note 音频, 手机: 五路并发，总有一路能传到你
```

## D 三类呼喊，别混用

| 类别 | 触发 | 通道 | 需要你吗 |
|---|---|---|---|
| `progress` / `milestone` | 中途进展 | 只推手机 | 不需要，有空再看 |
| `decision` / `credential` / `approval` | 真卡住 | 响铃 + 弹窗 + 手机 | 需要，立即处理 |
| `completion` | 任务全部完成 | 响铃报喜 + 手机 | 需要，可以收工了 |

混淆的代价：把"中途大进展"当 completion 发，你会以为可以收工了。所以 `completion` 有次数上限（默认 3 次/离开），`progress` 不参与去重。

## E 进度汇报：离开时的信息台

```callout info 单向信息台，永远不是暂停信号
进度汇报只推手机：不响铃、不弹窗、不进横幅，本地只留一条轻提示。它不需要你回应，也不打断 agent 干活——喊完继续干。
```

一次离开只启用一种模式（开启时选的，另一种模式的调用会被忽略）：

| 模式 | 谁驱动 | agent 收到什么 | category |
|---|---|---|---|
| 小阶段（默认） | agent 判断 + 系统自查 | 每 15 分钟一条 `[milestone check]`：有无值得报的节点 | `milestone` |
| 定时 | 系统驱动 | 每 N 分钟一条 `[定时汇报]` 三问：已完成什么 / 在做什么 / 有无进展 | `progress` |
| 不汇报 | — | 无 | — |

小阶段的判断标准写在 `rules.default.md`：值得报 = 完整跑通一个环节 / 攻克一个难点 / 产出可见的成果；不值得报 = 刚开工 / 普通小步骤 / 上一条后没有新进展。

心跳（`startReportTimer`）三处守卫，避免刷屏：

```flow
(开启离开) -> (心跳已启动): milestone / interval
(心跳已启动) -> 检查守卫: 每 N 分钟
检查守卫 -> (跳过本次): 离开模式已关 / 回合未进行 / 队列有积压
检查守卫 -> 注入提醒: 三守卫都通过
注入提醒 -> agent: steer 投递（下次 LLM 调用前生效）
agent -> 手机推送: shout_for_user(progress / milestone)
```

- **回合结束时跳过**：`agentActive` 为 false（在等你 / 已收尾）时没有进度可报。新回合开始自动恢复——比文本正则更可靠。
- **队列有积压则跳过**：`hasPendingMessages()` 为真（agent 卡在超长工具调用里），避免堆一串重复催促。
- **用 `steer` 而非 `followUp`**：steer 在下一次 LLM 调用前投递，不必等整个回合结束。

自动停表四条路径，都不需要 agent 配合：

1. 发 `completion`（`queueAlert` 里直接 `stopReportTimer`）
2. 回合总结命中 `detectTaskFinale`（`任务|全部|整体…完成|收工`，并排除"未完成 / 完成一半"）
3. 回合结束 → `agentActive = false` → 心跳自然跳过
4. `/off` 或关闭离开模式

## F 健康巡检：兜住"悄悄停住"

```flow LR
(working) -> {还在跑?}: 每次滴答
{还在跑?} -> (working): 是（工具/回合/子代理在跑）
{还在跑?} -> nudge: 否，且空闲超时
nudge -> {催够上限?}: 注入 [健康巡检]
{催够上限?} -> (working): 否，等它表态
{催够上限?} -> escalate: 是，还没动静
escalate -> (stalled): 喊你一次，然后静默
nudge -> (done): set_task_state(done)
nudge -> (waiting_user): set_task_state(waiting_user)
waiting_user -> (working): 用户开口
```

## G 两个定时器：重叠在哪，盲区在哪

离开模式里跑着两个定时器。它们不是同一个机制，但共用一套骨架，读代码时很容易当成一个东西。

| | 进度汇报 `reportTimer` | 健康巡检 `healthTimer` |
|---|---|---|
| 多久一次 | 15 分钟 | 5 分钟 |
| 干什么 | 催 agent 给你发手机消息 | 敲 agent：你还在吗 / 在等什么 |
| 会喊你吗 | 不会，只推手机 | 催满上限才喊 |
| 如何判“忙” | 统一走 `activitySnapshot(ctx)` | 同一份快照（回合/工具/子代理/队列） |
| 投递方式 | `steer`（下次 LLM 调用前） | `followUp`（等这一轮结束） |

三处重叠：

1. **同一个开关**：都在 `turnOn` 启动，`clearRepeatTimers()` 一起清。`repeatTimers` 这名字本是给“响铃重复”的，现在装了两个心跳。
2. **同一句守卫写了两遍**：`hasPendingMessages()` 有积压就跳过本次。
3. **收尾静默各写了一套**：见下面那条缺口。

```callout err 一处真实缺口：会多催一次
agent 收尾后说了句“改动已提交，等你回来验收”。进度汇报靠“这一轮结束”闭嘴了。

健康巡检没这条兜底。它只认文本正则（任务 / 全部 / 收工），“验收”不在里面。于是 10 分钟后它还会催一次已经收工的 agent。

修法：回合结束时同步 `setPhase(done)`。现在只让 `reportTimer` 静默，没动 `health.phase`。
```

```callout warn 健康巡检的盲区：管不到长工具卡死
它用 `followUp` 投递，必须等这一轮结束才送得出去。

agent 卡在跑很久的命令里时，它催不动。它真正管的是：这一轮已经结束、但没 settle、人也没回来。

名字叫“健康巡检”容易让人以为它什么都兜得住。页面上也很容易这么想。
```

## H 三处精妙的实现细节

| 设计 | 它解决的问题 | 做法 |
|---|---|---|
| 表态工具不算"干活" | agent 回一句 `shout_for_user` 就能清零催问计数，巡检永远升不了级 | `STATEMENT_ONLY_TOOLS` 白名单：这两个工具不触发 `markRealWork` |
| `touchActivity` 不清 `nudges` | 自己注入的巡检消息会触发回合，回合一动就把计数清零 | 只有真工具活动或用户输入才清零 |
| 有未处理阻塞呼喊 → `waiting_user` | agent 喊完在等你，巡检却当它卡死，重复喊 | 先判空闲时长，再判 `blockingAlerts > 0` → 静默 |

## M 多个 Agent 同时在跑

同时开着好几个 Agent 时会遇到两个问题：**看不出是谁在喊你**，**子 Agent 喊到你也没法回它**。

```flow
(子 Agent 想喊你) -> 写转达文件: tmp/relay/<父会话id>.jsonl
写转达文件 -> 父 Agent 取走: 收尾 / 巡检 / 子代理完成
父 Agent 取走 -> {值不值得吵醒你?}
{值不值得吵醒你?} -> 父 Agent 自己喊: 带【父会话】标签
{值不值得吵醒你?} -> 自己处理掉: 不打扰你
```

三条规则：

1. **每条呼喊都带 Agent 标签**。来源优先级：`config.agentAlias` > pi 会话显示名 > `PI_SUBAGENT_CHILD_AGENT` > 会话 id 短码。文字形式 `【会话名】`，子会话另外标 `· 子Agent`；TTS 会先把名字念出来，手机推送正文前缀也一致。
2. **子 Agent 不许直接响铃**。它可能是你根本没打开的会话（例如 Zen 镜像），自己响你也回不去。现在它调 `shout_for_user` 只会写一条转达请求，父 Agent 决定要不要真喊。子 Agent 的回执明确写着「真正响铃的是父 Agent，不要重复提交」。
3. **离开状态按会话分开**。`config.json` 是所有 pi 进程共享的一份，但 `cookingAgents` 按会话 id 记「谁在离开中」，`Alert.agentKey` 记呼喊归属——会话启动只清自己的，不会把另一个 Agent 的待处理呼喊和「离开中」状态洗掉。

```callout warn 子 Agent 也加载了这个插件时会怎样
pi-subagents 的会话声明 `PI_SUBAGENT_CHILD=1`，插件一看到就：不管理离开模式（不写共享配置）、不跑巡检与进度心跳、所有呼喊改走转达。这样父会话的状态不会被它干扰。
```

## I 模块分层

```tree
extensions/i-am-cooking
  index.ts | 2721 行：事件钩子 + 命令 + 9 个工具 + 呼喊编排（唯一接线层）
  rules.default.md | 出厂规则：自主推进 / 交接要求 / 完成通知 / 巡检义务
  lib
    health.ts | 纯状态机：decideHealthTick / applyHealthDecision / activitySnapshot 谓词
    tool-watch.ts | 工具执行计时与超时判定（TODO-1）
    errors.ts | 回合异常分类（429/5xx/上下文超限/永久失败）与退避序列
    end-judge.ts | 收尾判定的判官提示词与结论解析（TODO-2）
    identity.ts | 多 Agent 身份：谁在喊你 / 子 Agent 判定
    relay.ts | 子 Agent → 父 Agent 的呼喊转达文件格式与文案
    prefs.ts | 从用户原话识别偏好与自主等级、识别任务收尾
    rules.ts | 规则加载 + 拼装注入的 system prompt（含不可删的底线规则）
    config.ts | 配置读写与默认值
    audio.ts / audio-lock.ts | 三段式播放；多 Agent 间同一时刻只放一个声音
    tts.ts / volume.ts / push.ts | 语音文案 / 音量提升与恢复 / ntfy 与 webhook
    remote-stop.ts | 推送里"停止响铃"按钮的本地 HTTP 端点
    platform.ts | 跨平台命令执行
  scripts
    shout.ps1 / toast.ps1 / volume.ps1 | Windows 侧 PowerShell 实现
```

`lib` 里全是纯函数或窄接口，所以 `tests/` 下 13 个测试文件覆盖了 health / tool-watch / errors / end-judge / identity / relay / prefs / config / push / tts / audio-lock / remote-stop / rules / topic，另有两个「捉住定时器手动驱动」的接线级集成测试（真跑 abort / 退避 / 收尾 / 转达全链路）。

## J 两条容易忽略的取舍

```callout warn 离开状态不跨会话
`session_start` 时无条件 `resetCookingState`：会话关闭后重开，默认是"在岗"。

理由：离开是临时状态。跨会话存活的话，第二天早上打开 pi 会被隔夜的"离开中"绑住，还挂着一堆过期待处理呼喊。

代价：进程崩溃重启后需要重新 `on`——这正是健康巡检存在的原因之一。
```

```callout warn 规则文件"唯一生效"，出厂默认只做种子
首次运行把 `rules.default.md` 拷到 `~/.pi/i-am-cooking/rules.md`，之后你改的是那份，仓库里的只用于 `/reset-rules`。

底线规则 `GUARD_RAIL` 硬编码在 `rules.ts`，不写进文件，所以无法从规则文件删除：

> 要么遇到阻塞呼喊后暂停，要么完成，绝不要默默结束回合等用户回复。
```

## K TODO · 待修的缺口

两处缺口都还没修。第一处是死锁，优先级更高。

| 编号 | 缺口 | 现象 | 状态 |
|---|---|---|---|
| TODO-1 | 长脚本阻塞主会话 | agent 跑永不结束的脚本，巡检永远不催 | `yes` 已修（v0.10.0） |
| TODO-2 | 收尾漏判 | 回合结束没同步 `setPhase(done)`，多催一次 | `yes` 已修（v0.10.0） |
| TODO-3 | 两个定时器重叠 | “忙”的判定两套，守卫写两遍 | `yes` 已修（v0.10.0） |

### TODO-1 长脚本阻塞主会话

```callout err 巡检在这里是反向失效的
`tool_execution_start` 让 `runningTools` 变成 1。如果脚本永不结束，就再也没有 `end` 事件。

健康巡检闸门④把 `runningTools > 0` 当成「它正在干活」，于是永远跳过。agent 真卡死了，巡检一次都不催。

G 面板说的盲区在 `runningTools` 这条上不成立——那里不是「催得慢」，是「永远不催」。
```

要做三步：

1. **记时**：`tool_execution_start` 收到 `toolCallId`、`toolName`，记下起始时间。`tool_execution_end` 按 `toolCallId` 清除。
2. **超时中断**：单次工具执行超过阈值（建议默认 10 分钟）就调 `ctx.abort()`。这个阈值要进配置，跟 `healthIdleMinutes` 分开。
3. **注入纠偏提示**：中断后用 `steer` 送一条，讲清三件事：

   - 刚才那次执行已中断，不要原样重试。
   - 耗时操作交给 async 子代理（`subagent` 带 `async: true` 和 `timeoutMs`），不要阻塞主会话。
   - 长脚本先自查有没有终止条件，确认它不是永远跑不完。

实现前要定的四点：

- `ctx.abort()` 中断的是整轮，不是单个工具。中断后 agent 的上下文停在哪一步，需要实测确认。
- 阈值要不要按工具类型分开：`bash` 一种，`subagent` 另一种。
- 超过阈值时要不要同时推一条手机通知。放手等级下建议只记日志、不推。
- 中断后如果 agent 又跑了同一个长脚本，要不要限制重试次数。

### TODO-2 收尾漏判

回合结束时只让 `reportTimer` 静默，没动 `health.phase`。收尾措辞不命中 `TASK_DONE_RE` 时，健康巡检仍按 `working` 继续，会去催一个已收工的 agent。

修法：`agent_settled` 里回合结束的同时补一次 `setPhase(done)`。改动小，但要先补 `reportTimer` 的测试——现在这块零覆盖。

### TODO-3 两个定时器重叠部分的优化

按改动从小到大排三步。

1. **统一“忙”的判定（核心）**。现在两套：

   - `reportTimer`：只看 `agentActive`。
   - `healthTick`：`agentActive || !ctx.isIdle()`，再加 `runningTools > 0 || activeSubagents > 0`。

   结果同一时刻 A 判“不忙”、B 判“忙”。修法：抽出 `isHeartbeatQuiet(ctx)`，两条线共用。

2. **收拢队列守卫**。`hasPendingMessages()` 现在写了两遍（`:872` 与 `:992`）。收进同一个谓词，少一处漂移。

3. **修 `repeatTimers` 的职责**。这名字本是给“响铃重复”用的，现在装了 `reportTimer` 和 `healthTimer` 两个心跳。要么改名，要么拆成两个数组。

```callout info 明确不做：合并成一个 ticker
看着更干净，但没有测试保护。`tests/` 里没有 `startReportTimer` 的覆盖，`health.test.ts` 只测纯函数 `decideHealthTick`，不测 `healthTick` 的接线。零保护下合并定时器，等于拿生产环境试错。

前提：先补 `reportTimer` 测试，跟 TODO-2 同一件事。
```

注意：统一口径会改变行为。进度汇报在长工具调用时不再插话。这是期望的，已在 CHANGELOG 写明。

## L 异常状态认定表

表里写的判定与处置全部按**当前版本实际行为**记录，不是我的设想。处理版本一列：

- `v0.9.1` = 现状
- `未定版` = 待修，条目号对应 K 面板的 TODO

```callout info 批注列怎么用，数据存在哪
最后一列「批注」留空给你写。四种写法都行，数据都不会丢：

1. **直接在页面上改**：点表格下面的「✎ 编辑」，点单元格直接写，再点「💾 保存到 md」。这是最短路径，不用粘回对话。
2. **在页面上批注**：点 L 面板的评论按钮写一句，再点 Reply，把生成的文字粘回对话。我写进 md，重新渲染。
3. **直接改文件**：`docs/HOW-IT-WORKS.zh.md` 里这张表，在最后一列写。改完我重渲染。
4. **口头说**：直接说“第 3 条批注：……”，我落盘。

真正的存储是 `docs/HOW-IT-WORKS.zh.md`，它进 git，能 diff 能追溯。HTML 是派生物，不存批注。
```

| 现象 | 现在怎么认定 | 实际会怎样 | 处理版本 | 批注 | 文件夹 | 日期 |
|---|---|---|---|---|---|---|
| 长脚本永不结束 | 按 `toolCallId` 计时，超阈值即 `abort()` | 巡检不再被“有工具在跑”骗过；超时会中断整轮并注入纠偏 | `v0.10.0`（TODO-1） | 暂停，并提示agent 耗时操作需要交给子代理，不要阻塞主会话，并评估脚本是否永远不可能执行结束，是否有更好的执行方法 | extensions/i-am-cooking/index.ts | 2026-10-21 |
| 单次工具超过阈值 | `toolTimeoutMinutes`（默认 10） | 超阈值 → abort + 纠偏提示，同会话最多 3 次 | `v0.10.0`（TODO-1） | 暂停，并提示agent 耗时操作需要交给子代理，不要阻塞主会话，并评估脚本是否永远不可能执行结束，是否有更好的执行方法 | extensions/i-am-cooking/index.ts | 2026-10-21 |
| 一直显示 `working` 但卡住了 | 看 `agentActive` / 工具 / 子代理是否在跑 | 三样都没有才判“空闲”，10 分钟后开始催 | `v0.9.1`（F 面板闸门④⑥） | 暂停，并让agent从暂停出继续 | extensions/i-am-cooking/lib/health.ts | 2026-10-21 |
| 催 5 次还没动静 | 计数到上限升级 `stalled` | 喊你一次，然后静默；`别喊了` 时催到 30 次上限即停 | `v0.10.0` | 如果用户说过不要喊，则继续催，催到上限30次 | extensions/i-am-cooking/lib/health.ts | 2026-10-21 |
| 回合以“？”结尾 | `agent_settled` 里正则匹配 | 判 `waiting_user`，不再追问 | `v0.9.1` | 让agent自主推进，如果需要做决策，按照标准规范的方案选择，并注意文件数据安全 | extensions/i-am-cooking/index.ts | 2026-10-21 |
| 回合报错中断 | `stopReason === "error"` | 升级喊你（任何等级都喊） | `v0.9.1` | 让agent从暂停出继续 | extensions/i-am-cooking/index.ts | 2026-10-21 |
| API 限流 429 | `lib/errors.ts` 分类（状态码/文本） | 退避重试（1/2/4 分钟，上限 10 分钟），不按 urgent 喊；重试到上限才升级 | `v0.10.0` | 让agent从暂停出继续 | 待定 | 2026-10-21 |
| 上下文超限 | 同上分类 + 上下文占用 ≥95% | 先 `ctx.compact()` 再退避；仍失败才喊 | `v0.10.0` | 这个pi应该会自动压缩上下文 | 待定 | 2026-10-21 |
| 收尾措辞不命中正则 | 回合收尾判定 + 同回合幂等签名 | 判定为 done → 停表 + `setPhase(done)`；同一回合不重复扫描 | `v0.10.0`（TODO-2） | 启动另一个agent会话 模型选择 opencode的 free模型 让其判断是否结束，如果结束了 需要标记，已经结束的就不用再进行扫描了；但是注意一个会话可能开始进行最后结束多次，所以要做好状态管理 | extensions/i-am-cooking/lib/prefs.ts | 2026-10-21 |
| “忙”的判定两套口径 | 统一走 `activitySnapshot(ctx)` | 两条线同一个快照、同一个结论 | `v0.10.0`（TODO-3） | 没看懂 | extensions/i-am-cooking/index.ts | 2026-10-21 |

> **批注不在本页里编辑。** 本页的渲染器会在加载时重渲染面板，内嵌脚本会被清掉。
> 批注编辑器是独立页面：**[docs/am-annotator.html](am-annotator.html)**（支持按文件夹和日期筛选，改完直接写回 `HOW-IT-WORKS.zh.md`）。


### 批注怎么交回给我

批注写完，三种递交方式都行，结果一样：

1. 页面上点 Reply，把文字粘回对话。
2. 直接说“第 N 条：……”。
3. 你自己改 `docs/HOW-IT-WORKS.zh.md`，再说一句“批注写好了”。

我收到批注后做四件事：写进 md 批注列，重渲染页面，在 K 面板建对应 TODO（若是新问题），需要动代码的另开分支。批注一进 md 就进 git，可 diff 可追溯。

批注建议带日期和结论，例如 `10-21 要退避重试，别喊人`。

### 三类未识别的异常

```callout warn 429 限流现在按“报错”处理，处置动作不对
限流的正确处理是**退避重试**，不是喊你。现在它走进 `stopReason === "error"` 分支，直接 `queueAlert(urgent)`。

你在厨房被喊回来，看到的是“限流了”，而你能做的事跟“脚本写错了”完全不是一件。

要做：从 `AgentMessage` 的错误文本或 provider 状态码里分出 429 / 5xx，分别挂退避计时器，不要升级喊人。退避到上限才喊。
```

```callout warn 上下文超限该触发 compact，不该喊人
`ctx.compact()` 现成的，但巡检不调。现在它和普通报错一个待遇。

要做：识别上下文超限 → 先 `compact()`，失败或仍超限才喊。
```

```callout warn 需要区分“永久失败”与“暂时失败”
脚本语法错误、路径不存在是永久失败，重试没用，该喊。

限流、网络抖动、5xx 是暂时失败，该重试。

现在两者都走同一条 `urgent` 路径。分不出来，就只能是“全都喊你”。
```

要做异常识别，光有 `stopReason` 不够，还得有错误分类。`AgentEndEvent` 只给 `stopReason`，没有细分错误码。两条路：读 `AgentMessage` 里的错误文本，或等上游补类型。这是 TODO-1 之外第二个要先摸清的点。
