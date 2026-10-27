"""Segmentation file integrity, geometry and real decoded sample timing."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import importlib.util
NUMPY_READY = importlib.util.find_spec("numpy") is not None
if NUMPY_READY:
    import numpy as np

from arena import segmentation


@unittest.skipUnless(NUMPY_READY, "install optional model dependencies for segmentation tests")
class SegmentationTests(unittest.TestCase):
    def test_missing_or_partial_model_never_reports_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            settings = SimpleNamespace(sam2_path=folder, detector_path="")
            self.assertFalse(segmentation.segmentation_status(settings)["ready"])
            (Path(folder) / "model.safetensors").write_bytes(b"unfinished download")
            (Path(folder) / "manifest.json").write_text(json.dumps({"revision": segmentation.MODEL_REVISION}))
            self.assertFalse(segmentation.segmentation_status(settings)["ready"])
            for filename in segmentation.MODEL_FILES:
                (Path(folder) / filename).write_bytes(b"incomplete")
            for invalid in ([], {"model_id": segmentation.MODEL_ID, "revision": segmentation.MODEL_REVISION, "files": []}):
                (Path(folder) / "manifest.json").write_text(json.dumps(invalid))
                self.assertFalse(segmentation.segmentation_status(settings)["ready"])

    def test_normalized_roi_becomes_pixel_box_without_rounding_away_small_regions(self):
        self.assertEqual(segmentation.roi_box([.1, .2, .25, .3], 640, 480), [64., 96., 224., 240.])
        for roi in ([0, 0, 0, 1], [.9, 0, .2, 1], [0, float("nan"), 1, 1], [0, 0, 1]):
            with self.subTest(roi=roi), self.assertRaises(ValueError):
                segmentation.roi_box(roi, 640, 480)

    def test_mask_polygons_preserve_disconnected_regions_and_pixel_bounds(self):
        mask = np.zeros((40, 60), dtype=bool)
        mask[3:14, 5:20] = True
        mask[20:35, 35:55] = True
        polygons = segmentation.mask_polygons(mask)
        self.assertEqual(len(polygons), 2)
        bounds = sorted((min(p[0] for p in poly), min(p[1] for p in poly),
                         max(p[0] for p in poly), max(p[1] for p in poly)) for poly in polygons)
        self.assertEqual(bounds, [(5., 3., 19., 13.), (35., 20., 54., 34.)])
        self.assertEqual(segmentation.mask_polygons(np.zeros((20, 20), dtype=bool)), [])
        json.dumps(polygons, allow_nan=False)

    def test_sampling_normalizes_nonzero_pts_and_covers_entire_clip(self):
        with tempfile.TemporaryDirectory() as folder:
            video = Path(folder) / "timing.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=10:d=3",
                            "-vf", "setpts=PTS+2/TB", "-c:v", "libx264", "-threads", "1", str(video)],
                           capture_output=True, check=True)
            frames = list(segmentation.sampled_frames(video))
            self.assertEqual([round(t, 5) for t, _ in frames], [0., .5, 1., 1.5, 2., 2.5])
            self.assertEqual(frames[-1][1].shape, (48, 64, 3))

    @unittest.skipUnless(os.getenv("ARENA_TEST_SAM2_VIDEO"), "显式提供最多2秒的本地人物视频才运行真实 SAM2")
    def test_real_streaming_keeps_initial_objects_after_first_frame(self):
        from arena.video import probe
        root = Path(__file__).resolve().parents[1]
        path = Path(os.environ["ARENA_TEST_SAM2_VIDEO"])
        info, stream, _ = probe(path)
        duration = float(info["format"]["duration"])
        self.assertTrue(.5 < duration <= 2, "请提供0.5–2秒、含可检测人物的授权本地片段")
        settings = SimpleNamespace(sam2_path=str(root / "models" / "sam2"),
                                   detector_path=str(root / "models" / "rtmpose" / "detector.onnx"))
        self.assertTrue(segmentation.segmentation_status(settings)['automatic_prompt_ready'])
        without_detector=SimpleNamespace(sam2_path=settings.sam2_path,detector_path='')
        manual_status=segmentation.segmentation_status(without_detector)
        self.assertTrue(manual_status['ready'])
        self.assertFalse(manual_status['automatic_prompt_ready'])
        result = segmentation.SAM2Backend(settings).segment(path, {
            "width": stream["width"], "height": stream["height"], "duration": duration, "time_offset": 7.25,
        }, lambda *args: None)
        self.assertFalse(result["synthetic"])
        self.assertEqual(result["time_offset"], 7.25)
        self.assertEqual(result["frames"][0]["t"], 0.)
        self.assertGreaterEqual(result["frames"][-1]["t"], .5)
        self.assertGreaterEqual(result["summary"]["segmented_frames"], 2)
        self.assertGreaterEqual(result["summary"]["prompted_objects"], 1)
        self.assertFalse(result["provenance"]["identity_verified"])
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
