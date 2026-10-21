# Verification Checklist

> Run through this before every release (and after significant changes).
> Check off each item; if anything fails, fix it and re-verify before publishing.

## 1. Core flow

- [ ] `/i-am-cooking test` — sound, Chinese TTS, and desktop toast all fire
- [ ] `/i-am-cooking on <note>` — status shows 🍳 离开中, agent receives autonomous-work instructions
- [ ] Agent gets blocked → `shout_for_user` fires all enabled channels
- [ ] Typing anything while cooking mode is on → auto-exit + agent debrief
- [ ] `/i-am-cooking off` — debrief contains pending shouts summary, volume restored (if enabled)

## 2. Dynamic preferences & autonomy

- [ ] `/i-am-cooking on 完成后喊我` → preference becomes `completion_only` (only completions ring)
- [ ] Typing "别喊了" while away → preference becomes `silence` (banner only, no sounds)
- [ ] `set_calling_preference` tool switches modes (simulate via agent)
- [ ] `completion` category shout → "叮咚！好消息！" TTS, ✅ icon, no repeat
- [ ] `maxCompletionNotices` cap works (3 per session)
- [ ] `/i-am-cooking level autonomous` → agent_settled no longer shouts on "？" questions (errors still shout)
- [ ] Saying "我离开一下" / "I'm cooking" → agent calls `enter_cooking_mode` and enters away-mode
- [ ] Saying something ambiguous (e.g. a question) → agent does NOT auto-enter cooking mode

## 3. Volume control (if enabled)

- [ ] System volume at 0% → `on` raises to 80% → shout audible → `off` restores 0%
- [ ] System volume at 100% → `on` does NOT lower it
- [ ] macOS: muted=true (Mute key) → `on` plays sound, `off` restores mute state
- [ ] `/i-am-cooking volume` — menu shows current volume; setting to X% works; boostLevel configurable
- [ ] `set_volume` tool — agent can set absolute level and raise/lower; unmute before shout

## 4. Auto-detect safety net

- [ ] Agent turn ends with "？" and no trailing tool work → auto-shout (normal)
- [ ] Agent turn ends with "？" but has trailing tool results → NO shout
- [ ] Agent turn errors (`stopReason: error`) → auto-shout (urgent)

## 5. Phone push (if configured)

- [ ] `/i-am-cooking setup` guided flow completes; topic/token editable via preview-redraft loop
- [ ] Live test push arrives on phone
- [ ] Token with `${ENV_VAR}` resolves from environment

## 6. User-editable rules

- [ ] `/i-am-cooking edit-rules` creates `~/.pi/i-am-cooking/rules.md` (from factory template)
- [ ] Editing the file (custom rule added) → injected into next cooking-mode turn
- [ ] `/i-am-cooking rules` shows the file as the single source of effective rules
- [ ] Deleting the rules file → falls back to factory defaults (rules.default.md)
- [ ] `/i-am-cooking reset-rules` restores factory defaults
- [ ] Guard rail ("绝不要默默结束回合") is always appended even with custom rules

## 7. Custom ringtone & session isolation

- [ ] `/i-am-cooking sound` → set a custom song path → `/i-am-cooking test` plays beeps → voice → song
- [ ] Song stops automatically at the total-duration budget (default 60 s)
- [ ] `shout_for_user` with `ttsText` → TTS speaks the exact text (not the template)
- [ ] Away-mode ON in session A → close it → open a new session → status shows "在岗" (no leftover cooking state)

## 8. Robustness

- [ ] `/reload` after config edit — no errors
- [ ] Removing the package → pi starts clean, no dangling errors
- [ ] TTS/toast copy says "pi 需要你" / "任务完成" (not "I am cooking 需要你")
- [ ] Extension loads in fresh install: `pi install git:...` → `/reload` → `/i-am-cooking status` works

## 8b. Health watch

- [x] `health now` fires a manual check immediately（改由 `scripts/e2e-health.mjs` 自动验证，见 §11）
- [ ] Idle agent past threshold → `[健康巡检]` message delivered; banner shows `🩺 已催 1/5`
- [ ] Agent calls `set_task_state(done)` → banner shows `🩺 已完成`; further checks stay silent
- [ ] Typing anything → state returns to working; next idle check nudges again
- [ ] Nudge cap (5) exhausted → one `normal` shout fires, then checks go silent (`🩺 无响应（已喊人）`)
- [ ] With `silence` preference (`别喊了`) → checks keep nudging forever, never escalate to ringing
- [ ] Active async subagent → check skips (banner shows `🤖 子代理 N 个在跑`)
- [ ] Unacked blocking shout + long idle → check marks `waiting_user`, does not nudge
- [ ] `health off` disables it; `/status` shows `健康巡检: 关`

## 9. Cross-platform (if available)

- [ ] Windows: all channels + volume (Core Audio)
- [ ] macOS: sound/TTS (`say`)/notification (`osascript`)/volume
- [ ] Linux: sound/TTS (`espeak-ng`)/notification (`notify-send`)/volume (`pactl`)

## 10. Dev / release isolation（本地隔离，可自动化）

不碰日常配置、不加载已装版本的前提下验证本仓库代码：

```bash
# 用隔离状态目录 + 临时加载（-ne 关掉自动发现，避免已装 npm 版一起加载）
I_AM_COOKING_HOME=/tmp/iac-dev \
  pi -ne -e "$PWD/extensions/i-am-cooking/index.ts"
```

- [ ] `I_AM_COOKING_HOME` 未设时仍用 `~/.pi/i-am-cooking`（行为不变）
- [ ] 设了之后只在目标目录生成 `config.json` / `rules.md`，日常目录 mtime 不变
- [ ] 隔离实例的 `rules.md` 含最新出厂章节（旧实例不会自动更新 → 需 `reset-rules`）
- [ ] 日常已装 `npm:i-am-cooking` 时，`-ne -e` 只加载一份（工具不重复、不双份响铃）
- [ ] `npm run dev` 起开发实例：启动提示带「DEV 构建 / 源码路径 / 状态目录」，命令是 `/i-am-cooking-dev`
- [ ] 开发实例状态栏显示 `🍳 离开中 [DEV]`；`/i-am-cooking-dev status` 首行为 `🧪 构建: DEV`
- [ ] 打 `/i-am-cooking`（别名）会提示「你用的是 DEV 构建」
- [ ] 发布版实例（直接 `pi`）无任何 DEV 字样，命令仍是 `/i-am-cooking`
- [ ] `npm test`（含 `tests/load.test.ts` 装载冒烟 + 构建身份切换）与 `npm run typecheck` 全绿

---

## 11. Health watch E2E（自动化，替代 §8b 的人工条目）

`scripts/e2e-health.mjs` 用 RPC 模式起一个真实 pi 进程，验证「定时器滴答 → 注入
`[健康巡检]` → 横幅显示 `🩺 已催 N/M`」这条只有真跑才能覆盖的链路。三个模式：

| 模式 | 命令 | 验证内容 | 耗时 | 结果 |
|---|---|---|---|---|
| basic | `npm run e2e:health` | 滴答触发、注入 `[健康巡检 #N]`、横幅 `🩺 已催 1/5` | ~2.5min | ✅ 5/5 |
| escalation | `node scripts/e2e-health.mjs --mode=escalation` | 催满 5 次 → 升级呼喊一次 → 之后静默 | ~12min | ✅ 7/7 |
| silence | `node scripts/e2e-health.mjs --mode=silence` | 静默偏好下催过上限仍继续催、**绝不升级** | ~13min | ⏳ |

实测证据（escalation 模式）：

```
🩺 健康巡检：agent 已空闲 2 分钟，第 1 次追问状态。
🍳 离开中 [DEV] · ⚠0 待处理 · 🩺 已催 5/5 · /status 看全部
🚨 健康巡检：催了 5 次都没动静，已升级呼喊用户。
升级后仍有 0 条追问
```

通用断言（basic / escalation / silence 三种模式都会查）：

- [x] DEV 构建身份标识出现（启动提示带版本 / 源码路径 / 状态目录）
- [x] 巡检真的按间隔触发（`healthCheckMinutes=1` + `healthIdleMinutes=1`）
- [x] `[健康巡检 #N]` 消息真的注入会话
- [x] 横幅出现 `🍳 离开中 [DEV] · ⚠0 待处理 · 🩺 已催 N/M`
- [x] 无扩展装载错误（尤其两份同时加载时的工具名冲突）

### 三个踩坑记录（改脚本时别再踩）

1. **rules 文本本身含「健康巡检」四个字** → 断言必须匹配 `[健康巡检 #N]` 前缀，
   否则 `on` 时注入的规则文本会被误判成巡检消息，脚本提前退出（第一版就栽在这）。
2. **偏好是会话级的**：`resetCookingState`（`session_start`）会把 `callingMode` /
   `healthMuteEscalation` 洗回 `normal`。预置 config.json 造不出静默模式，
   必须在启动后用真实原话触发。
3. **`input` 事件只认 `source === "interactive"`**：RPC 发的消息不算「人在场打字」，
   不会触发偏好识别（这是对的，否则 agent 提示词里的「别喊了」字样会误伤用户）。
   触发路径只有 `on` 的备注：`/i-am-cooking-dev on 别喊了，安静点`。
   另外别分两条发 `on`——第一条会起一轮回合，第二条会被挡在队列后面。

### 仍需人工（TUI 才看得见，或需要模型配合）

- [ ] `set_task_state(done)` → 横幅 `🩺 已完成`，后续巡检静默
- [ ] 用户开口 → 状态回 `working`，下次空闲再催
- [ ] 有 async 子代理在跑 → 巡检跳过
- [ ] 未处理阻塞呼喊 + 长空闲 → 判 `waiting_user`，不催

---

## Release procedure

```bash
# 0. devDeps 里的 @earendil-works/* 版本要跟运行时 pi 一致（typecheck 才有效）
# 1. bump version in package.json + CHANGELOG.md
# 2. run this checklist
# 3. commit & tag
git add -A && git commit -m "Release v0.1.0"
git tag v0.1.0 && git push && git push --tags
# 4. (optional) publish to npm
npm publish
```
