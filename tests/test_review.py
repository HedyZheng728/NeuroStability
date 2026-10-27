"""Workspace-day and requested draft-language behavior without external services."""
import json
import os
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from arena import config, db, review
from arena.api import create_app
from arena.engine import LIMITATIONS


def facts(synthetic=False):
    return {"job_id": "recorded-analysis", "synthetic": synthetic, "method_version": "wse-2d-v1",
            "quality": {"usable_frames": 18, "total_frames": 20, "ambiguous_frames": 2},
            "metrics": {"hip_sway_ratio": {"label": "髋中点横向离散度", "value": 0.25, "unit": "躯干长度"},
                        "trunk_lean_deg": {"label": "平均躯干倾角", "value": None, "unit": "°"}},
            "limitations": LIMITATIONS,
            "specialty_score": {"value": None, "status": "unvalidated"}}


class WorkspaceTimeTests(unittest.TestCase):
    def test_timezone_defaults_environment_and_invalid_zone_validation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ):
            os.environ.pop("ARENA_TIMEZONE", None)
            settings = config.Settings(data_dir=Path(tmp), admin_password="test-password-123456")
            self.assertEqual(getattr(settings, "timezone", None), "Asia/Shanghai")
            os.environ["ARENA_TIMEZONE"] = "America/New_York"
            self.assertEqual(config.Settings().timezone, "America/New_York")
            settings.timezone = "not/a/timezone"
            with self.assertRaisesRegex(ValueError, "ARENA_TIMEZONE"):
                settings.validate()

    def test_workspace_today_accepts_aware_instants_without_host_timezone_assumptions(self):
        self.assertTrue(callable(getattr(config, "workspace_today", None)))
        instant = datetime(2026, 1, 1, 23, 30, tzinfo=timezone.utc)
        self.assertEqual(config.workspace_today("Asia/Shanghai", instant=instant), date(2026, 1, 2))
        self.assertEqual(config.workspace_today("UTC", instant=instant), date(2026, 1, 1))
        # New York crosses its own local midnight later than UTC.
        instant = datetime(2026, 1, 2, 0, 30, tzinfo=timezone.utc)
        self.assertEqual(config.workspace_today("America/New_York", instant=instant), date(2026, 1, 1))
        with self.assertRaises(ValueError):
            config.workspace_today("Asia/Shanghai", instant=datetime(2026, 1, 1, 12))


class ReviewLanguageTests(unittest.TestCase):
    def test_local_drafts_use_saved_review_without_sending_notes_to_remote_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = config.Settings(data_dir=Path(tmp), admin_password="test-password-123456")
            app = create_app(settings)
            with TestClient(app) as client:
                login = client.post('/api/login', json={'username': 'admin', 'password': settings.admin_password})
                client.headers['X-CSRF-Token'] = login.json()['csrf']
                athlete = client.post('/api/athletes', json={'name': 'private test athlete'}).json()
                session = client.post('/api/sessions', json={'athlete_id': athlete['id'], 'date': '2026-01-01'}).json()
                database = app.state.ctx.db
                database.add(db.videos, dict(id='local-video',session_id=session['id'],category='mixed',filename='private.mp4',
                    storage_key='private',sha256='a'*64,size_bytes=1,status='ready',authorized_at=db.now(),created_at=db.now()))
                database.add(db.jobs, dict(id='local-job',video_id='local-video',backend='rtmpose',status='completed',stage='done',
                    progress=100,params={},metadata={},result=facts(),error=None,lease_until=None,worker_token=None,created_at=db.now(),updated_at=db.now()))
                database.add(db.reviews, dict(id='saved-note',video_id='local-video',draft_id=None,observations='Private saved observation',
                    next_action='Private replay cue',confirmed=True,confirmed_by='admin',updated_at=db.now()))
                captured=[]
                def generate(evidence, *args, **kwargs):
                    captured.append(evidence)
                    return 'A candidate based on stored facts.'
                settings.review_model_path=Path('/explicit/local/model')
                def select(evidence, *args, **kwargs):
                    from arena.local_review import validate_selection
                    captured.append(evidence)
                    return validate_selection('{"observation_indices":[0],"next_action_index":0}', evidence)
                with patch('arena.local_review.generate_selection', select):
                    local=client.post('/api/videos/local-video/review-drafts',json={'job_id':'local-job','provider':'llm'})
                self.assertEqual(local.status_code,201,local.text)
                self.assertEqual(local.json()['model'],'Qwen/Qwen2.5-1.5B-Instruct')
                self.assertEqual(captured[-1]['recorded_review']['observations'],'Private saved observation')
                stored_facts=local.json()['facts']
                self.assertEqual({key:value for key,value in stored_facts.items() if key!='language_output'},captured[-1])
                self.assertEqual(stored_facts['language_output']['method'],'extractive-source-v1')
                self.assertIn('Private saved observation',local.json()['text'])
                before_count=len(database.rows(db.drafts.select()))
                with patch('arena.local_review.generate_selection',side_effect=ValueError('invalid model JSON')):
                    invalid=client.post('/api/videos/local-video/review-drafts',json={'job_id':'local-job','provider':'llm'})
                self.assertEqual(invalid.status_code,409)
                self.assertEqual(len(database.rows(db.drafts.select())),before_count)
                settings.review_model_path=None
                with patch('arena.api.llm_draft', generate):
                    remote=client.post('/api/videos/local-video/review-drafts',json={'job_id':'local-job','provider':'llm'})
                self.assertEqual(remote.status_code,201,remote.text)
                self.assertNotIn('recorded_review',captured[-1])
                self.assertEqual(database.get(db.reviews,'saved-note')['observations'],'Private saved observation')

    def test_segmentation_review_uses_summary_without_inventing_pose_measurements(self):
        result = {"kind": "segmentation", "synthetic": False, "method_version": "sam2-local",
                  "segmentation": {"segmented_frames": 7, "total_frames": 8, "object_count": 2,
                                   "prompted_objects": 2, "untrusted_extra": "ignore"},
                  "frames": [{"t": 0, "masks": []}]}
        evidence = review.facts_for({"id": "seg-job", "result": result})
        self.assertEqual(evidence["summary"]["segmented_frames"], 7)
        self.assertNotIn("frames", evidence)
        self.assertNotIn("metrics", evidence)
        self.assertNotIn("untrusted_extra", evidence["summary"])
        self.assertIn("7/8", review.rules_draft(evidence))
        self.assertIn("7/8", review.rules_draft(evidence, "en"))

    def test_local_review_keeps_text_compact_and_exact_evidence_separate(self):
        settings = config.Settings()
        settings.review_model_path = Path("/explicit/local/model")
        evidence = facts()
        evidence["metrics"]["hip_sway_ratio"]["value"] = 0.123456789123
        original = json.dumps(evidence, ensure_ascii=False, sort_keys=True)
        inputs = []
        def generate(supplied, language, settings):
            inputs.append(json.dumps(supplied, ensure_ascii=False, sort_keys=True))
            return "请核对遮挡区间。"
        with patch("arena.local_review.generate", generate):
            text = review.llm_draft(evidence, settings)
        self.assertIn("请核对遮挡区间。", text)
        self.assertEqual(inputs, [original])
        self.assertEqual(json.dumps(evidence, ensure_ascii=False, sort_keys=True), original)
        self.assertNotIn('"metrics"', text)
        self.assertLess(len(text), 150)
        self.assertIn("待", text)

    def test_local_review_label_identifies_saved_observations_as_source(self):
        settings = config.Settings(review_model_path="/explicit/local/model")
        evidence = facts()
        evidence["recorded_review"] = {"observations": "跪姿举球", "next_action": "回看膝部落点", "source": "saved_review"}
        with patch("arena.local_review.generate", return_value="回看举球过程。"):
            text = review.llm_draft(evidence, settings)
        self.assertIn("已记录观察", text)

    def test_facts_include_per_person_joint_summaries_without_per_frame_series(self):
        result = facts()
        result["kinematics"] = {"method_version": "joint-angles-2d-v1", "experimental": True,
            "unit": "deg", "tracks": [{"track_id": 4, "n_samples": 8,
                "joints": {"left_knee": {"mean": 87.123456789, "min": 70, "max": 95, "n": 7}},
                "series": [{"t": 0, "left_knee": 70}]}]}
        evidence = review.facts_for({"id": "pose-job", "result": result})
        track = evidence["kinematics"]["tracks"][0]
        self.assertEqual(track["track_id"], 4)
        self.assertEqual(track["joints"]["left_knee"]["mean"], 87.123456789)
        self.assertNotIn("series", track)

    def test_rules_english_preserves_observations_missing_values_and_limitations(self):
        text = review.rules_draft(facts(), language="en")
        self.assertIn("18/20", text)
        self.assertIn("2", text)
        self.assertIn("0.2500", text)
        self.assertIn("Lateral hip midpoint dispersion", text)
        self.assertIn("insufficient", text.lower())
        for limitation in ("camera", "occlusion", "center of mass", "identity tracking", "independent", "causal"):
            self.assertIn(limitation, text.lower())
        self.assertNotRegex(text, "[\\u4e00-\\u9fff]")
        self.assertIn("synthetic", review.rules_draft(facts(True), language="en").lower())
        self.assertIn("合成", review.rules_draft(facts(True)))

    def test_llm_prompt_output_label_and_synthetic_warning_follow_selected_language(self):
        settings = config.Settings(llm_base_url="https://model.invalid/v1", llm_model="configured-model", llm_key="secret")
        requests = []

        def respond(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, json={"choices": [{"message": {"content": "Provider draft text"}}]})

        client_type = httpx.Client
        with patch("arena.review.httpx.Client", lambda **kwargs: client_type(transport=httpx.MockTransport(respond), **kwargs)):
            english = review.llm_draft(facts(True), settings, language="en")
            chinese = review.llm_draft(facts(True), settings)
        self.assertTrue(english.startswith("AI review draft"), english)
        self.assertIn("Synthetic", english)
        self.assertIn("English", requests[0]["messages"][0]["content"])
        self.assertIn("limitations", requests[0]["messages"][0]["content"])
        self.assertIn("中文", requests[1]["messages"][0]["content"])
        self.assertIn("AI 复盘草稿", chinese)
        self.assertIn("合成", chinese)
        self.assertEqual(json.loads(requests[0]["messages"][1]["content"]), facts(True))

    def test_api_language_selects_new_drafts_and_preserves_existing_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = config.Settings(data_dir=Path(tmp), admin_password="test-password-123456")
            app = create_app(settings)
            with TestClient(app) as client:
                login = client.post("/api/login", json={"username": "admin", "password": settings.admin_password})
                client.headers["X-CSRF-Token"] = login.json()["csrf"]
                athlete = client.post("/api/athletes", json={"name": "isolated test record"}).json()
                session = client.post("/api/sessions", json={"athlete_id": athlete["id"], "date": "2026-01-01"}).json()
                app.state.ctx.db.add(db.videos, dict(id="video", session_id=session["id"], category="attack",
                    filename="private.mp4", storage_key="private.mp4", sha256="a" * 64, size_bytes=1,
                    status="ready", authorized_at=db.now(), created_at=db.now()))
                app.state.ctx.db.add(db.jobs, dict(id="job", video_id="video", backend="rtmpose", status="completed",
                    stage="done", progress=100, params={}, metadata={}, result=facts(), error=None,
                    lease_until=None, worker_token=None, created_at=db.now(), updated_at=db.now()))
                url = "/api/videos/video/review-drafts"
                old = client.post(url, json={"job_id": "job"})
                self.assertEqual(old.status_code, 201, old.text)
                self.assertIn("数据规则", old.json()["text"])
                english = client.post(url, json={"job_id": "job", "language": "en"})
                self.assertEqual(english.status_code, 201, english.text)
                self.assertIn("Evidence-based", english.json()["text"])
                self.assertEqual(app.state.ctx.db.get(db.drafts, old.json()["id"])["text"], old.json()["text"])
                self.assertEqual(client.post(url, json={"job_id": "job", "language": "fr"}).status_code, 422)
                settings.llm_base_url = "https://model.invalid/v1"
                settings.llm_model = "configured-model"
                settings.llm_key = "secret"
                prompts = []

                def respond(request):
                    prompts.append(json.loads(request.content)["messages"][0]["content"])
                    return httpx.Response(200, json={"choices": [{"message": {"content": "Observed evidence only."}}]})

                client_type = httpx.Client
                with patch("arena.review.httpx.Client", lambda **kwargs: client_type(transport=httpx.MockTransport(respond), **kwargs)):
                    generated = client.post(url, json={"job_id": "job", "provider": "llm", "language": "en"})
                self.assertEqual(generated.status_code, 201, generated.text)
                self.assertIn("English", prompts[0])
                self.assertTrue(generated.json()["text"].startswith("AI review draft"))
                report = client.get("/api/videos/video/report").json()
                self.assertEqual(len(report["drafts"]), 3)
                self.assertEqual({row["text"] for row in report["drafts"]},
                                 {old.json()["text"], english.json()["text"], generated.json()["text"]})
