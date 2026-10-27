"""Explicit download of official RTMPose ONNX models; never runs during upload."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import urllib.request
import urllib.error
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

MODELS = {
    "detector": "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_m_8xb8-300e_humanart-c2c7a14a.zip",
    "pose": "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip",
}


class HTTPSOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme.lower() != "https":
            raise urllib.error.URLError("模型下载拒绝重定向到非 HTTPS 地址")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser(description="下载官方 RTMPose 17点模型，不训练模型")
    parser.add_argument("--download", action="store_true", help="明确允许下载官方模型")
    parser.add_argument("--transport", choices=("urllib", "curl"), default="urllib", help="Python TLS 不兼容时可显式选择系统 curl；保持 HTTPS 校验")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "models" / "rtmpose")
    args = parser.parse_args()
    if not args.download:
        parser.error("需要 --download 才会联网下载")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = args.output / "manifest.json"
    try:
        cached = json.loads(manifest.read_text())
        if not isinstance(cached, dict):
            cached = {}
    except (OSError, ValueError):
        cached = {}
    records = {}
    for name, url in MODELS.items():
        dest = args.output / f"{name}.onnx"
        prior = cached.get(name, {})
        if not isinstance(prior, dict):
            prior = {}
        trusted = dest.is_file() and prior.get("source_url") == url and prior.get("filename") == dest.name
        if trusted:
            with dest.open("rb") as f:
                trusted = hashlib.file_digest(f, "sha256").hexdigest() == prior.get("sha256")
        if not trusted:
            print(f"下载 {name} 官方模型", flush=True)
            with tempfile.TemporaryDirectory(dir=args.output) as folder:
                archive = Path(folder) / "model.zip"
                if args.transport == "curl":
                    if not shutil.which("curl"):
                        raise ValueError("系统未安装 curl，请使用默认 urllib 下载方式")
                    subprocess.run(["curl", "--disable", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
                                    "--connect-timeout", "15", "--max-time", "600", "--max-filesize", str(200 * 1024 * 1024),
                                    "--silent", "--show-error", "--output", str(archive), url], check=True, timeout=605)
                else:
                    opener = urllib.request.build_opener(HTTPSOnlyRedirectHandler())
                    with opener.open(url, timeout=90) as response, archive.open("wb") as out:
                        size = 0
                        while chunk := response.read(1024 * 1024):
                            size += len(chunk)
                            if size > 200 * 1024 * 1024:
                                raise ValueError("模型包超过200MB，停止下载")
                            out.write(chunk)
                if archive.stat().st_size > 200 * 1024 * 1024:
                    raise ValueError("模型包超过200MB，停止下载")
                with zipfile.ZipFile(archive) as z:
                    files = [f for f in z.infolist() if f.filename.endswith(".onnx")]
                    if len(files) != 1 or not 0 < files[0].file_size <= 200 * 1024 * 1024:
                        raise ValueError("模型包内容与预期不符")
                    pending = Path(folder) / "model.onnx"
                    with z.open(files[0]) as src, pending.open("wb") as out:
                        shutil.copyfileobj(src, out)
                    pending.replace(dest)
        with dest.open("rb") as f:
            records[name] = {"source_url": url, "sha256": hashlib.file_digest(f, "sha256").hexdigest(), "filename": dest.name}
    pending_manifest = manifest.with_suffix(".json.tmp")
    pending_manifest.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    pending_manifest.replace(manifest)
    print("官方模型已保存；推理加载仍需通过本机验证。", flush=True)


if __name__ == "__main__":
    main()
