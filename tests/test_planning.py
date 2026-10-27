"""Planning and period-analysis contracts against isolated real SQLite records."""
import csv
import io
import json
import tempfile
import unittest
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import uuid4
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select

from arena import db
from arena.api import create_app
from arena.config import Settings


class PlanningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = Settings(data_dir=Path(self.tmp.name), admin_password="test-password-123456")
        self.app = create_app(self.settings)
        self.client = TestClient(self.app).__enter__()
        login = self.client.post("/api/login", json={"username": "admin", "password": "test-password-123456"})
        self.client.headers["X-CSRF-Token"] = login.json()["csrf"]
        self.athlete = self.client.post("/api/athletes", json={"name": "private athlete"}).json()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def plan(self, **values):
        payload = {"athlete_id": self.athlete["id"], "date": "2026-01-07", "category": "attack",
                   "objective": "private objective", "planned_minutes": 60, **values}
        result = self.client.post("/api/plans", json=payload)
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()

    def session(self, **values):
        payload = {"athlete_id": self.athlete["id"], "date": "2026-01-07", "duration_min": 60,
                   "notes": "private session notes", **values}
        result = self.client.post("/api/sessions", json=payload)
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()

    def insights(self, **filters):
        result = self.client.get("/api/insights", params={"start": "2026-01-01", "end": "2026-01-31", **filters})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def measurement(self, session, *, backend="rtmpose", status="completed", synthetic=False,
                    confirmed=True, value=0.25, draft_synthetic=False):
        """Insert recorded analysis artifacts without running inference or using external media."""
        video_id, job_id, draft_id = (str(uuid4()) for _ in range(3))
        database = self.app.state.ctx.db
        database.add(db.videos, dict(id=video_id, session_id=session["id"], category="attack",
                     filename="private source.mp4", storage_key="private/storage/path", sha256="a" * 64,
                     size_bytes=42, status="ready", authorized_at=db.now(), created_at=db.now()))
        result = {"synthetic": synthetic, "method_version": "pose2d-test-v1", "sample_fps": 10,
                  "roi": [0, 0, 1, 1], "model_sha256": {"pose": "b" * 64},
                  "metrics": {"hip_sway_ratio": {"value": value, "unit": "torso lengths", "status": "ok"},
                              "trunk_lean_deg": {"value": None, "unit": "deg", "status": "insufficient"}},
                  "quality": {"usable_frame_ratio": 0.8}, "limitations": ["experimental"]}
        database.add(db.jobs, dict(id=job_id, video_id=video_id, backend=backend, status=status, stage="done",
                     progress=100, params={"start_sec": 0, "end_sec": None, "roi": None},
                     metadata={"source_duration": 10}, result=result, error=None, lease_until=None,
                     worker_token=None, created_at=db.now(), updated_at=db.now()))
        database.add(db.drafts, dict(id=draft_id, video_id=video_id, job_id=job_id, provider="rules",
                     model="rules-v1", synthetic=draft_synthetic, text="private draft", facts=result, created_at=db.now()))
        database.add(db.reviews, dict(id=str(uuid4()), video_id=video_id, draft_id=draft_id,
                     observations="private review", next_action="private action", confirmed=confirmed,
                     confirmed_by="private username", updated_at=db.now()))
        return video_id, job_id

    def test_plan_links_once_and_rejects_mismatched_or_cancelled_sessions_atomically(self):
        plan = self.plan()
        self.assertEqual((plan["status"], plan["session_id"], plan["athlete_name"]),
                         ("planned", None, "private athlete"))
        other = self.client.post("/api/athletes", json={"name": "another"}).json()
        payload = {"athlete_id": other["id"], "date": "2026-01-07", "plan_id": plan["id"]}
        self.assertEqual(self.client.post("/api/sessions", json=payload).status_code, 409)
        self.assertEqual(self.client.get("/api/sessions").json(), [])
        session = self.session(plan_id=plan["id"], rpe=5)
        plans = self.client.get("/api/plans", params={"athlete_id": self.athlete["id"]}).json()
        self.assertEqual((plans[0]["status"], plans[0]["session_id"]), ("completed", session["id"]))
        payload["athlete_id"] = self.athlete["id"]
        self.assertEqual(self.client.post("/api/sessions", json=payload).status_code, 409)
        self.assertEqual(len(self.client.get("/api/sessions").json()), 1)
        self.assertEqual(self.client.patch(f"/api/plans/{plan['id']}", json={"status": "cancelled"}).status_code, 409)
        self.assertEqual(self.client.put(f"/api/sessions/{session['id']}", json={"athlete_id": other["id"],
                         "date": "2026-01-07"}).status_code, 409)
        cancelled = self.plan()
        self.assertEqual(self.client.patch(f"/api/plans/{cancelled['id']}", json={"status": "cancelled"}).status_code, 200)
        payload["plan_id"] = cancelled["id"]
        self.assertEqual(self.client.post("/api/sessions", json=payload).status_code, 409)
        self.assertEqual(self.client.patch(f"/api/plans/{cancelled['id']}", json={"status": "planned"}).json()["status"], "planned")

    def test_plan_validation_filtering_and_security(self):
        other = self.client.post("/api/athletes", json={"name": "other"}).json()
        self.plan(athlete_id=other["id"])
        self.assertEqual(self.client.get("/api/plans", params={"athlete_id": self.athlete["id"]}).json(), [])
        for values in ({"planned_minutes": 0}, {"planned_minutes": 1441}, {"date": "bad"}, {"category": "fake"}):
            payload = {"athlete_id": self.athlete["id"], "date": "2026-01-01", "category": "attack",
                       "planned_minutes": 60, "objective": "", **values}
            self.assertEqual(self.client.post("/api/plans", json=payload).status_code, 422)
        self.assertEqual(self.client.get("/api/plans?athlete_id=missing").status_code, 404)
        self.assertEqual(self.client.post("/api/sessions", json={"athlete_id": self.athlete["id"],
                         "date": "2026-01-07", "plan_id": "missing"}).status_code, 404)
        self.client.headers.pop("X-CSRF-Token")
        self.assertEqual(self.client.post("/api/plans", json={}).status_code, 403)
        with TestClient(self.app) as outsider:
            self.assertEqual(outsider.get("/api/insights").status_code, 401)
            self.assertEqual(outsider.get("/api/insights/export").status_code, 401)

    def test_empty_and_missing_rpe_remain_null_with_type7_statistics(self):
        empty = self.insights()
        self.assertEqual(empty["summary"], {"session_count": 0, "total_minutes": 0, "load_au": None,
                         "rpe_recorded": 0, "video_count": 0, "reviewed_videos": 0,
                         "verified_measurements": 0, "annotation_count": 0})
        self.assertEqual(empty["statistics"]["duration_min"], {"n": 0, "median": None, "q1": None, "q3": None})
        self.assertIsNone(empty["planning"]["completion_rate"])
        self.session(duration_min=10, date="2026-01-04")
        single = self.insights()
        self.assertEqual(single["statistics"]["duration_min"], {"n": 1, "median": 10, "q1": 10, "q3": 10})
        self.assertIsNone(single["summary"]["load_au"])
        self.session(duration_min=20, rpe=0, date="2026-01-05")
        self.session(duration_min=30, rpe=5, date="2026-01-06")
        self.session(duration_min=100, rpe=10, date="2026-01-07")
        self.session(duration_min=999, rpe=10, date="2025-12-31")
        result = self.insights()
        self.assertEqual(result["summary"]["session_count"], 4)
        self.assertEqual(result["summary"]["total_minutes"], 160)
        self.assertEqual((result["summary"]["load_au"], result["summary"]["rpe_recorded"]), (1150, 3))
        self.assertEqual(result["statistics"]["duration_min"], {"n": 4, "median": 25, "q1": 17.5, "q3": 47.5})
        self.assertEqual(result["statistics"]["rpe"], {"n": 3, "median": 5, "q1": 2.5, "q3": 7.5})
        self.assertEqual(result["weekly"], [
            {"week_start": "2025-12-29", "session_count": 1, "minutes": 10, "load_au": None, "rpe_recorded": 0},
            {"week_start": "2026-01-05", "session_count": 3, "minutes": 150, "load_au": 1150, "rpe_recorded": 3}])

    def test_date_ranges_defaults_and_athlete_scope(self):
        for filters in ({"start": "bad"}, {"start": "2026-02-01", "end": "2026-01-01"}):
            self.assertEqual(self.client.get("/api/insights", params=filters).status_code, 422)
            self.assertEqual(self.client.get("/api/insights/export", params=filters).status_code, 422)
        self.assertEqual(self.client.get("/api/insights?athlete_id=missing").status_code, 404)
        self.session(rpe=5)
        other = self.client.post("/api/athletes", json={"name": "other"}).json()
        self.session(athlete_id=other["id"], duration_min=100, rpe=10)
        self.assertEqual(self.insights(athlete_id=self.athlete["id"])["summary"]["total_minutes"], 60)
        with patch("arena.config.datetime") as clock:
            clock.now.return_value = datetime(2026, 1, 1, 23, 30, tzinfo=timezone.utc)
            filters = self.client.get("/api/insights").json()["filters"]
        self.assertEqual(filters["end"], "2026-01-02")
        self.assertEqual((date.fromisoformat(filters["end"]) - date.fromisoformat(filters["start"])).days, 55)

    def test_default_insights_include_existing_history_and_keep_explicit_periods(self):
        self.session(date="2026-07-25", duration_min=180)
        other = self.client.post("/api/athletes", json={"name": "other athlete"}).json()
        self.session(athlete_id=other["id"], date="2026-06-01", duration_min=30)
        with patch("arena.config.datetime") as clock:
            clock.now.return_value = datetime(2026, 10, 27, 4, tzinfo=timezone.utc)
            all_data = self.client.get("/api/insights").json()
            self.assertEqual(all_data["filters"], {"start": "2026-06-01", "end": "2026-10-27", "athlete_id": None})
            self.assertEqual(all_data["summary"]["total_minutes"], 210)
            scoped = self.client.get("/api/insights", params={"athlete_id": self.athlete["id"]}).json()
            self.assertEqual(scoped["filters"]["start"], "2026-07-25")
            self.assertEqual(scoped["summary"]["total_minutes"], 180)
            explicit = self.client.get("/api/insights?start=2026-09-02&end=2026-10-27").json()
            self.assertEqual(explicit["summary"]["session_count"], 0)
            self.assertEqual(explicit["filters"]["start"], "2026-09-02")
            response = self.client.get("/api/insights/export")
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                self.assertEqual(json.loads(archive.read("manifest.json"))["filters"], all_data["filters"])

    def test_batch_analysis_is_visible_across_surfaces_and_exports_without_private_text(self):
        session = self.session()
        video_id, job_id = self.measurement(session)
        insights = self.insights()
        overview = insights.get("analysis")
        self.assertIsNotNone(overview, "Stored analyses must be visible before opening individual videos")
        self.assertEqual(overview["video_count"], 1)
        self.assertEqual(overview["analyzed_videos"], 1)
        self.assertEqual(overview["measurements"][0]["video_id"], video_id)
        self.assertEqual(overview["measurements"][0]["job_id"], job_id)
        self.assertEqual(self.client.get("/api/dashboard").json()["analysis"]["analyzed_videos"], 1)
        self.assertEqual(self.client.get(f"/api/athletes/{self.athlete['id']}/profile").json()["analysis"]["analyzed_videos"], 1)
        response = self.client.get("/api/insights/analyses.csv?start=2026-01-01&end=2026-01-31")
        self.assertEqual(response.status_code, 200, response.text)
        rows = list(csv.DictReader(io.StringIO(response.content.decode('utf-8-sig'))))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["job_id"], job_id)
        for private in ("private source.mp4", "private athlete", "private review", "private/storage/path", "private username"):
            self.assertNotIn(private, response.text)
        with TestClient(self.app) as outsider:
            self.assertEqual(outsider.get("/api/insights/analyses.csv").status_code, 401)

    def test_profile_and_dashboard_counts_use_the_same_analysis_snapshot(self):
        from arena import planning
        session = self.session()
        read = planning.read_snapshot
        def upload_during_request(engine, filters):
            self.measurement(session)
            return read(engine, filters)
        for path in ('/api/dashboard', f"/api/athletes/{self.athlete['id']}/profile"):
            with patch('arena.api.planning.read_snapshot', side_effect=upload_during_request):
                response = self.client.get(path)
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body['video_count'], body['analysis']['video_count'])

    def test_dashboard_training_score_uses_only_actual_approved_reviews(self):
        self.assertEqual(self.client.get('/api/dashboard').json().get('review_scores', {}).get('n'), 0)
        session = self.session()
        video_id, _ = self.measurement(session)
        url = f'/api/videos/{video_id}/score'
        response = self.client.put(url, json={'score': 8.5, 'comment': 'Observed complete practice sequence.', 'confirmed': True})
        self.assertEqual(response.status_code, 200)
        scores = self.client.get('/api/dashboard').json()['review_scores']
        self.assertEqual((scores['n'], scores['mean']), (1, 8.5))
        self.client.put(url, json={'score': 7, 'comment': 'Review being revised.', 'confirmed': False})
        scores = self.client.get('/api/dashboard').json()['review_scores']
        self.assertEqual((scores['n'], scores['mean']), (0, None))

    def test_completion_excludes_cancelled_future_plans_and_sessions_after_cutoff(self):
        completed = self.plan(date="2026-01-01")
        self.session(date="2026-01-02", plan_id=completed["id"])
        after = self.plan(date="2026-01-03")
        self.session(date="2026-02-02", plan_id=after["id"])
        self.plan(date="2026-01-04")
        cancelled = self.plan(date="2026-01-05")
        self.client.patch(f"/api/plans/{cancelled['id']}", json={"status": "cancelled"})
        self.plan(date="2026-02-01")
        result = self.insights()
        self.assertEqual(result["planning"], {"due_count": 3, "completed_count": 1, "cancelled_count": 1,
                         "completion_rate": 1 / 3})
        future_plan = self.plan(date="2026-02-07")
        self.session(date="2026-01-31", plan_id=future_plan["id"])
        with patch("arena.config.datetime") as clock:
            clock.now.return_value = datetime(2026, 1, 31, 12, tzinfo=timezone.utc)
            planning = self.insights(start="2026-01-31", end="2026-02-07")["planning"]
        self.assertEqual((planning["due_count"], planning["completed_count"]), (0, 0))

    def test_workspace_day_controls_defaults_completion_and_export_at_utc_midnight(self):
        plan = self.plan(date="2026-01-02")
        self.session(date="2026-01-02", plan_id=plan["id"])
        # At the same instant, Shanghai is already Jan 2 while UTC remains Jan 1.
        instant = datetime(2026, 1, 1, 23, 30, tzinfo=timezone.utc)
        for zone, today, due in (("UTC", "2026-01-01", 0), ("Asia/Shanghai", "2026-01-02", 1)):
            self.settings.timezone = zone
            with self.subTest(timezone=zone), patch("arena.config.datetime", create=True) as clock:
                clock.now.return_value = instant
                defaults = self.client.get("/api/insights").json()
                self.assertEqual(defaults["filters"]["end"], today)
                result = self.insights(start="2026-01-01", end="2026-01-03")
                self.assertEqual((result["planning"]["due_count"], result["planning"]["completed_count"]), (due, due))
                response = self.client.get("/api/insights/export?start=2026-01-01&end=2026-01-03")
                with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["timezone"], zone)
                self.assertEqual(manifest["as_of_date"], today)
                self.assertEqual(manifest["completion_cutoff_date"], today)
                self.assertEqual(manifest["summary"]["planning"], result["planning"])

    def test_login_and_me_expose_configured_workspace_timezone(self):
        self.assertEqual(self.client.get("/api/me").json().get("timezone"), "Asia/Shanghai")
        self.settings.timezone = "America/New_York"
        login = self.client.post("/api/login", json={"username": "admin", "password": "test-password-123456"})
        self.assertEqual(login.json().get("timezone"), "America/New_York")
        self.assertEqual(self.client.get("/api/me").json().get("timezone"), "America/New_York")

    def test_verified_measurements_require_confirmed_real_eligible_jobs_with_values(self):
        session = self.session()
        self.measurement(session)
        for values in ({"synthetic": True}, {"backend": "sample"}, {"confirmed": False},
                       {"status": "failed"}, {"backend": "wham"}, {"value": None}, {"draft_synthetic": True}):
            self.measurement(session, **values)
        result = self.insights()
        self.assertEqual(result["summary"]["video_count"], 8)
        self.assertEqual(result["summary"]["reviewed_videos"], 7)
        self.assertEqual(result["summary"]["verified_measurements"], 1)
        self.assertEqual(result["category_counts"], {"stability": 0, "footwork": 0, "attack": 8, "defense": 0, "mixed": 0})

    def test_export_is_filtered_private_traceable_and_formula_safe(self):
        plan = self.plan(objective="secret objective")
        session = self.session(rpe=5, plan_id=plan["id"])
        video_id, job_id = self.measurement(session)
        self.measurement(session, synthetic=True)
        self.app.state.ctx.db.add(db.events, dict(id=str(uuid4()), video_id=video_id, start_sec=1,
                     end_sec=2, label="=HYPERLINK(\"bad\")", actor="athlete", outcome="+formula",
                     notes="private event notes", created_by="private username", created_at=db.now()))
        other = self.client.post("/api/athletes", json={"name": "other private name"}).json()
        self.session(athlete_id=other["id"])
        response = self.client.get("/api/insights/export", params={"start": "2026-01-01", "end": "2026-01-31",
                                   "athlete_id": self.athlete["id"]})
        self.assertEqual(response.status_code, 200, response.text if response.status_code != 200 else "")
        self.assertEqual(response.headers["content-type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertEqual(set(archive.namelist()), {"sessions.csv", "plans.csv", "metrics.csv", "events.csv", "scores.csv",
                                                     "manifest.json", "data_dictionary.json"})
            all_text = "\n".join(archive.read(name).decode() for name in archive.namelist())
            for secret in ("private athlete", "private session notes", "secret objective", "private source.mp4",
                           "private/storage/path", "private review", "private username", "private event notes"):
                self.assertNotIn(secret, all_text)
            read = lambda name: list(csv.DictReader(io.StringIO(archive.read(name).decode())))
            sessions = read("sessions.csv")
            self.assertEqual(len(sessions), 1)
            self.assertEqual(sessions[0]["session_id"], session["id"])
            self.assertEqual(sessions[0]["load_au"], "300")
            metrics = read("metrics.csv")
            self.assertEqual(len(metrics), 2)  # Null metric retained for the eligible real analysis.
            self.assertEqual({m["job_id"] for m in metrics}, {job_id})
            self.assertEqual(metrics[0]["method_version"], "pose2d-test-v1")
            self.assertIn("usable_frame_ratio", metrics[0]["quality_json"])
            self.assertIn("model_sha256_json", metrics[0])
            self.assertEqual(read("events.csv")[0]["label"], "'=HYPERLINK(\"bad\")")
            self.assertEqual(read("events.csv")[0]["outcome"], "'+formula")
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["filters"], {"start": "2026-01-01", "end": "2026-01-31", "athlete_id": self.athlete["id"]})
            self.assertEqual(manifest["counts"]["sessions"], 1)
            self.assertIn("columns", json.loads(archive.read("data_dictionary.json")))
        empty = self.client.get("/api/insights/export?start=2000-01-01&end=2000-01-01")
        with zipfile.ZipFile(io.BytesIO(empty.content)) as archive:
            for name in ("sessions.csv", "plans.csv", "metrics.csv", "events.csv", "scores.csv"):
                self.assertEqual(len(archive.read(name).decode().splitlines()), 1)


class MigrationTests(unittest.TestCase):
    def test_v1_records_and_credentials_survive_additive_idempotent_migration(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(data_dir=Path(tmp), admin_password="test-password-123456")
            settings.validate()
            database = db.Database(settings)
            # Build the exact legacy tables without the new training_plans table.
            with database.engine.begin() as connection:
                db.meta.create_all(connection, tables=[table for table in db.meta.sorted_tables
                                   if table.name not in ("training_plans", "manual_scores", "score_history")])
                connection.execute(db.schema.insert().values(version=1))
                connection.execute(db.users.insert().values(id="legacy-user", username="admin", password_hash="preserved-hash"))
                connection.execute(db.athletes.insert().values(id="legacy-athlete", name="retained", level="", created_at=db.now()))
                connection.execute(db.sessions.insert().values(id="legacy-session", athlete_id="legacy-athlete",
                                   date="2026-01-01", objective="retained objective", duration_min=45,
                                   rpe=None, notes="retained notes", created_at=db.now()))
            database.initialize("replacement-must-not-overwrite")
            database.initialize("replacement-must-not-overwrite")
            self.assertEqual(database.rows(select(db.schema))[0]["version"], 4)
            self.assertEqual(database.get(db.users, "legacy-user")["password_hash"], "preserved-hash")
            self.assertEqual(database.get(db.sessions, "legacy-session")["notes"], "retained notes")
            with database.engine.connect() as connection:
                self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM training_plans").scalar(), 0)
                self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])
            database.engine.dispose()
