"""Opt-in real ONNX tests. No download and no writes to the working dataset."""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from arena.api import create_app
from arena.config import Settings
from arena.worker import run_once
from arena.backends import RTMPoseBackend
from arena.video import preprocess

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(os.getenv('ARENA_TEST_MODEL_DIR', ROOT / 'models' / 'rtmpose'))


@unittest.skipUnless(os.getenv('ARENA_TEST_REAL_MODELS') == '1', '显式设置 ARENA_TEST_REAL_MODELS=1 才运行本地真模型测试')
class RealRTMPoseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='arena-real-model-test-')
        self.folder = Path(self.tmp.name)
        self.black = self.folder / 'black.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10',
                        '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(self.black)], check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_real_models_on_black_video_have_no_people_or_invented_metrics(self):
        output = self.folder / 'check.json'
        result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'check_rtmpose.py'),
                                 '--model-dir', str(MODEL_DIR), '--video', str(self.black), '--output', str(output)],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(output.read_text())
        self.assertEqual(report['backend'], 'rtmpose')
        self.assertFalse(report['synthetic'])
        self.assertEqual(report['detected_frames'], 0)
        self.assertEqual(report['quality']['usable_frames'], 0)
        self.assertTrue(report['needs_review'])
        self.assertTrue(all(m['value'] is None for m in report['metrics'].values()))
        self.assertTrue(all(len(v) == 64 for v in report['model_sha256'].values()))

    def test_multiplayer_video_upload_worker_review_and_trend_gate(self):
        source = Path(os.environ['ARENA_TEST_MULTIPERSON_VIDEO'])
        settings = Settings(data_dir=self.folder / 'data', admin_password='test-real-rtmpose-12345',
                            detector_path=str(MODEL_DIR / 'detector.onnx'), pose_path=str(MODEL_DIR / 'pose.onnx'))
        app = create_app(settings)
        with TestClient(app) as client:
            login = client.post('/api/login', json={'username':'admin','password':settings.admin_password})
            client.headers['X-CSRF-Token'] = login.json()['csrf']
            self.assertTrue(client.get('/api/models').json()['rtmpose']['ready'])
            athlete = client.post('/api/athletes', json={'name':'公开素材软件验证'}).json()
            session = client.post('/api/sessions', json={'athlete_id':athlete['id'], 'date':'2026-10-26',
                                  'objective':'仅验证真实模型链路，不评价竞技水平'}).json()
            video = client.post('/api/videos', data={'session_id':session['id'], 'category':'footwork', 'authorized':'true'},
                                files={'file':('public-validation.mp4',source.read_bytes(),'video/mp4')}).json()
            job = client.post(f"/api/videos/{video['id']}/jobs",json={'backend':'rtmpose'}).json()
            self.assertTrue(run_once(app.state.ctx))
            done = client.get(f"/api/jobs/{job['id']}").json()
            self.assertEqual(done['status'], 'needs_review', done)
            self.assertFalse(done['result']['synthetic'])
            self.assertGreater(done['result']['quality']['ambiguous_frames'], 0)
            self.assertTrue(all(m['value'] is None for m in done['result']['metrics'].values()))
            self.assertIsNone(done['result']['specialty_score']['value'])
            pose = client.get(f"/api/jobs/{job['id']}/pose").json()
            self.assertFalse(pose['synthetic'])
            self.assertEqual(pose['identity'], 'frame_local_no_tracking')
            self.assertEqual(len(pose['frames']), 5)
            self.assertEqual([f['t'] for f in pose['frames']], [0,0.2,0.4,0.6,0.8])
            people = [p for f in pose['frames'] for p in f['people']]
            self.assertGreater(len(people), 5)
            for person in people:
                self.assertEqual(len(person['keypoints']), 17)
                self.assertTrue(all(math.isfinite(v) for point in person['keypoints'] for v in point))
            draft = client.post(f"/api/videos/{video['id']}/review-drafts", json={'job_id':job['id'], 'provider':'rules'})
            self.assertEqual(draft.status_code, 201, draft.text)
            self.assertFalse(draft.json()['synthetic'])
            saved = client.put(f"/api/videos/{video['id']}/review",json={'draft_id':draft.json()['id'],
                               'observations':'多人歧义，不能归因给某一运动员', 'next_action':'使用授权单人片段重测', 'confirmed':True})
            self.assertEqual(saved.status_code,200,saved.text)
            self.assertEqual(client.get(f"/api/athletes/{athlete['id']}/profile").json()['trends'], [])
            report = client.get(f"/api/videos/{video['id']}/report").json()
            self.assertEqual(len(report['review_history']), 1)
            self.assertEqual(client.get(f"/api/jobs/{job['id']}/media").status_code, 200)

    def test_real_bytetrack_job_persists_scored_tracks_and_preserves_trend_gate(self):
        settings = Settings(data_dir=self.folder / 'tracked', admin_password='test-tracking-password-123',
                            detector_path=str(MODEL_DIR / 'detector.onnx'), pose_path=str(MODEL_DIR / 'pose.onnx'))
        with TestClient(create_app(settings)) as client:
            login=client.post('/api/login',json={'username':'admin','password':settings.admin_password})
            client.headers['X-CSRF-Token']=login.json()['csrf']
            athlete=client.post('/api/athletes',json={'name':'tracking test'}).json()
            session=client.post('/api/sessions',json={'athlete_id':athlete['id'],'date':'2026-10-27'}).json()
            source=Path(os.environ['ARENA_TEST_MULTIPERSON_VIDEO'])
            video=client.post('/api/videos',data={'session_id':session['id'],'category':'mixed','authorized':'true'},
                              files={'file':('public.mp4',source.read_bytes(),'video/mp4')}).json()
            response=client.post(f"/api/videos/{video['id']}/jobs",json={'backend':'rtmpose_tracking'})
            self.assertEqual(response.status_code,202,response.text)
            job_id=response.json()['id'];self.assertTrue(run_once(client.app.state.ctx))
            job=client.get(f'/api/jobs/{job_id}').json()
            self.assertIn(job['status'],['completed','needs_review'],job)
            self.assertGreaterEqual(job['result']['tracking']['track_count'],2)
            self.assertFalse(job['result']['tracking']['identity_verified'])
            pose=client.get(f'/api/jobs/{job_id}/pose').json()
            self.assertEqual(pose['backend'],'rtmpose_tracking')
            self.assertEqual(pose['identity'],'tracklets_not_verified')
            people=[p for frame in pose['frames'] for p in frame['people']]
            self.assertTrue(all(0.1<=p['detection_confidence']<=1 and len(p['bbox'])==4 for p in people))
            self.assertTrue(any(p['track_id'] is not None for p in people))
            self.assertEqual(client.get(f"/api/athletes/{athlete['id']}/profile").json()['trends'],[])
            status=client.get('/api/models').json()['tracking']
            self.assertEqual(status['processed_videos'],1)
            self.assertEqual(status['processed_jobs'],1)
            target=job['result']['tracking']['tracks'][0]['track_id']
            invalid=client.post(f"/api/videos/{video['id']}/jobs",json={'backend':'rtmpose_tracking','target_track_id':target})
            self.assertEqual(invalid.status_code,422,invalid.text)
            focused=client.post(f"/api/videos/{video['id']}/jobs",json={'backend':'rtmpose_tracking',
                    'source_pose_job_id':job_id,'target_track_id':target})
            self.assertEqual(focused.status_code,202,focused.text)
            self.assertTrue(run_once(client.app.state.ctx))
            focused_job=client.get('/api/jobs/'+focused.json()['id']).json()
            self.assertEqual(focused_job['status'],'needs_review',focused_job)
            self.assertEqual(focused_job['result']['selected_track_id'],target)
            self.assertEqual(focused_job['result']['source_pose_job_id'],job_id)
            self.assertEqual(focused_job['metadata'],job['metadata'])
            self.assertEqual(focused_job['result']['quality']['ambiguous_frames'],0)


    @unittest.skipUnless(os.getenv("ARENA_TEST_SAM2_VIDEO"), "提供本地短视频后才运行真实SAM2任务测试")
    def test_real_sam2_worker_stores_masks_and_compact_summary(self):
        settings=Settings(data_dir=self.folder/'sam2-data',admin_password='test-sam2-password-123',
                          detector_path=str(MODEL_DIR/'detector.onnx'),pose_path=str(MODEL_DIR/'pose.onnx'),
                          sam2_path=str(ROOT/'models/sam2'))
        with TestClient(create_app(settings)) as client:
            login=client.post('/api/login',json={'username':'admin','password':settings.admin_password})
            client.headers['X-CSRF-Token']=login.json()['csrf']
            athlete=client.post('/api/athletes',json={'name':'segmentation test'}).json()
            session=client.post('/api/sessions',json={'athlete_id':athlete['id'],'date':'2026-10-27'}).json()
            source=Path(os.environ['ARENA_TEST_SAM2_VIDEO'])
            video=client.post('/api/videos',data={'session_id':session['id'],'category':'mixed','authorized':'true'},
                              files={'file':('authorized-clip.mp4',source.read_bytes(),'video/mp4')}).json()
            response=client.post(f"/api/videos/{video['id']}/jobs",json={'backend':'sam2'})
            self.assertEqual(response.status_code,202,response.text)
            self.assertTrue(run_once(client.app.state.ctx))
            job=client.get('/api/jobs/'+response.json()['id']).json()
            self.assertEqual(job['status'],'completed',job)
            self.assertEqual(job['result']['kind'],'segmentation')
            self.assertNotIn('frames',job['result'])
            artifact=client.get('/api/jobs/'+job['id']+'/segmentation')
            self.assertEqual(artifact.status_code,200,artifact.text)
            data=artifact.json()
            self.assertEqual(data['summary'],job['result']['segmentation'])
            self.assertGreater(data['summary']['segmented_frames'],1)
            self.assertFalse(data['synthetic'])
            self.assertTrue(all(frame['masks'] for frame in data['frames']))
            self.assertEqual(client.get('/api/models').json()['sam2']['processed_videos'],1)
            self.assertEqual(client.get(f"/api/athletes/{athlete['id']}/profile").json()['trends'],[])

    def test_weights_changed_during_real_inference_cannot_get_false_fingerprint(self):
        from rtmlib import RTMPose
        for filename in ('detector.onnx','pose.onnx'):
            shutil.copyfile(MODEL_DIR / filename, self.folder / filename)
        settings = Settings(data_dir=self.folder, detector_path=str(self.folder / 'detector.onnx'),
                            pose_path=str(self.folder / 'pose.onnx'))
        normalized = self.folder / 'single-frame.mp4'
        metadata = preprocess(Path(os.environ['ARENA_TEST_MULTIPERSON_VIDEO']), normalized, settings, end_sec=0.2)
        original = RTMPose.__call__
        changed = False

        def replace_after_load(estimator, *args, **kwargs):
            nonlocal changed
            result = original(estimator, *args, **kwargs)
            if not changed:
                with (self.folder / 'pose.onnx').open('ab') as out:
                    out.write(b'changed-model-file')
                changed = True
            return result

        with patch.object(RTMPose, '__call__', replace_after_load):
            with self.assertRaisesRegex(ValueError, '权重.*变化'):
                RTMPoseBackend(settings).extract(normalized, metadata, lambda *args: None)


if __name__ == '__main__':
    unittest.main()
