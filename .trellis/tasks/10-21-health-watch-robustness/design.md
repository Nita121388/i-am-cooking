# 设计：健康巡检健壮性

## 边界

只改健康巡检链路，不动呼喊通道（声音/TTS/推送/横幅）、不动音量、不动规则文件注入。

| 文件 | 角色 |
|---|---|
| `extensions/i-am-cooking/lib/health.ts` | 滴答判定状态机（纯逻辑） |
| `extensions/i-am-cooking/lib/tool-watch.ts`（新增） | 工具执行计时与超时判定（纯逻辑） |
| `extensions/i-am-cooking/lib/errors.ts`（新增） | 回合异常分类与退避（纯逻辑） |
| `extensions/i-am-cooking/lib/end-judge.ts`（新增） | 收尾判定的提示词与结论解析（纯逻辑） |
| `extensions/i-am-cooking/index.ts` | 事件接线：工具开始/结束、滴答、收尾 |
| `extensions/i-am-cooking/lib/config.ts` | 新增配置项与默认值 |
| `tests/` | 三个新 lib 的单测 + 现有 health 测试扩展 |

原则：**判定全部下沉到 `lib/` 的纯函数**，`index.ts` 只做「读事件 → 调纯函数 → 执行副作用（abort / steer / 呼喊）」。这样所有新行为都能在 `node --test` 下覆盖，不需要真跑 pi。

## R1 长脚本超时拦截

数据：`Map<toolCallId, { toolName, startedAt }>`，替代裸 `runningTools` 计数（计数仍保留，`map.size` 即计数，避免两套状态）。

判定：`overdueTools(map, now, limitMs)` 返回超时的工具列表。**超时检查放在 healthTick 最前面，在 `config.healthCheck` 闸门之前**——巡检关掉也要能救死锁，它由 `toolTimeoutMinutes` 独立控制。

处理顺序（每个超时工具只处理一次，用 `abortedToolCalls` 标记）：

1. `ctx.abort()` 中断整轮。
2. 从 map 里摘掉该 toolCallId（防止重复 abort）。
3. `steer` 注入纠偏提示：已中断 / 耗时操作交 async 子代理 / 先自查终止条件。
4. 只 `ctx.ui.notify` 记日志，**不推手机、不升级呼喊**（放手等级下的既定取舍）。
5. 同一会话累计中断 3 次（`toolTimeoutMaxAborts`）后停止自动 abort，只记日志并让后续巡检按老逻辑催——避免 agent 反复重试长脚本造成无限 abort 循环。

阈值：`toolTimeoutMinutes`（默认 10，0=关），与 `healthIdleMinutes` 分离。检测粒度 = `healthCheckMinutes`（默认 5 分钟），即最长 15 分钟内必定触发。

已知限制：`ctx.abort()` 中断的是整轮不是单个工具，中断后本轮剩余工具调用不会执行——这是期望行为（本来就是要停下来纠偏）。

## R4 异常分类与退避

分类纯函数 `classifyTurnError({ errorMessage, rawStopReason, statusCode, contextPercent })`：

| 类别 | 依据（优先 provider 状态码，其次错误文本） | 处置 |
|---|---|---|
| `context-overflow` | 状态码 413 / 文本命中 context window 类词 | 先 `ctx.compact()`；仍失败才喊 |
| `rate-limit` | 状态码 429 / 文本命中 rate limit 类词 | 退避重试，不按 urgent 喊 |
| `transient` | 5xx / 网络类词 | 退避重试 |
| `permanent` | 语法错误 / 路径不存在 / 400 参数错误 | 直接喊（现状不变） |
| `unknown` | 都不命中 | 直接喊（保持现状，宁可误喊不可漏喊） |

退避：`backoffMs(attempt, base, cap)` = `min(cap, base * 2^(attempt-1))`，默认 base 60s / cap 10min / 最多 3 次。退避用 `setTimeout` 记进 `sessionTimers`，`off` / 新会话一起清掉。到上限仍失败 → 升级为现在这种 urgent 呼喊。

状态码来源：`AssistantMessage.errorMessage` 文本里抠 `"(429)"` / `"429 "` 这类模式，加上 `rawStopReason`。pi 没有把状态码单独暴露出来，这是当前能做到的最准的一档，**在 docs 里写明该限制**。

## R2 收尾判定与状态管理

现状：`agent_settled` 只靠 `detectTaskFinale` 正则 + 收尾正则命中才 `setPhase(done)`。

改动三件：

1. **幂等**：`settleSeq` 自增，`lastJudgedSettleSeq` 记录已判定过的回合；同一回合不重复判定（`agent_settled` 可能因内部重试多次触发）。
2. **独立判定会话**：正则漏判时，可选地把最后一句交给一个**独立会话**判定（`end-judge.ts` 只负责提示词与结论解析）：
   - 配置 `healthEndJudge`：`"off"`（默认）/ `"cli"`。
   - `"cli"` 模式下用 `healthEndJudgeCmd` 指定的命令（默认 `opencode run --model <free>`，通过 stdin 喂提示词），20 秒超时。
   - **任何失败都降级为正则结论**（命令不存在 / 非 0 退出 / 超时 / 输出无法解析），绝不阻塞或卡死。
   - 判定结论 `done` → `setPhase(done)`；`not-done` / `unknown` → 保持 working。
   - 默认 `off`：本机没有 opencode，默认走正则，需要时一行配置开启。
3. **phase 同步**：判定为 `done` 时同时 `stopReportTimer()`，与现有行为合并到一个函数，避免两处各写一遍。

「开始 → 结束 → 又继续」：`markUserInput` / `markRealWork` 已把 `done` 翻回 `working`；本轮补 `settleSeq` 幂等，保证新一轮重新进入判定。

## R3 统一「忙」的判定

`index.ts` 新增单一入口 `activitySnapshot(ctx)`：

```ts
{ agentBusy, runningTools, activeSubagents, pendingMessages, busy, quiet }
```

- `healthTick` 的 probe 全部取自它。
- `reportTimer` 改成 `!snap.agentBusy || snap.runningTools > 0 || snap.pendingMessages → skip`（长工具调用中不再插话，行为变化写进 CHANGELOG）。
- 两处 `ctx.hasPendingMessages?.()` 守卫收进 snapshot，只留一处。
- `repeatTimers` 改名 `sessionTimers`（它装的是所有会话级定时器，不只是响铃重复）。

不做：合并成一个 ticker（明确不做，零测试保护下不动定时器结构）。

## R5 静默模式催问上限

`muteEscalation` 分支当前无上限。改成：

- `silenceMaxNudges`（默认 30，`healthMaxNudgesSilence`）。
- 催到 30 次仍没动静 → 返回新判定 `{ action: "exhausted" }` → 落到新阶段 `exhausted`（"按你要求不喊，已停止追问"），**不升级响铃、不喊人**。
- 第 31 次及以后：`decideHealthTick` 因 `phase !== "working"` 直接 skip，行为有明确断言。
- 用户再开口（`markUserInput`）→ 回 `working`，重新计数。

## R6 暂停/继续语义

- 新增 `paused` 概念落到现有 `stalled` / `exhausted`：已是「暂停并交接」，不再追问。
- 巡检中断（R1 超时）→ 注入的纠偏提示里明确「这是暂停交接提示，先纠偏再从暂停处继续，不要重做已完成部分」。
- 报错退避（R4）→ 提示里明确「其他不依赖本次失败的工作照常推进」。
- 放手等级下以「？」结尾不自动喊人已有实现（`level === "autonomous"` 早退），本轮补测试锁定。

## 兼容与回滚

- 全部新配置项都有默认值，旧 `config.json` 缺字段走 `DEFAULTS`，不需要迁移。
- 行为变化（定时汇报在长工具调用时不再插话 / 429 不再 urgent 呼喊）写进 `CHANGELOG.md` 的 Unreleased。
- 回滚粒度：`toolTimeoutMinutes: 0` 关 R1；`healthEndJudge: "off"` 关 R2 独立判定；`healthMaxNudgesSilence` 调大即恢复无限催。
