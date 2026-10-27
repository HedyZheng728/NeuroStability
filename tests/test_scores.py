"""Training review scores use actual API requests and disposable SQLite records."""
import csv
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from arena import db
from arena.api import create_app
from arena.config import Settings


class ScoreTests(unittest.TestCase):
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

    def video(self, *, day="2026-07-25", athlete=None, category="mixed"):
        session = self.client.post("/api/sessions", json={"athlete_id": (athlete or self.athlete)["id"],
                                   "date": day, "duration_min": 180, "notes": "private session notes"})
        self.assertEqual(session.status_code, 201, session.text)
        video = self.client.post("/api/videos", data={"session_id": session.json()["id"], "category": category,
                                "authorized": "true"}, files={"file": ("private source.mov", b"recorded source", "video/quicktime")})
        self.assertEqual(video.status_code, 201, video.text)
        return video.json()

    def save(self, video, **values):
        response = self.client.put(f"/api/videos/{video['id']}/score", json={"score": 7.5,
                                   "comment": "private coach comment", "confirmed": True, **values})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_unscored_video_stays_null_in_score_and_report(self):
        video = self.video()
        response = self.client.get(f"/api/videos/{video['id']}/score")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"current": None, "history": []})
        report = self.client.get(f"/api/videos/{video['id']}/report").json()
        self.assertIsNone(report["score"])
        self.assertEqual(report["score_history"], [])

    def test_video_library_exposes_current_score_without_private_comment(self):
        video = self.video()
        row = next(row for row in self.client.get('/api/videos').json() if row['id'] == video['id'])
        self.assertIn('score', row)
        self.assertIsNone(row['score'])
        self.save(video, score=8.5)
        row = next(row for row in self.client.get('/api/videos').json() if row['id'] == video['id'])
        self.assertEqual(row['score'], {'score': 8.5, 'confirmed': True})
        self.assertNotIn('comment', row['score'])

    def test_score_range_confirmation_and_server_owned_provenance(self):
        video = self.video()
        url = f"/api/videos/{video['id']}/score"
        for invalid in ({}, {"score": -0.01}, {"score": 10.01}, {"score": None}, {"score": True},
                        {"score": "7"}, {"score": 7, "comment": "  ", "confirmed": True},
                        {"score": 7, "assessor": "invented"}, {"score": 7, "rubric_version": "invented"}):
            with self.subTest(payload=invalid):
                self.assertEqual(self.client.put(url, json=invalid).status_code, 422)
        self.assertEqual(self.client.get(url).json(), {"current": None, "history": []})
        first = self.save(video, score=0, comment="", confirmed=False)
        self.assertEqual(first["score"], 0)
        self.assertFalse(first["confirmed"])
        self.assertEqual(first["assessor"], "admin")
        self.assertEqual(first["rubric_version"], "training-review-10-v1")
        self.assertEqual(first["video_id"], video["id"])
        last = self.save(video, score=10, comment="  Human observation  ")
        self.assertEqual(last["score"], 10)
        self.assertEqual(last["comment"], "Human observation")

    def test_every_save_appends_immutable_snapshot_and_preserves_current_id(self):
        video = self.video()
        first = self.save(video, score=4, confirmed=False)
        second = self.save(video, score=6.5)
        third = self.save(video, score=6.5)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(second["id"], third["id"])
        data = self.client.get(f"/api/videos/{video['id']}/score").json()
        self.assertEqual(data["current"], third)
        self.assertEqual([row["snapshot"] for row in data["history"]], [first, second, third])
        self.assertEqual(len({row["id"] for row in data["history"]}), 3)
        self.assertTrue(all(row["video_id"] == video["id"] and row["created_at"] for row in data["history"]))
        report = self.client.get(f"/api/videos/{video['id']}/report").json()
        self.assertEqual(report["score"], third)
        self.assertEqual(report["score_history"], data["history"])
        # Re-opening the API against the same disposable DB retains all snapshots.
        with TestClient(create_app(self.settings)) as reopened:
            login = reopened.post("/api/login", json={"username": "admin", "password": "test-password-123456"})
            self.assertEqual(login.status_code, 200)
            self.assertEqual(reopened.get(f"/api/videos/{video['id']}/score").json(), data)

    def test_saving_new_method_keeps_historical_rubric_and_source_account(self):
        video = self.video()
        original = self.save(video)
        original["rubric_version"] = "coach-review-10-v1"
        database = self.app.state.ctx.db
        with database.engine.begin() as connection:
            connection.execute(db.manual_scores.update().where(db.manual_scores.c.id == original["id"])
                               .values(rubric_version=original["rubric_version"]))
            connection.execute(db.score_history.update().where(db.score_history.c.video_id == video["id"])
                               .values(snapshot=original))
        before = self.client.get(f"/api/videos/{video['id']}/score").json()
        self.assertEqual(before["current"]["rubric_version"], "coach-review-10-v1")
        saved = self.save(video, score=8, comment="Observed stable recovery.")
        after = self.client.get(f"/api/videos/{video['id']}/score").json()
        self.assertEqual(after["current"]["rubric_version"], "training-review-10-v1")
        self.assertEqual(after["current"]["assessor"], "admin")
        self.assertEqual([row["snapshot"] for row in after["history"]], [original, saved])

    def test_failed_history_insert_rolls_back_new_and_updated_score(self):
        video = self.video()
        url = f"/api/videos/{video['id']}/score"
        database = self.app.state.ctx.db
        with database.engine.begin() as connection:
            connection.exec_driver_sql("CREATE TRIGGER reject_score_history BEFORE INSERT ON score_history "
                                       "BEGIN SELECT RAISE(ABORT, 'history rejected'); END")
        with TestClient(self.app, raise_server_exceptions=False) as caller:
            caller.cookies.update(self.client.cookies)
            caller.headers["X-CSRF-Token"] = self.client.headers["X-CSRF-Token"]
            self.assertEqual(caller.put(url, json={"score": 5}).status_code, 500)
        self.assertEqual(self.client.get(url).json(), {"current": None, "history": []})
        with database.engine.begin() as connection:
            connection.exec_driver_sql("DROP TRIGGER reject_score_history")
        first = self.save(video)
        with database.engine.begin() as connection:
            connection.exec_driver_sql("CREATE TRIGGER reject_score_history BEFORE INSERT ON score_history "
                                       "BEGIN SELECT RAISE(ABORT, 'history rejected'); END")
        with TestClient(self.app, raise_server_exceptions=False) as caller:
            caller.cookies.update(self.client.cookies)
            caller.headers["X-CSRF-Token"] = self.client.headers["X-CSRF-Token"]
            self.assertEqual(caller.put(url, json={"score": 2}).status_code, 500)
        data = self.client.get(url).json()
        self.assertEqual(data["current"], first)
        self.assertEqual([row["snapshot"] for row in data["history"]], [first])

    def test_score_requires_existing_video_login_and_csrf(self):
        self.assertEqual(self.client.get("/api/videos/missing/score").status_code, 404)
        self.assertEqual(self.client.put("/api/videos/missing/score", json={"score": 5}).status_code, 404)
        video = self.video()
        url = f"/api/videos/{video['id']}/score"
        with TestClient(self.app) as outsider:
            self.assertEqual(outsider.get(url).status_code, 401)
            self.assertEqual(outsider.put(url, json={"score": 5}).status_code, 401)
        self.client.headers.pop("X-CSRF-Token")
        self.assertEqual(self.client.put(url, json={"score": 5}).status_code, 403)

    def test_only_current_confirmed_scores_enter_filtered_statistics(self):
        filters = {"start": "2026-07-25", "end": "2026-07-25", "athlete_id": self.athlete["id"]}
        self.assertEqual(self.client.get("/api/insights", params=filters).json()["manual_scores"],
                         {"n": 0, "mean": None, "median": None, "q1": None, "q3": None,
                          "distribution": [], "by_category": {}})
        video = self.video()
        self.save(video, score=0)
        single = self.client.get("/api/insights", params=filters).json()
        self.assertEqual(single["manual_scores"], {"n": 1, "mean": 0, "median": 0, "q1": 0, "q3": 0,
                         "distribution": [{"score": 0, "n": 1}], "by_category": {"mixed": {"n": 1, "mean": 0}}})
        self.assertEqual(single["category_counts"]["mixed"], 1)
        for value in (2, 6, 10):
            self.save(self.video(), score=value)
        draft = self.video()
        self.save(draft, score=9)
        self.save(draft, score=1, confirmed=False)  # Prior confirmations do not remain eligible.
        self.save(self.video(day="2026-07-24"), score=8)
        self.save(self.video(day="2026-07-26"), score=8)
        other = self.client.post("/api/athletes", json={"name": "other private athlete"}).json()
        self.save(self.video(athlete=other), score=8)
        result = self.client.get("/api/insights", params=filters).json()
        self.assertEqual(result["manual_scores"], {"n": 4, "mean": 4.5, "median": 4, "q1": 1.5, "q3": 7,
                         "distribution": [{"score": 0, "n": 1}, {"score": 2, "n": 1},
                                          {"score": 6, "n": 1}, {"score": 10, "n": 1}],
                         "by_category": {"mixed": {"n": 4, "mean": 4.5}}})
        self.assertIsNone(result["summary"]["load_au"])
        self.assertEqual(result["summary"]["verified_measurements"], 0)

    def test_score_distribution_preserves_decimal_values_and_current_category_observations(self):
        self.save(self.video(), score=0)
        current = self.video()
        self.save(current, score=1)
        self.save(current, score=7.25)
        self.save(self.video(category="attack"), score=7.25)
        self.save(self.video(category="attack"), score=8.125)
        self.save(self.video(category="defense"), score=9.99, confirmed=False)
        self.video(category="stability")
        scores = self.client.get("/api/insights", params={"start": "2026-07-25", "end": "2026-07-25",
                                 "athlete_id": self.athlete["id"]}).json()["manual_scores"]
        self.assertEqual(scores.get("distribution"), [{"score": 0, "n": 1}, {"score": 7.25, "n": 2},
                                                 {"score": 8.125, "n": 1}])
        self.assertEqual(scores["by_category"], {"mixed": {"n": 2, "mean": 3.625},
                                                 "attack": {"n": 2, "mean": 7.6875}})
        self.assertEqual(scores["n"], 4)
        self.assertEqual(scores["mean"], 5.65625)

    def test_export_scores_are_confirmed_filtered_private_and_traceable(self):
        video = self.video()
        record = self.save(video)
        self.save(self.video(), confirmed=False)
        self.save(self.video(day="2026-07-24"))
        other = self.client.post("/api/athletes", json={"name": "other private athlete"}).json()
        self.save(self.video(athlete=other))
        response = self.client.get("/api/insights/export", params={"start": "2026-07-25", "end": "2026-07-25",
                                   "athlete_id": self.athlete["id"]})
        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertEqual(len(archive.namelist()), 7)
            rows = list(csv.DictReader(io.StringIO(archive.read("scores.csv").decode())))
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertEqual(row["score_id"], record["id"])
            self.assertEqual(row["video_id"], video["id"])
            self.assertEqual(row["session_id"], video["session_id"])
            self.assertEqual(row["athlete_id"], self.athlete["id"])
            self.assertEqual(row["date"], "2026-07-25")
            self.assertEqual(row["category"], "mixed")
            self.assertEqual(row["rubric_version"], "training-review-10-v1")
            self.assertEqual(float(row["score"]), 7.5)
            self.assertEqual(row["confirmed"], "True")
            self.assertEqual(row["updated_at"], record["updated_at"])
            self.assertNotIn("comment", row)
            self.assertNotIn("assessor", row)
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["counts"]["scores"], 1)
            self.assertEqual(manifest["manual_scoring"]["rubric_version"], "training-review-10-v1")
            self.assertEqual(manifest["manual_scoring"]["source"], "training video review")
            self.assertIn("comment required", manifest["manual_scoring"]["eligibility"])
            self.assertIn("subjective", manifest["manual_scoring"]["eligibility"])
            self.assertIn("not a validated ability measure or competition score", manifest["manual_scoring"]["eligibility"])
            self.assertNotIn("human-confirmed", manifest["manual_scoring"]["eligibility"].lower())
            self.assertEqual(manifest["summary"]["manual_scores"]["n"], 1)
            dictionary = json.loads(archive.read("data_dictionary.json"))
            self.assertIn("scores.csv", dictionary["columns"])
            self.assertNotIn("coach", json.dumps(dictionary["columns"]["scores.csv"]).lower())
            self.assertNotIn("human-confirmed", json.dumps(dictionary["columns"]["scores.csv"]).lower())
            all_text = "\n".join(archive.read(name).decode() for name in archive.namelist())
            for secret in ("private coach comment", "private athlete", "private session notes", "private source.mov", "admin"):
                self.assertNotIn(secret, all_text)
        empty = self.client.get("/api/insights/export?start=2000-01-01&end=2000-01-01")
        with zipfile.ZipFile(io.BytesIO(empty.content)) as archive:
            self.assertEqual(len(archive.read("scores.csv").decode().splitlines()), 1)

    def test_video_deletion_cascades_current_and_all_score_history(self):
        video = self.video()
        self.save(video)
        self.save(video, score=6)
        self.assertEqual(self.client.delete(f"/api/videos/{video['id']}").status_code, 204)
        database = self.app.state.ctx.db
        self.assertEqual(database.rows(select(db.manual_scores)), [])
        self.assertEqual(database.rows(select(db.score_history)), [])


class ScoreMigrationTests(unittest.TestCase):
    def test_existing_v2_gets_only_additive_score_tables_and_keeps_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(data_dir=Path(tmp), admin_password="test-password-123456")
            settings.validate()
            database = db.Database(settings)
            with database.engine.begin() as connection:
                db.meta.create_all(connection, tables=[table for table in db.meta.sorted_tables
                                   if table.name not in ("manual_scores", "score_history")])
                connection.execute(db.schema.insert().values(version=2))
                connection.execute(db.users.insert().values(id="retained-user", username="admin", password_hash="retained hash"))
                connection.execute(db.athletes.insert().values(id="retained-athlete", name="retained", level="", created_at=db.now()))
                original_columns = connection.exec_driver_sql("PRAGMA table_info(videos)").all()
            database.initialize("must-not-reset")
            database.initialize("must-not-reset")
            self.assertEqual(database.rows(select(db.schema)), [{"version": 4}])
            self.assertEqual(database.get(db.users, "retained-user")["password_hash"], "retained hash")
            self.assertEqual(database.get(db.athletes, "retained-athlete")["name"], "retained")
            self.assertEqual(database.rows(select(db.manual_scores)), [])
            self.assertEqual(database.rows(select(db.score_history)), [])
            with database.engine.connect() as connection:
                self.assertEqual(connection.exec_driver_sql("PRAGMA table_info(videos)").all(), original_columns)
                self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])
            database.engine.dispose()
