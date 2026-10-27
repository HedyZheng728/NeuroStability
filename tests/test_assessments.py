"""Analysis decisions close technical review without rewriting model observations."""
import csv
import io
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select, update

from arena import analytics, db, planning
from arena.api import create_app
from arena.config import Settings


class AssessmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = Settings(data_dir=Path(self.tmp.name), admin_password="test-password-123456")
        self.app = create_app(self.settings)
        self.database = self.app.state.ctx.db
        self.client = TestClient(self.app).__enter__()
        login = self.client.post("/api/login", json={"username": "admin", "password": self.settings.admin_password})
        self.client.headers["X-CSRF-Token"] = login.json()["csrf"]
        self.database.add(db.athletes, dict(id="athlete-a", name="private athlete", level="", created_at=db.now()))

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def job(self, id="job-a", *, video="video-a", athlete="athlete-a", date="2026-01-07", backend="rtmpose",
            status="needs_review", result=None, params=None, created_at="2026-01-07T00:00:00+00:00"):
        session = "session-" + video
        if not self.database.get(db.videos, video):
            self.database.add(db.sessions, dict(id=session, athlete_id=athlete, date=date, objective="", duration_min=60,
                              rpe=None, notes="", created_at=db.now()))
            self.database.add(db.videos, dict(id=video, session_id=session, category="mixed", filename="private source.mp4",
                              storage_key="private/source", sha256="a" * 64, size_bytes=1, status="ready",
                              authorized_at=db.now(), created_at=db.now()))
        self.database.add(db.jobs, dict(id=id, video_id=video, backend=backend, status=status, stage="finished", progress=100,
                          params=params or {}, metadata={"source_duration": 20}, result=self.result() if result is None else result,
                          error=None, lease_until=None, worker_token=None, created_at=created_at, updated_at=created_at))
        return id

    @staticmethod
    def result(**values):
        return {"synthetic": False, "experimental": True, "needs_review": True, "method_version": "pose-v1",
                "metrics": {"hip_sway_ratio": {"value": 0.25, "unit": "torso lengths"}},
                "quality": {"total_frames": 20, "usable_frames": 15, "ambiguous_frames": 0, "missing_frames": 5}, **values}

    def save(self, job="job-a", **values):
        return self.client.put(f"/api/jobs/{job}/assessment", json={"decision": "excluded", "subject_role": "coach",
                               "reason": "private technical observation", **values})

    def snapshot(self, **filters):
        return planning.read_snapshot(self.database.engine,
            {"start": "2026-01-01", "end": "2026-01-31", "athlete_id": None, **filters})

    def test_decisions_require_reason_and_server_owned_account(self):
        self.job()
        url = "/api/jobs/job-a/assessment"
        self.assertEqual(self.client.get(url).json(), {"current": None, "history": []})
        for invalid in ({"decision": "accepted", "subject_role": "athlete"},
                        {"decision": "excluded", "subject_role": "coach", "reason": "  "},
                        {"decision": "invented", "subject_role": "unknown", "reason": "observed"},
                        {"decision": "excluded", "subject_role": "opponent", "reason": "observed"},
                        {"decision": "excluded", "subject_role": "coach", "reason": "observed", "reviewer": "coach"}):
            with self.subTest(payload=invalid):
                self.assertEqual(self.client.put(url, json=invalid).status_code, 422)
        response = self.save(reason="  Person shown is the coach  ")
        self.assertEqual(response.status_code, 200, response.text)
        record = response.json()
        self.assertEqual((record["reviewer"], record["subject_role"], record["reason"]),
                         ("admin", "coach", "Person shown is the coach"))
        self.assertEqual(record["job_id"], "job-a")

    def test_v2_upgrade_adds_assessments_with_version_and_preserves_original_jobs(self):
        self.job()
        before = self.database.get(db.jobs, "job-a")
        with self.database.engine.begin() as connection:
            db.analysis_assessment_history.drop(connection)
            db.analysis_assessments.drop(connection)
            connection.execute(update(db.schema).values(version=2))
        self.database.initialize(self.settings.admin_password)
        self.database.initialize(self.settings.admin_password)
        self.assertEqual(self.database.rows(select(db.schema)), [{"version": 4}])
        self.assertEqual(self.database.get(db.jobs, "job-a"), before)
        self.assertEqual(self.client.get("/api/jobs/job-a/assessment").json(), {"current": None, "history": []})

    def test_assessment_requires_existing_job_login_and_csrf(self):
        self.assertEqual(self.client.get("/api/jobs/missing/assessment").status_code, 404)
        self.assertEqual(self.save("missing").status_code, 404)
        self.job()
        with TestClient(self.app) as outsider:
            self.assertEqual(outsider.get("/api/jobs/job-a/assessment").status_code, 401)
            self.assertEqual(outsider.put("/api/jobs/job-a/assessment", json={"decision": "pending"}).status_code, 401)
        self.client.headers.pop("X-CSRF-Token")
        self.assertEqual(self.save().status_code, 403)

    def test_synthetic_unready_and_unsupported_jobs_cannot_be_assessed(self):
        for index, values in enumerate(({"backend": "sample"}, {"result": self.result(synthetic=True)},
                                        {"result": {"metrics": {}}}, {"backend": "preprocess"},
                                        {"status": "running"}, {"status": "failed"})):
            with self.subTest(values=values):
                id = f"job-{index}"
                self.job(id, video=f"video-{index}", **values)
                self.assertEqual(self.save(id).status_code, 409)

    def test_acceptance_requires_known_metric_complete_quality_and_athlete_role(self):
        invalid = [self.result(metrics={"invented": {"value": 3}}), self.result(metrics={"hip_sway_ratio": {"value": True}}),
                   self.result(quality={}), self.result(quality={"total_frames": 20, "usable_frames": 9,
                       "ambiguous_frames": 0, "missing_frames": 11}),
                   self.result(quality={"total_frames": 20, "usable_frames": 11, "ambiguous_frames": 0, "missing_frames": 9}),
                   self.result(quality={"total_frames": 20, "usable_frames": 15, "ambiguous_frames": 1, "missing_frames": 4}),
                   self.result(quality={"total_frames": 20, "usable_frames": 15, "ambiguous_frames": 0, "missing_frames": 4})]
        for index, result in enumerate(invalid):
            self.job(f"job-{index}", video=f"video-{index}", result=result)
            response = self.save(f"job-{index}", decision="accepted", subject_role="athlete")
            self.assertEqual(response.status_code, 409, response.text)
        self.job()
        self.assertEqual(self.save(decision="accepted", subject_role="unknown").status_code, 409)
        self.assertEqual(self.save(decision="accepted", subject_role="coach").status_code, 409)
        self.assertEqual(self.save(decision="accepted", subject_role="athlete").status_code, 200)

    def test_target_track_acceptance_keeps_raw_review_flag_and_provenance(self):
        self.job(backend="rtmpose_tracking", params={"target_track_id": 3, "source_pose_job_id": "source-job"},
                 result=self.result(selected_track_id=3, source_pose_job_id="source-job"))
        before = self.database.get(db.jobs, "job-a")
        response = self.save(decision="accepted", subject_role="athlete")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.database.get(db.jobs, "job-a"), before)
        summary = analytics.summarize(self.snapshot())
        self.assertEqual(summary["review_counts"], {"reviewed": 1, "pending": 0, "accepted": 1, "excluded": 0, "superseded": 0})
        self.assertEqual(summary["quality_passed"], 0)
        self.assertEqual(summary["status_counts"]["needs_review"], 1)
        self.assertEqual(summary["measurements"][0]["target_track_id"], 3)
        self.assertEqual(summary["measurements"][0]["source_pose_job_id"], "source-job")
        self.assertEqual(self.snapshot()["measurements"], [])

    def test_sam2_acceptance_requires_sane_nonzero_segmentation_summary(self):
        for index, summary in enumerate(({}, {"segmented_frames": 0, "total_frames": 10, "object_count": 1},
                                         {"segmented_frames": 11, "total_frames": 10, "object_count": 1},
                                         {"segmented_frames": 2, "total_frames": 10, "object_count": 0},
                                         {"segmented_frames": True, "total_frames": 10, "object_count": 1})):
            self.job(f"job-{index}", video=f"video-{index}", backend="sam2",
                     result={"synthetic": False, "kind": "segmentation", "segmentation": summary})
            self.assertEqual(self.save(f"job-{index}", decision="accepted", subject_role="athlete").status_code, 409)
        self.job(backend="sam2", result={"synthetic": False, "kind": "segmentation",
                 "segmentation": {"segmented_frames": 2, "total_frames": 10, "object_count": 1, "prompted_objects": 1}})
        self.assertEqual(self.save(decision="accepted", subject_role="athlete").status_code, 200)
        self.assertEqual(analytics.summarize(self.snapshot())["review_counts"]["reviewed"], 0)

    def test_exclusion_closes_review_pending_reopens_and_history_preserves_all_saves(self):
        self.job()
        before = self.database.get(db.jobs, "job-a")
        self.assertEqual(analytics.summarize(self.snapshot())["needs_review"], 1)
        first = self.save().json()
        closed = analytics.summarize(self.snapshot())
        self.assertEqual((closed["needs_review"], closed["review_queue"], closed["measurement_count"]), (0, [], 0))
        self.assertEqual(closed["by_session"][0]["review_needed"], 0)
        second = self.save(decision="pending", subject_role="unknown", reason="").json()
        data = self.client.get("/api/jobs/job-a/assessment").json()
        self.assertEqual(data["current"], second)
        self.assertEqual([row["snapshot"] for row in data["history"]], [first, second])
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len({row["id"] for row in data["history"]}), 2)
        reopened = analytics.summarize(self.snapshot())
        self.assertEqual((reopened["needs_review"], reopened["review_counts"]["pending"]), (1, 1))
        self.assertEqual(self.database.get(db.jobs, "job-a"), before)
        self.assertEqual(self.database.rows(select(db.reviews)), [])
        self.assertEqual(self.database.rows(select(db.manual_scores)), [])

    def test_full_report_and_job_surfaces_expose_current_and_history(self):
        self.job()
        record = self.save().json()
        self.assertEqual(self.client.get("/api/jobs/job-a").json()["assessment"], record)
        self.assertEqual(self.client.get("/api/videos/video-a").json()["latest_job"]["assessment"], record)
        self.assertEqual(self.client.get("/api/dashboard").json()["recent_jobs"][0]["assessment"], record)
        report = self.client.get("/api/videos/video-a/report").json()
        self.assertEqual(report["jobs"][0]["assessment"], record)
        self.assertEqual(report["assessment_history"][0]["snapshot"], record)

    def test_snapshot_scope_filters_assessments_by_session_date_and_athlete(self):
        self.job()
        self.save()
        self.database.add(db.athletes, dict(id="athlete-b", name="other private athlete", level="", created_at=db.now()))
        self.job("job-b", video="video-b", athlete="athlete-b")
        self.save("job-b")
        self.job("job-old", video="video-old", date="2025-12-31")
        self.save("job-old")
        self.assertEqual([row["job_id"] for row in self.snapshot(athlete_id="athlete-a")["assessments"]], ["job-a"])

    def test_latest_tracking_deduplicates_review_and_csv_keeps_excluded_raw_metrics(self):
        self.job("job-old", status="completed", result=self.result(needs_review=False))
        self.job(backend="rtmpose_tracking", created_at="2026-01-08T00:00:00+00:00",
                 params={"target_track_id": 3, "source_pose_job_id": "job-old"})
        self.save(decision="superseded", reason="private duplicate measurement")
        self.job("job-sam", backend="sam2", created_at="2026-01-09T00:00:00+00:00")
        data = self.snapshot()
        summary = analytics.summarize(data)
        self.assertEqual((summary["analyzed_videos"], summary["measurement_count"], summary["needs_review"]), (1, 0, 0))
        self.assertEqual(summary["review_counts"], {"reviewed": 1, "pending": 0, "accepted": 0, "excluded": 0, "superseded": 1})
        text = analytics.export_csv(data).decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["job_id"], rows[0]["hip_sway_ratio"], rows[0]["assessment_decision"],
                          rows[0]["target_track_id"], rows[0]["source_pose_job_id"]),
                         ("job-a", "0.25", "superseded", "3", "job-old"))
        self.assertNotIn("private", text)
        self.assertNotIn("reviewer", text)

    def test_review_queue_uses_latest_terminal_real_pose_even_during_retry(self):
        self.job(status="completed", result=self.result(needs_review=False))
        self.job("job-retry", status="queued", result={}, created_at="2026-01-08T00:00:00+00:00")
        summary = analytics.summarize(self.snapshot())
        self.assertEqual(summary["status_counts"]["queued"], 1)
        self.assertEqual(summary["review_counts"], {"reviewed": 0, "pending": 1, "accepted": 0, "excluded": 0, "superseded": 0})
        self.assertEqual(summary["review_queue"][0]["job_id"], "job-a")

    def test_explicit_exclusion_removes_legacy_verified_measurement_but_acceptance_does_not_admit_one(self):
        self.job(status="completed", result=self.result(needs_review=False))
        self.database.add(db.drafts, dict(id="draft-a", video_id="video-a", job_id="job-a", provider="rules", model="rules-v1",
                          synthetic=False, text="", facts={}, created_at=db.now()))
        self.database.add(db.reviews, dict(id="review-a", video_id="video-a", draft_id="draft-a", observations="private review",
                          next_action="", confirmed=True, confirmed_by="admin", updated_at=db.now()))
        self.assertEqual(len(self.snapshot()["measurements"]), 1)
        self.save()
        self.assertEqual(self.snapshot()["measurements"], [])
        self.job("job-b", video="video-b", status="completed")
        self.save("job-b", decision="accepted", subject_role="athlete")
        self.assertEqual(self.snapshot()["measurements"], [])

    def test_job_deletion_cascades_current_decision_and_history(self):
        self.job()
        self.save()
        self.save(decision="pending", reason="")
        with self.database.engine.begin() as connection:
            connection.execute(delete(db.jobs).where(db.jobs.c.id == "job-a"))
        self.assertEqual(self.database.rows(select(db.analysis_assessments)), [])
        self.assertEqual(self.database.rows(select(db.analysis_assessment_history)), [])

    def test_history_failure_rolls_back_decision(self):
        self.job()
        first = self.save().json()
        with self.database.engine.begin() as connection:
            connection.exec_driver_sql("CREATE TRIGGER reject_assessment_history BEFORE INSERT ON analysis_assessment_history "
                                       "BEGIN SELECT RAISE(ABORT, 'history rejected'); END")
        with TestClient(self.app, raise_server_exceptions=False) as caller:
            caller.cookies.update(self.client.cookies)
            caller.headers["X-CSRF-Token"] = self.client.headers["X-CSRF-Token"]
            response = caller.put("/api/jobs/job-a/assessment", json={"decision": "pending", "subject_role": "unknown", "reason": ""})
            self.assertEqual(response.status_code, 500)
        data = self.client.get("/api/jobs/job-a/assessment").json()
        self.assertEqual(data["current"], first)
        self.assertEqual([row["snapshot"] for row in data["history"]], [first])

    def test_current_and_history_are_read_from_one_snapshot_during_concurrent_save(self):
        self.job()
        first = self.save().json()
        second = {**first, "decision": "pending", "reason": "", "updated_at": "2027-01-09T00:00:00+00:00"}
        saved = False

        def concurrent_save(connection, cursor, statement, parameters, context, executemany):
            nonlocal saved
            if not saved and statement.startswith("SELECT") and "FROM analysis_assessment_history" in statement:
                saved = True
                with self.database.engine.begin() as writer:
                    writer.execute(update(db.analysis_assessments).where(db.analysis_assessments.c.job_id == "job-a").values(**second))
                    writer.execute(db.analysis_assessment_history.insert().values(id="concurrent-save", job_id="job-a",
                                   snapshot=second, created_at=second["updated_at"]))

        event.listen(self.database.engine, "before_cursor_execute", concurrent_save)
        try:
            data = self.client.get("/api/jobs/job-a/assessment").json()
        finally:
            event.remove(self.database.engine, "before_cursor_execute", concurrent_save)
        self.assertTrue(saved)
        self.assertEqual(data["current"], first)
        self.assertEqual([row["snapshot"] for row in data["history"]], [first])
        self.assertEqual(self.client.get("/api/jobs/job-a/assessment").json()["current"], second)


if __name__ == "__main__":
    unittest.main()
