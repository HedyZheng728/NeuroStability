from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
import httpx
from unittest.mock import patch

from botocore.exceptions import ClientError
from sqlalchemy import create_engine

from arena import db
from scripts.cloudflare_migrate import (D1Query, apply_records, canonical, export_bundle, import_bundle, sha_file, sync_objects,
                                       validate_bundle, verify_objects, verify_rows)

ROOT = Path(__file__).resolve().parents[1]


class SQLiteCloud:
    """The production import function runs actual bound SQL against real SQLite."""
    def __init__(self, path):
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript((ROOT / "cloudflare/migrations/0001_schema.sql").read_text())
        self.calls = []
        self.interrupt = False

    def __call__(self, sql, params=()):
        self.calls.append((sql, list(params)))
        if self.interrupt and sql.startswith('INSERT INTO "jobs"'):
            self.interrupt = False
            raise OSError("test: interrupted connection")
        with self.connection:
            cursor = self.connection.execute(sql, params)
            return [dict(row) for row in cursor] if cursor.description else []

    def close(self):
        self.connection.close()


class ObjectFixture:
    """Test-only storage adapter uses real files and verifies uploaded bytes."""
    def __init__(self, root):
        self.root, self.metadata, self.uploads = Path(root), {}, 0
        self.root.mkdir()

    def head_object(self, Bucket, Key):
        path = self.root / Key
        if not path.exists():
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ContentLength": path.stat().st_size, "Metadata": self.metadata.get(Key, {})}

    def upload_file(self, source, bucket, key, ExtraArgs):
        target = self.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        self.metadata[key] = ExtraArgs["Metadata"]
        self.uploads += 1

    def get_object(self, Bucket, Key):
        return {"Body": (self.root / Key).open("rb")}


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "source.sqlite3"
        engine = create_engine(f"sqlite:///{self.source}")
        db.meta.create_all(engine)
        engine.dispose()
        self.objects = self.root / "objects"
        source = self.objects / "videos/video-1/source.mp4"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"real fixture bytes, not an inference result")
        artifact = self.objects / "videos/video-1/jobs/job-1/normalized.mp4"
        artifact.parent.mkdir(parents=True)
        artifact.write_bytes(b"private artifact fixture")
        orphan = self.objects / "videos/deleted-video/jobs/failed-job/pose.json"
        orphan.parent.mkdir(parents=True)
        orphan.write_bytes(b'{"preserved_failed_artifact":true}')
        self.raw_json = '{  "text": "\\u4e2d文",\n "values" : [ 1, null, 2.0 ] }'
        self.stamp = "2026-10-28T01:02:03.123456+00:00"
        with closing(sqlite3.connect(self.source)) as connection, connection:
            connection.execute("PRAGMA foreign_keys=ON")
            self.add(connection, "schema_version", version=4)
            self.add(connection, "users", id="user-1", username="original-admin", password_hash="original-salt:original-hash")
            self.add(connection, "auth_sessions", id="private-cookie", user_id="user-1", csrf="private-csrf", expires=123456)
            self.add(connection, "login_attempts", id="attempt-1", client="private-client", created=1)
            self.add(connection, "athletes", id="athlete-1", name="原始姓名", level="研究组", created_at=self.stamp)
            self.add(connection, "sessions", id="session-1", athlete_id="athlete-1", date="2026-10-28", objective="原始目标",
                     duration_min=60, rpe=None, notes="保留空值", created_at=self.stamp)
            self.add(connection, "training_plans", id="plan-1", athlete_id="athlete-1", date="2026-10-28", category="stability",
                     objective="原始计划", planned_minutes=10, status="planned", session_id="session-1", created_at=self.stamp)
            self.add(connection, "videos", id="video-1", session_id="session-1", category="stability", filename="原始.mp4",
                     storage_key="videos/video-1/source.mp4", sha256=sha_file(source), size_bytes=source.stat().st_size,
                     status="uploaded", authorized_at=self.stamp, created_at=self.stamp)
            self.add(connection, "jobs", id="job-1", video_id="video-1", backend="preprocess", status="completed", stage="保留原始阶段",
                     progress=100, params=self.raw_json, metadata=self.raw_json, result=None, error=None, lease_until=None,
                     worker_token="original-worker-token", created_at=self.stamp, updated_at=self.stamp)
            self.add(connection, "analysis_assessments", id="assessment-1", job_id="job-1", decision="pending", subject_role="unknown",
                     reason="", reviewer="原始评审", updated_at=self.stamp)
            self.add(connection, "analysis_assessment_history", id="assessment-history-1", job_id="job-1", snapshot=self.raw_json, created_at=self.stamp)
            self.add(connection, "review_drafts", id="draft-1", video_id="video-1", job_id="job-1", provider="rules", model="evidence-rules-v1",
                     synthetic=0, text="原始草稿", facts=self.raw_json, created_at=self.stamp)
            self.add(connection, "reviews", id="review-1", video_id="video-1", draft_id="draft-1", observations="原始观察", next_action="下次回看",
                     confirmed=1, confirmed_by="原始教练", updated_at=self.stamp)
            self.add(connection, "review_history", id="review-history-1", video_id="video-1", snapshot=self.raw_json, created_at=self.stamp)
            self.add(connection, "manual_scores", id="score-1", video_id="video-1", score=7.0, comment="原始评分说明", confirmed=1,
                     assessor="原始教练", rubric_version="training-review-10-v1", updated_at=self.stamp)
            self.add(connection, "score_history", id="score-history-1", video_id="video-1", snapshot=self.raw_json, created_at=self.stamp)
            self.add(connection, "events", id="event-1", video_id="video-1", source_job_id="job-1", start_sec=0.0, end_sec=1.0, label="原始事件",
                     actor="unknown", outcome="未确认", notes="原始笔记", created_by="original-admin", created_at=self.stamp)
        self.cloud = SQLiteCloud(self.root / "cloud.sqlite3")
        self.bundle_path = self.root / "private-bundle"

    @staticmethod
    def add(connection, table, **values):
        connection.execute(f'INSERT INTO "{table}" ({",".join(values)}) VALUES({",".join("?" for _ in values)})', list(values.values()))

    def tearDown(self):
        self.cloud.close()
        self.tmp.cleanup()

    def export(self):
        return export_bundle(self.source, self.objects, self.bundle_path)

    def test_all_original_rows_hashes_history_and_credentials_preserved(self):
        before = self.source.read_bytes()
        bundle = self.export()
        self.assertEqual(self.source.read_bytes(), before)
        self.assertNotIn("auth_sessions", bundle["tables"])
        self.assertNotIn("login_attempts", bundle["tables"])
        self.assertEqual(len(bundle["manifest"]["objects"]), 3)
        self.assertEqual(list(self.bundle_path.iterdir()), [self.bundle_path / "snapshot.sqlite3", self.bundle_path / "manifest.json"])
        self.assertEqual(self.bundle_path.stat().st_mode & 0o777, 0o700)
        for name in ("snapshot.sqlite3", "manifest.json"):
            self.assertEqual((self.bundle_path / name).stat().st_mode & 0o777, 0o600)
        with closing(sqlite3.connect(self.bundle_path / "snapshot.sqlite3")) as snapshot:
            self.assertEqual(snapshot.execute("SELECT count(*) FROM auth_sessions").fetchone()[0], 0)
        counts = apply_records(self.cloud, bundle)
        self.assertEqual(counts, verify_rows(self.cloud, bundle))
        self.assertEqual(self.cloud("SELECT password_hash FROM users")[0]["password_hash"], "original-salt:original-hash")
        for table, column in (("jobs", "params"), ("jobs", "metadata"), ("score_history", "snapshot"),
                              ("review_history", "snapshot"), ("analysis_assessment_history", "snapshot"), ("review_drafts", "facts")):
            self.assertEqual(self.cloud(f'SELECT "{column}" FROM "{table}"')[0][column], self.raw_json)
        self.assertEqual(self.cloud("SELECT count(*) AS n FROM auth_sessions")[0]["n"], 0)
        self.assertEqual(self.cloud("SELECT count(*) AS n FROM login_attempts")[0]["n"], 0)
        self.assertNotEqual(self.cloud("SELECT imported_at FROM cloud_migrations")[0]["imported_at"], "pending")

    def test_resume_same_manifest_after_interruption(self):
        bundle = self.export()
        self.cloud.interrupt = True
        with self.assertRaises(OSError):
            apply_records(self.cloud, bundle)
        self.assertEqual(self.cloud("SELECT imported_at FROM cloud_migrations")[0]["imported_at"], "pending")
        apply_records(self.cloud, bundle)
        before = {name: self.cloud(f'SELECT * FROM "{name}"') for name in bundle["tables"]}
        apply_records(self.cloud, bundle)
        self.assertEqual(before, {name: self.cloud(f'SELECT * FROM "{name}"') for name in bundle["tables"]})

    def test_wal_source_is_backed_up_without_mutating_source_or_needing_sidecars(self):
        with closing(sqlite3.connect(self.source)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("UPDATE athletes SET level='committed in WAL'")
            writer.commit()
            source_bytes = self.source.read_bytes()
            wal = Path(str(self.source) + "-wal")
            wal_bytes = wal.read_bytes()
            bundle = self.export()
            self.assertEqual(self.source.read_bytes(), source_bytes)
            self.assertEqual(wal.read_bytes(), wal_bytes)
            self.assertEqual(bundle["tables"]["athletes"]["rows"][0]["level"], "committed in WAL")
            self.assertEqual({p.name for p in self.bundle_path.iterdir()}, {"manifest.json", "snapshot.sqlite3"})

    def test_nonempty_database_without_manifest_is_refused(self):
        bundle = self.export()
        self.cloud("INSERT INTO athletes(id,name,level,created_at) VALUES(?,?,?,?)", ["someone", "已有记录", "", self.stamp])
        with self.assertRaisesRegex(ValueError, "not empty"):
            apply_records(self.cloud, bundle)
        self.assertEqual(self.cloud("SELECT count(*) AS n FROM users")[0]["n"], 0)

    def test_conflicting_existing_row_is_not_overwritten(self):
        bundle = self.export()
        apply_records(self.cloud, bundle)
        self.cloud("UPDATE athletes SET name='changed' WHERE id='athlete-1'")
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            apply_records(self.cloud, bundle)
        self.assertEqual(self.cloud("SELECT name FROM athletes")[0]["name"], "changed")

    def test_different_manifest_cannot_resume(self):
        bundle = self.export()
        apply_records(self.cloud, bundle)
        other = export_bundle(self.source, self.objects, self.root / "other-bundle")
        with self.assertRaisesRegex(ValueError, "different migration"):
            apply_records(self.cloud, other)

    def test_large_raw_json_uses_bound_parameters_and_compact_sql(self):
        large = '{ "fixture" : "' + "证据" * 60000 + '" }'
        with closing(sqlite3.connect(self.source)) as connection, connection:
            connection.execute("UPDATE jobs SET result=?", [large])
        bundle = self.export()
        apply_records(self.cloud, bundle)
        self.assertEqual(self.cloud("SELECT result FROM jobs")[0]["result"], large)
        inserts = [(sql, params) for sql, params in self.cloud.calls if sql.startswith("INSERT INTO")]
        self.assertTrue(any(large in params for _, params in inserts))
        self.assertTrue(all(len(sql.encode()) < 100_000 and len(params) <= 100 for sql, params in inserts))

    def test_source_checksum_mismatch_fails_without_modifying_database(self):
        before = self.source.read_bytes()
        (self.objects / "videos/video-1/source.mp4").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.export()
        self.assertEqual(self.source.read_bytes(), before)
        self.assertFalse(self.bundle_path.exists())

    def test_missing_source_and_completed_artifacts_are_rejected(self):
        (self.objects / "videos/video-1/jobs/job-1/normalized.mp4").unlink()
        with self.assertRaisesRegex(ValueError, "Missing completed"):
            self.export()
        (self.objects / "videos/video-1/source.mp4").unlink()
        with self.assertRaisesRegex(ValueError, "Missing source"):
            self.export()

    def test_storage_traversal_is_rejected(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            connection.execute("UPDATE videos SET storage_key='../private-password'")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            self.export()

    def test_active_jobs_are_rejected(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            connection.execute("UPDATE jobs SET status='running'")
        with self.assertRaisesRegex(ValueError, "Active"):
            self.export()

    def test_changed_source_database_aborts_export(self):
        from scripts import cloudflare_migrate as migration
        original = migration.file_record
        changed = False
        def mutate_after_snapshot(root, key):
            nonlocal changed
            if not changed:
                with closing(sqlite3.connect(self.source)) as connection, connection:
                    connection.execute("UPDATE athletes SET level='changed while exporting'")
                changed = True
            return original(root, key)
        with patch.object(migration, "file_record", side_effect=mutate_after_snapshot):
            with self.assertRaisesRegex(ValueError, "changed during export"):
                self.export()
        self.assertFalse(self.bundle_path.exists())

    def test_modified_snapshot_or_missing_manifest_object_is_detected(self):
        self.export()
        (self.objects / "videos/deleted-video/jobs/failed-job/pose.json").unlink()
        with self.assertRaisesRegex(ValueError, "Missing object"):
            validate_bundle(self.bundle_path)
        with (self.bundle_path / "snapshot.sqlite3").open("ab") as output:
            output.write(b"tampered")
        with self.assertRaisesRegex(ValueError, "Snapshot checksum"):
            validate_bundle(self.bundle_path, check_objects=False)

    def test_object_sync_resume_full_verification_and_conflict_refusal(self):
        bundle = self.export()
        store = ObjectFixture(self.root / "remote-objects")
        self.assertEqual(sync_objects(store, "private-bucket", bundle), 3)
        self.assertEqual(verify_objects(store, "private-bucket", bundle, full=True), 3)
        sync_objects(store, "private-bucket", bundle)
        self.assertEqual(store.uploads, 3)
        key = bundle["manifest"]["objects"][0]["key"]
        data = (store.root / key).read_bytes()
        (store.root / key).write_bytes(bytes([data[0] ^ 1]) + data[1:])
        with self.assertRaisesRegex(ValueError, "content checksum"):
            verify_objects(store, "private-bucket", bundle, full=True)
        store.metadata[key] = {"sha256": "wrong"}
        with self.assertRaisesRegex(ValueError, "conflicts"):
            sync_objects(store, "private-bucket", bundle)

    def test_numeric_transport_normalization_does_not_parse_raw_json(self):
        self.assertEqual(canonical({"value": 7.0}), canonical({"value": 7}))
        self.assertNotEqual(canonical({"raw": '{"n":7.0}'}), canonical({"raw": '{"n":7}'}))

    def test_import_never_marks_complete_based_only_on_matching_object_metadata(self):
        bundle = self.export()
        store = ObjectFixture(self.root / "remote-objects")
        sync_objects(store, "private-bucket", bundle)
        key = bundle["manifest"]["objects"][0]["key"]
        target = store.root / key
        original = target.read_bytes()
        target.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        with self.assertRaisesRegex(ValueError, "content checksum"):
            import_bundle(self.cloud, store, "private-bucket", bundle)
        self.assertEqual(self.cloud("SELECT imported_at FROM cloud_migrations")[0]["imported_at"], "pending")
        target.write_bytes(original)
        counts, objects = import_bundle(self.cloud, store, "private-bucket", bundle)
        self.assertEqual(objects, 3)
        self.assertEqual(counts["reviews"], 1)
        self.assertNotEqual(self.cloud("SELECT imported_at FROM cloud_migrations")[0]["imported_at"], "pending")

    def test_export_rejects_oversized_d1_row_before_any_cloud_change(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            connection.execute("UPDATE jobs SET error=?", ("x" * 2_000_000,))
        with self.assertRaisesRegex(ValueError, "D1 row limit"):
            self.export()
        self.assertFalse(self.bundle_path.exists())
        self.assertEqual(self.cloud.calls, [])

    def test_first_deploy_login_attempts_do_not_prevent_import_into_empty_workspace(self):
        bundle = self.export()
        self.cloud("INSERT INTO login_attempts(id,client,created) VALUES(?,?,?)", ["new-site-visit", "client", 1])
        self.cloud("INSERT INTO login_challenges(id,username,nonce,expires) VALUES(?,?,?,?)", ["new-site-login", "admin", "nonce", 1])
        self.cloud("INSERT INTO worker_capabilities(worker_id,models,last_seen) VALUES(?,?,?)", ["paired-computer", "{}", 1])
        self.assertEqual(apply_records(self.cloud, bundle)["videos"], 1)

    def test_d1_rate_limit_retries_same_bound_request_without_disclosing_credentials(self):
        requests = []
        def respond(request):
            requests.append(json.loads(request.content))
            if len(requests) == 1:
                return httpx.Response(429, headers={"retry-after": "2"}, json={"success": False})
            return httpx.Response(200, json={"success": True, "result": [{"success": True, "results": [{"n": 1}]}]})
        query = D1Query("test-account", "test-db", "private-test-token")
        query.client.close()
        query.client = httpx.Client(transport=httpx.MockTransport(respond))
        try:
            with patch("scripts.cloudflare_migrate.time.sleep") as sleep:
                self.assertEqual(query("SELECT ? AS n", [1]), [{"n": 1}])
                sleep.assert_called_once_with(2)
            self.assertEqual(requests[0], requests[1])
        finally:
            query.close()
