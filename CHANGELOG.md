# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - 2025-08-14

### Added
- **published to npm**: `pi install npm:i-am-cooking` now works. Package trimmed via `files` field (excludes tests/tsconfig); verified install from clean dir with lib/ intact.

## [Unreleased]

### Changed
- **进度汇报模式**：`milestoneReminders` 布尔重构为 `progressReporting` 三态（milestone 小阶段完成时/interval 定时/none 不汇报），默认小阶段；每次手动 `on` 时弹"进度汇报·可选-手机通知"三选一，选定时可设间隔（默认 15 分钟）；定时模式下每 N 分钟强制 agent 汇报进度（含无进展/卡住情况），随 off 自动停止。紧急/完成通知不受影响。

### Added
- **音量控制** `/i-am-cooking volume`：交互式中文菜单（查看当前音量 / 立即调音量 / 设置离开自动拉高 / 开关）；`set_volume` 工具让 agent 也能调（用户明确要求时，或呼喊前解除静音）。跨平台：macOS osascript / Linux pactl / Windows volume.ps1。
- **多 Agent 协作**：音频互斥锁（多个 pi 同时离开只放一个声音，崩溃锁自动抢占，test 可强制抢占）；联动关闭（任一 Agent 检测到你回来，其他全自动关闭，watch+轮询双保险）。
- **可爱 Topic 名**：编程/算法/LLM 风词池（22 形容词 × 24 名词）+ 6 位随机数字 = 5.28 亿种组合，全局唯一。
- **自定义呼喊短语** `shoutPhrase`：默认"agent 需要你"，TTS 模板支持 `{shoutPhrase}` 占位，改一处全文案生效。
- **人类在岗**：状态显示从"在岗"改为"人类在岗"。
- **呼喊交接时序（规则化）**：`rules.default.md` 新增「呼喊交接」段——喊用户前先准备好交接内容（刚好够用：决策给选项和推荐/凭据给获取方式/手动操作给步骤），准备好再喊，喊出的消息即最终版；禁止先喊再准备。工具描述/turnOn 指令同步。
- **三层消息音频区分**：🚨需要你（完整三段式含歌曲）/ ✅整个完成（2声不播歌）/ 📈小阶段完成（1声轻声）——听声即知发生了什么。
- **小阶段完成提醒开关**：`shout_for_user` 支持 `category="milestone"`；每次手动开启离开模式时询问是否开启（开启=每小阶段轻声提醒，关闭=只在全部完成/卡住时通知）。
- **铃声文件浏览器** `/i-am-cooking sound`：设置歌曲时从 `~/Music` 逐级浏览（📁文件夹/🔊音频文件）选择，无需手输路径；仍支持手动输入。
- **`set_shout_sound` 工具**：用户说"帮我换个铃声"并给路径时，agent 可帮助设置自定义歌曲（含路径校验/格式校验）。
- **声音开关菜单** `/i-am-cooking sound`：新增「开关」选项，可切换 哔哔声/Agent语音/桌面弹窗（此前只能改 config.json）。
- **安全边界文档**：README 新增"Agent 不能设置什么"表格，说明手机推送/音量/防打扰/规则等为何不交给 agent。
- **自定义呼喊铃声** `/i-am-cooking sound`：三段式顺序播放（短铃声 → Agent 语音 → 自定义歌曲），总时长默认 60 秒到点强制停止（可调 1-300 秒）；支持试听、路径设置/清除；macOS afplay / Linux paplay / Windows PowerShell。
- **Agent 自由语音**：`shout_for_user` 新增可选 `ttsText` 参数——Agent 填了则 TTS 原样念出（不走默认模板），让呼喊更个性化。

### Changed
- **离开状态不跨会话**：任何会话启动都从"在岗"开始（`resetCookingState`），上次会话的离开模式不再自动恢复；旧呼喊记录随会话结束直接清空（不再保留待办）。
- **Agent 自主开启离开模式**：新增 `enter_cooking_mode` 工具，用户说"我去做饭了/我离开一下/I'm cooking"等明确表达时 agent 理解并自动开启（无需手输命令）；工具描述严格限定仅在用户意图非常明确时调用，避免误开。

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
