"""Outgoing Cloudflare worker. All computation and retry data stay in a private outbox.

Run ``python -m arena.remote_worker`` with ARENA_CLOUD_URL and ARENA_WORKER_TOKEN.
Each claim computes in its own SQLite database. Results-only claims read the local
video catalog without modifying it and retain media in the local object store.
"""
import argparse
import copy
from contextlib import closing
from dataclasses import replace
import fcntl
import hashlib
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import sqlite3
import stat
import threading
import time
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx
from sqlalchemy import update
from sqlalchemy.engine import make_url

from . import db
from .backends import model_status
from .config import Settings
from .storage import LocalStore
from .worker import Context, LeaseLost, run_once

log = logging.getLogger(__name__)
CHUNK_BYTES = 8 * 1024 * 1024
INLINE_RESULT_BYTES = 512 * 1024
MAX_SUMMARY_BYTES = 1536 * 1024
MAX_RESULT_BYTES = 16 * 1024 * 1024
ARTIFACTS = {"normalized.mp4": "video/mp4", "pose.json": "application/json",
             "pose3d.json": "application/json", "segmentation.json": "application/json", "result.json": "application/json"}
DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / "data" / "cloudflare-worker.json"


class StaleLease(LeaseLost):
    """The server revoked or expired the claim; private results must not publish."""


class LocalSourceUnavailable(ValueError):
    """A results-only claim requires matching media on this computer."""


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def save_json(path, value):
    """Atomic private journal; a crash leaves either complete version readable."""
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as out:
        json.dump(value, out, ensure_ascii=False, allow_nan=False)
        out.flush()
        os.fsync(out.fileno())
    temporary.replace(path)


def validate_url(url):
    parsed = urlsplit(url)
    try:
        loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback)
            or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("Cloud URL must use HTTPS (HTTP is allowed only on loopback)")
    return loopback


def private_text(path):
    path = Path(path)
    if os.name == "posix" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError(f"Private worker configuration must have mode 600: {path}")
    return path.read_text(encoding="utf-8")


def load_config(path):
    path = Path(path)
    if not path.exists():
        return {}
    config = json.loads(private_text(path))
    if not isinstance(config, dict) or any(key not in {"url", "token"} for key in config):
        raise ValueError("Worker config must contain only url and token")
    if any(not isinstance(value, str) for value in config.values()):
        raise ValueError("Worker config url and token must be strings")
    return config


def connection_config(path, url=None):
    config = load_config(path)
    return (url or os.getenv("ARENA_CLOUD_URL") or config.get("url", ""),
            os.getenv("ARENA_WORKER_TOKEN") or config.get("token", ""))


def configure(path, url):
    """Prepare private local pairing files without contacting any service."""
    validate_url(url)
    path = Path(path).resolve()
    existing = load_config(path)
    token_path = path.parent / "cloudflare-worker-token.txt"
    stored = private_text(token_path).strip() if token_path.exists() else ""
    if token_path.exists() and not stored:
        raise ValueError("Existing worker token file is empty; neither pairing file was overwritten")
    token = existing.get("token") or stored or secrets.token_urlsafe(32)
    if not token or any(char in token for char in "\r\n"):
        raise ValueError("Worker token is invalid")
    if stored and stored != token:
        raise ValueError("Existing worker config and token file disagree; neither secret was overwritten")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not token_path.exists():
        descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as out:
            out.write(token + "\n")
    save_json(path, {"url": url.rstrip("/"), "token": token})
    return path, token_path


def discover_settings(settings=None, root=None):
    """Use the same installed model locations as scripts/dev.py; env wins."""
    settings = settings or Settings()
    models = (Path(root) if root else Path(__file__).resolve().parents[1]) / "models"
    candidates = {
        "detector_path": models / "rtmpose" / "detector.onnx",
        "pose_path": models / "rtmpose" / "pose.onnx",
        "sam2_path": models / "sam2",
        "review_model_path": models / "review",
        "pose3d_model_path": models / "pose3d",
        "action_model_path": models / "vision-action",
    }
    updates = {}
    for name, path in candidates.items():
        marker = path / ({"sam2_path": "manifest.json", "pose3d_model_path": "best_epoch.bin",
                          "action_model_path": "manifest.json"}.get(name, "")) if path.is_dir() else path
        if not getattr(settings, name) and marker.exists():
            updates[name] = str(path)
    return replace(settings, **updates)


class RemoteWorker:
    def __init__(self, url, token, outbox, *, settings=None, worker_id=None,
                 heartbeat_interval=30, timeout=30, results_only=False):
        loopback = validate_url(url)
        if not token or any(c in token for c in "\r\n"):
            raise ValueError("ARENA_WORKER_TOKEN is required")
        self.outbox = Path(outbox).resolve()
        self.outbox.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.outbox.chmod(0o700)
        self._lock = (self.outbox / "worker.lock").open("a")
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._lock.close()
            raise ValueError("Another worker is already using this private outbox") from None
        binding = self.outbox / "endpoint"
        endpoint = url.rstrip("/")
        if binding.exists() and binding.read_text() != endpoint:
            self._lock.close()
            raise ValueError("Private outbox belongs to another Cloud URL; use a separate outbox")
        if not binding.exists():
            binding.write_text(endpoint)
        identity = self.outbox / "worker-id"
        if not identity.exists():
            descriptor = os.open(identity, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as out:
                out.write(worker_id or str(uuid4()))
        self.worker_id = identity.read_text().strip()
        self.settings = discover_settings(settings)
        self.results_only = results_only
        if results_only and not self.settings.review_model_path and self.settings.llm_base_url:
            host = urlsplit(self.settings.llm_base_url).hostname or ''
            try: local_language_server = ipaddress.ip_address(host).is_loopback
            except ValueError: local_language_server = host == 'localhost'
            if not local_language_server:
                # A local-results deployment must not silently invoke a paid remote language API.
                self.settings = replace(self.settings, llm_base_url='', llm_key='', llm_model='')
        self.heartbeat_interval = heartbeat_interval
        self.models, self.last_advertised = None, 0
        self.client = httpx.Client(base_url=url.rstrip("/") + "/api/worker/", timeout=timeout,
                                   follow_redirects=False, trust_env=not loopback,
                                   headers={"Authorization": f"Bearer {token}"})

    def close(self):
        self.client.close()
        self._lock.close()

    def request(self, method, path, **kwargs):
        response = self.client.request(method, path, **kwargs)
        if response.status_code in (404, 409, 410, 412):
            raise StaleLease(f"Worker lease rejected ({response.status_code})")
        response.raise_for_status()
        # Redirects must never move the bearer credential or source to another host.
        if response.is_redirect:
            raise ValueError("Worker API redirects are forbidden")
        return response

    def capabilities(self):
        models = model_status(self.settings)
        # The cloud installation intentionally disables synthetic sample jobs.
        models["sample"] = {"ready": False, "synthetic": True, "reason": "Cloud sample mode is disabled"}
        return models

    def advertise(self):
        models = self.capabilities()
        self.request("POST", "heartbeat", json={"worker_id": self.worker_id, "models": models})
        self.models, self.last_advertised = models, time.monotonic()
        backends = [name for name, state in models.items() if state.get("ready")
                    and name not in {"llm", "preprocessing", "tracking", "sample"}]
        if models["preprocessing"]["ready"]:
            backends.append("preprocess")
        backends.append("review_draft")  # Rules drafts require no language-model weights.
        return backends

    @staticmethod
    def job_path(claim):
        return "jobs/" + quote(claim["job"]["id"], safe="")

    def heartbeat(self, claim, local=None):
        payload = {"worker_token": claim["job"]["worker_token"]}
        payload.update(stage=claim["job"]["stage"], progress=min(99, claim["job"]["progress"]))
        if local:
            row = local.db.get(db.jobs, claim["job"]["id"])
            if row:
                payload.update(stage=row["stage"], progress=min(99, row["progress"]))
        response = self.request("POST", self.job_path(claim) + "/heartbeat", json=payload)
        data = response.json() if response.content else {}
        claim["job"]["lease_until"] = data.get("lease_until", int(time.time()) + 180)
        if time.monotonic() - self.last_advertised >= 30:
            self.models = self.models or self.capabilities()
            self.request("POST", "heartbeat", json={"worker_id": self.worker_id, "models": self.models})
            self.last_advertised = time.monotonic()

    def download(self, claim, artifact, destination, expected):
        """Stream and check both size and digest before making source bytes available."""
        partial = Path(destination).with_suffix(".download")
        expected = expected or {}
        try:
            with self.client.stream("GET", self.job_path(claim) + "/source", params={"artifact": artifact},
                                    headers={"X-Worker-Lease": claim["job"]["worker_token"]}) as response:
                if response.status_code in (404, 409, 410, 412):
                    raise StaleLease("Source lease rejected")
                response.raise_for_status()
                checksum = expected.get("sha256") or response.headers.get("X-Content-SHA256")
                size = expected.get("size_bytes")
                if size is None:
                    size = response.headers.get("Content-Length")
                establishing = artifact == "source" and claim["video"].get("sha256") == ""
                if (not establishing and (not isinstance(checksum, str) or len(checksum) != 64)) or size is None:
                    raise ValueError("Source integrity descriptor is missing")
                size = int(size)
                if size < 0 or size > 512 * 1024 * 1024:
                    raise ValueError("Source exceeds download limit")
                count, sha = 0, hashlib.sha256()
                with partial.open("wb") as out:
                    for chunk in response.iter_bytes(1024 * 1024):
                        count += len(chunk)
                        if count > size:
                            raise ValueError("Source size mismatch")
                        sha.update(chunk)
                        out.write(chunk)
                if count != size or (checksum and sha.hexdigest() != checksum):
                    raise ValueError("Source checksum mismatch")
            partial.replace(destination)
            return sha.hexdigest()
        finally:
            partial.unlink(missing_ok=True)

    def local_store(self):
        root = self.settings.data_dir / "objects"
        if not root.is_dir():
            raise LocalSourceUnavailable("Local video storage is unavailable on this computer")
        return LocalStore(root)

    def local_video(self, claim):
        """Read the original SQLite catalog without initialization, migrations or writes."""
        url = make_url(self.settings.database_url or f"sqlite:///{self.settings.data_dir / 'arena.db'}")
        if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
            raise LocalSourceUnavailable("Results-only inference requires a local SQLite video catalog")
        try:
            with closing(sqlite3.connect(Path(url.database).resolve().as_uri() + "?mode=ro", uri=True)) as connection:
                connection.row_factory = sqlite3.Row
                row = connection.execute("SELECT id, sha256, size_bytes, storage_key FROM videos WHERE id = ?",
                                         (claim["video"]["id"],)).fetchone()
        except sqlite3.Error as exc:
            raise LocalSourceUnavailable("Local video catalog is unavailable") from exc
        video = claim["video"]
        if (not row or not re.fullmatch(r"[0-9a-f]{64}", video.get("sha256", ""))
                or row["sha256"] != video["sha256"] or row["size_bytes"] != video["size_bytes"]):
            raise LocalSourceUnavailable("Local video id, checksum or size does not match the cloud task")
        try:
            path = self.local_store().path(row["storage_key"])
        except ValueError as exc:
            raise LocalSourceUnavailable("Local video storage path is invalid") from exc
        if not path.is_file():
            raise LocalSourceUnavailable("Local source video is missing; restore the video on this computer")
        return path

    @staticmethod
    def copy_checked(source, destination, expected):
        """Verify the copied bytes too, so a changing source cannot reach inference."""
        try:
            shutil.copyfile(source, destination)
        except FileNotFoundError as exc:
            raise LocalSourceUnavailable("Local source video or cached artifact is missing") from exc
        checksum = digest(destination)
        if (expected.get("size_bytes") is not None and destination.stat().st_size != expected["size_bytes"]
                or expected.get("sha256") and checksum != expected["sha256"]):
            destination.unlink(missing_ok=True)
            raise LocalSourceUnavailable("Local source checksum or size mismatch")
        return checksum

    def prepare_local_sources(self, claim, local, state):
        source = self.local_video(claim)
        source_job = claim.get("source_job")
        if not claim["job"].get("params", {}).get("source_pose_job_id"):
            state["source_sha256"] = self.copy_checked(source, local.store.path("source"), claim["video"])
            return
        # Even a cached pose must belong to this locally verified source video.
        if source.stat().st_size != claim["video"]["size_bytes"] or digest(source) != claim["video"]["sha256"]:
            raise LocalSourceUnavailable("Local source checksum or size mismatch")
        prefix = f"videos/{claim['video']['id']}/jobs/{source_job['id']}/"
        store = self.local_store()
        for name in ("normalized.mp4", "pose.json"):
            destination = local.store.path(prefix + name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            cached = store.path(prefix + name)
            descriptor = source_job.get("artifacts", {}).get(name, {})
            if cached.is_file():
                self.copy_checked(cached, destination, descriptor)
            elif name == "pose.json":
                self.download(claim, name, destination, descriptor)
            else:
                raise LocalSourceUnavailable("Local normalized video is missing; rerun its source analysis on this computer")

    def retain_local_artifacts(self, folder, state):
        """Atomically add computed files, preserving any existing local artifact."""
        if state["complete"]["status"] not in ("completed", "needs_review"):
            return
        claim = state["claim"]
        prefix = f"videos/{claim['video']['id']}/jobs/{claim['job']['id']}/"
        store = None
        for name in ARTIFACTS:
            source = folder / "objects" / prefix / name
            if not source.is_file():
                continue
            store = store or self.local_store()
            destination = store.path(prefix + name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name("." + name + "." + uuid4().hex + ".tmp")
            try:
                self.copy_checked(source, temporary, {"sha256": digest(source), "size_bytes": source.stat().st_size})
                try:
                    os.link(temporary, destination)
                except FileExistsError:
                    if not destination.is_file() or digest(destination) != digest(temporary):
                        raise ValueError("Existing local artifact differs; refusing to overwrite it") from None
            finally:
                temporary.unlink(missing_ok=True)

    def local_context(self, folder, claim):
        """Only the claim's isolated database is initialized, never Settings.database_url."""
        settings = replace(self.settings, data_dir=folder, database_url=f"sqlite:///{folder / 'task.db'}",
                           bucket="", production=False, admin_password=secrets.token_urlsafe(32))
        database = db.Database(settings)
        db.meta.create_all(database.engine)
        store = LocalStore(folder / "objects")
        stamp, video = db.now(), claim["video"]
        job = claim["job"]
        # Minimal private parent rows satisfy the existing relational schema.
        database.add(db.athletes, dict(id="task-athlete", name="Remote task", level="", created_at=stamp))
        database.add(db.sessions, dict(id="task-session", athlete_id="task-athlete", date="2000-01-01",
                                      objective="Remote task", duration_min=1, rpe=None, notes="", created_at=stamp))
        database.add(db.videos, {**{key: video[key] for key in ("id", "sha256", "size_bytes")},
                                "session_id": "task-session", "category": video.get("category", "stability"),
                                "filename": "source", "storage_key": "source", "status": "uploaded",
                                "authorized_at": stamp, "created_at": stamp})
        fields = {column.name for column in db.jobs.columns}
        source_job = claim.get("source_job")
        if job.get("params", {}).get("source_pose_job_id"):
            if not source_job or source_job["id"] != job["params"]["source_pose_job_id"]:
                raise ValueError("Source pose task is missing")
            database.add(db.jobs, {key: value for key, value in source_job.items() if key in fields})
        database.add(db.jobs, {**{key: value for key, value in job.items() if key in fields},
                               "status": "queued", "worker_token": None, "lease_until": None,
                               "created_at": job.get("created_at", stamp), "updated_at": stamp})
        return Context(settings, database, store)

    def draft(self, claim):
        from .review import facts_for, llm_draft, rules_draft
        job, source = claim["job"], claim.get("source_job")
        params = job["params"]
        if (not source or source["id"] != params["job_id"] or source["video_id"] != job["video_id"]
                or not source.get("result")):
            raise ValueError("Review source task does not match")
        provider, language = params.get("provider", "rules"), params.get("language", "zh")
        if language not in ("zh", "en") or provider not in ("rules", "llm"):
            raise ValueError("Invalid review provider or language")
        facts = facts_for(source)
        saved = claim.get("review")
        if provider == "llm" and self.settings.review_model_path and saved and saved.get("confirmed"):
            facts["recorded_review"] = {"source": "saved_review", "observations": saved["observations"],
                                        "next_action": saved["next_action"]}
        if provider == "rules":
            text, model = rules_draft(facts, language), "evidence-rules-v1"
        elif self.settings.review_model_path:
            from .local_review import generate_selection, MODEL_ID
            selection = generate_selection(facts, language, self.settings)
            text = llm_draft(facts, self.settings, language, selection=selection)
            facts["language_output"] = {"method": "extractive-source-v1", "selection": selection}
            model = MODEL_ID
        else:
            text, model = llm_draft(facts, self.settings, language), self.settings.llm_model
        return dict(id=str(uuid4()), video_id=job["video_id"], job_id=source["id"], provider=provider,
                    model=model, synthetic=source["result"]["synthetic"], text=text, facts=facts, created_at=db.now())

    def process(self, folder, state, stop):
        claim = state["claim"]
        if time.time() >= claim["job"]["lease_until"]:
            raise StaleLease("Task lease expired before processing")
        local = None
        lost, finished = threading.Event(), threading.Event()

        def pulse():
            while not finished.wait(self.heartbeat_interval):
                if stop.is_set():
                    lost.set()
                try:
                    if not lost.is_set():
                        self.heartbeat(claim, local)
                except StaleLease:
                    lost.set()
                except httpx.HTTPError:
                    log.warning("Cloud heartbeat unavailable; private processing lease expires at %s",
                                claim["job"]["lease_until"])
                if finished.is_set():
                    return
                if time.time() >= claim["job"]["lease_until"]:
                    lost.set()
                if lost.is_set():
                    if local:
                        with local.db.engine.begin() as connection:
                            connection.execute(update(db.jobs).where(db.jobs.c.id == claim["job"]["id"])
                                               .values(status="failed", worker_token=None, lease_until=None))
                    return

        thread = threading.Thread(target=pulse, daemon=True)
        thread.start()
        try:
            if claim["job"]["backend"] == "review_draft":
                draft = self.draft(claim)
                complete = dict(status="completed", stage="复盘草稿已生成", metadata=None, result=None,
                                error=None, draft=draft)
            else:
                # A process crash before journalling completion safely recomputes privately.
                (folder / "task.db").unlink(missing_ok=True)
                for suffix in ("-wal", "-shm"):
                    Path(str(folder / "task.db") + suffix).unlink(missing_ok=True)
                local = self.local_context(folder, claim)
                source_job = claim.get("source_job")
                if claim.get("storage_mode") == "results-only":
                    self.prepare_local_sources(claim, local, state)
                elif claim["job"].get("params", {}).get("source_pose_job_id"):
                    prefix = f"videos/{claim['video']['id']}/jobs/{source_job['id']}/"
                    for name in ("normalized.mp4", "pose.json"):
                        destination = local.store.path(prefix + name)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        self.download(claim, name, destination, source_job.get("artifacts", {}).get(name))
                else:
                    state["source_sha256"] = self.download(claim, "source", local.store.path("source"), claim["video"])
                if lost.is_set() or stop.is_set():
                    raise StaleLease("Task interrupted before inference")
                run_once(local)
                row = local.db.get(db.jobs, claim["job"]["id"])
                complete = {key: row.get(key) for key in ("status", "stage", "metadata", "result", "error")}
            if lost.is_set() or stop.is_set() or time.time() >= claim["job"]["lease_until"]:
                raise StaleLease("Task interrupted; no result will publish")
            complete["worker_token"] = claim["job"]["worker_token"]
            source_sha256 = state.get("source_sha256") or claim["video"].get("sha256")
            if source_sha256:
                complete["source_sha256"] = source_sha256
            state["complete"] = complete
            claim["job"].update(stage="同步分析结果", progress=99)
            state["artifacts"] = {}
            prefix = folder / "objects" / "videos" / claim["video"]["id"] / "jobs" / claim["job"]["id"]
            for name, content_type in ARTIFACTS.items():
                if claim.get("storage_mode") == "results-only" and content_type != "application/json":
                    continue
                path = prefix / name
                if path.is_file():
                    state["artifacts"][name] = dict(size_bytes=path.stat().st_size, sha256=digest(path),
                                                    content_type=content_type)
            save_json(folder / "state.json", state)
        finally:
            finished.set()
            thread.join(timeout=1)
            if local:
                local.db.engine.dispose()

    def prepare_result(self, folder, state):
        """Keep dense per-frame results in result storage, with bounded summaries."""
        complete = state["complete"]
        result = complete.get("result")
        if not result or complete.get("result_artifact"):
            return
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
        if len(encoded) <= INLINE_RESULT_BYTES:
            return
        if len(encoded) > MAX_RESULT_BYTES:
            raise ValueError("Full analysis result exceeds the 16MiB synchronization limit")
        compact = copy.deepcopy(result)
        kinematics = compact.get("kinematics")
        if isinstance(kinematics, dict):
            for track in kinematics.get("tracks", []):
                track.pop("series", None)

        def encoded_size():
            return len(json.dumps(compact, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())

        if encoded_size() > MAX_SUMMARY_BYTES:
            raise ValueError("Analysis summary exceeds the 1.5MiB synchronization limit")
        claim = state["claim"]
        path = folder / "objects" / "videos" / claim["video"]["id"] / "jobs" / claim["job"]["id"] / "result.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded)
        state["artifacts"]["result.json"] = dict(size_bytes=len(encoded), sha256=digest(path), content_type="application/json")
        complete.update(result=compact, result_artifact=True)
        save_json(folder / "state.json", state)

    def synchronize(self, folder, state):
        claim, complete = state["claim"], state["complete"]
        endpoint = self.job_path(claim)
        if state.get("commit_attempted"):
            # A lost response might already have committed. Retry identical payload first,
            # before heartbeat, so server idempotence also works after lease expiry.
            self.request("POST", endpoint + "/complete", json=complete)
            return
        self.prepare_result(folder, state)
        if claim.get("storage_mode") == "results-only":
            self.retain_local_artifacts(folder, state)
            # Also enforce this when resuming an older private journal.
            state["artifacts"] = {name: artifact for name, artifact in state["artifacts"].items()
                                  if ARTIFACTS.get(name) == "application/json"}
            save_json(folder / "state.json", state)
        self.heartbeat(claim)
        for name, artifact in state["artifacts"].items():
            if artifact.get("uploaded"):
                continue
            self.heartbeat(claim)
            route = endpoint + "/artifacts/" + name
            payload = {key: artifact[key] for key in ("size_bytes", "sha256", "content_type")}
            payload["worker_token"] = claim["job"]["worker_token"]
            if not artifact.get("upload_id"):
                artifact["upload_id"] = self.request("POST", route + "/init", json=payload).json()["upload_id"]
                artifact["parts"] = []
                save_json(folder / "state.json", state)
            path = folder / "objects" / "videos" / claim["video"]["id"] / "jobs" / claim["job"]["id"] / name
            if path.stat().st_size != artifact["size_bytes"] or digest(path) != artifact["sha256"]:
                raise ValueError("Private artifact integrity check failed")
            with path.open("rb") as source:
                part = 0
                while chunk := source.read(CHUNK_BYTES):
                    part += 1
                    if part <= len(artifact["parts"]):
                        continue
                    self.heartbeat(claim)
                    response = self.request("PUT", route, params={"upload_id": artifact["upload_id"], "part": part},
                                            headers={"X-Worker-Lease": claim["job"]["worker_token"],
                                                     "Content-Type": "application/octet-stream"}, content=chunk)
                    data = response.json() if response.content else {}
                    artifact["parts"].append({"part": part, "etag": data.get("etag", response.headers.get("ETag", "")).strip('"')})
                    save_json(folder / "state.json", state)
            self.request("POST", route + "/finalize", json={**{key: value for key, value in payload.items() if key != "content_type"},
                                                           "upload_id": artifact["upload_id"],
                                                           "parts": artifact["parts"]})
            artifact["uploaded"] = True
            save_json(folder / "state.json", state)
        state["commit_attempted"] = True
        save_json(folder / "state.json", state)
        self.request("POST", endpoint + "/complete", json=complete)

    def cycle(self, stop=None):
        stop = stop or threading.Event()
        pending = sorted(self.outbox.glob("task-*/state.json"))
        if not pending:
            backends = self.advertise()
            response = self.request("POST", "claim", json={"worker_id": self.worker_id, "backends": backends})
            if response.status_code == 204 or not response.content:
                return False
            claim = response.json()
            if self.results_only:
                claim["storage_mode"] = "results-only"
            for identifier in (claim["job"]["id"], claim["video"]["id"],
                               (claim.get("source_job") or {}).get("id", "source")):
                if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier):
                    raise ValueError("Invalid remote task identifier")
            if claim["job"]["video_id"] != claim["video"]["id"]:
                raise ValueError("Remote task video does not match")
            folder = self.outbox / ("task-" + uuid4().hex)
            folder.mkdir(mode=0o700)
            state = {"claim": claim}
            save_json(folder / "state.json", state)
            pending = [folder / "state.json"]
        for journal in pending:
            folder, state = journal.parent, json.loads(journal.read_text())
            if self.results_only:
                state["claim"]["storage_mode"] = "results-only"
            try:
                if "complete" not in state:
                    self.heartbeat(state["claim"])
                    self.process(folder, state, stop)
                if stop.is_set():
                    return True
                self.synchronize(folder, state)
            except StaleLease:
                log.warning("Remote task lease revoked; discarding private task %s", state["claim"]["job"]["id"])
            except (ValueError, RuntimeError) as exc:
                # Invalid input must not be retried forever or silently publish results.
                log.warning("Remote task rejected: %s", exc)
                state["complete"] = {
                    "worker_token": state["claim"]["job"]["worker_token"],
                    "status": "blocked" if isinstance(exc, LocalSourceUnavailable) else "failed",
                    "stage": "本机源视频不可用" if isinstance(exc, LocalSourceUnavailable) else "输入校验或处理失败",
                    "metadata": None, "result": None, "error": str(exc)}
                if state.get("source_sha256"):
                    state["complete"]["source_sha256"] = state["source_sha256"]
                state["artifacts"] = {}
                state.pop("commit_attempted", None)
                save_json(folder / "state.json", state)
                try:
                    self.synchronize(folder, state)
                except StaleLease:
                    log.warning("Task expired before its failure could be synchronized")
            shutil.rmtree(folder)
        return True

    def serve(self, stop=None, poll_seconds=2, max_backoff=60):
        stop, delay = stop or threading.Event(), poll_seconds
        while not stop.is_set():
            try:
                busy = self.cycle(stop)
                delay = poll_seconds
                if busy:
                    continue
            except (httpx.HTTPError, OSError):
                log.warning("Cloud unavailable; private outbox retained for retry", exc_info=True)
                delay = min(max_backoff, max(poll_seconds, delay * 2))
            stop.wait(delay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--configure", metavar="HTTPS_URL", help="Prepare private pairing files locally; no network requests")
    parser.add_argument("--url")
    parser.add_argument("--outbox", type=Path, default=Path(os.getenv("ARENA_WORKER_OUTBOX", "data/remote-outbox")))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--results-only", action="store_true", help="Use local videos; synchronize JSON results only")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    # Outbox video data, SQLite files and journals are private, including library writes.
    os.umask(0o077)
    if args.configure:
        for path in configure(args.config, args.configure):
            print(path)
        return
    url, token = connection_config(args.config, args.url)
    if not url or not token:
        parser.exit(2, "尚未配置云端分析。请先运行 python -m arena.remote_worker --configure https://你的域名，或设置 ARENA_CLOUD_URL 和 ARENA_WORKER_TOKEN。\n")
    worker = RemoteWorker(url, token, args.outbox, results_only=args.results_only)
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    try:
        worker.cycle(stop) if args.once else worker.serve(stop)
    finally:
        worker.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exc:
        raise SystemExit(str(exc)) from None
