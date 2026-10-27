"""Explicitly install one pinned official author MotionBERT Lite checkpoint."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from arena.pose3d import WEIGHT_BYTES, WEIGHT_REVISION, WEIGHT_SHA256, WEIGHT_URL


class HTTPSOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme.lower() != 'https':
            raise urllib.error.URLError('Pose3D model redirect must use HTTPS')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser(description='安装官方 MotionBERT Lite 三维骨架模型；不训练、不下载 SMPL')
    parser.add_argument('--download', action='store_true', help='明确允许下载固定官方权重')
    parser.add_argument('--output', type=Path, default=ROOT / 'models/pose3d')
    parser.add_argument('--transport', choices=('urllib', 'curl'), default='urllib')
    args = parser.parse_args()
    if not args.download:
        parser.error('需要 --download 才会联网下载')
    args.output.mkdir(parents=True, exist_ok=True)
    destination = args.output / 'best_epoch.bin'
    valid = False
    if destination.is_file() and destination.stat().st_size == WEIGHT_BYTES:
        with destination.open('rb') as stream:
            valid = hashlib.file_digest(stream, 'sha256').hexdigest() == WEIGHT_SHA256
    if not valid:
        print('下载官方 MotionBERT Lite 64MB 权重', flush=True)
        with tempfile.TemporaryDirectory(dir=args.output) as folder:
            pending = Path(folder) / 'best_epoch.bin'
            if args.transport == 'curl':
                if not shutil.which('curl'):
                    parser.error('curl 未安装，请使用默认 urllib 下载方式')
                subprocess.run(['curl', '--disable', '--fail', '--location', '--proto', '=https',
                                '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '600',
                                '--max-filesize', str(WEIGHT_BYTES), '--silent', '--show-error',
                                '--output', str(pending), WEIGHT_URL], check=True, timeout=605)
            else:
                opener = urllib.request.build_opener(HTTPSOnlyRedirectHandler())
                with opener.open(WEIGHT_URL, timeout=90) as response, pending.open('wb') as stream:
                    size = 0
                    while block := response.read(1024 * 1024):
                        size += len(block)
                        if size > WEIGHT_BYTES:
                            raise ValueError('Pose3D weight download exceeds the pinned file size')
                        stream.write(block)
            if pending.stat().st_size != WEIGHT_BYTES:
                raise ValueError('Pose3D weight download has incorrect size')
            with pending.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != WEIGHT_SHA256:
                    raise ValueError('Pose3D weight SHA256 does not match the official checkpoint')
            pending.replace(destination)
    manifest = {'model': 'MotionBERT Lite FT_MB_lite_MB_ft_h36m_global_lite', 'source_url': WEIGHT_URL,
                'revision': WEIGHT_REVISION, 'sha256': WEIGHT_SHA256, 'bytes': WEIGHT_BYTES,
                'repository_license': 'Apache-2.0', 'filename': destination.name,
                'license_source': 'https://github.com/Walter0807/MotionBERT/blob/705d3a95354db8bdb696b3492e47a3b5537174ff/LICENSE'}
    pending_manifest = args.output / 'manifest.json.tmp'
    pending_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    pending_manifest.replace(args.output / 'manifest.json')
    print(f'官方权重 SHA256 校验通过。配置 ARENA_POSE3D_MODEL={destination.resolve()}', flush=True)


if __name__ == '__main__':
    main()
