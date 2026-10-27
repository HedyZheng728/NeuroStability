#!/usr/bin/env python3
"""Explicit, resumable download of the fixed official Qwen model; never run by requests."""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from arena.local_review import MODEL_FILES, MODEL_ID, MODEL_REVISION, file_hashes


def install(directory):
    import httpx
    directory.mkdir(parents=True, exist_ok=True)
    records = {}
    with httpx.Client(timeout=httpx.Timeout(120, connect=30), follow_redirects=True) as client:
        for filename in MODEL_FILES:
            path = directory / filename
            url = f"https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{filename}"
            if path.is_file():
                sha256 = file_hashes(path, filename)
                print(f"Verified existing {filename}", flush=True)
            else:
                partial = path.with_name(path.name + ".part")
                offset = partial.stat().st_size if partial.exists() else 0
                headers = {"Range": f"bytes={offset}-"} if offset else {}
                print(f"Downloading {filename} ({MODEL_FILES[filename][0]:,} bytes)", flush=True)
                with client.stream("GET", url, headers=headers) as response:
                    response.raise_for_status()
                    if offset and response.status_code != 206:
                        offset = 0
                    with partial.open("ab" if offset else "wb") as target:
                        for chunk in response.iter_bytes(4 * 1024 * 1024):
                            target.write(chunk)
                sha256 = file_hashes(partial, filename)
                partial.replace(path)
            records[filename] = {"sha256": sha256, "size": path.stat().st_size, "source_url": url}
    manifest = {"model_id": MODEL_ID, "revision": MODEL_REVISION, "files": records,
                "installed_at": datetime.now(timezone.utc).isoformat(), "license": "Apache-2.0"}
    temporary = directory / "manifest.json.part"
    temporary.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    temporary.replace(directory / "manifest.json")
    print(f"Installed and verified {MODEL_ID} at {directory.resolve()}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Explicitly authorize the 3.1 GB official download")
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[1] / "models/review")
    args = parser.parse_args()
    if not args.download:
        parser.error("No files downloaded. Add --download to install the free official local model.")
    install(args.directory.resolve())


if __name__ == "__main__":
    main()
