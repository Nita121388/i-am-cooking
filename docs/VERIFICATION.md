# Verification Checklist

> Run through this before every release (and after significant changes).
> Check off each item; if anything fails, fix it and re-verify before publishing.

## 1. Core flow

- [ ] `/i-am-cooking test` — sound, Chinese TTS, and desktop toast all fire
- [ ] `/i-am-cooking on <note>` — status shows 🍳 离开中, agent receives autonomous-work instructions
- [ ] Agent gets blocked → `shout_for_user` fires all enabled channels
- [ ] Typing anything while cooking mode is on → auto-exit + agent debrief
- [ ] `/i-am-cooking off` — debrief contains pending shouts summary, volume restored (if enabled)

## 2. Dynamic preferences

- [ ] `/i-am-cooking on 完成后喊我` → preference becomes `completion_only` (only completions ring)
- [ ] Typing "别喊了" while away → preference becomes `silence` (banner only, no sounds)
- [ ] `set_calling_preference` tool switches modes (simulate via agent)
- [ ] `completion` category shout → "主人，好消息！" TTS, ✅ icon, no repeat
- [ ] `maxCompletionNotices` cap works (3 per session)

## 3. Volume control (if enabled)

- [ ] System volume at 0% → `on` raises to 80% → shout audible → `off` restores 0%
- [ ] System volume at 100% → `on` does NOT lower it

## 4. Auto-detect safety net

- [ ] Agent turn ends with "？" and no trailing tool work → auto-shout (normal)
- [ ] Agent turn ends with "？" but has trailing tool results → NO shout
- [ ] Agent turn errors (`stopReason: error`) → auto-shout (urgent)

## 5. Phone push (if configured)

- [ ] `/i-am-cooking setup` guided flow completes; topic/token editable via preview-redraft loop
- [ ] Live test push arrives on phone
- [ ] Token with `${ENV_VAR}` resolves from environment

## 6. Robustness

- [ ] `/reload` after config edit — no errors
- [ ] Removing the package → pi starts clean, no dangling errors
- [ ] TTS/toast copy says "pi 需要你" / "任务完成" (not "I am cooking 需要你")
- [ ] Extension loads in fresh install: `pi install git:...` → `/reload` → `/i-am-cooking status` works

## 7. Cross-platform (if available)

- [ ] Windows: all channels + volume (Core Audio)
- [ ] macOS: sound/TTS (`say`)/notification (`osascript`)/volume
- [ ] Linux: sound/TTS (`espeak-ng`)/notification (`notify-send`)/volume (`pactl`)

---

## Release procedure

```bash
# 1. bump version in package.json + CHANGELOG.md
# 2. run this checklist
# 3. commit & tag
git add -A && git commit -m "Release v0.1.0"
git tag v0.1.0 && git push && git push --tags
# 4. (optional) publish to npm
npm publish
```
