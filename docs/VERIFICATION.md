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

- [ ] `/i-am-cooking health` shows state; `health now` fires a manual check immediately
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
- [ ] `npm test`（含 `tests/load.test.ts` 装载冒烟）与 `npm run typecheck` 全绿

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
