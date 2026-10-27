"""Install pinned official SAM2.1 safetensors for local inference; no training."""
import argparse
import hashlib
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from arena.segmentation import MODEL_FILES, MODEL_ID, MODEL_REVISION, official_file_hash


class HTTPSOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme.lower() != "https":
            raise urllib.error.URLError("模型下载拒绝非 HTTPS 重定向")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser(description="下载官方 SAM2.1 tiny；不训练、不上传视频")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--transport", choices=("urllib", "curl"), default="urllib")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "models" / "sam2")
    args = parser.parse_args()
    if not args.download:
        parser.error("需要 --download 才会联网")
    args.output.mkdir(parents=True, exist_ok=True)
    records = {}
    for filename, (size, _) in MODEL_FILES.items():
        url = f"https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{filename}"
        target = args.output / filename
        if not target.is_file() or not official_file_hash(target, filename):
            print(f"下载官方 SAM2：{filename}", flush=True)
            # Keep unfinished data for an explicit retry; never load it as a model.
            pending = args.output / (filename + ".download")
            if pending.exists() and pending.stat().st_size >= size and not official_file_hash(pending, filename):
                pending.unlink()
            if args.transport == "curl":
                subprocess.run(["curl", "--disable", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
                                "--continue-at", "-", "--connect-timeout", "20", "--max-time", "600", "--max-filesize", str(max(size, 1024 * 1024)),
                                "--silent", "--show-error", "--output", str(pending), url], check=True, timeout=605)
            else:
                opener = urllib.request.build_opener(HTTPSOnlyRedirectHandler())
                while not pending.exists() or pending.stat().st_size < size:
                    offset = pending.stat().st_size if pending.exists() else 0
                    request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{size - 1}"})
                    with opener.open(request, timeout=90) as response:
                        if response.status == 206:
                            content_range = response.headers.get("Content-Range", "")
                            if not content_range.startswith(f"bytes {offset}-") or not content_range.endswith(f"/{size}"):
                                raise ValueError("SAM2 续传返回的字节区间不匹配")
                        elif response.status == 200:
                            offset = 0
                        else:
                            raise ValueError("SAM2 模型下载响应无效")
                        total = offset
                        with pending.open("ab" if offset else "wb") as dest:
                            while chunk := response.read(1024 * 1024):
                                total += len(chunk)
                                if total > size:
                                    raise ValueError("SAM2 下载文件超出官方长度")
                                dest.write(chunk)
                        if total == offset:
                            raise ValueError("SAM2 下载未返回数据；部分文件已保留供续传")
            if not official_file_hash(pending, filename):
                raise ValueError(f"SAM2 官方文件校验失败：{filename}")
            pending.replace(target)
        with target.open("rb") as source:
            records[filename] = {"source_url": url, "sha256": hashlib.file_digest(source, "sha256").hexdigest(),
                                 "size": target.stat().st_size}
    manifest = {"model_id": MODEL_ID, "revision": MODEL_REVISION, "format": "safetensors", "files": records}
    pending = args.output / "manifest.json.tmp"
    pending.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    pending.replace(args.output / "manifest.json")
    print("官方 SAM2 文件及来源清单已保存并校验；加载与真实视频推理需本机验证。", flush=True)


if __name__ == "__main__":
    main()
