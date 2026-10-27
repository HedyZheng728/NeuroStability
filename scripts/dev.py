"""Local API + one Worker. No seed records. Password is stored in a private local file."""
import os
import secrets
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from arena.api import create_app
from arena.config import Settings
from arena.worker import serve


def main():
    import uvicorn
    data = ROOT / "data"
    data.mkdir(exist_ok=True)
    secret_file = data / "admin-password.txt"
    if not secret_file.exists():
        descriptor = os.open(secret_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as out:
            out.write(secrets.token_urlsafe(24) + "\n")
    password = os.getenv("ARENA_ADMIN_PASSWORD") or secret_file.read_text().strip()
    kwargs = dict(data_dir=data, production=False, admin_password=password)
    model_dir = ROOT / "models" / "rtmpose"
    if (model_dir / "detector.onnx").is_file() and (model_dir / "pose.onnx").is_file():
        kwargs.update(detector_path=str(model_dir / "detector.onnx"), pose_path=str(model_dir / "pose.onnx"))
    sam2_dir = ROOT / "models" / "sam2"
    if (sam2_dir / "manifest.json").is_file():
        kwargs["sam2_path"] = str(sam2_dir)
    review_dir = ROOT / "models" / "review"
    if review_dir.is_dir():
        kwargs["review_model_path"] = str(review_dir)
    if (ROOT / "models" / "pose3d" / "best_epoch.bin").is_file():
        kwargs["pose3d_model_path"] = str(ROOT / "models" / "pose3d")
    if (ROOT / "models" / "vision-action" / "manifest.json").is_file():
        kwargs["action_model_path"] = str(ROOT / "models" / "vision-action")
    app = create_app(Settings(**kwargs))
    stop = threading.Event()
    worker = threading.Thread(target=serve, args=(app.state.ctx, stop), daemon=True)
    worker.start()
    print(f"本机工作台 http://127.0.0.1:8000 — 账号 admin，初始密码见 {secret_file}")
    try:
        uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
    finally:
        stop.set()
        worker.join(timeout=3)


if __name__ == "__main__":
    main()
