# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed
- **回来输入被忽略**：cooking 模式中用户打字回来时，输入内容现在会作为新指令转交给 agent（之前 followUp 只发固定"汇报进度"消息，用户补充内容被丢弃导致 agent 继续原方向）。input handler 返回 `handled` 避免消息重复。

### Changed
- **默认防打扰间隔**：正常呼喊重复 5→3 分钟，紧急呼喊重复 3→1 分钟。
- **`/i-am-cooking limits`**：新增交互式中文菜单调整防打扰参数（替代难记的英文子命令）。

### Added
- **autonomy levels**: `conservative`（遇墙就喊）/ `balanced`（有点难度才喊，默认）/ `autonomous`（能不喊就不喊）— 控制遇到阻塞（人类墙：验证码/登录/手动点击等）时 agent 该不该喊用户。`/i-am-cooking level` 命令 + `set_autonomy_level` tool + 文字匹配保险丝 + `on` 备注均可切换；持久化到 config.json；`agent_settled` 安全网在 autonomous 等级下不再自动喊普通问题（报错仍喊）。

### Changed
- **push reliability**: `pushPhone`/`pushWebhook` now return real success (HTTP 状态 + 15s 超时 + 失败日志)；`/i-am-cooking test` 逐通道汇报真实结果（声音/TTS/桌面通知/手机推送 ✓/✗），不再重复发送手机推送，且测试会如实反映当前呼喊偏好（静音/仅完成模式下通道按偏好跳过并提示）。
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
