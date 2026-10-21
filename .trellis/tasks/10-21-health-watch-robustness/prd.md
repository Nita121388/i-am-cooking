# 健康巡检健壮性：长脚本拦截、收尾判定与异常分类

## Goal

修掉 `docs/HOW-IT-WORKS.zh.md` K/L 面板里的 3 个 TODO 与 5 条批注：长脚本把主会话锁死时巡检反向失效、回合收尾漏判导致多催、两套「忙」判定口径漂移，以及 429 / 上下文超限被当成普通报错直接喊人。

来源：`docs/HOW-IT-WORKS.zh.md` 第 189–284 行（TODO-1/2/3 + L 表批注）。

## Requirements

### R1 长脚本超时拦截（TODO-1）

- `tool_execution_start` 记录 `toolCallId` / `toolName` / 起始时间；`tool_execution_end` 按 `toolCallId` 清除。
- 单次工具执行超过阈值 → `ctx.abort()` 中断当前回合。阈值进配置，**与 `healthIdleMinutes` 分开**（默认建议 10 分钟）。
- 中断后用 `steer` 注入纠偏提示，必须讲清三件事：
  1. 刚才那次执行已中断，不要原样重试；
  2. 耗时操作交给 async 子代理（`async: true` + `timeoutMs`），不要阻塞主会话；
  3. 长脚本先自查终止条件，确认它不是永远跑不完。

### R2 收尾判定与状态管理（TODO-2 + 批注）

- 回合结束时除了停 `reportTimer`，还要同步 `health.phase`，避免对已收工的 agent 继续催。
- 现有 `TASK_DONE_RE` 正则漏判时，用**独立 agent 会话**（opencode free 模型）判断是否真正结束；判定结果要落成状态。
- 同一会话可能「开始 → 结束 → 又继续」多次，必须做幂等状态管理：已标记结束的回合不重复扫描，新一轮工作要能重新进入 working。

### R3 统一「忙」的判定（TODO-3）

- 抽出 `isHeartbeatQuiet(ctx)`，`reportTimer` 与 `healthTick` 共用，消除「同一时刻 A 判不忙、B 判忙」。
- `hasPendingMessages()` 的两处重复守卫（`index.ts:872` / `:992`）收进同一个谓词。
- `repeatTimers` 职责拆分或改名：它现在同时装 `reportTimer` 和 `healthTimer`，不再是「响铃重复」专用。
- **明确不做**：合并成一个 ticker。前提是先有 `reportTimer` 测试，零保护下不动定时器结构。

### R4 异常分类与退避（L 表批注）

- 429 限流：退避重试，不按 urgent 喊人；退避到上限仍失败才升级。
- 上下文超限：先 `ctx.compact()`，失败或仍超限才喊。
- 区分永久失败（脚本语法错误、路径不存在，直接喊）与暂时失败（429 / 5xx / 网络抖动，先重试）。
- 判定来源：优先 provider 状态码，其次 `AgentMessage` 错误文本；`AgentEndEvent` 只有 `stopReason`，不够用时记录该限制。

### R5 静默模式催问上限

- 用户明确说过「别喊了」时，不升级响铃，但继续催，**上限 30 次**（当前实现无上限或 5 次即升级，需按批注调整）。

### R6 暂停/继续语义

- 巡检升级或报错后，被卡住的事标记为暂停并交接，其他不依赖用户的工作继续；用户恢复后从暂停处继续，不重做已完成部分。
- 放手等级下，回合以「？」结尾不自动喊人，按标准规范自主决策，并保证文件/数据安全。

## Acceptance Criteria

- [ ] R1：有单测覆盖「记录起始时间 / 超时判定 / 清除」；e2e 证明超时后 `abort` 生效且注入纠偏提示。
- [ ] R2：收尾漏判场景不再多催；同一会话多次收尾/重启有状态测试；独立判定会话失败时降级为现有正则而不是卡死。
- [ ] R3：`reportTimer` 与 `healthTick` 对同一状态给出相同「忙/闲」结论；新增 `reportTimer` 测试后再动定时器结构。
- [ ] R4：429、上下文超限、永久失败三类各有一条可执行测试；429 不再触发 urgent 呼喊。
- [ ] R5：静默模式催到 30 次仍不升级，第 31 次行为有明确断言。
- [ ] R6：暂停/继续路径在 e2e 中可复现。
- [ ] 回归：现有测试全绿（当前 89/89），`CHANGELOG.md` 写明行为变化。
- [ ] 文档：`docs/HOW-IT-WORKS.zh.md` 的 K/L 面板状态与处理版本同步更新。

## Open Questions

- `ctx.abort()` 中断整轮后，agent 上下文停在哪一步？需实测。
- 阈值是否按工具类型分开（`bash` / `subagent` / 其他）？
- 超时中断是否推手机通知？放手等级下建议只记日志。
- 同一长脚本中断后是否限制重试次数？
- 独立收尾判定用哪个 provider/model？调用预算与失败降级策略？
- 429 / 上下文超限的具体识别字段需先摸清上游 `AgentMessage` 结构。

## Notes

- 优先级：R1（死锁）> R4（误喊）> R2（多催）> R3（结构优化）。
- R3 是重构，必须先补测试；R1/R4 是行为修复，可独立交付。
- 本任务涉及 `extensions/i-am-cooking/index.ts`、`lib/health.ts`、`lib/prefs.ts`、`lib/config.ts` 与 `tests/`。
