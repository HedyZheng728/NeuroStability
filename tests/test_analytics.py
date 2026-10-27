"""Real snapshot and aggregation contracts; fixtures never touch the live archive."""
import csv
import io
import json
import tempfile
import unittest
from pathlib import Path

from arena import analytics, db, planning
from arena.config import Settings


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        settings = Settings(data_dir=Path(self.tmp.name), admin_password="test-password-123456")
        settings.validate()
        self.database = db.Database(settings)
        self.database.initialize(settings.admin_password)
        self.database.add(db.athletes, dict(id="athlete-a", name="private athlete", level="", created_at=db.now()))
        self.session("session-a", "2026-01-07", duration_min=180)

    def tearDown(self):
        self.database.engine.dispose()
        self.tmp.cleanup()

    def session(self, id, date, *, athlete_id="athlete-a", duration_min=60):
        self.database.add(db.sessions, dict(id=id, athlete_id=athlete_id, date=date, objective="private objective",
                          duration_min=duration_min, rpe=None, notes="private notes", created_at=db.now()))

    def video(self, id, *, session_id="session-a", size_bytes=100, category="mixed"):
        self.database.add(db.videos, dict(id=id, session_id=session_id, category=category,
                          filename=f"private {id}.mp4", storage_key=f"private/storage/{id}", sha256="a" * 64,
                          size_bytes=size_bytes, status="ready", authorized_at=db.now(), created_at=db.now()))

    def job(self, id, video_id, *, created_at="2026-01-07T00:00:00+00:00", backend="rtmpose",
            status="completed", metadata=None, result=None, params=None):
        self.database.add(db.jobs, dict(id=id, video_id=video_id, backend=backend, status=status, stage="private stage",
                          progress=100, params=params or {"start_sec": 0, "end_sec": None, "roi": None},
                          metadata=metadata, result=result, error="private error", lease_until=None,
                          worker_token=None, created_at=created_at, updated_at=created_at))

    @staticmethod
    def result(*, total=20, usable=15, ambiguous=0, missing=5, value=0.25, synthetic=False, **values):
        return {"synthetic": synthetic, "experimental": True, "needs_review": False, "method_version": "wse-2d-v1",
                "sample_fps": 10, "roi": [0, 0, 1, 1], "model_sha256": {"pose": "b" * 64},
                "quality": {"total_frames": total, "usable_frames": usable, "ambiguous_frames": ambiguous,
                            "missing_frames": missing, "minimum_usable_frames": 10, "minimum_coverage": 0.6},
                "metrics": {"hip_sway_ratio": {"value": value, "unit": "torso lengths"},
                            "trunk_lean_deg": {"value": None, "unit": "deg"},
                            "ankle_span_ratio": {"value": None, "unit": "torso lengths"}}, **values}

    def snapshot(self, **filters):
        return planning.read_snapshot(self.database.engine,
            {"start": "2026-01-01", "end": "2026-01-31", "athlete_id": None, **filters})

    def summary(self, **filters):
        return analytics.summarize(self.snapshot(**filters))

    def verified_review(self, video_id, job_id, *, confirmed=True):
        draft_id = "draft-" + job_id
        self.database.add(db.drafts, dict(id=draft_id, video_id=video_id, job_id=job_id, provider="rules", model="rules-v1",
                          synthetic=False, text="private draft", facts={}, created_at=db.now()))
        self.database.add(db.reviews, dict(id="review-" + video_id, video_id=video_id, draft_id=draft_id,
                          observations="private observations", next_action="private action", confirmed=confirmed,
                          confirmed_by="private reviewer", updated_at=db.now()))

    def test_empty_summary_preserves_unknown_durations_and_ratios(self):
        result = self.summary()
        self.assertEqual(result["video_count"], 0)
        self.assertEqual(result["analyzed_videos"], 0)
        self.assertEqual(result["storage_bytes"], 0)
        self.assertIsNone(result["footage_seconds"])
        self.assertEqual(result["duration_stats"], {"n": 0, "mean": None, "median": None, "q1": None,
                                                  "q3": None, "min": None, "max": None})
        self.assertEqual(result["frames"], {"total": 0, "usable": 0, "ambiguous": 0, "missing": 0, "usable_ratio": None})
        self.assertEqual(result["scores"], {"confirmed": 0, "draft": 0, "unscored": 0})
        self.assertEqual(result["by_session"], [{"session_id": "session-a", "date": "2026-01-07", "athlete_id": "athlete-a",
                                               "duration_min": 180, "video_count": 0, "analyzed_videos": 0, "review_needed": 0}])
        self.assertEqual(result.get("capabilities"), [
            {"backend": backend, "processed_videos": 0, "video_count": 0, "first_video_id": None, "first_job_id": None}
            for backend in ("rtmpose_tracking", "sam2", "action", "pose3d")])
        json.dumps(result, allow_nan=False)

    def test_capabilities_keep_latest_real_output_per_video_despite_new_pending_or_failed_attempts(self):
        for id in ("v-b", "v-a", "v-empty"):
            self.video(id)
        outputs = {
            "rtmpose_tracking": {"kind": "pose", "synthetic": False, "tracking": {"track_count": 2}},
            "sam2": {"kind": "segmentation", "synthetic": False, "segmentation": {"segmented_frames": 3}},
            "action": {"kind": "recognition", "synthetic": False, "windows": [{"start_sec": 0, "end_sec": 1}]},
            "pose3d": {"kind": "pose3d", "synthetic": False, "pose3d": {"frame_count": 4}},
        }
        for backend, result in outputs.items():
            self.job("old-" + backend, "v-a", backend=backend, result=result)
            self.job("new-" + backend, "v-a", backend=backend, status="needs_review", result=result,
                     created_at="2026-01-08T00:00:00+00:00")
        self.job("z-tracking", "v-a", backend="rtmpose_tracking", result=outputs["rtmpose_tracking"],
                 created_at="2026-01-08T00:00:00+00:00")
        self.job("pending-tracking", "v-a", backend="rtmpose_tracking", status="queued",
                 created_at="2026-01-09T00:00:00+00:00")
        self.job("failed-sam2", "v-a", backend="sam2", status="failed", result=outputs["sam2"],
                 created_at="2026-01-09T00:00:00+00:00")
        self.job("empty-pose3d", "v-a", backend="pose3d", result={"kind": "pose3d", "synthetic": False,
                 "pose3d": {"frame_count": 0}}, created_at="2026-01-09T00:00:00+00:00")
        self.job("pose3d-b", "v-b", backend="pose3d", result=outputs["pose3d"])
        data = self.snapshot()
        self.assertEqual({job["backend"] for job in data["jobs"]}, {"rtmpose_tracking", "sam2", "action", "pose3d"})
        expected = [
            {"backend": "rtmpose_tracking", "processed_videos": 1, "video_count": 3, "first_video_id": "v-a", "first_job_id": "z-tracking"},
            {"backend": "sam2", "processed_videos": 1, "video_count": 3, "first_video_id": "v-a", "first_job_id": "new-sam2"},
            {"backend": "action", "processed_videos": 1, "video_count": 3, "first_video_id": "v-a", "first_job_id": "new-action"},
            {"backend": "pose3d", "processed_videos": 2, "video_count": 3, "first_video_id": "v-a", "first_job_id": "new-pose3d"},
        ]
        self.assertEqual(analytics.summarize(data).get("capabilities"), expected)
        data["jobs"].reverse()
        data["videos"].reverse()
        self.assertEqual(analytics.summarize(data)["capabilities"], expected)

    def test_capabilities_reject_wrong_kind_synthetic_nonterminal_and_empty_or_invalid_outputs(self):
        self.video("v-a")
        bases = {
            "rtmpose_tracking": {"kind": "pose", "synthetic": False, "tracking": {"track_count": 1}},
            "sam2": {"kind": "segmentation", "synthetic": False, "segmentation": {"segmented_frames": 1}},
            "action": {"kind": "recognition", "synthetic": False, "windows": [{"start_sec": 0, "end_sec": 1}]},
            "pose3d": {"kind": "pose3d", "synthetic": False, "pose3d": {"frame_count": 1}},
        }
        invalid_counts = (0, -1, .5, True, "2", None, float("nan"), float("inf"))
        for backend, result in bases.items():
            variants = [("completed", {**result, "kind": "wrong"}), ("completed", {**result, "synthetic": True}),
                        ("completed", {**result, "synthetic": None}), ("completed", {"kind": result["kind"], "synthetic": False}),
                        *[(status, result) for status in ("queued", "running", "failed", "blocked")]]
            if backend == "action":
                variants += [("completed", {**result, "windows": value}) for value in ([], {}, "one", None)]
            else:
                key, field = {"rtmpose_tracking": ("tracking", "track_count"), "sam2": ("segmentation", "segmented_frames"),
                              "pose3d": ("pose3d", "frame_count")}[backend]
                variants += [("completed", {**result, key: {field: value}}) for value in invalid_counts]
            for status, invalid in variants:
                with self.subTest(backend=backend, status=status, result=invalid):
                    data = self.snapshot()
                    data["jobs"] = [{"id": "invalid", "video_id": "v-a", "backend": backend, "status": status,
                                     "created_at": "2026-01-07", "params": {}, "metadata": None, "result": invalid}]
                    self.assertEqual(analytics.summarize(data).get("capabilities"), [
                        {"backend": value, "processed_videos": 0, "video_count": 1, "first_video_id": None, "first_job_id": None}
                        for value in ("rtmpose_tracking", "sam2", "action", "pose3d")])
        data = self.snapshot()
        data["jobs"] = [{"id": backend, "video_id": "v-a", "backend": backend, "status": "completed",
                         "created_at": "2026-01-07", "params": {}, "metadata": None,
                         "result": bases["rtmpose_tracking"]} for backend in ("sample", "rtmpose")]
        self.assertTrue(all(row["processed_videos"] == 0 for row in analytics.summarize(data)["capabilities"]))

    def test_capabilities_only_link_to_videos_in_the_current_filter(self):
        self.video("v-current")
        self.session("session-old", "2025-12-31")
        self.video("v-old", session_id="session-old")
        self.job("action-old", "v-old", backend="action", result={"kind": "recognition", "synthetic": False,
                 "windows": [{"start_sec": 0, "end_sec": 1}]})
        data = self.snapshot()
        self.assertEqual([row["id"] for row in data["videos"]], ["v-current"])
        self.assertEqual(data["jobs"], [])
        # Defend the aggregation boundary even if a caller supplies jobs outside its video selection.
        data["jobs"] = [self.database.get(db.jobs, "action-old")]
        capabilities = analytics.summarize(data).get("capabilities")
        self.assertIsNotNone(capabilities)
        self.assertTrue(all(row["processed_videos"] == 0 and row["video_count"] == 1
                            and row["first_video_id"] is None and row["first_job_id"] is None for row in capabilities))

    def test_snapshot_filters_joined_jobs_videos_and_current_scores_without_changing_export_eligibility(self):
        self.video("v-a")
        self.job("j-a", "v-a", result=self.result(), metadata={"source_duration": 30})
        self.verified_review("v-a", "j-a")
        self.database.add(db.manual_scores, dict(id="score-a", video_id="v-a", score=0, comment="private coach comment",
                          confirmed=False, assessor="private coach", rubric_version=db.MANUAL_SCORE_RUBRIC, updated_at=db.now()))
        self.database.add(db.athletes, dict(id="athlete-b", name="other private athlete", level="", created_at=db.now()))
        self.session("session-b", "2026-01-07", athlete_id="athlete-b")
        self.video("v-b", session_id="session-b")
        self.job("j-b", "v-b", result=self.result())
        self.session("session-old", "2025-12-31")
        self.video("v-old", session_id="session-old")
        self.job("j-old", "v-old", result=self.result())
        snapshot = self.snapshot(athlete_id="athlete-a")
        self.assertEqual([v["id"] for v in snapshot["videos"]], ["v-a"])
        self.assertTrue({"filename", "date", "athlete_id", "size_bytes"}.issubset(snapshot["videos"][0]), "Snapshot lacks analysis video metadata")
        self.assertEqual({key: snapshot["videos"][0][key] for key in ("filename", "date", "athlete_id", "size_bytes")},
                         {"filename": "private v-a.mp4", "date": "2026-01-07", "athlete_id": "athlete-a", "size_bytes": 100})
        self.assertEqual([j["id"] for j in snapshot["jobs"]], ["j-a"])
        self.assertEqual([(s["video_id"], s["confirmed"]) for s in snapshot["current_scores"]], [("v-a", False)])
        self.assertEqual(snapshot["scores"], [])
        self.assertEqual([m["job_id"] for m in snapshot["measurements"]], ["j-a"])
        result = analytics.summarize(snapshot)
        self.assertEqual(result["scores"], {"confirmed": 0, "draft": 1, "unscored": 0})

    def test_latest_attempt_is_deterministic_and_excludes_sample_or_synthetic_results(self):
        self.video("v-a")
        self.video("v-b")
        self.video("v-c")
        self.video("v-d")
        self.job("j-0", "v-a", result=self.result(value=1), metadata={"source_duration": 60})
        self.job("j-1", "v-a", result=self.result(value=2), created_at="2026-01-08T00:00:00+00:00")
        self.job("j-2", "v-a", status="failed", created_at="2026-01-08T00:00:00+00:00")
        self.job("j-sample", "v-a", backend="sample", result=self.result(synthetic=True, value=999),
                 metadata={"source_duration": 999}, created_at="2026-01-09T00:00:00+00:00")
        self.job("j-synthetic", "v-a", result=self.result(synthetic=True, value=999),
                 created_at="2026-01-10T00:00:00+00:00")
        self.job("j-b", "v-b", backend="preprocess", metadata={"source_duration": 30})
        self.job("j-c", "v-c", backend="sample", result=self.result(synthetic=True))
        self.job("j-d", "v-d", result={"quality": self.result()["quality"]})
        result = self.summary()
        self.assertEqual(result["video_count"], 4)
        self.assertEqual(result["status_counts"], {"completed": 1, "needs_review": 0, "queued": 0, "running": 0,
                                                 "failed": 1, "blocked": 0, "not_analyzed": 2})
        self.assertEqual(result["analyzed_videos"], 0)
        self.assertEqual(result["measurement_count"], 0)
        self.assertEqual(result["frames"]["total"], 0)
        self.assertEqual(result["footage_seconds"], 90)

    def test_duration_uses_latest_available_full_source_once_and_exact_upper_bins(self):
        for index, duration in enumerate((10, 30, 60, 61), 1):
            id = f"v-{index}"
            self.video(id, size_bytes=index * 10)
            self.job(f"j-{index}", id, result=self.result(), metadata={"source_duration": duration, "duration": 2},
                     params={"start_sec": 10, "end_sec": 12, "roi": None})
        self.job("j-new", "v-1", status="failed", created_at="2026-01-08T00:00:00+00:00")
        self.job("j-middle", "v-2", status="failed", metadata={"source_duration": 20},
                 created_at="2026-01-06T00:00:00+00:00")
        self.video("v-unknown", size_bytes=7)
        self.job("j-unknown", "v-unknown", status="failed", metadata={"duration": 999})
        result = self.summary()
        self.assertEqual(result["storage_bytes"], 107)
        self.assertEqual(result["footage_seconds"], 161)
        self.assertEqual(result["duration_known"], 4)
        self.assertEqual(result["duration_stats"], {"n": 4, "mean": 40.25, "median": 45, "q1": 25,
                                                  "q3": 60.25, "min": 10, "max": 61})
        self.assertEqual(result["duration_bins"], [{"key": "0-10", "count": 1}, {"key": "10-30", "count": 1},
                                                 {"key": "30-60", "count": 1}, {"key": "60+", "count": 1}])

    def test_frame_ratios_use_complete_partitions_and_weighted_counts(self):
        self.video("v-a")
        self.video("v-b")
        self.job("j-a", "v-a", result=self.result(total=100, usable=80, missing=20))
        self.job("j-b", "v-b", status="needs_review",
                 result=self.result(total=10, usable=0, ambiguous=3, missing=7, needs_review=True))
        result = self.summary()
        self.assertEqual(result["frames"], {"total": 110, "usable": 80, "ambiguous": 3, "missing": 27,
                                            "usable_ratio": 80 / 110})
        self.assertEqual((result["quality_known"], result["quality_passed"], result["needs_review"]), (2, 1, 2))
        self.assertEqual({row["job_id"]: row["usable_ratio"] for row in result["review_queue"]}, {"j-a": 0.8, "j-b": 0})
        self.assertEqual(result["review_counts"], {"reviewed": 0, "pending": 2, "accepted": 0, "excluded": 0, "superseded": 0})
        self.assertEqual(result["status_counts"]["needs_review"], 1)
        self.assertEqual(result["by_session"][0]["review_needed"], 2)

    def test_invalid_and_incomplete_quality_does_not_invent_counts_or_zero_ratios(self):
        invalid = ({}, {"usable_frames": 10}, {"total_frames": 10, "usable_frames": 10, "ambiguous_frames": 1, "missing_frames": 0},
                   {"total_frames": 10, "usable_frames": -1, "ambiguous_frames": 0, "missing_frames": 11},
                   {"total_frames": 1, "usable_frames": True, "ambiguous_frames": 0, "missing_frames": 0},
                   {"total_frames": 1.5, "usable_frames": 1.5, "ambiguous_frames": 0, "missing_frames": 0},
                   {"total_frames": float("inf"), "usable_frames": 0, "ambiguous_frames": 0, "missing_frames": 0})
        # JSON storage does not admit NaN/Infinity on every database, so corrupt legacy payloads enter after real snapshot.
        data = self.snapshot()
        for index, quality in enumerate(invalid):
            id = f"v-{index}"
            data["videos"].append({"id": id, "session_id": "session-a", "athlete_id": "athlete-a", "date": "2026-01-07",
                                   "category": "mixed", "filename": "private.mp4", "size_bytes": 1})
            data.setdefault("jobs", []).append({"id": f"j-{index}", "video_id": id, "backend": "rtmpose", "status": "needs_review",
                                               "created_at": "2026-01-07", "result": self.result(quality=quality), "metadata": None, "params": {}})
        result = analytics.summarize(data)
        self.assertEqual(result["quality_known"], 0)
        self.assertEqual(result["quality_passed"], 0)
        self.assertEqual(result["frames"], {"total": 0, "usable": 0, "ambiguous": 0, "missing": 0, "usable_ratio": None})
        self.assertTrue(all(row["usable_ratio"] is None for row in result["review_queue"]))
        json.dumps(result, allow_nan=False)

    def test_measurement_previews_keep_finite_actual_values_and_job_specific_confirmation(self):
        self.video("v-a")
        self.job("j-old", "v-a", result=self.result(value=0.2))
        self.verified_review("v-a", "j-old")
        self.job("j-new", "v-a", result=self.result(value=0), created_at="2026-01-08T00:00:00+00:00")
        self.video("v-b")
        self.job("j-b", "v-b", result=self.result(value=0.5))
        self.verified_review("v-b", "j-b")
        self.video("v-c")
        data = self.snapshot()
        self.assertIn("jobs", data, "Snapshot lacks analysis attempts")
        data["jobs"].append({"id": "j-c", "video_id": "v-c", "backend": "rtmpose", "status": "completed", "created_at": "2026-01-07",
                             "metadata": None, "params": {}, "result": self.result(value=float("nan"), metrics={
                                 "hip_sway_ratio": {"value": float("nan")}, "trunk_lean_deg": {"value": True},
                                 "ankle_span_ratio": {"value": "0.8"}})})
        result = analytics.summarize(data)
        self.assertEqual(result["measurement_count"], 2)
        self.assertEqual({m["job_id"]: m["confirmed"] for m in result["measurements"]}, {"j-new": False, "j-b": True})
        zero = next(m for m in result["measurements"] if m["job_id"] == "j-new")
        self.assertEqual(zero["metrics"], {"hip_sway_ratio": {"value": 0, "unit": "torso lengths"}})
        self.assertEqual(zero["filename"], "private v-a.mp4")
        json.dumps(result, allow_nan=False)

    def test_previews_are_bounded_with_quality_first_and_terminal_review_queue_only(self):
        for index in range(15):
            id = f"v-{index:02}"
            self.video(id)
            self.job(f"j-{index:02}", id, status="needs_review" if index < 10 else "completed",
                     result=self.result(total=20, usable=15, ambiguous=1 if index < 10 else 0,
                                        missing=4 if index < 10 else 5, needs_review=index < 10))
        self.video("v-queued")
        self.job("j-queued", "v-queued", status="queued")
        result = self.summary()
        self.assertEqual((result["measurement_count"], len(result["measurements"])), (15, 12))
        self.assertTrue(all(m["quality_passed"] for m in result["measurements"][:5]))
        self.assertEqual((result["needs_review"], len(result["review_queue"])), (15, 6))
        self.assertEqual(result["status_counts"]["needs_review"], 10)
        self.assertNotIn("j-queued", {m["job_id"] for m in result["review_queue"]})
        self.assertEqual(result["analyzed_videos"], 15)

    def test_csv_has_latest_real_attempts_traceability_blanks_and_no_private_text(self):
        self.video("v-a")
        self.job("j-old", "v-a", result=self.result(value=9))
        self.job("j-new", "v-a", result=self.result(value=0), metadata={"source_duration": 30, "duration": 4},
                 created_at="2026-01-08T00:00:00+00:00", params={"start_sec": 4, "end_sec": 8, "roi": [0, 0, 1, 1]})
        self.verified_review("v-a", "j-new")
        self.video("v-b")
        self.job("j-b", "v-b", status="queued")
        self.video("v-sample")
        self.job("j-sample", "v-sample", backend="sample", result=self.result(synthetic=True))
        self.video("v-synthetic")
        self.job("j-synthetic", "v-synthetic", result=self.result(synthetic=True))
        data = self.snapshot()
        self.assertIn("jobs", data, "Snapshot lacks analysis attempts")
        latest = next(j for j in data["jobs"] if j["id"] == "j-new")
        latest["result"]["method_version"] = " =HYPERLINK(\"bad\")"
        payload = analytics.export_csv(data)
        self.assertIsInstance(payload, bytes)
        text = payload.decode("utf-8-sig")
        for secret in ("private", "storage", "comment", "assessor", "worker_token", "filename", "password", "csrf"):
            self.assertNotIn(secret, text)
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual({r["job_id"] for r in rows}, {"j-new", "j-b"})
        row = next(r for r in rows if r["job_id"] == "j-new")
        self.assertEqual((row["video_id"], row["session_id"], row["athlete_id"], row["date"], row["category"]),
                         ("v-a", "session-a", "athlete-a", "2026-01-07", "mixed"))
        self.assertEqual(row["method_version"], "' =HYPERLINK(\"bad\")")
        self.assertEqual((row["experimental"], row["confirmed"]), ("True", "True"))
        self.assertEqual(row["hip_sway_ratio"], "0")
        self.assertEqual(row["trunk_lean_deg"], "")
        self.assertEqual((row["source_duration"], row["start_sec"], row["end_sec"]), ("30", "4", "8"))
        self.assertEqual(json.loads(row["roi_json"]), [0, 0, 1, 1])
        self.assertEqual(json.loads(row["model_sha256_json"]), {"pose": "b" * 64})
        pending = next(r for r in rows if r["job_id"] == "j-b")
        self.assertEqual((pending["backend"], pending["status"], pending["hip_sway_ratio"], pending["total_frames"]),
                         ("rtmpose", "queued", "", ""))
        self.assertEqual(len(list(csv.DictReader(io.StringIO(analytics.export_csv(self.snapshot(start="2000-01-01", end="2000-01-01")).decode())))), 0)


if __name__ == "__main__":
    unittest.main()
