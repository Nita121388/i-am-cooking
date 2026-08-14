# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **autonomy levels**: `conservative`（遇墙就喊）/ `balanced`（有点难度才喊，默认）/ `autonomous`（能不喊就不喊）— 控制遇到阻塞（人类墙：验证码/登录/手动点击等）时 agent 该不该喊用户。`/i-am-cooking level` 命令 + `set_autonomy_level` tool + 文字匹配保险丝 + `on` 备注均可切换；持久化到 config.json；`agent_settled` 安全网在 autonomous 等级下不再自动喊普通问题（报错仍喊）。

### Changed
- **single-rule model**: rules are now ONE fully-editable file (`~/.pi/i-am-cooking/rules.md`) instead of separate built-in + user layers; the built-in default lives in the repo at `extensions/i-am-cooking/rules.default.md` (source of truth, ships with the plugin) and is only copied into the user file on first run. Added `/i-am-cooking reset-rules` to restore the factory default.
- **user-editable rules**: `/i-am-cooking rules` + `/i-am-cooking edit-rules`; rules live in `~/.pi/i-am-cooking/rules.md`, read fresh every turn, guard rail always appended

## [0.1.0] - 2025-07-08

### Added
- **core**: `/i-am-cooking on/off/status/setup/test` commands
- **core**: `shout_for_user` tool — agent calls when blocked or when work is done
- **core**: `set_calling_preference` tool — agent adjusts alert mode based on user's words
- **detection**: auto-detect when agent ends turn with a question (safety net)
- **exit**: typing while cooking mode is on = "I'm back" auto-exit + agent debrief
- **guidance**: inject autonomous-work rules into system prompt when cooking mode is on
- **channels**: sound (beeps / custom wav), Chinese TTS, Windows Toast, macOS notification, Linux notify-send
- **phone push**: ntfy.sh (free, zero-config) + generic webhook (Bark / WeChat Work / ServerChan)
- **setup wizard**: interactive `/i-am-cooking setup` with ntfy/webhook guide, auto-random topic, preview-then-confirm flow, "redraft on mistake"
- **token security**: `${ENV_VAR}` / `$ENV_VAR` support in token fields (ntfyToken, webhookToken)
- **volume control**: auto-boost system volume on enter (opt-in), restore on exit (Windows Core Audio API / macOS osascript / Linux pactl)
- **dynamic preferences**: `silence` / `completion_only` / `urgent_only` / `eager` / `normal` — agent switches based on user's words; text-matching as safety net
- **completion alerts**: agent notifies when tasks finish ("好消息！任务完成了！"), info-level, no repeat, capped per session
- **cross-platform**: Windows, macOS, Linux
- **verification checklist**: docs/VERIFICATION.md
