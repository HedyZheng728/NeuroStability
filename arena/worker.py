import json
import logging
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select, update

from . import db
from .backends import BackendUnavailable, get_backend
from .config import Settings
from .engine import analyze
from .storage import make_store
from .video import preprocess

log = logging.getLogger(__name__)


class LeaseLost(RuntimeError):
    pass


@dataclass
class Context:
    settings: Settings
    db: db.Database
    store: object


def context(settings):
    settings.validate()
    database = db.Database(settings)
    database.initialize(settings.admin_password)
    return Context(settings, database, make_store(settings))


def run_once(ctx):
    token = str(uuid4())
    with ctx.db.engine.begin() as c:
        # Expired leases require explicit user retry: never publish an abandoned worker's result.
        c.execute(update(db.jobs).where(db.jobs.c.status == "running", db.jobs.c.lease_until < int(time.time()))
                  .values(status="failed", stage="任务中断", error="Worker 租约已过期，请重试", updated_at=db.now()))
        stmt = select(db.jobs).where(db.jobs.c.status == "queued").order_by(db.jobs.c.created_at).limit(1)
        if ctx.db.engine.dialect.name == "postgresql":
            stmt = stmt.with_for_update(skip_locked=True)
        row = c.execute(stmt).mappings().first()
        if not row:
            return False
        job = dict(row)
        claimed = c.execute(update(db.jobs).where(db.jobs.c.id == job["id"], db.jobs.c.status == "queued")
                            .values(status="running", stage="读取视频", progress=5, worker_token=token,
                                    lease_until=int(time.time()) + 90, updated_at=db.now()))
        if not claimed.rowcount:
            return False
    stop = threading.Event()

    def patch(**values):
        with ctx.db.engine.begin() as c:
            result = c.execute(update(db.jobs).where(db.jobs.c.id == job["id"], db.jobs.c.worker_token == token,
                                                     db.jobs.c.status == "running", db.jobs.c.lease_until > int(time.time()))
                               .values(**values, updated_at=db.now()))
            if not result.rowcount:
                raise LeaseLost("任务租约失效，停止发布结果")

    def put_artifact(path, key, content_type):
        # Same video-row lock as deletion, held across the write: deletion cannot finish
        # between lease validation and storage commit. A stale worker cannot recreate data.
        with ctx.db.engine.begin() as c:
            present = c.execute(select(db.videos.c.id).where(db.videos.c.id == job["video_id"]).with_for_update()).first()
            if not present:
                raise LeaseLost("视频已删除，停止存储")
            c.execute(update(db.videos).where(db.videos.c.id == job["video_id"]).values(status=db.videos.c.status))
            current = c.execute(select(db.jobs.c.id).where(db.jobs.c.id == job["id"], db.jobs.c.worker_token == token,
                                db.jobs.c.status == "running", db.jobs.c.lease_until > int(time.time()))).first()
            if not current:
                raise LeaseLost("任务已失效，停止存储")
            ctx.store.put(path, key, content_type)

    def heartbeat():
        while not stop.wait(20):
            try:
                patch(lease_until=int(time.time()) + 90)
            except Exception:
                log.exception("worker heartbeat failed")
                return

    pulse = threading.Thread(target=heartbeat, daemon=True)
    pulse.start()
    prefix = f"videos/{job['video_id']}/jobs/{job['id']}/"
    try:
        video = ctx.db.get(db.videos, job["video_id"])
        with tempfile.TemporaryDirectory(prefix="arena-") as folder:
            source, normalized = Path(folder) / "source", Path(folder) / "normalized.mp4"
            source_pose_job_id = job["params"].get("source_pose_job_id")
            cached_pose = None
            if source_pose_job_id:
                source_job = ctx.db.get(db.jobs, source_pose_job_id)
                if not source_job or source_job["video_id"] != job["video_id"] or source_job["backend"] != "rtmpose_tracking" or source_job["status"] not in ("completed", "needs_review") or (source_job["result"] or {}).get("synthetic") is not False:
                    raise ValueError("来源轨迹分析不可用")
                source_prefix = f"videos/{job['video_id']}/jobs/{source_pose_job_id}/"
                ctx.store.download(source_prefix + "normalized.mp4", normalized)
                pose_path = Path(folder) / "source-pose.json"
                ctx.store.download(source_prefix + "pose.json", pose_path)
                cached_pose = json.loads(pose_path.read_text())
                info = source_job["metadata"]
                patch(stage="读取已保存的人物轨迹", progress=20)
            else:
                ctx.store.download(video["storage_key"], source)
                patch(stage="预处理：规范画面并去除音轨", progress=10)
                info = preprocess(source, normalized, ctx.settings, start_sec=job["params"].get("start_sec", 0),
                                  end_sec=job["params"].get("end_sec"))
            put_artifact(normalized, prefix + "normalized.mp4", "video/mp4")
            patch(metadata=info, stage="检查推理后端", progress=30)
            if job["backend"] == "preprocess":
                patch(status="completed", stage="视频预处理完成，可人工标注复盘", progress=100, lease_until=None)
                return True
            backend = get_backend(job["backend"], ctx.settings) if cached_pose is None or job["backend"] != "rtmpose_tracking" else None
            progress = lambda value, stage: patch(progress=value, stage=stage)
            if job["backend"] in ("fsw", "action"):
                result = backend.classify(normalized, info, progress)
                result["needs_review"] = True
            elif job["backend"] == "pose3d":
                pose = cached_pose if cached_pose is not None else get_backend("rtmpose_tracking", ctx.settings).extract(normalized, info, progress)
                reconstructed = backend.reconstruct(pose, info, progress, target_track_id=job["params"].get("target_track_id"))
                reconstructed["source_pose_job_id"] = source_pose_job_id
                reconstructed["time_offset"] = info["time_offset"]
                artifact = Path(folder) / "pose3d.json"
                artifact.write_text(json.dumps(reconstructed, ensure_ascii=False, allow_nan=False), encoding="utf-8")
                put_artifact(artifact, prefix + "pose3d.json", "application/json")
                result = {key: value for key, value in reconstructed.items() if key not in ("frames", "summary")}
                result["pose3d"] = reconstructed["summary"]
                result["needs_review"] = not reconstructed["frames"]
            elif job["backend"] == "sam2":
                segmentation = backend.segment(normalized, info, progress, roi=job["params"].get("roi"))
                segment_file = Path(folder) / "segmentation.json"
                segment_file.write_text(json.dumps(segmentation, ensure_ascii=False, allow_nan=False), encoding="utf-8")
                put_artifact(segment_file, prefix + "segmentation.json", "application/json")
                result = {key: value for key, value in segmentation.items() if key not in ("frames", "summary")}
                result["segmentation"] = segmentation["summary"]
                result["needs_review"] = segmentation["summary"]["segmented_frames"] == 0
            else:
                pose = cached_pose if cached_pose is not None else backend.extract(normalized, info, progress)
                pose["time_offset"] = info["time_offset"]
                result = analyze(pose, roi=job["params"].get("roi"), target_track_id=job["params"].get("target_track_id"))
                if source_pose_job_id:
                    result["source_pose_job_id"] = source_pose_job_id
                result.update(kind="pose", synthetic=pose["synthetic"], backend=job["backend"], sample_fps=info["sample_fps"],
                              roi=job["params"].get("roi"), model_sha256=pose.get("model_sha256", {}))
                if pose.get("tracking"):
                    from .tracking import summarize
                    result["tracking"] = {**summarize(pose), "provenance": pose["tracking"]}
                pose_file = Path(folder) / "pose.json"
                pose_file.write_text(json.dumps(pose, ensure_ascii=False, allow_nan=False), encoding="utf-8")
                put_artifact(pose_file, prefix + "pose.json", "application/json")
            patch(result=result, status="needs_review" if result.get("needs_review") else "completed",
                  progress=100, stage="需人工检查遮挡/人物或质量" if result.get("needs_review") else "分析完成", lease_until=None)
    except LeaseLost:
        with ctx.db.engine.begin() as c:
            c.execute(update(db.jobs).where(db.jobs.c.id == job["id"], db.jobs.c.worker_token == token,
                                           db.jobs.c.status == "running")
                      .values(status="failed", stage="任务中断", error="Worker 租约失效，请重试", updated_at=db.now()))
    except BackendUnavailable as exc:
        patch(status="blocked", stage="模型未就绪", error=str(exc), lease_until=None)
    except Exception as exc:
        log.exception("analysis failed: %s", job["id"])
        patch(status="failed", stage="分析失败", error=str(exc) if isinstance(exc, ValueError) else "处理异常，请检查 Worker 日志后重试", lease_until=None)
    finally:
        stop.set()
        pulse.join(timeout=1)
    return True


def serve(ctx, stop=None):
    stop = stop or threading.Event()
    while not stop.is_set():
        try:
            busy = run_once(ctx)
        except Exception:
            log.exception("worker cycle failed")
            busy = False
        if not busy:
            stop.wait(2)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    serve(context(Settings()))
