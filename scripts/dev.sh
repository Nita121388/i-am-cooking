#!/usr/bin/env bash
# 以「开发版」身份启动 pi：只加载本仓库代码 + 独立状态目录 + DEV 标记。
# 用法: bash scripts/dev.sh [pi 的参数...]   或   npm run dev -- [参数...]
#
# 为什么需要它：pi 对工具名做硬性冲突检查，同一会话里
# 「已安装的 npm 发布版」和「本仓库开发版」不能共存——后加载的会整个失败，
# 8 个工具全部注册不上，而且往往只有一行启动错误，很容易没看见。
# 所以切版本要按「进程」切，不是按命令名切。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ext="$here/extensions/i-am-cooking/index.ts"

# 状态目录：默认与日常在用的那份隔离，避免临时调阈值污染日常配置
export I_AM_COOKING_HOME="${I_AM_COOKING_HOME:-$HOME/.pi/iac-dev}"
# 构建身份：命令注册为 /i-am-cooking-dev，状态栏/横幅带 DEV
export I_AM_COOKING_DEV=1

if [ ! -f "$ext" ]; then
  echo "找不到扩展入口: $ext" >&2
  exit 1
fi

echo "🧪 DEV 构建"
echo "   源码: $ext"
echo "   状态: $I_AM_COOKING_HOME"
echo "   命令: /i-am-cooking-dev（/i-am-cooking 为别名，会提醒）"
echo

# -ne 关掉全局包发现，-e 只加载本仓库 —— 保证不会和已安装的发布版抢工具名
exec pi -ne -e "$ext" "$@"