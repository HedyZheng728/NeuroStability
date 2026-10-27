#!/bin/zsh
set -eu
tool_dir="${0:A:h}"
cd "$tool_dir"
tool_python="$tool_dir/.venv/bin/python"
if [[ ! -x "$tool_python" ]]; then
  tool_python="$(command -v python3)"
fi
"$tool_python" "$tool_dir/scripts/prepare_video.py"
