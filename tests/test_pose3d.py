"""Learned pose lifting contracts; real checkpoint tests are explicitly opt-in."""
import importlib.util
import json
import math
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


class Pose3DPreparationTests(unittest.TestCase):
    def backend_module(self):
        self.assertIsNotNone(importlib.util.find_spec('arena.pose3d'), 'The learned pose3d backend must exist')
        from arena import pose3d
        return pose3d

    def test_coco_mapping_and_official_crop_normalization(self):
        module = self.backend_module()
        import numpy as np
        coco = np.array([[[i * 10., i * 20., .8] for i in range(17)]], dtype=np.float32)
        h36m = module.coco_to_h36m(coco)
        self.assertEqual(h36m.shape, (1, 17, 3))
        np.testing.assert_allclose(h36m[0, 0], [115, 230, .8])
        np.testing.assert_allclose(h36m[0, 1], coco[0, 12])
        np.testing.assert_allclose(h36m[0, 8], [55, 110, .8])
        result = module.normalize_input(h36m)
        self.assertTrue(np.isfinite(result).all())
        self.assertAlmostEqual(float(result[..., :2].max()), 1.)
        self.assertAlmostEqual(float(result[..., :2].min()), -1.)
        np.testing.assert_allclose(result[..., 2], .8)
        shifted = h36m.copy(); shifted[..., :2] = shifted[..., :2] * 3 + 100
        np.testing.assert_allclose(module.normalize_input(shifted), result, atol=1e-6)

    def test_tracks_split_at_missing_frames_and_keep_exact_pts_and_quality(self):
        module = self.backend_module()
        person = lambda track: {'track_id': track, 'keypoints': [[i, i * 2, .9] for i in range(17)], 'quality': {'occlusion': 'unknown'}}
        pose = {'layout': 'coco17', 'synthetic': False, 'sample_fps': 10, 'frames': [
            {'t': .034, 'people': [person(1), person(2)]},
            {'t': .137, 'people': [person(1)]},
            {'t': .241, 'people': [person(2)]},
        ]}
        segments, skipped = module.prepare_segments(pose)
        self.assertEqual([[o['t'] for o in s] for s in segments], [[.034, .137], [.034], [.241]])
        self.assertEqual(segments[0][0]['person']['quality']['occlusion'], 'unknown')
        self.assertEqual(skipped, 0)
        selected, _ = module.prepare_segments(pose, 2)
        self.assertEqual(len(selected), 2)
        with self.assertRaisesRegex(ValueError, 'track'):
            module.prepare_segments(pose, 99)

    def test_unidentified_detections_are_skipped_and_invalid_sources_rejected(self):
        module = self.backend_module()
        pose = {'layout': 'coco17', 'synthetic': False, 'frames': [{'t': 0, 'people': [{'track_id': None}]}]}
        with self.assertRaisesRegex(ValueError, 'track'):
            module.prepare_segments(pose)
        pose['synthetic'] = True
        with self.assertRaisesRegex(ValueError, 'synthetic'):
            module.prepare_segments(pose)

    def test_checkpoint_rejects_missing_and_wrong_hash_before_loading(self):
        module = self.backend_module()
        with tempfile.TemporaryDirectory() as folder:
            backend = module.Pose3DBackend(SimpleNamespace(pose3d_model_path=folder))
            with self.assertRaisesRegex(ValueError, 'install_pose3d'):
                backend.load_model()
            with (Path(folder) / 'best_epoch.bin').open('wb') as stream:
                stream.truncate(module.WEIGHT_BYTES)
            with self.assertRaisesRegex(ValueError, 'SHA256'):
                backend.load_model()


@unittest.skipUnless(os.getenv('ARENA_TEST_REAL_POSE3D') == '1', 'Set ARENA_TEST_REAL_POSE3D=1 for the pinned local model')
class RealPose3DTests(unittest.TestCase):
    def test_real_short_clip_preserves_pts_and_has_learned_finite_depth(self):
        from arena.pose3d import Pose3DBackend
        jobs = json.loads((ROOT / 'data/imports/joint-observations-20260725/jobs.json').read_text())['jobs']
        job = jobs[0]
        pose = json.loads((ROOT / f"data/objects/videos/{job['video_id']}/jobs/{job['job_id']}/pose.json").read_text())
        pose['frames'] = pose['frames'][1:4]
        result = Pose3DBackend(SimpleNamespace(pose3d_model_path=str(ROOT / 'models/pose3d'))).reconstruct(pose, {}, lambda *a: None, 1)
        self.assertFalse(result['synthetic'])
        self.assertEqual(result['layout'], 'h36m17')
        self.assertEqual(result['coordinates'], 'root_relative_model_space')
        self.assertEqual([f['t'] for f in result['frames']], [f['t'] for f in pose['frames']])
        depth = []
        for frame in result['frames']:
            joints = frame['people'][0]['joints']
            self.assertEqual(len(joints), 17)
            self.assertEqual(joints[0], [0., 0., 0.])
            for joint in joints:
                self.assertEqual(len(joint), 3)
                self.assertTrue(all(math.isfinite(x) for x in joint))
                depth.append(joint[2])
        self.assertGreater(max(depth) - min(depth), .01)

    def test_real_single_paired_and_short_sources_have_finite_learned_depth(self):
        from arena.pose3d import Pose3DBackend
        import numpy as np
        jobs = json.loads((ROOT / 'data/imports/joint-observations-20260725/jobs.json').read_text())['jobs']
        backend = Pose3DBackend(SimpleNamespace(pose3d_model_path=str(ROOT / 'models/pose3d')))
        for filename, minimum_tracks in [('IMG_0757.MOV', 1), ('IMG_0737.MOV', 2), ('IMG_0697.MOV', 2)]:
            with self.subTest(filename=filename):
                job = next(job for job in jobs if job['filename'] == filename)
                pose = json.loads((ROOT / f"data/objects/videos/{job['video_id']}/jobs/{job['job_id']}/pose.json").read_text())
                result = backend.reconstruct(pose, {}, lambda *a: None)
                self.assertGreaterEqual(len(result['summary']['track_ids']), minimum_tracks)
                coordinates = np.array([p['joints'] for frame in result['frames'] for p in frame['people']])
                self.assertTrue(np.isfinite(coordinates).all())
                self.assertGreater(float(np.ptp(coordinates[..., 2])), .01)
                by_time = {frame['t']: frame for frame in pose['frames']}
                for frame in result['frames']:
                    source = by_time[frame['t']]
                    for person in frame['people']:
                        original = next(p for p in source['people'] if p.get('track_id') == person['track_id'])
                        self.assertEqual(person['source_quality']['coco17_confidence'], [p[2] for p in original['keypoints']])
                        self.assertEqual(person['source_quality']['occlusion'], 'unknown')
                self.assertEqual(result['provenance']['temporal_padding'], 'none; official variable-length inference')


if __name__ == '__main__':
    unittest.main()
