"""Same-origin team workspace API. All training records and media require login."""
import hashlib
import json
import logging
import math
import secrets
import tempfile
import time
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from . import db
from .backends import model_status
from .config import Settings, workspace_today
from . import analytics, planning
from .review import facts_for, llm_draft, rules_draft
from .storage import LocalStore
from .worker import context

log = logging.getLogger(__name__)
Category = Literal["stability", "footwork", "attack", "defense"]
VideoCategory = Literal["stability", "footwork", "attack", "defense", "mixed"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
ACTIVE = ("queued", "running")


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class Login(Input):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=300)


class Athlete(Input):
    name: Name
    level: str = Field(default="", max_length=100)


class Session(Input):
    athlete_id: str
    date: date
    objective: str = Field(default="", max_length=2000)
    duration_min: int = Field(default=0, ge=0, le=1440)
    rpe: int | None = Field(default=None, ge=0, le=10)
    notes: str = Field(default="", max_length=5000)


class SessionCreate(Session):
    plan_id: str | None = None


class Plan(Input):
    athlete_id: str
    date: date
    category: Category
    objective: str = Field(default="", max_length=2000)
    planned_minutes: int = Field(ge=1, le=1440)


class PlanStatus(Input):
    status: Literal["planned", "cancelled"]


class JobInput(Input):
    backend: Literal["rtmpose", "rtmpose_tracking", "sam2", "fsw", "sample", "wham", "preprocess", "action", "pose3d"] = "rtmpose"
    sample_acknowledged: bool = False
    source_pose_job_id: str | None = Field(default=None, min_length=1, max_length=36)
    target_track_id: int | None = Field(default=None, strict=True, ge=1, le=100000)
    roi: list[float] | None = None
    start_sec: float = Field(default=0, ge=0)
    end_sec: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def check(self):
        if self.backend in ("action", "pose3d") and self.roi is not None:
            raise ValueError("此方法不支持目标选区；三维可使用已有的目标轨迹")
        if self.target_track_id is not None and self.source_pose_job_id is None:
            raise ValueError("选择目标轨迹须同时指定来源分析")
        if self.source_pose_job_id is not None and self.backend == "rtmpose_tracking" and self.target_track_id is None:
            raise ValueError("二维目标复算须明确选择轨迹")
        if self.source_pose_job_id is not None and (self.backend not in ("rtmpose_tracking", "pose3d") or self.roi is not None
                                                     or self.start_sec != 0 or self.end_sec is not None):
            raise ValueError("目标轨迹复用来源片段，不能更改时间或选区")
        if self.backend == "sample" and not self.sample_acknowledged:
            raise ValueError("请明确确认合成样例不代表真实视频分析")
        if self.end_sec is not None and self.end_sec <= self.start_sec:
            raise ValueError("片段终点必须晚于起点")
        if self.roi is not None:
            r = self.roi
            if (len(r) != 4 or min(r) < 0 or min(r[2:]) <= 0 or r[0] + r[2] > 1 or r[1] + r[3] > 1):
                raise ValueError("ROI 须为图像内归一化 [x,y,w,h]")
        return self


class DraftInput(Input):
    job_id: str
    provider: Literal["rules", "llm"] = "rules"
    language: Literal["en", "zh"] = "zh"


class VideoCategoryInput(Input):
    category: VideoCategory


class ReviewInput(Input):
    draft_id: str | None = None
    observations: str = Field(max_length=15000)
    next_action: str = Field(default="", max_length=5000)
    confirmed: bool = False


class ScoreInput(Input):
    score: float = Field(ge=0, le=10, strict=True)
    comment: str = Field(default="", max_length=5000)
    confirmed: bool = False

    @model_validator(mode="after")
    def check(self):
        if self.confirmed and not self.comment:
            raise ValueError("确认人工评分需要填写评语")
        return self


class AssessmentInput(Input):
    decision: Literal["accepted", "excluded", "superseded", "pending"]
    subject_role: Literal["athlete", "coach", "unknown"]
    reason: str = Field(default="", max_length=5000)

    @model_validator(mode="after")
    def check(self):
        if self.decision != "pending" and not self.reason:
            raise ValueError("关闭分析审核需要填写判断依据")
        return self


class EventInput(Input):
    source_job_id: str | None = Field(default=None, min_length=1, max_length=36)
    start_sec: float = Field(ge=0, le=300)
    end_sec: float = Field(gt=0, le=300)
    label: Name
    actor: Literal["athlete", "opponent", "unknown"] = "unknown"
    outcome: str = Field(default="待确认", max_length=100)
    notes: str = Field(default="", max_length=3000)

    @model_validator(mode="after")
    def check(self):
        if self.end_sec <= self.start_sec:
            raise ValueError("片段终点必须晚于起点")
        return self


def create_app(settings=None):
    settings = settings or Settings()
    ctx = context(settings)

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            ctx.db.engine.dispose()

    app = FastAPI(title="NeuroStability Arena", version="0.1.0", lifespan=lifespan,
                  docs_url=None if settings.production else "/docs",
                  redoc_url=None)
    app.state.ctx = ctx

    def require(table, id):
        value = ctx.db.get(table, id)
        if value is None:
            raise HTTPException(404, "记录不存在")
        return value

    def assessed_jobs(rows):
        assessments = ctx.db.rows(select(db.analysis_assessments)
                                  .where(db.analysis_assessments.c.job_id.in_([row["id"] for row in rows]))) if rows else []
        by_job = {row["job_id"]: row for row in assessments}
        return [{**row, "assessment": by_job.get(row["id"])} for row in rows]

    def security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; media-src 'self' https: blob:; connect-src 'self'; "
            "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        if settings.production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    @app.middleware("http")
    async def access(request, call_next):
        path = request.url.path
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            allowed = settings.public_url if settings.production else str(request.base_url).rstrip("/")
            if origin and origin != allowed:
                return security_headers(JSONResponse({"detail": "来源不允许"}, status_code=403))
        if path == "/api/videos" and request.method == "POST":
            try:
                length = int(request.headers.get("content-length", "-1"))
            except ValueError:
                length = -1
            if length < 0 or length > settings.max_upload_bytes + 1024 * 1024:
                return security_headers(JSONResponse({"detail": "上传须携带合法大小，且文件不超过100MB"}, status_code=413))
        if path.startswith("/api/") and path != "/api/login":
            raw = request.cookies.get("arena_session", "")
            auth = ctx.db.get(db.tokens, hashlib.sha256(raw.encode()).hexdigest()) if raw else None
            if not auth or auth["expires"] <= int(time.time()):
                return security_headers(JSONResponse({"detail": "请先登录"}, status_code=401))
            if request.method not in ("GET", "HEAD", "OPTIONS") and not secrets.compare_digest(
                    request.headers.get("x-csrf-token", ""), auth["csrf"]):
                return security_headers(JSONResponse({"detail": "CSRF 校验失败，请刷新后重试"}, status_code=403))
            request.state.user = require(db.users, auth["user_id"])
            request.state.auth = auth
        return security_headers(await call_next(request))

    @app.get("/healthz")
    def health():
        ctx.db.rows(select(db.schema))
        return {"status": "ok", "version": "0.1.0"}

    @app.post("/api/login")
    def login(payload: Login, request: Request, response: Response):
        client = hashlib.sha256((request.client.host if request.client else "unknown").encode()).hexdigest()
        cutoff = int(time.time()) - 300
        with ctx.db.engine.begin() as c:
            c.execute(delete(db.attempts).where(db.attempts.c.created < cutoff))
            count = c.execute(select(func.count()).select_from(db.attempts).where(db.attempts.c.client == client)).scalar()
            if count >= 10:
                raise HTTPException(429, "登录尝试过多，请5分钟后重试")
            c.execute(db.attempts.insert().values(id=str(uuid4()), client=client, created=int(time.time())))
            user = c.execute(select(db.users).where(db.users.c.username == payload.username)).mappings().first()
        stored = user["password_hash"] if user else db.password_hash("unmatchable", "0" * 32)
        matched = secrets.compare_digest(db.password_hash(payload.password, stored.split(":")[0]), stored)
        if not user or not matched:
            raise HTTPException(401, "用户名或密码错误")
        raw, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        ctx.db.add(db.tokens, {"id": hashlib.sha256(raw.encode()).hexdigest(), "user_id": user["id"],
                               "csrf": csrf, "expires": int(time.time()) + 8 * 3600})
        with ctx.db.engine.begin() as c:
            c.execute(delete(db.tokens).where(db.tokens.c.expires < int(time.time())))
        response.set_cookie("arena_session", raw, httponly=True, secure=settings.production,
                            samesite="strict", max_age=8 * 3600)
        return {"username": user["username"], "csrf": csrf, "timezone": settings.timezone}

    @app.get("/api/me")
    def me(request: Request):
        return {"username": request.state.user["username"], "csrf": request.state.auth["csrf"], "timezone": settings.timezone}

    @app.post("/api/logout", status_code=204)
    def logout(request: Request):
        with ctx.db.engine.begin() as c:
            c.execute(delete(db.tokens).where(db.tokens.c.id == request.state.auth["id"]))
        response = Response(status_code=204)
        response.delete_cookie("arena_session", secure=settings.production, httponly=True, samesite="strict")
        return response

    @app.get("/api/models")
    def models():
        status = model_status(settings)
        for backend, key in (("rtmpose", "rtmpose"), ("rtmpose_tracking", "tracking"), ("sam2", "sam2"), ("action", "action"), ("pose3d", "pose3d")):
            rows = ctx.db.rows(select(db.jobs.c.video_id, db.jobs.c.result, db.jobs.c.updated_at)
                               .where(db.jobs.c.backend == backend, db.jobs.c.status.in_(("completed", "needs_review")))
                               .order_by(db.jobs.c.updated_at))
            successful = [row for row in rows if isinstance(row["result"], dict) and row["result"].get("synthetic") is False]
            latest = {row["video_id"]: row for row in successful}
            status[key].update(processed_jobs=len(successful), processed_videos=len(latest),
                               last_processed_at=successful[-1]["updated_at"] if successful else None)
            if key == "sam2":
                status[key]["segmented_frames"] = sum(row["result"].get("segmentation", {}).get("segmented_frames", 0) for row in latest.values())
            status[key]["active_jobs"] = len(ctx.db.rows(select(db.jobs.c.id).where(db.jobs.c.backend == backend, db.jobs.c.status.in_(ACTIVE))))
            if key == "tracking":
                status[key]["track_count"] = sum(row["result"].get("tracking", {}).get("track_count", 0) for row in latest.values())
                status[key]["joint_observed_videos"] = sum(bool(row["result"].get("kinematics", {}).get("tracks")) for row in latest.values())
            if key == "pose3d":
                status[key]["reconstructed_frames"] = sum(row["result"].get("pose3d", {}).get("frame_count", 0) for row in latest.values())
        language_drafts = ctx.db.rows(select(db.drafts.c.video_id, db.drafts.c.model, db.drafts.c.facts).where(db.drafts.c.provider == "llm", db.drafts.c.synthetic.is_(False)))
        language_drafts = [row for row in language_drafts if row["model"] != "Qwen/Qwen2.5-1.5B-Instruct"
                           or (row["facts"] or {}).get("language_output", {}).get("method") == "extractive-source-v1"]
        status["llm"].update(processed_jobs=len(language_drafts), processed_videos=len({row["video_id"] for row in language_drafts}))
        return status

    @app.get("/api/athletes")
    def athletes():
        return ctx.db.rows(select(db.athletes).order_by(db.athletes.c.created_at.desc()))

    @app.post("/api/athletes", status_code=201)
    def create_athlete(payload: Athlete):
        return ctx.db.add(db.athletes, dict(id=str(uuid4()), **payload.model_dump(), created_at=db.now()))

    @app.put("/api/athletes/{id}")
    def edit_athlete(id: str, payload: Athlete):
        require(db.athletes, id)
        with ctx.db.engine.begin() as c:
            c.execute(update(db.athletes).where(db.athletes.c.id == id).values(**payload.model_dump()))
        return require(db.athletes, id)

    @app.get("/api/sessions")
    def sessions():
        return ctx.db.rows(select(db.sessions).order_by(db.sessions.c.date.desc(), db.sessions.c.created_at.desc()))

    @app.post("/api/sessions", status_code=201)
    def create_session(payload: SessionCreate):
        row = dict(id=str(uuid4()), **payload.model_dump(mode="json", exclude={"plan_id"}), created_at=db.now())
        with ctx.db.engine.begin() as c:
            if not c.execute(select(db.athletes.c.id).where(db.athletes.c.id == payload.athlete_id)).first():
                raise HTTPException(404, "记录不存在")
            if payload.plan_id is not None:
                plan = c.execute(select(db.plans).where(db.plans.c.id == payload.plan_id).with_for_update()).mappings().first()
                if not plan:
                    raise HTTPException(404, "训练计划不存在")
                if plan["status"] != "planned" or plan["session_id"] is not None:
                    raise HTTPException(409, "训练计划已取消或已关联场次")
                if plan["athlete_id"] != payload.athlete_id:
                    raise HTTPException(409, "计划与场次的运动员必须一致")
            c.execute(db.sessions.insert().values(**row))
            if payload.plan_id is not None:
                linked = c.execute(update(db.plans).where(db.plans.c.id == payload.plan_id,
                    db.plans.c.status == "planned", db.plans.c.session_id.is_(None)).values(session_id=row["id"]))
                if linked.rowcount != 1:
                    raise HTTPException(409, "训练计划已取消或已关联场次")
        return row

    @app.put("/api/sessions/{id}")
    def edit_session(id: str, payload: Session):
        require(db.athletes, payload.athlete_id)
        with ctx.db.engine.begin() as c:
            if not c.execute(select(db.sessions.c.id).where(db.sessions.c.id == id).with_for_update()).first():
                raise HTTPException(404, "记录不存在")
            linked = c.execute(select(db.plans.c.athlete_id).where(db.plans.c.session_id == id)).scalar()
            if linked is not None and linked != payload.athlete_id:
                raise HTTPException(409, "已关联计划的场次不能更换运动员")
            c.execute(update(db.sessions).where(db.sessions.c.id == id).values(**payload.model_dump(mode="json")))
        return require(db.sessions, id)

    def plan_rows(athlete_id=None, id=None):
        stmt = select(db.plans, db.athletes.c.name.label("athlete_name")).join(db.athletes)
        if athlete_id is not None:
            stmt = stmt.where(db.plans.c.athlete_id == athlete_id)
        if id is not None:
            stmt = stmt.where(db.plans.c.id == id)
        rows = ctx.db.rows(stmt.order_by(db.plans.c.date.desc(), db.plans.c.created_at.desc()))
        for row in rows:
            if row["session_id"] is not None:
                row["status"] = "completed"
        return rows

    @app.get("/api/plans")
    def plans(athlete_id: str | None = None):
        if athlete_id is not None:
            require(db.athletes, athlete_id)
        return plan_rows(athlete_id=athlete_id)

    @app.post("/api/plans", status_code=201)
    def create_plan(payload: Plan):
        require(db.athletes, payload.athlete_id)
        row = dict(id=str(uuid4()), **payload.model_dump(mode="json"), status="planned", session_id=None, created_at=db.now())
        ctx.db.add(db.plans, row)
        return plan_rows(id=row["id"])[0]

    @app.patch("/api/plans/{id}")
    def edit_plan(id: str, payload: PlanStatus):
        with ctx.db.engine.begin() as c:
            row = c.execute(select(db.plans).where(db.plans.c.id == id).with_for_update()).mappings().first()
            if not row:
                raise HTTPException(404, "训练计划不存在")
            changed = c.execute(update(db.plans).where(db.plans.c.id == id, db.plans.c.session_id.is_(None))
                                .values(status=payload.status))
            if changed.rowcount != 1:
                raise HTTPException(409, "已关联场次的训练计划不能更改状态")
        return plan_rows(id=id)[0]

    def insight_filters(start, end, athlete_id, today):
        if athlete_id is not None:
            require(db.athletes, athlete_id)
        if start is None:
            stmt = select(func.min(db.sessions.c.date)).where(db.sessions.c.date <= (end or today).isoformat())
            if athlete_id is not None:
                stmt = stmt.where(db.sessions.c.athlete_id == athlete_id)
            with ctx.db.engine.connect() as c:
                earliest = c.execute(stmt).scalar()
            if earliest:
                start = date.fromisoformat(earliest)
        return planning.date_filters(start, end, athlete_id, today=today)

    @app.get("/api/insights")
    def insights(start: date | None = None, end: date | None = None, athlete_id: str | None = None):
        today = workspace_today(settings.timezone)
        filters = insight_filters(start, end, athlete_id, today)
        snapshot = planning.read_snapshot(ctx.db.engine, filters)
        return {**planning.summarize(snapshot, filters, today=today), "analysis": analytics.summarize(snapshot)}

    @app.get("/api/insights/analyses.csv")
    def export_analyses(start: date | None = None, end: date | None = None, athlete_id: str | None = None):
        filters = insight_filters(start, end, athlete_id, workspace_today(settings.timezone))
        content = analytics.export_csv(planning.read_snapshot(ctx.db.engine, filters))
        return Response(content, media_type="text/csv; charset=utf-8", headers={
            "Content-Disposition": f'attachment; filename="arena-analyses-{filters["start"]}-{filters["end"]}.csv"'})

    @app.get("/api/insights/export")
    def export_insights(start: date | None = None, end: date | None = None, athlete_id: str | None = None):
        today = workspace_today(settings.timezone)
        filters = insight_filters(start, end, athlete_id, today)
        content = planning.export_zip(planning.read_snapshot(ctx.db.engine, filters), filters,
                                      today=today, timezone_name=settings.timezone)
        return Response(content, media_type="application/zip", headers={
            "Content-Disposition": f'attachment; filename="arena-insights-{filters["start"]}-{filters["end"]}.zip"'})

    def video_rows(category=None, athlete_id=None, id=None):
        stmt = select(db.videos, db.athletes.c.name.label("athlete_name"), db.sessions.c.date.label("session_date"))\
            .join(db.sessions, db.videos.c.session_id == db.sessions.c.id).join(db.athletes, db.sessions.c.athlete_id == db.athletes.c.id)
        if category:
            stmt = stmt.where(db.videos.c.category == category)
        if athlete_id:
            stmt = stmt.where(db.athletes.c.id == athlete_id)
        if id:
            stmt = stmt.where(db.videos.c.id == id)
        rows = ctx.db.rows(stmt.order_by(db.videos.c.created_at.desc()))
        score_rows = ctx.db.rows(select(db.manual_scores.c.video_id, db.manual_scores.c.score, db.manual_scores.c.confirmed)
                                .where(db.manual_scores.c.video_id.in_([row["id"] for row in rows]))) if rows else []
        scores = {row["video_id"]: {"score": row["score"], "confirmed": row["confirmed"]} for row in score_rows}
        for video in rows:
            video["score"] = scores.get(video["id"])
            found = ctx.db.rows(select(db.jobs).where(db.jobs.c.video_id == video["id"]).order_by(db.jobs.c.created_at.desc()).limit(1))
            video["latest_job"] = assessed_jobs(found)[0] if found else None
            review = ctx.db.rows(select(db.reviews).where(db.reviews.c.video_id == video["id"]))
            video["review"] = review[0] if review else None
            video.pop("storage_key", None)
        return rows

    @app.get("/api/videos")
    def videos(category: VideoCategory | None = None, athlete_id: str | None = None):
        return video_rows(category, athlete_id)

    @app.get("/api/videos/{id}")
    def get_video(id: str):
        require(db.videos, id)
        return video_rows(id=id)[0]

    @app.post("/api/videos", status_code=201)
    def upload_video(session_id: Annotated[str, Form()], category: Annotated[VideoCategory, Form()],
                     authorized: Annotated[bool, Form()], file: Annotated[UploadFile, File()]):
        require(db.sessions, session_id)
        if not authorized:
            raise HTTPException(422, "请确认已获得视频中所有相关人员的上传和分析授权")
        name = Path((file.filename or "video").replace("\\", "/")).name[:200]
        if Path(name).suffix.lower() not in (".mp4", ".mov", ".webm", ".mkv", ".m4v"):
            raise HTTPException(422, "支持 MP4、MOV、WebM、MKV、M4V 视频")
        id = str(uuid4())
        key = f"videos/{id}/source{Path(name).suffix.lower()}"
        size, digest = 0, hashlib.sha256()
        try:
            with tempfile.NamedTemporaryFile() as tmp:
                while chunk := file.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_upload_bytes:
                        raise HTTPException(413, "视频超过100MB")
                    digest.update(chunk)
                    tmp.write(chunk)
                tmp.flush()
                if not size:
                    raise HTTPException(422, "视频文件为空")
                ctx.store.put(tmp.name, key, file.content_type or "application/octet-stream")
            ctx.db.add(db.videos, dict(id=id, session_id=session_id, category=category, filename=name,
                       storage_key=key, sha256=digest.hexdigest(), size_bytes=size, status="uploaded",
                       authorized_at=db.now(), created_at=db.now()))
        except Exception:
            ctx.store.delete_prefix(f"videos/{id}/")
            raise
        finally:
            file.file.close()
        return get_video(id)

    @app.patch("/api/videos/{id}/category")
    def categorize_video(id: str, payload: VideoCategoryInput):
        require(db.videos, id)
        with ctx.db.engine.begin() as c:
            c.execute(update(db.videos).where(db.videos.c.id == id).values(category=payload.category))
        return get_video(id)

    def stored_file(key, media_type, filename=None):
        if isinstance(ctx.store, LocalStore):
            path = ctx.store.path(key)
            if not path.is_file():
                raise HTTPException(404, "文件不存在")
            return FileResponse(path, media_type=media_type, filename=filename,
                                content_disposition_type="inline")
        return RedirectResponse(ctx.store.url(key), status_code=307)

    @app.get("/api/videos/{id}/media")
    def video_media(id: str):
        video = require(db.videos, id)
        # Unknown codecs remain private downloads; normalized playback is available after preprocessing.
        kind = "video/webm" if video["filename"].lower().endswith(".webm") else "video/mp4"
        return stored_file(video["storage_key"], kind, video["filename"])

    @app.post("/api/videos/{id}/jobs", status_code=202)
    def enqueue(id: str, payload: JobInput):
        if payload.backend == "sample" and not settings.sample_enabled:
            raise HTTPException(409, "合成样例模式已禁用")
        row = dict(id=str(uuid4()), video_id=id, backend=payload.backend, status="queued", stage="等待 Worker",
                   progress=0, params=payload.model_dump(exclude={"backend", "sample_acknowledged"}),
                   metadata=None, result=None, error=None, worker_token=None, lease_until=None,
                   created_at=db.now(), updated_at=db.now())
        try:
            with ctx.db.engine.begin() as c:
                # Serializes enqueue and delete on PostgreSQL; SQLite's unique active-job index covers competing submissions.
                stmt = select(db.videos.c.id).where(db.videos.c.id == id).with_for_update()
                if not c.execute(stmt).first():
                    raise HTTPException(404, "记录不存在")
                c.execute(update(db.videos).where(db.videos.c.id == id).values(status=db.videos.c.status))
                if payload.source_pose_job_id is not None:
                    source = c.execute(select(db.jobs).where(db.jobs.c.id == payload.source_pose_job_id)).mappings().first()
                    if not source or source["video_id"] != id or source["backend"] != "rtmpose_tracking" or source["status"] not in ("completed", "needs_review") or (source["result"] or {}).get("synthetic") is not False:
                        raise HTTPException(422, "来源必须是此视频已完成的人物轨迹分析")
                    if payload.backend == "pose3d" and payload.target_track_id is None:
                        row["params"]["target_track_id"] = (source["params"] or {}).get("target_track_id")
                    metadata = source["metadata"] or {}
                    offset, duration = metadata.get("time_offset"), metadata.get("duration")
                    if not isinstance(offset, (int, float)) or not isinstance(duration, (int, float)) or not math.isfinite(offset) or not math.isfinite(duration) or offset < 0 or duration <= 0:
                        raise HTTPException(422, "来源片段的时间信息无效")
                    row["params"].update(start_sec=offset, end_sec=offset + duration)
                    tracks = (source["result"] or {}).get("tracking", {}).get("tracks", [])
                    if row["params"].get("target_track_id") is not None and not any(track.get("track_id") == row["params"]["target_track_id"] for track in tracks):
                        raise HTTPException(422, "来源分析中没有此轨迹")
                c.execute(db.jobs.insert().values(**row))
        except IntegrityError as exc:
            raise HTTPException(409, "已有排队或运行中的分析任务") from exc
        return row

    @app.get("/api/jobs/{id}")
    def get_job(id: str):
        return assessed_jobs([require(db.jobs, id)])[0]

    @app.post("/api/jobs/{id}/cancel")
    def cancel_job(id: str):
        require(db.jobs, id)
        with ctx.db.engine.begin() as c:
            changed = c.execute(update(db.jobs).where(db.jobs.c.id == id, db.jobs.c.status.in_(ACTIVE))
                                .values(status="failed", stage="Cancelled", error="Cancelled",
                                        worker_token=None, lease_until=None, updated_at=db.now()))
            if not changed.rowcount:
                raise HTTPException(409, "任务已经结束")
        return get_job(id)

    @app.get("/api/jobs/{id}/assessment")
    def get_assessment(id: str):
        with ctx.db.engine.connect() as c:
            if ctx.db.engine.dialect.name == "postgresql":
                c = c.execution_options(isolation_level="REPEATABLE READ")
                c.begin()
            else:
                c.exec_driver_sql("BEGIN")
            if not c.execute(select(db.jobs.c.id).where(db.jobs.c.id == id)).first():
                raise HTTPException(404, "记录不存在")
            current = c.execute(select(db.analysis_assessments).where(db.analysis_assessments.c.job_id == id)).mappings().first()
            history = c.execute(select(db.analysis_assessment_history).where(db.analysis_assessment_history.c.job_id == id)
                                .order_by(db.analysis_assessment_history.c.created_at, db.analysis_assessment_history.c.id)).mappings().all()
            return {"current": dict(current) if current else None, "history": [dict(row) for row in history]}

    @app.put("/api/jobs/{id}/assessment")
    def save_assessment(id: str, payload: AssessmentInput, request: Request):
        with ctx.db.engine.begin() as c:
            # Serialize SQLite saves without writing to the immutable source job.
            if ctx.db.engine.dialect.name == "sqlite":
                c.exec_driver_sql("BEGIN IMMEDIATE")
            job = c.execute(select(db.jobs).where(db.jobs.c.id == id).with_for_update()).mappings().first()
            if not job:
                raise HTTPException(404, "记录不存在")
            result = analytics.mapping(job["result"])
            if (job["backend"] not in (*analytics.POSE_BACKENDS, "sam2") or job["status"] not in analytics.TERMINAL_ANALYSES
                    or result.get("synthetic") is not False):
                raise HTTPException(409, "仅可审核已产出结果的真实姿态或人物分割分析")
            if payload.decision == "accepted":
                error = analytics.acceptance_error(job, payload.subject_role)
                if error:
                    raise HTTPException(409, error)
            current = c.execute(select(db.analysis_assessments).where(db.analysis_assessments.c.job_id == id)).mappings().first()
            stamp = db.now()
            record = dict(id=current["id"] if current else str(uuid4()), job_id=id, **payload.model_dump(),
                          reviewer=request.state.user["username"], updated_at=stamp)
            if current:
                c.execute(update(db.analysis_assessments).where(db.analysis_assessments.c.id == current["id"]).values(**record))
            else:
                c.execute(db.analysis_assessments.insert().values(**record))
            c.execute(db.analysis_assessment_history.insert().values(id=str(uuid4()), job_id=id, snapshot=record, created_at=stamp))
        return record

    @app.get("/api/jobs/{id}/media")
    def job_media(id: str):
        job = require(db.jobs, id)
        if not job["metadata"]:
            raise HTTPException(409, "预处理尚未完成")
        return stored_file(f"videos/{job['video_id']}/jobs/{id}/normalized.mp4", "video/mp4")

    @app.get("/api/jobs/{id}/pose")
    def job_pose(id: str):
        job = require(db.jobs, id)
        if not job["result"] or job["backend"] not in ("sample", "rtmpose", "rtmpose_tracking"):
            raise HTTPException(409, "此任务尚无二维关键点结果")
        key = f"videos/{job['video_id']}/jobs/{id}/pose.json"
        if isinstance(ctx.store, LocalStore):
            return stored_file(key, "application/json")
        # Proxy JSON so the private bucket needs no cross-origin CORS policy.
        with tempfile.NamedTemporaryFile() as tmp:
            ctx.store.download(key, tmp.name)
            return JSONResponse(json.loads(Path(tmp.name).read_text(encoding="utf-8")))

    @app.get("/api/jobs/{id}/pose3d")
    def job_pose3d(id: str):
        job = require(db.jobs, id)
        if not job["result"] or job["backend"] != "pose3d" or job["result"].get("kind") != "pose3d":
            raise HTTPException(409, "此任务尚无三维骨架结果")
        key = f"videos/{job['video_id']}/jobs/{id}/pose3d.json"
        if isinstance(ctx.store, LocalStore):
            return stored_file(key, "application/json")
        with tempfile.NamedTemporaryFile() as tmp:
            ctx.store.download(key, tmp.name)
            return JSONResponse(json.loads(Path(tmp.name).read_text(encoding="utf-8")))

    @app.get("/api/jobs/{id}/segmentation")
    def job_segmentation(id: str):
        job = require(db.jobs, id)
        if not job["result"] or job["backend"] != "sam2" or job["result"].get("kind") != "segmentation":
            raise HTTPException(409, "此任务尚无人物分割结果")
        key = f"videos/{job['video_id']}/jobs/{id}/segmentation.json"
        if isinstance(ctx.store, LocalStore):
            return stored_file(key, "application/json")
        with tempfile.NamedTemporaryFile() as tmp:
            ctx.store.download(key, tmp.name)
            return JSONResponse(json.loads(Path(tmp.name).read_text(encoding="utf-8")))

    @app.delete("/api/videos/{id}", status_code=204)
    def delete_video(id: str):
        with ctx.db.engine.begin() as c:
            row = c.execute(select(db.videos.c.id).where(db.videos.c.id == id).with_for_update()).first()
            if not row:
                raise HTTPException(404, "记录不存在")
            c.execute(update(db.videos).where(db.videos.c.id == id).values(status="deleting"))
            if c.execute(select(db.jobs.c.id).where(db.jobs.c.video_id == id, db.jobs.c.status.in_(ACTIVE))).first():
                raise HTTPException(409, "任务排队或运行中，请结束后删除")
            # Storage deletion must succeed before the database no longer knows what to delete. Retrying is idempotent.
            ctx.store.delete_prefix(f"videos/{id}/")
            c.execute(delete(db.videos).where(db.videos.c.id == id))
        return Response(status_code=204)

    @app.get("/api/videos/{id}/events")
    def list_events(id: str):
        require(db.videos, id)
        return ctx.db.rows(select(db.events).where(db.events.c.video_id == id).order_by(db.events.c.start_sec))

    @app.post("/api/videos/{id}/events", status_code=201)
    def add_event(id: str, payload: EventInput, request: Request):
        require(db.videos, id)
        metadata_rows = ctx.db.rows(select(db.jobs.c.metadata).where(db.jobs.c.video_id == id).order_by(db.jobs.c.created_at.desc()))
        known = next((r["metadata"] for r in metadata_rows if isinstance(r["metadata"], dict)
                      and isinstance(r["metadata"].get("source_duration"), (int, float))), None)
        if known is None:
            raise HTTPException(409, "请先完成视频预处理后标注；无需安装分析模型")
        if payload.end_sec > known["source_duration"] + 0.05:
            raise HTTPException(422, "事件超出原视频时长")
        if payload.source_job_id:
            source = ctx.db.get(db.jobs, payload.source_job_id)
            if not source or source["video_id"] != id or source["backend"] not in ("action", "fsw") or source["status"] not in ("completed", "needs_review") or (source["result"] or {}).get("kind") != "recognition" or (source["result"] or {}).get("synthetic") is not False:
                raise HTTPException(422, "动作来源须为此视频已完成的真实识别任务")
            metadata = source["metadata"] or {}
            duration, offset = metadata.get("duration"), metadata.get("time_offset")
            if not analytics.finite(duration) or not analytics.finite(offset) or duration <= 0:
                raise HTTPException(409, "动作来源缺少有效的时间信息")
            if payload.start_sec < offset - .05 or payload.end_sec > offset + duration + .05:
                raise HTTPException(422, "标注超出来源分析片段的时间范围")
        return ctx.db.add(db.events, dict(id=str(uuid4()), video_id=id, **payload.model_dump(),
                          created_by=request.state.user["username"], created_at=db.now()))

    @app.delete("/api/events/{id}", status_code=204)
    def remove_event(id: str):
        require(db.events, id)
        with ctx.db.engine.begin() as c:
            c.execute(delete(db.events).where(db.events.c.id == id))
        return Response(status_code=204)

    @app.post("/api/videos/{id}/review-drafts", status_code=201)
    def draft_review(id: str, payload: DraftInput):
        require(db.videos, id)
        job = require(db.jobs, payload.job_id)
        if job["video_id"] != id or not job["result"]:
            raise HTTPException(409, "请选择属于当前视频且已有结果的分析任务")
        facts = facts_for(job)
        if payload.provider == "llm" and settings.review_model_path:
            saved = ctx.db.rows(select(db.reviews).where(db.reviews.c.video_id == id, db.reviews.c.confirmed.is_(True)))
            if saved:
                facts["recorded_review"] = {"source": "saved_review", "observations": saved[0]["observations"],
                                            "next_action": saved[0]["next_action"]}
        try:
            if payload.provider == "rules":
                text = rules_draft(facts, language=payload.language)
            elif settings.review_model_path:
                from .local_review import generate_selection
                selection = generate_selection(facts, payload.language, settings)
                text = llm_draft(facts, settings, language=payload.language, selection=selection)
                facts = {**facts, "language_output": {"method": "extractive-source-v1", "selection": selection}}
            else:
                text = llm_draft(facts, settings, language=payload.language)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(409, str(exc)) from exc
        except (httpx.HTTPError, KeyError, IndexError, json.JSONDecodeError) as exc:
            log.warning("LLM review request failed (%s)", type(exc).__name__)
            raise HTTPException(502, "语言模型调用失败，请检查配置、余额或稍后重试") from exc
        return ctx.db.add(db.drafts, dict(id=str(uuid4()), video_id=id, job_id=job["id"], provider=payload.provider,
                          model=("Qwen/Qwen2.5-1.5B-Instruct" if settings.review_model_path else settings.llm_model) if payload.provider == "llm" else "evidence-rules-v1",
                          synthetic=job["result"]["synthetic"], text=text, facts=facts, created_at=db.now()))

    @app.put("/api/videos/{id}/review")
    def save_review(id: str, payload: ReviewInput, request: Request):
        require(db.videos, id)
        if payload.draft_id and require(db.drafts, payload.draft_id)["video_id"] != id:
            raise HTTPException(422, "草稿不属于此视频")
        if payload.confirmed and not payload.observations.strip():
            raise HTTPException(422, "确认复盘需要填写观察")
        with ctx.db.engine.begin() as c:
            current = c.execute(select(db.reviews).where(db.reviews.c.video_id == id)).mappings().first()
            record = dict(id=current["id"] if current else str(uuid4()), video_id=id, **payload.model_dump(),
                          confirmed_by=request.state.user["username"] if payload.confirmed else None, updated_at=db.now())
            if current:
                c.execute(update(db.reviews).where(db.reviews.c.id == current["id"]).values(**record))
            else:
                c.execute(db.reviews.insert().values(**record))
            c.execute(db.review_history.insert().values(id=str(uuid4()), video_id=id, snapshot=record, created_at=db.now()))
        return record

    @app.get("/api/videos/{id}/score")
    def get_score(id: str):
        require(db.videos, id)
        # Read the current value and its snapshots from one transaction.
        with ctx.db.engine.connect() as c:
            if ctx.db.engine.dialect.name == "sqlite":
                c.exec_driver_sql("BEGIN")
            current = c.execute(select(db.manual_scores).where(db.manual_scores.c.video_id == id)).mappings().first()
            history = c.execute(select(db.score_history).where(db.score_history.c.video_id == id)
                                .order_by(db.score_history.c.created_at, db.score_history.c.id)).mappings().all()
            return {"current": dict(current) if current else None, "history": [dict(row) for row in history]}

    @app.put("/api/videos/{id}/score")
    def save_score(id: str, payload: ScoreInput, request: Request):
        with ctx.db.engine.begin() as c:
            video = c.execute(select(db.videos.c.id).where(db.videos.c.id == id).with_for_update()).first()
            if not video:
                raise HTTPException(404, "记录不存在")
            # Acquire SQLite's write lock before selecting the current score; PostgreSQL locks the video row above.
            c.execute(update(db.videos).where(db.videos.c.id == id).values(status=db.videos.c.status))
            current = c.execute(select(db.manual_scores).where(db.manual_scores.c.video_id == id)).mappings().first()
            stamp = db.now()
            record = dict(id=current["id"] if current else str(uuid4()), video_id=id, **payload.model_dump(),
                          assessor=request.state.user["username"], rubric_version=db.MANUAL_SCORE_RUBRIC, updated_at=stamp)
            if current:
                c.execute(update(db.manual_scores).where(db.manual_scores.c.id == current["id"]).values(**record))
            else:
                c.execute(db.manual_scores.insert().values(**record))
            c.execute(db.score_history.insert().values(id=str(uuid4()), video_id=id, snapshot=record, created_at=stamp))
        return record

    @app.get("/api/videos/{id}/report")
    def report(id: str):
        video = get_video(id)
        score = get_score(id)
        return {"schema_version": 1, "exported_at": db.now(), "video": video,
                "jobs": assessed_jobs(ctx.db.rows(select(db.jobs).where(db.jobs.c.video_id == id).order_by(db.jobs.c.created_at.desc()))),
                "drafts": ctx.db.rows(select(db.drafts).where(db.drafts.c.video_id == id).order_by(db.drafts.c.created_at.desc())),
                "review": video["review"], "events": list_events(id),
                "score": score["current"], "score_history": score["history"],
                "assessment_history": ctx.db.rows(select(db.analysis_assessment_history).join(db.jobs)
                    .where(db.jobs.c.video_id == id).order_by(db.analysis_assessment_history.c.created_at, db.analysis_assessment_history.c.id)),
                "review_history": ctx.db.rows(select(db.review_history).where(db.review_history.c.video_id == id).order_by(db.review_history.c.created_at))}

    @app.get("/api/athletes/{id}/profile")
    def profile(id: str):
        athlete = require(db.athletes, id)
        snapshot = planning.read_snapshot(ctx.db.engine,
                    {"start": "0001-01-01", "end": "9999-12-31", "athlete_id": id})
        rows = snapshot["sessions"]
        trends = []
        for entry in snapshot["measurements"]:
            r = entry["result"]
            trends.append(dict(date=entry["date"], category=entry["category"], job_id=entry["job_id"],
                               method_version=r.get("method_version"), sample_fps=r.get("sample_fps"), roi=r.get("roi"),
                               metrics=r["metrics"], model_sha256=r.get("model_sha256", {})))
        return {"athlete": athlete, "sessions": rows, "video_count": len(snapshot["videos"]),
                "recorded_minutes": sum(s["duration_min"] for s in rows),
                "recorded_load": sum(s["duration_min"] * s["rpe"] for s in rows if s["rpe"] is not None)
                    if any(s["rpe"] is not None for s in rows) else None,
                "load_unit": "RPE·分钟（自填负荷代理）", "trends": sorted(trends, key=lambda t: t["date"]),
                "analysis": analytics.summarize(snapshot)}

    @app.get("/api/dashboard")
    def dashboard():
        snapshot = planning.read_snapshot(ctx.db.engine,
                    {"start": "0001-01-01", "end": "9999-12-31", "athlete_id": None})
        records, session_rows = snapshot["videos"], snapshot["sessions"]
        return {"athlete_count": len(athletes()), "session_count": len(session_rows), "video_count": len(records),
                "pending_review_count": len(records) - len(snapshot["reviewed"]),
                "recorded_minutes": sum(s["duration_min"] for s in session_rows),
                "category_counts": {c: sum(v["category"] == c for v in records) for c in ("stability", "footwork", "attack", "defense", "mixed")},
                "recent_jobs": assessed_jobs(ctx.db.rows(select(db.jobs).order_by(db.jobs.c.created_at.desc()).limit(8))),
                "review_scores": planning.summarize(snapshot,
                    {"start": "0001-01-01", "end": "9999-12-31", "athlete_id": None},
                    today=workspace_today(settings.timezone))["manual_scores"],
                "analysis": analytics.summarize(snapshot)}

    frontend = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if frontend.is_dir():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    else:
        @app.get("/")
        def no_frontend():
            return JSONResponse({"detail": "请先在 frontend 执行 npm ci && npm run build，API文档位于 /docs"}, status_code=503)
    return app


def main():
    import uvicorn
    uvicorn.run(create_app(), host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
