> 中文文档：[README.md](../README.md)
>
# 🍳 I am cooking

> When you step away from the computer (e.g. cooking), pi keeps working autonomously.
> When the agent truly needs you — or when the work is done — it **shouts loudly** through
> sound, Chinese TTS, desktop notifications, and **phone push**, so you can come back from the kitchen.

The name "I am cooking" describes **your** status: the user is away. The agent is the one calling:
_"pi 需要你！" (pi needs you!)_

## ✨ Features

| Feature | Description |
|---|---|
| 🧠 Autonomous mode | `/i-am-cooking on` injects "work autonomously, don't wait" rules into the agent |
| 📣 Multi-channel shout | sound (beeps / custom wav) + Chinese TTS + desktop toast + **phone push** (ntfy / webhook) + TUI banner |
| 📱 Phone push | ntfy.sh (free, zero-config) — the key channel when you're in the kitchen |
| 🔔 Completion alerts | agent notifies you when the task is done: "主人，好消息！任务完成了！" |
| 🎛️ Dynamic preferences | agent adjusts alert mode from your words: "别喊了" → silence, "完成后喊我" → completion only, "随时汇报" → eager… |
| 🛡️ Safety net | if the agent ends its turn with a question while you're away, it auto-shouts |
| 🔙 Auto-exit | just type anything while cooking mode is on → "I'm back", agent debriefs what it shouted |
| 🔊 Volume boost | opt-in: auto-raise system volume when you leave, restore when you return |
| 🗣️ Setup wizard | `/i-am-cooking setup` — guided, with ntfy explainer, auto-random topic, preview-then-confirm |
| 🔐 Token security | token fields support `${ENV_VAR}` so secrets never hit disk |
| 💻 Cross-platform | Windows / macOS / Linux |

## 📦 Install

```bash
# from GitHub
pi install git:github.com/<your-name>/i-am-cooking

# or local path during development
pi install E:/File/NitaFile/Projects/i-am-cooking

# or from npm (after publish)
pi install npm:i-am-cooking
```

Reload pi (`/reload`) after installing.

## 🚀 Quick start

```
/i-am-cooking setup                     # ① configure phone push (guided wizard)
/i-am-cooking test                      # ② test all channels
/i-am-cooking on 继续做登录模块           # ③ enter cooking mode, then leave
/i-am-cooking off                       # ④ I'm back
/i-am-cooking status                    # view mode / pending shouts / channels / preference
```

## 📖 Commands

| Command | Description |
|---|---|
| `/i-am-cooking on [note]` | Enter cooking mode. Note can carry a preference, e.g. `on 完成后喊我` |
| `/i-am-cooking off` | Leave cooking mode; agent receives a debrief of what it shouted |
| `/i-am-cooking status` | Mode, pending shouts, channels, token state, current preference |
| `/i-am-cooking setup` | Interactive wizard: ntfy / webhook, token, volume boost permission |
| `/i-am-cooking rules` | Show currently active rules (built-in or user file) |
| `/i-am-cooking edit-rules` | Edit the rules file (saves instantly) |
| `/i-am-cooking test` | Fire a test shout on all channels (no mode needed) |

## 🧠 User-editable rules

The behavior rules while you're away are not hard-coded — you can edit them:

```
/i-am-cooking edit-rules    # open editor, save = immediately effective
/i-am-cooking rules         # show currently active rules
```

The rules file is `~/.pi/i-am-cooking/rules.md` (Markdown). When missing, built-in defaults apply
(autonomy, when to shout, completion notices). A guard rail is always appended:
"never end your turn silently waiting for user input".

## 🧠 Dynamic calling preferences

The agent picks a mode from what you say, and adjusts instantly:

| You say | Mode | Effect |
|---|---|---|
| *(nothing)* | `normal` (default) | shout when needed + when done |
| "别喊了" / "安静" / "别打扰" | `silence` | no sounds at all, TUI banner only |
| "完成后喊我" / "干完通知我" | `completion_only` | ring only when work is done |
| "只有紧急才找我" | `urgent_only` | ring only for urgent |
| "随时汇报" / "每步告诉我" | `eager` | shout for needs, completions, and progress |

Two detection paths (belt & suspenders):

1. **Text matching** (extension code, instant): keywords in your typed messages or `on` notes.
2. **Semantic understanding** (agent): the agent calls `set_calling_preference` for expressions the keywords don't cover, e.g. "我睡会儿".

## 📱 Phone push setup

```
/i-am-cooking setup
```

Guided flow: pick ntfy (recommended, free) → it explains what ntfy is, how to install the app
(Android / iOS), auto-generates a random topic → enter optional access token → preview & confirm → live test.

Manual config in `~/.pi/i-am-cooking/config.json`:

```json
{
  "phonePush": true,
  "pushProvider": "ntfy",
  "ntfyTopic": "i-am-cooking-your-random-topic",
  "ntfyToken": "${NTFY_TOKEN}"
}
```

Tokens support `${ENV_VAR}` / `$ENV_VAR` references. Webhook providers (Bark, WeChat Work bot,
ServerChan) are supported via `pushProvider: "webhook"` + `webhookUrl`.

## 🔊 Volume control (opt-in)

Prevents you missing the shout when the system volume is low or muted:

| Platform | Implementation |
|---|---|
| Windows | Core Audio API (via PowerShell, no deps) |
| macOS | `osascript` (built-in) |
| Linux | `pactl` (PulseAudio) |

When enabled, entering cooking mode raises volume to `boostLevel` (default 80) only if it's lower,
and restores the original value on exit. You are asked explicitly in the setup wizard.

## 🛡️ Anti-noise guards (system-enforced)

- Completion alerts never repeat, are `info`-level ("好消息！"), and are capped at
  `maxCompletionNotices` (default 3) per cooking session.
- `normal` shouts repeat once after `repeatIntervalMinutes`; `urgent` repeats every
  `urgentRepeatMinutes` until you return.
- Duplicate shouts are deduplicated within 10 minutes.

## 🖥️ Platform support

| Platform | Sound | Chinese TTS | Desktop notif | Phone push | Volume |
|---|---|---|---|---|---|
| Windows | ✅ | ✅ | ✅ Toast | ✅ | ✅ |
| macOS | ✅ | ✅ | ✅ | ✅ | ✅ |
| Linux | ✅¹ | ✅¹ | ✅¹ | ✅ | ✅¹ |

¹ Linux: `canberra-gtk-play` / `espeak-ng` / `notify-send` / `pactl` — install the relevant packages.

## ✅ Verification checklist

Before every release, run through [docs/VERIFICATION.md](docs/VERIFICATION.md).

## 📄 License

MIT — see [LICENSE](LICENSE).

## 🏷️ Gallery

Tagged `pi-package` — automatically listed on [pi.dev/packages](https://pi.dev/packages).
