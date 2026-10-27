"""Inspect local FSW artifacts; exit 2 while inference is blocked."""
import argparse
import os
from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from arena.fsw import fsw_status


def main():
    parser = argparse.ArgumentParser(description="FSW-Net 本地权重预检（不下载、不训练、不推理）")
    parser.add_argument("--bundle", default=os.getenv("FSW_BUNDLE", ""), help="本地 JSON manifest 路径")
    args = parser.parse_args()
    status = fsw_status(SimpleNamespace(fsw_bundle=args.bundle))
    print(f"FSW-Net: {'READY' if status['ready'] else 'BLOCKED'} [{status['code']}]")
    print(status["reason"])
    print(f"核查日期：{status['audit_date']}；公开代码 commit：{status['source_commit']}")
    print("验证范围：本地 manifest/文件完整性；未完成训练权重来源核实、严格加载或真实片段推理。")
    return 0 if status["ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
