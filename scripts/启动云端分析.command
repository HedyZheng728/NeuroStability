#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")/.."
if [[ ! -x .venv/bin/python ]]; then
  print -u2 "尚未安装本机 Python 环境，请先完成 README 中的本地环境配置。"
  read -r "?按回车键关闭窗口。"
  exit 1
fi
if [[ ! -f data/cloudflare-worker.json && ( -z "${ARENA_CLOUD_URL:-}" || -z "${ARENA_WORKER_TOKEN:-}" ) ]]; then
  print -u2 "尚未配置云端分析。请先按照 README 完成一次性配对："
  print -u2 ".venv/bin/python -m arena.cloud_bridge --configure https://你的域名"
  read -r "?按回车键关闭窗口。"
  exit 1
fi
exec .venv/bin/python -m arena.cloud_bridge --config data/cloudflare-worker.json
