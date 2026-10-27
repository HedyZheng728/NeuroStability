"""Run installed real models locally. No network, database or training records."""
import argparse
import contextlib
import importlib.metadata
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from arena.backends import BackendUnavailable, get_backend
from arena.config import Settings
from arena.engine import analyze
from arena.video import preprocess


def main():
    parser = argparse.ArgumentParser(description='本地验证已安装 RTMPose；默认用无人画面检查，不联网、不写训练数据库')
    parser.add_argument('--model-dir', type=Path, default=ROOT / 'models' / 'rtmpose')
    parser.add_argument('--video', type=Path, help='可选：已授权的本地视频；未提供则生成无人测试画面')
    parser.add_argument('--seconds', type=float, default=3, help='验证视频前多少秒，默认3秒')
    parser.add_argument('--output', type=Path, help='可选：保存验证摘要 JSON')
    args = parser.parse_args()
    if not 0 < args.seconds <= 300:
        parser.error('--seconds 须在 0 到 300 秒之间')
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix='arena-model-check-') as folder:
            root = Path(folder)
            settings = Settings(data_dir=root, detector_path=str(args.model_dir / 'detector.onnx'),
                                pose_path=str(args.model_dir / 'pose.onnx'))
            backend = get_backend('rtmpose', settings)
            source = args.video
            if source is None:
                source = root / 'blank.mp4'
                subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10',
                                '-t', str(args.seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)],
                               check=True, capture_output=True, timeout=60)
            # The normal validation rejects excessive/invalid source files before inference.
            from arena.video import probe
            info, _, _ = probe(source)
            end = min(float(info['format']['duration']), args.seconds)
            normalized = root / 'normalized.mp4'
            metadata = preprocess(source, normalized, settings, end_sec=end)
            # rtmlib prints load messages; keep stdout machine-readable.
            with contextlib.redirect_stdout(sys.stderr):
                pose = backend.extract(normalized, metadata, lambda *args: None)
            result = analyze(pose)
            report = {'schema_version':1, 'verification':'local_inference_executed', 'backend':'rtmpose',
                      'synthetic':False, 'fixture':'user_selected_video' if args.video else 'blank_safety_check',
                      'elapsed_seconds':round(time.monotonic() - started, 3),
                      'runtime_versions':{p:importlib.metadata.version(p) for p in ('rtmlib','onnxruntime')},
                      'model_sha256':pose['model_sha256'], 'identity':pose['identity'], 'metadata':metadata,
                      'detected_frames':sum(bool(frame['people']) for frame in pose['frames']),
                      'people_per_frame':[len(frame['people']) for frame in pose['frames']], **result,
                      'notice':'仅验证本地模型与软件可运行；不等于摔跤动作识别、身份跟踪或运动学效度验证。'}
            text = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
            if args.output:
                args.output.write_text(text, encoding='utf-8')
            print(text, end='')
    except (BackendUnavailable, ValueError, OSError, subprocess.SubprocessError) as exc:
        print(f'RTMPose 检查未通过：{exc}', file=sys.stderr)
        return 2
    except Exception as exc:
        print(f'RTMPose 加载或推理失败（{type(exc).__name__}）：{exc}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
