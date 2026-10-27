"""Local review readiness must never be inferred from a configured folder alone."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from arena import config, local_review

OBSERVATIONS_0747 = ("001从教练身后环住其腰部，教练起初双手撑垫、身体前倾。"
    "随后001起身，补充画面可见教练双手离垫且黑鞋短暂离开垫面；末段两人松开并站立复位。")
NEXT_ACTION_0747 = "回看由低位抱腰到起身时，001双脚落点与环抱双手的相对位置。"


def recorded_facts():
    return {"recorded_review": {"source": "saved_review", "observations": OBSERVATIONS_0747,
                                "next_action": NEXT_ACTION_0747}}


class LocalReviewTests(unittest.TestCase):
    def test_extractive_renderer_preserves_0747_subjects_and_exact_next_action(self):
        facts = recorded_facts()
        original = json.dumps(facts, ensure_ascii=False)
        selection = local_review.validate_selection('{"observation_indices":[0,1],"next_action_index":0}', facts)
        for language in ("zh", "en"):
            text = local_review.render_selection(facts, selection, language)
            self.assertIn("001从教练身后环住其腰部，教练起初双手撑垫、身体前倾。", text)
            self.assertIn("随后001起身，补充画面可见教练双手离垫且黑鞋短暂离开垫面；末段两人松开并站立复位。", text)
            self.assertIn(NEXT_ACTION_0747, text)
            self.assertNotIn("不符", text)
        self.assertEqual(json.dumps(facts, ensure_ascii=False), original)

    def test_invalid_json_or_indices_reject_without_repair_or_rewriting(self):
        invalid = ['not JSON', '```json\n{"observation_indices":[0],"next_action_index":0}\n```',
            '{"observation_indices":[0],"next_action_index":0,"text":"不符"}',
            '{"observation_indices":[2],"next_action_index":0}',
            '{"observation_indices":[-1],"next_action_index":0}',
            '{"observation_indices":[true],"next_action_index":0}',
            '{"observation_indices":[0,0],"next_action_index":0}',
            '{"observation_indices":[],"next_action_index":0}',
            '{"observation_indices":[0],"next_action_index":1}',
            '{"observation_indices":[0],"next_action_index":false}',
            '{"observation_indices":[0],"observation_indices":[1],"next_action_index":0}']
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                local_review.validate_selection(raw, recorded_facts())

    def test_selection_cannot_be_reused_after_saved_source_changes(self):
        facts = recorded_facts()
        selection = local_review.validate_selection('{"observation_indices":[0],"next_action_index":0}', facts)
        facts["recorded_review"]["next_action"] = "另一个核对事项。"
        with self.assertRaises(ValueError):
            local_review.render_selection(facts, selection)

    def test_count_selection_accepts_only_exact_existing_integer_values(self):
        facts = {"quality": {"total_frames": 8, "usable_frames": 7}}
        selection = local_review.validate_selection('{"coverage":{"quality.total_frames":8,"quality.usable_frames":7}}', facts)
        self.assertIn("8", local_review.render_selection(facts, selection))
        for raw in ('{"coverage":{"quality.total_frames":9}}', '{"coverage":{"unknown":8}}',
                    '{"coverage":{"quality.total_frames":true}}', '{"coverage":{}}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                local_review.validate_selection(raw, facts)

    def test_no_notes_prompt_contains_only_observation_coverage_counts(self):
        facts = {"quality": {"usable_frames": 7, "total_frames": 8, "usable_ratio": 0.875},
                 "metrics": {"hip": {"value": 0.12345}}, "limitations": ["不能作为动作判断"]}
        supplied = json.loads(local_review.prompt_messages(facts, "zh")[1]["content"])
        self.assertEqual(supplied, {"coverage": {"quality.usable_frames": 7, "quality.total_frames": 8}})
        self.assertEqual(facts["metrics"]["hip"]["value"], 0.12345)

    def test_recorded_review_prompt_uses_only_saved_notes_without_metric_distractors(self):
        facts = {"metrics": {"hip": {"value": 0.12345}},
                 "recorded_review": {"source": "saved_review", "observations": "跪姿举球", "next_action": "核对膝部落点"}}
        messages = local_review.prompt_messages(facts, "zh")
        supplied = json.loads(messages[1]["content"])
        self.assertEqual(supplied, {"observation_sentences": [{"index": 0, "text": "跪姿举球"}],
                                    "next_actions": [{"index": 0, "text": "核对膝部落点"}]})
        self.assertEqual(facts["metrics"]["hip"]["value"], 0.12345)

    def test_prompt_projection_selects_observed_tracks_without_mutating_full_facts(self):
        facts = {"metrics": {"hip": {"value": 0.123456789123}},
                 "recorded_review": {"observations": "已记录身体前倾", "next_action": "回看进入接触前的姿态", "source": "saved_review"},
                 "kinematics": {"unit": "deg", "tracks": [
                     {"track_id": number, "n_samples": count, "joints": {
                         "a": {"n": 5, "median": 1}, "b": {"n": 8, "median": 2},
                         "c": {"n": 7, "median": 3}, "d": {"n": 6, "median": 4},
                         "e": {"n": 4, "median": 5}, "f": {"n": 3, "median": 6}}}
                     for number, count in [(1, 2), (2, 20), (3, 15), (4, 10)]]}}
        original = json.dumps(facts, sort_keys=True)
        projected = local_review.prompt_facts(facts)
        self.assertEqual([t["track_id"] for t in projected["kinematics"]["tracks"]], [2, 3, 4])
        self.assertEqual(set(projected["kinematics"]["tracks"][0]["joints"]), {"a", "b", "c", "d", "e"})
        self.assertEqual(projected["prompt_projection"]["omitted_track_count"], 1)
        self.assertEqual(projected["metrics"]["hip"]["value"], 0.123456789123)
        self.assertEqual(projected["recorded_review"]["observations"], "已记录身体前倾")
        self.assertEqual(json.dumps(facts, sort_keys=True), original)

    def test_correct_size_with_wrong_official_digest_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "config.json")
            path.write_bytes(b"x" * 660)
            with self.assertRaisesRegex(ValueError, "校验"):
                local_review.file_hashes(path, "config.json")

    def test_symlink_cannot_substitute_for_installed_official_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp, "elsewhere")
            target.write_bytes(b"x" * 660)
            link = Path(tmp, "config.json")
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                local_review.file_hashes(link, "config.json")

    def test_unconfigured_and_unverified_folders_are_unavailable(self):
        settings = config.Settings()
        settings.review_model_path = None
        self.assertFalse(local_review.status(settings)["ready"])
        with tempfile.TemporaryDirectory() as tmp:
            settings.review_model_path = Path(tmp)
            self.assertFalse(local_review.status(settings)["ready"])
            Path(tmp, "manifest.json").write_text(json.dumps({"model_id": "untrusted/model"}))
            self.assertFalse(local_review.status(settings)["ready"])
            with self.assertRaises((ValueError, RuntimeError)):
                local_review.generate({"synthetic": False}, "zh", settings)

    def test_review_directory_requires_explicit_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(config.Settings().review_model_path)
            os.environ["ARENA_REVIEW_MODEL_DIR"] = "/tmp/arena-review-model"
            self.assertEqual(Path(config.Settings().review_model_path), Path("/tmp/arena-review-model"))

    def test_installer_without_download_does_not_create_model_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "model"
            result = subprocess.run([os.sys.executable, "scripts/install_review_model.py", "--directory", str(destination)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--download", result.stdout + result.stderr)
            self.assertFalse(destination.exists())

    def test_oversized_evidence_is_rejected_before_model_loading(self):
        settings = config.Settings()
        settings.review_model_path = Path("/unavailable")
        with self.assertRaisesRegex(ValueError, "长|large"):
            local_review.generate({"limitations": ["x" * 20000]}, "zh", settings)


@unittest.skipUnless(os.environ.get("ARENA_TEST_LOCAL_REVIEW"), "Opt-in real 3 GB model inference")
class InstalledLocalReviewTests(unittest.TestCase):
    def test_real_model_selects_0747_source_without_changing_actor_or_asserting_mismatch(self):
        settings = config.Settings()
        facts = recorded_facts()
        original = json.dumps(facts, ensure_ascii=False)
        selection = local_review.generate_selection(facts, "zh", settings)
        text = local_review.render_selection(facts, selection)
        source = local_review.selection_source(facts)
        for index in selection["observation_indices"]:
            self.assertIn(source["observation_sentences"][index], text)
        self.assertIn(NEXT_ACTION_0747, text)
        self.assertNotIn("不符", text)
        self.assertEqual(json.dumps(facts, ensure_ascii=False), original)
        print("REAL 0747 SELECTION:", selection["raw_response"], "\n", text)

    def test_real_offline_model_generates_nonempty_review(self):
        settings = config.Settings()
        self.assertTrue(local_review.status(settings)["ready"], local_review.status(settings))
        text = local_review.generate({"synthetic": False, "kind": "segmentation", "method_version": "sam2-test",
            "summary": {"segmented_frames": 7, "total_frames": 8, "object_count": 2},
            "limitations": ["人物遮罩不是身份或技术识别，不能判断得分与动作成败。"]}, "zh", settings)
        self.assertGreater(len(text), 10)
        self.assertLess(len(text), 4000)
        self.assertTrue(any("\u4e00" <= character <= "\u9fff" for character in text), text)
        self.assertIn("7", text)
        self.assertIn("8", text)
        self.assertNotRegex(text, "髋|膝|表情|姿势|力量|技术|动作")
        print("REAL LOCAL REVIEW:", text)

