# 执行计划：健康巡检健壮性

每个阶段都「写代码 → 跑测试 → 提交前全绿」。阶段间可独立交付，按优先级排。

## P0 基线保护（先做，防重构踩空）

- [ ] `tests/report-timer.test.ts`：把 `startReportTimer` 的守卫逻辑抽成纯函数后再测
      （`shouldSkipReportTick({cooking, agentBusy, runningTools, pendingMessages})`），
      断言：休息中/长工具/队列有货 → skip，工作回合空闲 → 发。
      **这是 R3 改定时器接线的前提，先补再动。**

## P1 R1 长脚本超时拦截（死锁修复，最高优先）

- [ ] 新增 `lib/tool-watch.ts`：`startToolWatch` / `endToolWatch` / `overdueTools` / `buildToolTimeoutSteer`。
- [ ] `lib/config.ts`：`toolTimeoutMinutes`（默认 10）、`toolTimeoutMaxAborts`（默认 3）。
- [ ] `index.ts`：`runningToolCalls` Map + `abortedToolCalls` Set；`tool_execution_start/end` 改用它，
      `runningTools = map.size`。
- [ ] `healthTick` 最前面做超时检查（`config.healthCheck` 闸门之前）；`startHealthTimer` 的启动条件
      改为 `config.healthCheck || toolTimeoutMinutes > 0`。
- [ ] `tests/tool-watch.test.ts`：记录/清除/超时判定/纠偏文案/累计上限。
- [ ] `scripts/e2e-health.mjs` 加一段：短阈值下触发 abort + 断言纠偏消息注入。

## P2 R4 异常分类与退避

- [ ] 新增 `lib/errors.ts`：`classifyTurnError` / `backoffMs` / `buildRetrySteer` / `shouldEscalate`.
- [ ] `lib/config.ts`：`errorRetryBaseMinutes`（1）、`errorRetryMaxMinutes`（10）、`errorRetryMaxAttempts`（3）。
- [ ] `index.ts`：`agent_settled` 的 `stopReason === "error"` 分支改为分类 + 退避：
      429/5xx → 排退避重试（`sessionTimers` 里），到上限才 urgent 喊；上下文超限 → `ctx.compact()` 后重试一次；
      永久失败 → 保持直接喊。
- [ ] `tests/errors.test.ts`：五类判定 + 退避序列 + 升级阈值。
- [ ] `docs/HOW-IT-WORKS.zh.md` L 表 429/上下文两行写「已处理版本 + 识别字段的限制」。

## P3 R5 静默模式催问上限

- [ ] `lib/health.ts`：`HealthTickProbe.silenceMaxNudges`；`decideHealthTick` 的 muteEscalation 分支加
      `>= silenceMaxNudges → { action: "exhausted" }`；`applyHealthDecision` 落到新阶段 `exhausted`。
- [ ] `HealthPhase` 增加 `"exhausted"`，`PHASE_LABEL` / `formatHealthLine` 同步。
- [ ] `lib/config.ts`：`healthMaxNudgesSilence`（默认 30）；`/i-am-cooking health` 菜单显示它。
- [ ] `tests/health.test.ts`：催到 30 仍不升级、第 31 次 skip、用户开口后重新计数。

## P4 R3 统一「忙」的判定

- [ ] `index.ts`：`activitySnapshot(ctx)` 单一入口；`healthTick` probe 与 `reportTimer` 都改用它。
- [ ] `reportTimer` 加 `runningTools > 0` 守卫（长工具中不插话）。
- [ ] 两处 `hasPendingMessages` 守卫收进 snapshot。
- [ ] `repeatTimers` → `sessionTimers`（纯改名）。
- [ ] `tests/health.test.ts` 补：同一 snapshot 下两条线结论一致。

## P5 R2 收尾判定与状态管理

- [ ] 新增 `lib/end-judge.ts`：`buildEndJudgePrompt` / `parseEndJudgeVerdict`（`done|not-done|unknown`）。
- [ ] `lib/config.ts`：`healthEndJudge`（`"off"`）、`healthEndJudgeCmd`（`""`）、`healthEndJudgeTimeoutSeconds`（20）。
- [ ] `index.ts`：`settleSeq` / `lastJudgedSettleSeq` 幂等；正则漏判且 `healthEndJudge === "cli"` 时
      起子进程判定，失败降级为正则；`done` → `stopReportTimer()` + `setPhase(done)`。
- [ ] `tests/end-judge.test.ts`：提示词、解析（含拒绝/含糊输出）、降级路径（用假命令）。

## P6 R6 暂停/继续语义 + 文档

- [ ] 纠偏 / 退避提示文案里写清「暂停交接、从他处继续、不重做已完成部分」。
- [ ] `tests/` 锁定：放手等级下「？」结尾不自动喊人。
- [ ] `docs/HOW-IT-WORKS.zh.md`：K 面板 3 个 TODO 状态改 `done`（写版本）；L 表「处理版本」列补处理版本；
      F 面板闸门说明补「超时中断在巡检之前」。
- [ ] `CHANGELOG.md` Unreleased：新增 4 条（R1 超时拦截 / R4 429 退避 / R5 静默 30 次上限 / R3 定时汇报不再插话）。

## 验证命令

```bash
npm test            # 单测（新增 3 个 lib 测试文件）
npm run typecheck   # tsc --noEmit
npm run e2e:health  # 真跑 pi 进程：滴答→注入→横幅→超时中断
```

## 审查门

- P1 完成后单独跑一遍 e2e（死锁修复必须真进程验证，单测只能证明判定对）。
- P4 之前必须有 `tests/report-timer.test.ts` 全绿。
- 全部完成后跑 `docs/VERIFICATION.md` 的 4（auto-detect）+ 8（健康巡检）两节。

## 回滚点

- P1 出问题 → `toolTimeoutMinutes: 0`（配置级关闭，不撤代码）。
- P2 出问题 → 分类只影响「喊不喊」，把 `errorRetryMaxAttempts: 0` 即回到旧行为。
- P4 出问题 → `reportTimer` 守卫改回只看 `agentActive` 一行即可。
