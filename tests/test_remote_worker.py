"""Real HTTP transport and FFmpeg preprocessing; cloud protocol fixtures only."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import httpx

from arena import db
from arena.config import Settings
from arena.engine import analyze
from arena.remote_worker import (RemoteWorker, CHUNK_BYTES, INLINE_RESULT_BYTES, MAX_RESULT_BYTES,
                                 configure, connection_config, discover_settings, digest, load_config, save_json)
from arena.video import probe, preprocess


class CloudFixture:
    """A narrow test server implementing the documented lease/upload protocol."""
    def __init__(self, content):
        self.content = content
        stamp = "2026-10-28T00:00:00+00:00"
        self.claim = {
            "job": {"id": "job-test", "video_id": "video-test", "backend": "preprocess", "status": "running",
                    "stage": "读取视频", "progress": 0, "params": {}, "worker_token": "lease-test",
                    "lease_until": int(time.time()) + 180, "created_at": stamp, "updated_at": stamp},
            "video": {"id": "video-test", "sha256": hashlib.sha256(content).hexdigest(), "size_bytes": len(content)},
            "source_job": None,
        }
        self.events, self.uploads, self.commits = [], {}, []
        self.claimed, self.revoked, self.fail_commit, self.accept_failed_commit = False, False, 0, False
        self.committed, self.tamper, self.revoke_on_put = None, False, False
        self.revoke_on_source = False
        self.expired_heartbeat = False
        self.source_artifacts = {}
        self.fail_part, self.failed_part = None, False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def handle_request(self):
                path = urlsplit(self.path)
                fixture.events.append((self.command, path.path))
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b""
                if self.headers.get("Authorization") != "Bearer private-test-token":
                    return self.reply(401)
                data = json.loads(raw) if raw and self.command == "POST" else {}
                if path.path.endswith("/heartbeat") and "/jobs/" not in path.path:
                    fixture.models = data["models"]
                    return self.reply(200, {})
                if path.path.endswith("/claim"):
                    if fixture.claimed:
                        return self.reply(204)
                    fixture.claimed = True
                    return self.reply(200, fixture.claim)
                token = data.get("worker_token") if self.command == "POST" else self.headers.get("X-Worker-Lease")
                if token != fixture.claim["job"]["worker_token"]:
                    return self.reply(409)
                if path.path.endswith("/complete"):
                    fixture.commits.append(data)
                    if fixture.committed is not None:
                        return self.reply(200, {}) if fixture.committed == data else self.reply(409)
                    if fixture.revoked:
                        return self.reply(409)
                    if fixture.fail_commit:
                        fixture.fail_commit -= 1
                        if fixture.accept_failed_commit:
                            fixture.committed = data
                        return self.reply(503)
                    fixture.committed = data
                    return self.reply(200, {})
                if fixture.revoked or fixture.committed:
                    return self.reply(409)
                if path.path.endswith("/heartbeat"):
                    return self.reply(200, {"lease_until": int(time.time()) + (-1 if fixture.expired_heartbeat else 180)})
                if path.path.endswith("/source"):
                    artifact = parse_qs(path.query).get("artifact", ["source"])[0]
                    content = fixture.source_artifacts.get(artifact, fixture.content)
                    content += b"tampered" if fixture.tamper else b""
                    if fixture.revoke_on_source:
                        fixture.revoked = True
                    return self.reply(200, content, {"X-Content-SHA256": fixture.claim["video"]["sha256"]})
                if "/artifacts/" in path.path:
                    name = path.path.split("/artifacts/")[1].split("/")[0]
                    if path.path.endswith("/init"):
                        fixture.uploads[name] = {"metadata": data, "parts": {}}
                        return self.reply(200, {"upload_id": name + "-upload"})
                    upload = fixture.uploads[name]
                    if self.command == "PUT":
                        if fixture.revoke_on_put:
                            fixture.revoked = True
                            return self.reply(409)
                        part = int(parse_qs(path.query)["part"][0])
                        if part == fixture.fail_part and not fixture.failed_part:
                            fixture.failed_part = True
                            return self.reply(503)
                        if len(raw) > CHUNK_BYTES:
                            return self.reply(413)
                        upload["parts"][part] = raw
                        return self.reply(200, {"etag": hashlib.sha256(raw).hexdigest()})
                    if path.path.endswith("/finalize"):
                        content = b"".join(upload["parts"][part] for part in sorted(upload["parts"]))
                        if len(content) != data["size_bytes"] or hashlib.sha256(content).hexdigest() != data["sha256"]:
                            return self.reply(422)
                        upload["content"] = content
                        return self.reply(200, {})
                return self.reply(404)

            do_POST = do_GET = do_PUT = handle_request

            def reply(self, status, content=None, headers=None):
                body = content if isinstance(content, bytes) else json.dumps(content).encode() if content is not None else b""
                self.send_response(status)
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class WorkerConfigTests(unittest.TestCase):
    def test_private_config_cli_is_offline_idempotent_and_env_overrides(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private" / "cloudflare-worker.json"
            command = [sys.executable, "-m", "arena.remote_worker", "--config", str(path),
                       "--configure", "https://generated-config-test.workers.dev"]
            first = subprocess.run(command, check=True, capture_output=True, text=True)
            config = load_config(path)
            token_file = path.parent / "cloudflare-worker-token.txt"
            self.assertGreaterEqual(len(config["token"]), 43)
            self.assertEqual(token_file.read_text().strip(), config["token"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(token_file.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(config["token"], first.stdout + first.stderr)
            self.assertEqual(first.stdout.splitlines(), [str(path.resolve()), str(token_file.resolve())])
            before = token_file.stat().st_mtime_ns
            subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertEqual(load_config(path)["token"], config["token"])
            self.assertEqual(token_file.stat().st_mtime_ns, before)
            with patch.dict(os.environ, {"ARENA_CLOUD_URL": "https://env-config-test.workers.dev", "ARENA_WORKER_TOKEN": "env-test-secret"}):
                self.assertEqual(connection_config(path), ("https://env-config-test.workers.dev", "env-test-secret"))
                self.assertEqual(connection_config(path, "https://explicit-config-test.workers.dev"),
                                 ("https://explicit-config-test.workers.dev", "env-test-secret"))
                path.chmod(0o644)
                with self.assertRaisesRegex(ValueError, "mode 600"):
                    connection_config(path)

    def test_existing_token_is_reused_and_conflicts_or_public_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cloudflare-worker.json"
            token_file = path.parent / "cloudflare-worker-token.txt"
            token_file.write_text("existing-private-token-must-not-rotate\n")
            token_file.chmod(0o600)
            configure(path, "https://generated-config-test.workers.dev")
            token = load_config(path)["token"]
            self.assertEqual(token, "existing-private-token-must-not-rotate")
            configure(path, "https://changed-config-test.workers.dev")
            self.assertEqual(load_config(path)["token"], token)
            save_json(path, {"url": "https://changed-config-test.workers.dev", "token": "different-test-token"})
            with self.assertRaisesRegex(ValueError, "neither secret was overwritten"):
                configure(path, "https://generated-config-test.workers.dev")
            self.assertEqual(token_file.read_text().strip(), token)
            token_file.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "mode 600"):
                configure(path, "https://generated-config-test.workers.dev")


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class RemoteWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.TemporaryDirectory()
        cls.clip = Path(cls.media.name) / "generated.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=10",
                        "-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.4", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", str(cls.clip)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.media.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.original_db = self.folder / "original.db"
        self.original_db.write_bytes(b"Original private database must never be opened or modified")
        self.cloud = CloudFixture(self.clip.read_bytes())
        self.worker = self.make_worker()

    def make_worker(self):
        return RemoteWorker(self.cloud.url, "private-test-token", self.folder / "outbox",
                            settings=Settings(data_dir=self.folder / "original-data",
                                              detector_path="uninstalled", pose_path="uninstalled", sam2_path="uninstalled",
                                              action_model_path="uninstalled", pose3d_model_path="uninstalled", review_model_path="uninstalled",
                                              database_url=f"sqlite:///{self.original_db}"))

    def tearDown(self):
        self.worker.close()
        self.cloud.close()
        self.tmp.cleanup()

    def test_real_preprocess_upload_and_local_database_isolation(self):
        original = self.original_db.read_bytes()
        self.assertTrue(self.worker.cycle())
        complete = self.cloud.committed
        self.assertEqual(complete["status"], "completed", complete)
        self.assertTrue(complete["metadata"]["audio_removed"])
        self.assertEqual(self.original_db.read_bytes(), original)
        self.assertFalse((self.folder / "original-data").exists())
        artifact = self.cloud.uploads["normalized.mp4"]
        normalized = self.folder / "normalized.mp4"
        normalized.write_bytes(artifact["content"])
        self.assertTrue(all(stream["codec_type"] != "audio" for stream in probe(normalized)[0]["streams"]))
        self.assertEqual(hashlib.sha256(artifact["content"]).hexdigest(), artifact["metadata"]["sha256"])
        self.assertFalse(list((self.folder / "outbox").glob("task-*")))
        self.assertIn("rtmpose_tracking", self.cloud.models)
        self.assertFalse(self.cloud.models["sample"]["ready"])
        self.assertFalse(self.worker.cycle())

    def local_video(self):
        self.original_db.unlink()
        database = db.Database(self.worker.settings)
        db.meta.create_all(database.engine)
        stamp = db.now()
        database.add(db.athletes, dict(id="athlete-local", name="Local", level="", created_at=stamp))
        database.add(db.sessions, dict(id="session-local", athlete_id="athlete-local", date="2026-10-28",
                     objective="", duration_min=1, notes="", created_at=stamp))
        database.add(db.videos, {**self.cloud.claim["video"], "session_id": "session-local", "category": "stability",
                     "filename": "private.mp4", "storage_key": "videos/video-test/source.mp4", "status": "uploaded",
                     "authorized_at": stamp, "created_at": stamp})
        database.engine.dispose()
        path = self.worker.settings.data_dir / "objects" / "videos/video-test/source.mp4"
        path.parent.mkdir(parents=True)
        path.write_bytes(self.clip.read_bytes())
        self.cloud.claim["storage_mode"] = "results-only"
        return path

    def test_results_only_preprocess_reads_local_video_and_retains_mp4_without_upload(self):
        self.local_video()
        original = self.original_db.read_bytes()
        self.cloud.tamper = True  # Cloud video bytes must never be requested.
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "completed", self.cloud.committed)
        self.assertFalse(any(path.endswith("/source") for _, path in self.cloud.events))
        self.assertFalse(self.cloud.uploads)
        normalized = self.worker.settings.data_dir / "objects/videos/video-test/jobs/job-test/normalized.mp4"
        self.assertTrue(normalized.is_file())
        self.assertTrue(all(stream["codec_type"] != "audio" for stream in probe(normalized)[0]["streams"]))
        self.assertEqual(self.original_db.read_bytes(), original)

    def test_results_only_missing_local_video_is_blocked_without_cloud_download(self):
        self.local_video().unlink()
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "blocked", self.cloud.committed)
        self.assertIn("local", self.cloud.committed["error"].lower())
        self.assertFalse(any(path.endswith("/source") for _, path in self.cloud.events))
        self.assertFalse(self.cloud.uploads)

    def test_results_only_tampered_local_video_is_blocked(self):
        self.local_video().write_bytes(b"different private video")
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "blocked", self.cloud.committed)
        self.assertFalse(any(path.endswith("/source") for _, path in self.cloud.events))
        self.assertFalse(self.cloud.uploads)

    def test_results_only_rejects_source_path_outside_local_objects(self):
        self.local_video()
        database = db.Database(self.worker.settings)
        with database.engine.begin() as connection:
            connection.exec_driver_sql("UPDATE videos SET storage_key = ? WHERE id = ?",
                                       ("../private.mp4", "video-test"))
        database.engine.dispose()
        outside = self.worker.settings.data_dir / "private.mp4"
        outside.write_bytes(self.clip.read_bytes())
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "blocked", self.cloud.committed)
        self.assertFalse(any(path.endswith("/source") for _, path in self.cloud.events))
        self.assertEqual(outside.read_bytes(), self.clip.read_bytes())

    def test_results_only_rejects_remote_task_path_traversal(self):
        self.cloud.claim["storage_mode"] = "results-only"
        self.cloud.claim["job"]["id"] = "../outside-job"
        with self.assertRaisesRegex(ValueError, "identifier"):
            self.worker.cycle()
        self.assertFalse(self.cloud.uploads)
        self.assertFalse(list((self.folder / "outbox").glob("task-*")))

    def local_pose(self):
        self.local_video()
        normalized = self.folder / "cached-normalized.mp4"
        metadata = preprocess(self.clip, normalized, self.worker.settings)
        pose = {"schema_version": 1, "layout": "coco17", "synthetic": False, "backend": "rtmpose_tracking",
                "width": metadata["width"], "height": metadata["height"], "sample_fps": 10,
                "frames": [{"t": i / 10, "people": []} for i in range(4)]}
        artifacts = {"normalized.mp4": normalized.read_bytes(), "pose.json": json.dumps(pose).encode()}
        prefix = self.worker.settings.data_dir / "objects/videos/video-test/jobs/prior-job"
        prefix.mkdir(parents=True)
        for name, content in artifacts.items():
            (prefix / name).write_bytes(content)
        job = self.cloud.claim["job"]
        job.update(backend="rtmpose_tracking", params={"source_pose_job_id": "prior-job"})
        self.cloud.claim["source_job"] = {**job, "id": "prior-job", "status": "needs_review", "params": {},
            "metadata": metadata, "result": {"synthetic": False}, "artifacts": {
                name: {"size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                for name, content in artifacts.items()}}
        # D1 has JSON descriptors but no video artifact descriptor in results-only mode.
        self.cloud.claim["source_job"]["artifacts"].pop("normalized.mp4")
        return prefix, artifacts

    def test_results_only_reuses_local_pose_cache_and_uploads_only_json(self):
        prefix, _ = self.local_pose()
        self.worker.cycle()
        complete = self.cloud.committed
        self.assertEqual(complete["status"], "needs_review", complete)
        self.assertEqual(complete["result"]["source_pose_job_id"], "prior-job")
        self.assertEqual(set(self.cloud.uploads), {"pose.json"})
        self.assertFalse(any(path.endswith("/source") for _, path in self.cloud.events))
        self.assertTrue((prefix.parent / "job-test/pose.json").is_file())

    def test_results_only_fetches_missing_json_cache_but_keeps_video_local(self):
        prefix, artifacts = self.local_pose()
        (prefix / "pose.json").unlink()
        self.cloud.source_artifacts = artifacts
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "needs_review", self.cloud.committed)
        self.assertEqual(sum(path.endswith("/source") for _, path in self.cloud.events), 1)
        self.assertEqual(set(self.cloud.uploads), {"pose.json"})

    def test_results_only_missing_normalized_cache_is_blocked_without_downloading_video(self):
        prefix, _ = self.local_pose()
        (prefix / "normalized.mp4").unlink()
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "blocked", self.cloud.committed)
        self.assertFalse(any(path.endswith("/source") for _, path in self.cloud.events))
        self.assertFalse(self.cloud.uploads)

    def test_results_only_review_does_not_require_local_media(self):
        self.cloud.claim["storage_mode"] = "results-only"
        job = self.cloud.claim["job"]
        job.update(backend="review_draft", params={"job_id": "analysis-test", "provider": "rules", "language": "en"})
        self.cloud.claim["source_job"] = {"id": "analysis-test", "video_id": "video-test", "result": {
            "kind": "segmentation", "synthetic": False, "method_version": "fixture-evidence",
            "segmentation": {"segmented_frames": 2, "total_frames": 3, "object_count": 1}}}
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "completed", self.cloud.committed)
        self.assertIn("2/3", self.cloud.committed["draft"]["text"])
        self.assertFalse(self.cloud.uploads)

    def test_results_only_option_prevents_media_upload_from_legacy_retry_journal(self):
        self.worker.results_only = True
        folder = self.folder / "outbox/task-old-journal"
        artifact = folder / "objects/videos/video-test/jobs/job-test/normalized.mp4"
        artifact.parent.mkdir(parents=True)
        artifact.write_bytes(self.clip.read_bytes())
        state = {"claim": self.cloud.claim, "complete": {"worker_token": "lease-test", "status": "failed",
                 "stage": "Transport test only", "metadata": None, "result": None, "error": "test fixture"},
                 "artifacts": {"normalized.mp4": {"size_bytes": artifact.stat().st_size,
                     "sha256": digest(artifact), "content_type": "video/mp4"}}}
        save_json(folder / "state.json", state)
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "failed")
        self.assertFalse(self.cloud.uploads)

    def test_results_only_local_artifacts_never_replace_existing_bytes(self):
        self.local_video()
        normalized = self.worker.settings.data_dir / "objects/videos/video-test/jobs/job-test/normalized.mp4"
        normalized.parent.mkdir(parents=True)
        normalized.write_bytes(b"existing artifact must remain")
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "failed", self.cloud.committed)
        self.assertEqual(normalized.read_bytes(), b"existing artifact must remain")
        self.assertFalse(self.cloud.uploads)

    def test_transient_commit_survives_process_restart_without_reprocessing(self):
        self.cloud.fail_commit = 1
        with self.assertRaises(httpx.HTTPStatusError):
            self.worker.cycle()
        journals = list((self.folder / "outbox").glob("task-*/state.json"))
        self.assertEqual(len(journals), 1)
        self.assertEqual(journals[0].stat().st_mode & 0o777, 0o600)
        before = list(self.cloud.events)
        self.worker.close()
        self.worker = self.make_worker()
        self.assertTrue(self.worker.cycle())
        self.assertEqual(self.cloud.commits[0], self.cloud.commits[1])
        self.assertEqual(self.cloud.events[len(before):], [("POST", "/api/worker/jobs/job-test/complete")])

    def test_lost_success_response_retries_idempotently_after_server_task_completed(self):
        self.cloud.fail_commit = 1
        self.cloud.accept_failed_commit = True
        with self.assertRaises(httpx.HTTPStatusError):
            self.worker.cycle()
        self.cloud.revoked = True
        self.worker.cycle()
        self.assertEqual(self.cloud.commits[0], self.cloud.commits[1])
        self.assertFalse(list((self.folder / "outbox").glob("task-*")))

    def test_stale_upload_lease_cannot_commit(self):
        self.cloud.revoke_on_put = True
        self.worker.cycle()
        self.assertIsNone(self.cloud.committed)
        self.assertFalse(self.cloud.commits)
        self.assertFalse(list((self.folder / "outbox").glob("task-*")))

    def test_deleted_task_during_download_cannot_publish(self):
        self.cloud.revoke_on_source = True
        self.worker.cycle()
        self.assertFalse(self.cloud.uploads)
        self.assertFalse(self.cloud.commits)

    def test_tampered_source_is_rejected_before_inference(self):
        self.cloud.tamper = True
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "failed")
        self.assertIn("mismatch", self.cloud.committed["error"])
        self.assertFalse(self.cloud.uploads)

    def test_fresh_upload_establishes_source_checksum_locally(self):
        self.cloud.claim["video"]["sha256"] = ""
        self.worker.cycle()
        self.assertEqual(self.cloud.committed["status"], "completed")
        self.assertEqual(self.cloud.committed["source_sha256"], hashlib.sha256(self.clip.read_bytes()).hexdigest())

    def test_expired_lease_stops_before_source_download(self):
        self.cloud.expired_heartbeat = True
        self.worker.cycle()
        self.assertFalse(self.cloud.commits)
        self.assertFalse(any(path.endswith("/source") for _, path in self.cloud.events))

    def test_chunk_upload_resumes_after_network_restart(self):
        # Protocol fixture bytes, no fabricated analysis result or model invocation.
        folder = self.folder / "outbox" / "task-transport-test"
        artifact = folder / "objects" / "videos" / "video-test" / "jobs" / "job-test" / "pose.json"
        artifact.parent.mkdir(parents=True)
        artifact.write_bytes(json.dumps({"transport_fixture": "x" * CHUNK_BYTES}).encode())
        state = {"claim": self.cloud.claim, "complete": {"worker_token": "lease-test", "status": "failed",
                 "stage": "Transport test only", "metadata": None, "result": None, "error": "test fixture"},
                 "artifacts": {"pose.json": {"size_bytes": artifact.stat().st_size,
                                              "sha256": digest(artifact), "content_type": "application/json"}}}
        save_json(folder / "state.json", state)
        self.cloud.fail_part = 2
        with self.assertRaises(httpx.HTTPStatusError):
            self.worker.cycle()
        self.assertEqual(len(self.cloud.uploads["pose.json"]["parts"]), 1)
        self.worker.close()
        self.worker = self.make_worker()
        self.worker.cycle()
        uploaded = self.cloud.uploads["pose.json"]
        self.assertEqual(len(uploaded["parts"][1]), CHUNK_BYTES)
        self.assertLess(len(uploaded["parts"][2]), CHUNK_BYTES)
        self.assertEqual(hashlib.sha256(uploaded["content"]).hexdigest(), state["artifacts"]["pose.json"]["sha256"])
        self.assertFalse(list((self.folder / "outbox").glob("task-*")))

    def test_dense_actual_engine_result_spills_and_survives_commit_restart(self):
        # Explicit keypoint fixture exercises real analyzer math, never a model or
        # a claim that the generated color clip contains these people.
        points = [(320, 40), (310, 35), (330, 35), (300, 40), (340, 40),
                  (280, 120), (350, 110), (250, 180), (380, 175), (220, 240), (400, 245),
                  (290, 270), (350, 265), (270, 350), (370, 345), (250, 440), (390, 435)]
        people = [{"track_id": track, "keypoints": [[x + track * 5, y, .95] for x, y in points]}
                  for track in (1, 2, 3)]
        pose = {"layout": "coco17", "width": 640, "height": 480, "backend": "rtmpose_tracking", "synthetic": False,
                "frames": [{"t": i / 10, "people": people} for i in range(3000)]}
        full = {**analyze(pose), "synthetic": False, "kind": "pose", "backend": "rtmpose_tracking"}
        self.assertGreater(len(json.dumps(full).encode()), 1024 * 1024)
        folder = self.folder / "outbox" / "task-dense-fixture"
        folder.mkdir()
        state = {"claim": self.cloud.claim, "complete": {"worker_token": "lease-test", "status": "needs_review",
            "stage": "Dense analyzer transport fixture", "metadata": {"duration": 300}, "result": full, "error": None}, "artifacts": {}}
        save_json(folder / "state.json", state)
        self.cloud.fail_commit = 1
        with self.assertRaises(httpx.HTTPStatusError):
            self.worker.cycle()
        journal = json.loads((folder / "state.json").read_text())
        self.assertTrue(journal["complete"]["result_artifact"])
        compact = journal["complete"]["result"]
        self.assertLess(len(json.dumps(compact, ensure_ascii=False).encode()), INLINE_RESULT_BYTES)
        self.assertEqual(compact["metrics"], full["metrics"])
        self.assertEqual(compact["quality"], full["quality"])
        self.assertTrue(all("series" not in track for track in compact["kinematics"]["tracks"]))
        artifact = self.cloud.uploads["result.json"]
        self.assertEqual(json.loads(artifact["content"]), full)
        self.assertEqual(hashlib.sha256(artifact["content"]).hexdigest(), artifact["metadata"]["sha256"])
        self.worker.close()
        self.worker = self.make_worker()
        self.worker.cycle()
        self.assertEqual(self.cloud.commits[0], self.cloud.commits[1])
        self.assertFalse(folder.exists())

    def test_spill_preserves_other_detail_arrays_and_summary_evidence(self):
        folder = self.folder / "outbox" / "task-extra-detail"
        folder.mkdir()
        full = {"method_version": "fixture", "metrics": {"n": 1}, "quality": {"total": 1},
                "provenance": {"source": "explicit fixture"}, "series": ["x" * INLINE_RESULT_BYTES]}
        state = {"claim": self.cloud.claim, "complete": {"result": full}, "artifacts": {}}
        self.worker.prepare_result(folder, state)
        self.assertTrue(state["complete"]["result_artifact"])
        self.assertEqual(state["complete"]["result"], full)

    def test_oversized_full_result_is_rejected_without_partial_publication(self):
        folder = self.folder / "outbox" / "task-too-large"
        folder.mkdir()
        state = {"claim": self.cloud.claim, "complete": {"result": {"series": ["x" * MAX_RESULT_BYTES]}}, "artifacts": {}}
        with self.assertRaisesRegex(ValueError, "16MiB"):
            self.worker.prepare_result(folder, state)
        self.assertFalse(state["artifacts"])
        self.assertFalse(self.cloud.commits)

    def test_rules_review_uses_existing_evidence_rules_and_language(self):
        job = self.cloud.claim["job"]
        job.update(backend="review_draft", params={"job_id": "analysis-test", "provider": "rules", "language": "en"})
        self.cloud.claim["source_job"] = {"id": "analysis-test", "video_id": "video-test", "result": {
            "kind": "segmentation", "synthetic": False, "method_version": "fixture-evidence",
            "segmentation": {"segmented_frames": 2, "total_frames": 3, "object_count": 1}}}
        self.worker.cycle()
        draft = self.cloud.committed["draft"]
        self.assertEqual(draft["model"], "evidence-rules-v1")
        self.assertIn("2/3", draft["text"])
        self.assertIn("pending human confirmation", draft["text"])
        self.assertEqual(draft["job_id"], "analysis-test")
        self.assertFalse(self.cloud.uploads)
        self.assertFalse(any(path.endswith("/source") for _, path in self.cloud.events))

    def test_existing_pose_is_reused_without_loading_an_inference_model(self):
        # Empty detections are a protocol fixture for the generated blank test clip.
        # The cache branch still runs the existing analyzer and artifact writer.
        normalized = self.folder / "cached-normalized.mp4"
        metadata = preprocess(self.clip, normalized, self.worker.settings)
        pose = {"schema_version": 1, "layout": "coco17", "synthetic": False, "backend": "rtmpose_tracking",
                "width": metadata["width"], "height": metadata["height"], "sample_fps": 10,
                "frames": [{"t": i / 10, "people": []} for i in range(4)]}
        artifacts = {"normalized.mp4": normalized.read_bytes(), "pose.json": json.dumps(pose).encode()}
        self.cloud.source_artifacts = artifacts
        job = self.cloud.claim["job"]
        job.update(backend="rtmpose_tracking", params={"source_pose_job_id": "prior-job"})
        self.cloud.claim["source_job"] = {**job, "id": "prior-job", "status": "needs_review", "params": {},
            "metadata": metadata, "result": {"synthetic": False}, "artifacts": {
                name: {"size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                for name, content in artifacts.items()}}
        self.worker.cycle()
        complete = self.cloud.committed
        self.assertEqual(complete["status"], "needs_review", complete)
        self.assertEqual(complete["result"]["source_pose_job_id"], "prior-job")
        self.assertEqual(complete["result"]["quality"]["usable_frames"], 0)
        self.assertEqual(set(self.cloud.uploads), {"normalized.mp4", "pose.json"})

    def test_outbox_has_single_owner(self):
        with self.assertRaisesRegex(ValueError, "already using"):
            self.make_worker()

    def test_https_enforced_without_opening_local_data(self):
        with self.assertRaises(ValueError):
            RemoteWorker("http://example.com", "token", self.folder / "invalid")
        self.assertFalse((self.folder / "invalid").exists())

    def test_model_autodiscovery_preserves_explicit_configuration(self):
        models = self.folder / "models" / "rtmpose"
        models.mkdir(parents=True)
        (models / "detector.onnx").touch()
        (models / "pose.onnx").touch()
        settings = discover_settings(Settings(detector_path="explicit-detector"), self.folder)
        self.assertEqual(settings.detector_path, "explicit-detector")
        self.assertEqual(settings.pose_path, str(models / "pose.onnx"))
