# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
