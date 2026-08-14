# 🍳 I am cooking

> **你离开电脑去做饭时，pi 继续自主干活。**
> 它真正卡住时——或任务完成时——会**大声呼喊你**：声音、中文 TTS、桌面弹窗、**手机推送**，厨房里的你也能听到。

"I am cooking" 描述的是**你的状态**（你在做饭）。呼喊时 agent 说：**"pi 需要你！"**

[English version](docs/README.en.md)

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🧠 自主模式 | `/i-am-cooking on` 注入"自主推进，别干等"规则 |
| 📣 多路呼喊 | 声音 + 中文 TTS + 桌面弹窗 + **手机推送** + TUI 横幅 |
| 📱 手机推送 | ntfy.sh（免费，零配置）— 厨房场景的关键通道 |
| 🔔 完成通知 | agent 完成任务时喊："主人，好消息！任务完成了！" |
| 🎛️ 动态偏好 | 从你的话里自动切换：别喊了→静音 / 完成后喊我→完成才喊 / 随时汇报→积极模式 |
| 🛡️ 安全网 | agent 以"？"结尾等你回复时，自动喊 |
| 🔙 自动退出 | 离开时你打字 → "我回来了"，agent 汇报 |
| 🔊 音量控制 | 可选：离开时自动拉高音量，回来恢复 |
| 🗣️ 交互式配置 | `/i-am-cooking setup` — 向导式，含 ntfy 引导 + 预览确认 + 配错可重填 |
| 🔐 Token 安全 | 配置值支持 `${ENV_VAR}`，token 不落盘明文 |
| 💻 跨平台 | Windows / macOS / Linux |

## 📦 安装

```bash
# GitHub 安装（推荐）
pi install git:github.com/<你的用户名>/i-am-cooking

# 本地开发路径
pi install E:/File/NitaFile/Projects/i-am-cooking

# npm 发布后
pi install npm:i-am-cooking
```

安装后 `/reload` 或重启 pi 生效。

## 🚀 快速开始

```
/i-am-cooking setup                     # ① 配置手机推送（交互式向导）
/i-am-cooking test                      # ② 测试所有通道
/i-am-cooking on 继续做登录模块           # ③ 开启离开模式，走人
/i-am-cooking off                       # ④ 我回来了，agent 汇报
/i-am-cooking status                    # 查看状态
```

## 📖 命令

| 命令 | 说明 |
|---|---|
| `/i-am-cooking on [备注]` | 开启离开模式。备注可带偏好（如 `on 完成后喊我`） |
| `/i-am-cooking off` | 关闭离开模式，agent 收到"喊了你什么"的汇报 |
| `/i-am-cooking status` | 查看模式 / 待处理呼喊 / 通道 / token / 当前偏好 |
| `/i-am-cooking setup` | 交互式配置向导（含 ntfy 引导、重填、音量允许） |
| `/i-am-cooking test` | 测试所有通道（无需开模式） |

子命令支持 Tab 补全：`/i-am-cooking ` 后按 Tab 弹出选项。

## 🧠 动态呼喊偏好

agent 从你的话里自动判断偏好，**两种方式并行**：

1. **文字匹配**（扩展代码，毫秒级）：你说"别喊了" → 立即静音
2. **语义理解**（agent）：你说"我睡会儿" → 理解为静音，调用 `set_calling_preference`

| 你说 | 模式 | 效果 |
|---|---|---|
| （不说） | `normal`（默认） | 需要你 + 完成都喊 |
| "别喊了" / "安静" / "静音" | `silence` | 全静音，只剩横幅 |
| "完成后喊我" / "干完通知我" | `completion_only` | 只有完成才响铃 |
| "只有紧急才找我" | `urgent_only` | 只有 urgent 才响铃 |
| "随时汇报" / "每步告诉我" | `eager` | 需要你 / 完成 / 进度都喊 |

## 📱 手机推送配置

### 交互式向导（推荐）

```
/i-am-cooking setup
```

会引导你：了解 ntfy 是什么 → 装 app → 填 topic → 自动随机 topic 建议 → 预览确认（填错了可重填）→ 测试推送。

### 手动配置

`~/.pi/i-am-cooking.json`：

```json
{
  "phonePush": true,
  "pushProvider": "ntfy",
  "ntfyTopic": "i-am-cooking-你的随机topic",
  "ntfyToken": "${NTFY_TOKEN}"
}
```

**ntfy 安装**：Android/iOS 搜 "ntfy" 安装 → Subscribe → 填入 topic 名即可。

也支持 Webhook（Bark / 企业微信机器人 / Server酱），见 [完整文档](docs/README.en.md)。

## 🔊 音量控制（可选）

离开时自动拉高音量（防止静音听不到呼喊），回来恢复。

setup 向导里会明确问你"允许吗"，默认关闭。允许后每次 `on` 自动拉高，`off` 恢复原值。

| 平台 | 实现 |
|---|---|
| Windows | Core Audio API（PowerShell，零依赖） |
| macOS | `osascript`（系统自带） |
| Linux | `pactl`（PulseAudio） |

## 🛡️ 防打扰机制（系统强制）

| 规则 | 值 |
|---|---|
| 完成通知只喊一次 | 不重复 |
| 每次离开最多喊几轮完成 | `maxCompletionNotices` 默认 3 |
| 正常级别重复一次 | 5 分钟后 |
| 紧急级别反复喊 | 3 分钟一次，直到你回来 |
| 10 分钟内不重复同内容 | 自动去重 |

## 🖥️ 平台支持

| 平台 | 声音 | 中文 TTS | 桌面通知 | 手机推送 | 音量控制 |
|---|---|---|---|---|---|
| Windows | ✅ | ✅ | ✅ Toast | ✅ | ✅ |
| macOS | ✅ | ✅ say Tingting | ✅ osascript | ✅ | ✅ |
| Linux | ✅¹ | ✅¹ espeak-ng | ✅¹ notify-send | ✅ | ✅¹ |

¹ Linux：需安装对应包。

## ✅ 验证清单

发布前请通过 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 📄 许可

MIT — 详见 [LICENSE](LICENSE)。

---

**English users**: see [docs/README.en.md](docs/README.en.md) for the full English documentation.
