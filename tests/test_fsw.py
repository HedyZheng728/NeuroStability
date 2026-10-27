import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

from arena.backends import BackendUnavailable
from arena.fsw import FSWBackend, fsw_status


class FSWTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = self.root / "bundle.json"
        self.settings = SimpleNamespace(fsw_bundle=str(self.manifest))

    def bundle(self):
        # These are arbitrary file bytes for integrity tests, never model outputs.
        (self.root / "action.pth").write_bytes(b"not a trained checkpoint")
        (self.root / "segment.pth").write_bytes(b"not a segmenter checkpoint")
        return {
            "schema_version": 1,
            "source_url": "https://example.org/model-release",
            "source_commit": "9dad3e652507e57714c60abb3a3853d000267e4c",
            "architecture": "CNN_BiLSTM",
            "training_dataset": "Open FSW",
            "labels": ["Hip headlock throw", "Single leg tackle",
                       "Gut wrench / rolling side sweep", "Arm spin",
                       "Side sweep and over-under", "Ankle lace", "From head and arm"],
            "preprocessing": {"num_frames": 15, "resize": [224, 224], "color": "RGB",
                              "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225],
                              "segmentation": "DeepLabV3+"},
            "checkpoint": {"path": "action.pth", "sha256": hashlib.sha256(
                (self.root / "action.pth").read_bytes()).hexdigest()},
            "segmentation_checkpoint": {"path": "segment.pth", "sha256": hashlib.sha256(
                (self.root / "segment.pth").read_bytes()).hexdigest()},
        }

    def write_bundle(self, bundle):
        self.manifest.write_text(json.dumps(bundle), encoding="utf-8")
        return fsw_status(self.settings)

    def test_unconfigured_is_blocked_without_prediction(self):
        status = fsw_status(SimpleNamespace(fsw_bundle=""))
        self.assertFalse(status["ready"])
        self.assertEqual(status["code"], "missing_bundle")
        self.assertFalse(status["synthetic"])
        self.assertNotIn("probabilities", status)

    def test_missing_manifest_is_blocked(self):
        self.assertEqual(fsw_status(self.settings)["code"], "missing_bundle")

    def test_remote_manifest_never_downloads(self):
        status = fsw_status(SimpleNamespace(fsw_bundle="https://example.org/bundle.json"))
        self.assertEqual(status["code"], "invalid_bundle")
        self.assertIn("本地", status["reason"])

    def test_invalid_json_and_nonobject_are_blocked(self):
        for value in ("{", "[]", "null", '{"schema_version":true}'):
            with self.subTest(value=value):
                self.manifest.write_text(value, encoding="utf-8")
                self.assertEqual(fsw_status(self.settings)["code"], "invalid_bundle")

    def test_invalid_schema_labels_architecture_and_preprocessing_are_blocked(self):
        for key, value in (("schema_version", 2), ("labels", ["unknown"] * 7),
                           ("architecture", "efficientnet_b7"), ("preprocessing", {}),
                           ("training_dataset", "ImageNet"), ("source_commit", "main")):
            with self.subTest(key=key):
                bundle = self.bundle()
                bundle[key] = value
                self.assertEqual(self.write_bundle(bundle)["code"], "invalid_bundle")

    def test_missing_checkpoint_and_hash_mismatch_are_blocked(self):
        bundle = self.bundle()
        (self.root / "action.pth").unlink()
        self.assertEqual(self.write_bundle(bundle)["code"], "missing_checkpoint")
        bundle = self.bundle()
        bundle["checkpoint"]["sha256"] = "0" * 64
        self.assertEqual(self.write_bundle(bundle)["code"], "checkpoint_mismatch")

    def test_segmenter_required_and_generic_backbone_cannot_enable_inference(self):
        bundle = self.bundle()
        del bundle["segmentation_checkpoint"]
        self.assertEqual(self.write_bundle(bundle)["code"], "missing_checkpoint")
        bundle = self.bundle()
        bundle["preprocessing"]["segmentation"] = "DeepLabV3"
        self.assertEqual(self.write_bundle(bundle)["code"], "invalid_bundle")

    def test_remote_and_escaping_checkpoint_paths_are_rejected(self):
        for path in ("https://example.org/model.pth", "../outside.pth", "/tmp/model.pth"):
            with self.subTest(path=path):
                bundle = self.bundle()
                bundle["checkpoint"]["path"] = path
                self.assertEqual(self.write_bundle(bundle)["code"], "invalid_bundle")

    def test_manifest_claims_cannot_mark_unverified_weights_ready(self):
        bundle = self.bundle()
        bundle["verified"] = True
        bundle["ready"] = True
        status = self.write_bundle(bundle)
        self.assertFalse(status["ready"])
        self.assertEqual(status["code"], "verification_required")
        self.assertTrue(status["artifact_hashes_match"])
        self.assertFalse(status["strict_load_verified"])
        self.assertFalse(status["real_clip_verified"])

    def test_classify_always_raises_until_real_weights_are_verified(self):
        self.write_bundle(self.bundle())
        progress = []
        with self.assertRaises(BackendUnavailable):
            FSWBackend(self.settings).classify(self.root / "clip.mp4", {}, lambda *x: progress.append(x))
        self.assertEqual(progress, [])

    def test_cli_missing_exit_code_is_two(self):
        env = dict(os.environ, FSW_BUNDLE="", ARENA_FSW_BUNDLE="")
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run([sys.executable, str(root / "scripts/check_fsw.py")],
                                cwd=root, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("BLOCKED", result.stdout)
        self.assertIn("FSW", result.stdout)


if __name__ == "__main__":
    unittest.main()
