import io
import json
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from arena.api import create_app
from arena.config import Settings
from arena.worker import run_once
from arena import db
from arena.backends import SampleBackend
from sqlalchemy import update


class FlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.video_dir = tempfile.TemporaryDirectory()
        cls.clip = Path(cls.video_dir.name) / "clip.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=10",
                        "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.clip)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.video_dir.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = Settings(data_dir=Path(self.tmp.name), admin_password="test-password-123456")
        self.app = create_app(self.settings)
        self.client = TestClient(self.app)
        self.client.__enter__()
        r = self.client.post("/api/login", json={"username": "admin", "password": "test-password-123456"})
        self.assertEqual(r.status_code, 200, r.text)
        self.client.headers["X-CSRF-Token"] = r.json()["csrf"]

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def records(self):
        a = self.client.post("/api/athletes", json={"name": "测试运动员", "level": "国家一级"})
        self.assertEqual(a.status_code, 201, a.text)
        s = self.client.post("/api/sessions", json={"athlete_id": a.json()["id"], "date": "2026-10-26",
                             "objective": "测试目标", "duration_min": 60, "rpe": 5})
        self.assertEqual(s.status_code, 201, s.text)
        return a.json(), s.json()

    def upload(self, session, authorized="true", content=None):
        return self.client.post("/api/videos", data={"session_id": session["id"], "category": "stability",
                               "authorized": authorized}, files={"file": ("../../test.mp4", content or self.clip.read_bytes(), "video/mp4")})

    def job(self, video, backend="sample"):
        r = self.client.post(f"/api/videos/{video['id']}/jobs", json={"backend": backend,
                              "sample_acknowledged": backend == "sample"})
        self.assertEqual(r.status_code, 202, r.text)
        run_once(self.app.state.ctx)
        return self.client.get(f"/api/jobs/{r.json()['id']}").json()

    def test_end_to_end_sample_excluded_from_profile_and_confirmable_review(self):
        athlete, session = self.records()
        response = self.upload(session)
        self.assertEqual(response.status_code, 201, response.text)
        video = response.json()
        self.assertEqual(video["status"], "uploaded")
        job = self.job(video)
        self.assertEqual(job["status"], "completed", job)
        self.assertTrue(job["result"]["synthetic"])
        pose = self.client.get(f"/api/jobs/{job['id']}/pose").json()
        self.assertGreater(len(pose["frames"]), 10)
        self.assertEqual(self.client.get(f"/api/videos/{video['id']}/media").status_code, 200)
        profile = self.client.get(f"/api/athletes/{athlete['id']}/profile").json()
        self.assertEqual(profile["trends"], [])
        self.assertEqual(profile["recorded_load"], 300)
        draft = self.client.post(f"/api/videos/{video['id']}/review-drafts", json={"job_id": job["id"], "provider": "rules"})
        self.assertEqual(draft.status_code, 201, draft.text)
        review = self.client.put(f"/api/videos/{video['id']}/review", json={"draft_id": draft.json()["id"],
                                "observations": "人工校正的观察", "next_action": "下次检查机位", "confirmed": True})
        self.assertEqual(review.status_code, 200, review.text)
        self.assertEqual(review.json()["observations"], "人工校正的观察")
        report = self.client.get(f"/api/videos/{video['id']}/report").json()
        self.assertEqual(report["review"]["observations"], "人工校正的观察")
        self.assertIn("合成", report["drafts"][0]["text"])
        self.assertIsNone(job["result"]["specialty_score"]["value"])

    def test_auth_csrf_and_empty_dashboard(self):
        self.assertEqual(self.client.get("/api/dashboard").json()["video_count"], 0)
        self.client.headers.pop("X-CSRF-Token")
        self.assertEqual(self.client.post("/api/athletes", json={"name": "x"}).status_code, 403)
        with TestClient(self.app) as outsider:
            self.assertEqual(outsider.get("/api/videos").status_code, 401)

    def test_consent_and_input_validation(self):
        _, s = self.records()
        self.assertEqual(self.upload(s, authorized="false").status_code, 422)
        self.assertEqual(self.client.get("/api/videos").json(), [])
        self.assertEqual(self.client.post("/api/sessions", json={"athlete_id": "absent", "date": "2026-10-26"}).status_code, 404)
        self.assertEqual(self.client.post("/api/athletes", json={"name": " "}).status_code, 422)

    def test_invalid_video_fails_without_metrics_and_retries_are_explicit(self):
        _, s = self.records()
        v = self.upload(s, content=b"not a video").json()
        job = self.job(v)
        self.assertEqual(job["status"], "failed")
        self.assertIsNone(job["result"])
        self.assertIn("视频", job["error"])
        self.assertEqual(self.client.get(f"/api/jobs/{job['id']}/pose").status_code, 409)

    def test_uninstalled_model_blocks_without_falling_back_to_fake(self):
        _, s = self.records()
        v = self.upload(s).json()
        job = self.job(v, "rtmpose")
        self.assertEqual(job["status"], "blocked", job)
        self.assertIsNone(job["result"])
        self.assertFalse(self.client.get("/api/models").json()["rtmpose"]["ready"])

    def test_sam2_without_local_weights_blocks_without_fake_masks(self):
        _, session = self.records()
        video = self.upload(session).json()
        job = self.job(video, 'sam2')
        self.assertEqual(job['status'], 'blocked', job)
        self.assertIsNone(job['result'])
        self.assertFalse(self.client.get('/api/models').json()['sam2']['ready'])
        self.assertEqual(self.client.get(f"/api/jobs/{job['id']}/segmentation").status_code,409)

    def test_sample_requires_acknowledgement_and_duplicate_jobs_conflict(self):
        _, s = self.records()
        v = self.upload(s).json()
        url = f"/api/videos/{v['id']}/jobs"
        self.assertEqual(self.client.post(url, json={"backend": "sample"}).status_code, 422)
        self.assertEqual(self.client.post(url, json={"backend": "sample", "sample_acknowledged": True}).status_code, 202)
        self.assertEqual(self.client.post(url, json={"backend": "sample", "sample_acknowledged": True}).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/videos/{v['id']}").status_code, 409)

    def test_delete_removes_media_jobs_and_review(self):
        _, s = self.records()
        v = self.upload(s).json()
        job = self.job(v)
        self.assertEqual(self.client.delete(f"/api/videos/{v['id']}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/videos/{v['id']}/media").status_code, 404)
        self.assertEqual(self.client.get(f"/api/jobs/{job['id']}").status_code, 404)
        self.assertEqual(self.client.get("/api/videos").json(), [])

    def test_llm_not_configured_is_honest(self):
        _, s = self.records()
        v = self.upload(s).json()
        job = self.job(v)
        r = self.client.post(f"/api/videos/{v['id']}/review-drafts", json={"job_id": job["id"], "provider": "llm"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("未配置", r.json()["detail"])

    def test_clip_range_and_manual_events_preserve_original_timeline(self):
        _, s = self.records()
        v = self.upload(s).json()
        j = self.client.post(f"/api/videos/{v['id']}/jobs", json={"backend": "sample", "sample_acknowledged": True,
                             "start_sec": 0.5, "end_sec": 1.8}).json()
        run_once(self.app.state.ctx)
        done = self.client.get(f"/api/jobs/{j['id']}").json()
        self.assertEqual(done["status"], "completed", done)
        self.assertAlmostEqual(done["metadata"]["time_offset"], 0.5)
        self.assertAlmostEqual(done["metadata"]["source_duration"], 2)
        event = self.client.post(f"/api/videos/{v['id']}/events", json={"start_sec": 0.6, "end_sec": 1.6,
                                "label": "人工确认的技术", "actor": "athlete", "outcome": "待核实"})
        self.assertEqual(event.status_code, 201, event.text)
        self.assertEqual(len(self.client.get(f"/api/videos/{v['id']}/events").json()), 1)
        self.assertEqual(self.client.post(f"/api/videos/{v['id']}/events", json={"start_sec": 1, "end_sec": 3,
                         "label": "越界"}).status_code, 422)

    def test_original_frame_rate_is_preserved_in_preprocessing(self):
        _, s = self.records()
        v = self.upload(s).json()
        j = self.job(v)
        self.assertAlmostEqual(j["metadata"]["fps"], 10)

    def test_review_versions_are_preserved(self):
        _, s = self.records()
        v = self.upload(s).json()
        url = f"/api/videos/{v['id']}/review"
        for observations in ("第一次观察", "人工修订"):
            self.assertEqual(self.client.put(url, json={"observations": observations, "confirmed": True}).status_code, 200)
        report = self.client.get(f"/api/videos/{v['id']}/report").json()
        self.assertEqual(len(report["review_history"]), 2)
        self.assertEqual(report["review_history"][0]["snapshot"]["observations"], "第一次观察")

    def test_fsw_weights_missing_and_wham_are_explicitly_blocked(self):
        _, s = self.records()
        v = self.upload(s).json()
        for backend in ("fsw", "wham"):
            j = self.job(v, backend)
            self.assertEqual(j["status"], "blocked", j)
            self.assertIsNone(j["result"])

    def test_logout_and_cross_origin_are_rejected(self):
        self.assertEqual(self.client.post("/api/athletes", json={"name": "x"},
                         headers={"Origin": "https://evil.invalid"}).status_code, 403)
        self.assertEqual(self.client.post("/api/logout").status_code, 204)
        self.assertEqual(self.client.get("/api/videos").status_code, 401)

    def test_bad_roi_and_range_rejected(self):
        _, s = self.records()
        v = self.upload(s).json()
        for params in ({"roi": [0, 0, 2, 1]}, {"start_sec": 2, "end_sec": 1}):
            self.assertEqual(self.client.post(f"/api/videos/{v['id']}/jobs", json=params).status_code, 422)

    def test_expired_worker_cannot_publish_results(self):
        _, s = self.records()
        v = self.upload(s).json()
        j = self.client.post(f"/api/videos/{v['id']}/jobs", json={"backend": "sample", "sample_acknowledged": True}).json()
        original = SampleBackend.extract
        ctx = self.app.state.ctx

        def expire(backend, *args):
            result = original(backend, *args)
            with ctx.db.engine.begin() as c:
                c.execute(update(db.jobs).where(db.jobs.c.id == j["id"]).values(lease_until=int(time.time()) - 1))
            return result

        with patch.object(SampleBackend, "extract", expire):
            run_once(ctx)
        self.assertEqual(ctx.db.get(db.jobs, j["id"])["status"], "failed")
        self.assertIsNone(ctx.db.get(db.jobs, j["id"])["result"])

    def test_deleted_job_cannot_recreate_private_artifacts(self):
        from arena.video import preprocess
        _, s = self.records()
        v = self.upload(s).json()
        j = self.client.post(f"/api/videos/{v['id']}/jobs", json={"backend": "sample", "sample_acknowledged": True}).json()
        waiting, release = threading.Event(), threading.Event()
        ctx, failures = self.app.state.ctx, []

        def pause(*args, **kwargs):
            info = preprocess(*args, **kwargs)
            waiting.set()
            if not release.wait(10):
                raise TimeoutError("test worker synchronization failed")
            return info

        def work():
            try:
                run_once(ctx)
            except Exception as exc:
                failures.append(str(exc))

        with patch("arena.worker.preprocess", pause):
            worker = threading.Thread(target=work)
            worker.start()
            try:
                self.assertTrue(waiting.wait(5))
                with ctx.db.engine.begin() as c:
                    c.execute(update(db.jobs).where(db.jobs.c.id == j["id"]).values(lease_until=int(time.time()) - 1))
                self.assertFalse(run_once(ctx))
                self.assertEqual(self.client.delete(f"/api/videos/{v['id']}").status_code, 204)
            finally:
                release.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertFalse(any(p.is_file() for p in (ctx.settings.data_dir / "objects" / "videos" / v["id"]).rglob("*")))

    def test_events_require_known_duration_instead_of_500_or_unchecked_time(self):
        _, s = self.records()
        v = self.upload(s).json()
        event_url = f"/api/videos/{v['id']}/events"
        payload = {"start_sec": 0.2, "end_sec": 1, "label": "人工观察"}
        self.assertEqual(self.client.post(event_url, json=payload).status_code, 409)
        j = self.client.post(f"/api/videos/{v['id']}/jobs", json={"backend": "preprocess"})
        self.assertEqual(j.status_code, 202, j.text)
        self.assertEqual(self.client.post(event_url, json=payload).status_code, 409)
        run_once(self.app.state.ctx)
        self.assertEqual(self.client.post(event_url, json=payload).status_code, 201)
        self.assertEqual(self.client.post(event_url, json={**payload, "end_sec": 3}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
