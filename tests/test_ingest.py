import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from arena.api import create_app
from arena.config import Settings


class FolderIngestionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='arena-ingest-test-')
        self.root = Path(self.tmp.name)
        self.inbox = self.root / 'inbox'
        (self.inbox / '步法训练').mkdir(parents=True)
        self.source = self.inbox / '步法训练' / 'clip.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=1',
                        '-c:v', 'libx264', str(self.source)], check=True)
        self.client = TestClient(create_app(Settings(data_dir=self.root/'data', admin_password='ingest-test-password-1234')))
        self.client.__enter__()
        auth = self.client.post('/api/login', json={'username':'admin','password':'ingest-test-password-1234'}).json()
        self.client.headers['X-CSRF-Token'] = auth['csrf']
        athlete = self.client.post('/api/athletes', json={'name':'001号运动员'}).json()
        self.session = self.client.post('/api/sessions', json={'athlete_id':athlete['id'], 'date':'2026-10-25',
            'objective':'测试视频导入', 'duration_min':60, 'rpe':None}).json()

    def tearDown(self):
        self.client.__exit__(None,None,None)
        self.tmp.cleanup()

    def ingest(self, client=None, session_id=None):
        from arena.ingest import import_folder
        return import_folder(client or self.client, self.inbox, session_id or self.session['id'], self.root/'imports')

    def test_real_api_import_preserves_small_original_and_queues_rtmpose(self):
        report = self.ingest()
        self.assertEqual(report['failed'], [])
        self.assertEqual(report['pending'], [])
        self.assertEqual(len(report['imported']), 1)
        videos = self.client.get('/api/videos').json()
        self.assertEqual(len(videos),1)
        self.assertEqual(videos[0]['sha256'],hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(videos[0]['category'],'footwork')
        self.assertEqual(videos[0]['latest_job']['backend'],'rtmpose')
        self.assertEqual(videos[0]['latest_job']['status'],'queued')
        self.assertIsNone(self.client.get('/api/sessions').json()[0]['rpe'])
        self.assertEqual(self.client.get('/api/sessions').json()[0]['duration_min'],60)

    def test_rerun_and_identical_file_copy_do_not_duplicate_records(self):
        first = self.ingest()
        shutil.copyfile(self.source,self.source.with_name('renamed-copy.mp4'))
        self.ingest()
        videos = self.client.get('/api/videos').json()
        self.assertEqual(len(videos),1)
        self.assertEqual(videos[0]['id'],first['imported'][0]['video_id'])
        self.assertEqual(len(self.client.get(f"/api/videos/{videos[0]['id']}/report").json()['jobs']),1)

    def test_unknown_upload_outcome_is_recovered_using_real_server_hash(self):
        class ConnectionLost:
            def __init__(self, client): self.client,self.lost=client,False
            def get(self,*args,**kwargs): return self.client.get(*args,**kwargs)
            def post(self,path,**kwargs):
                response=self.client.post(path,**kwargs)
                if path=='/api/videos' and not self.lost:
                    self.lost=True
                    raise httpx.ReadTimeout('Injected connection loss after real server acceptance')
                return response
        first=self.ingest(client=ConnectionLost(self.client))
        self.assertEqual(len(first['failed']),1)
        self.assertEqual(len(self.client.get('/api/videos').json()),1)
        second=self.ingest()
        self.assertEqual(second['failed'],[])
        self.assertEqual(len(self.client.get('/api/videos').json()),1)
        self.assertEqual(self.client.get('/api/videos').json()[0]['latest_job']['backend'],'rtmpose')

    def test_lost_response_then_identical_copy_in_same_run_is_not_uploaded_twice(self):
        shutil.copyfile(self.source,self.source.with_name('renamed-copy.mp4'))
        class ConnectionLost:
            def __init__(self,client):self.client,self.lost=client,False
            def get(self,*args,**kwargs):return self.client.get(*args,**kwargs)
            def post(self,path,**kwargs):
                response=self.client.post(path,**kwargs)
                if path=='/api/videos' and not self.lost:
                    self.lost=True
                    raise httpx.ReadTimeout('Injected response loss after actual upload')
                return response
        self.ingest(client=ConnectionLost(self.client))
        self.assertEqual(len(self.client.get('/api/videos').json()),1)

    def test_missing_rpe_is_unknown_in_profile(self):
        profile=self.client.get(f"/api/athletes/{self.session['athlete_id']}/profile").json()
        self.assertIsNone(profile['recorded_load'])

    def test_unknown_category_and_external_symlink_stay_pending(self):
        self.source.rename(self.inbox/'unclassified.mp4')
        outside=self.root/'outside.mp4'
        shutil.copyfile(self.inbox/'unclassified.mp4',outside)
        (self.inbox/'步法训练'/'linked.mp4').symlink_to(outside)
        report=self.ingest()
        self.assertEqual(len(report['pending']),2)
        self.assertEqual(self.client.get('/api/videos').json(),[])

    def test_broken_source_does_not_prevent_other_real_clips(self):
        (self.inbox/'步法训练'/'broken.mp4').write_bytes(b'broken')
        report=self.ingest()
        self.assertEqual(len(report['failed']),1)
        self.assertEqual(len(report['imported']),1)
        self.assertEqual(len(self.client.get('/api/sessions').json()),1)

    def test_requires_actual_existing_session(self):
        with self.assertRaises(ValueError):self.ingest(session_id='does-not-exist')
        self.assertEqual(self.client.get('/api/videos').json(),[])

    def test_mixed_upload_and_manual_category_change_do_not_guess_action_labels(self):
        with self.source.open('rb') as source:
            response=self.client.post('/api/videos',data={'session_id':self.session['id'],'category':'mixed','authorized':'true'},files={'file':('clip.mp4',source,'video/mp4')})
        self.assertEqual(response.status_code,201,response.text)
        id=response.json()['id']
        insights=self.client.get('/api/insights?start=2026-10-25&end=2026-10-25').json()
        self.assertEqual(insights['category_counts'].get('mixed'),1)
        self.assertEqual(self.client.get('/api/videos?category=mixed').json()[0]['id'],id)
        changed=self.client.patch(f'/api/videos/{id}/category',json={'category':'attack'})
        self.assertEqual(changed.status_code,200,changed.text)
        self.assertEqual(changed.json()['category'],'attack')
        self.assertEqual(self.client.get('/api/videos?category=mixed').json(),[])
        denied=self.client.patch(f'/api/videos/{id}/category',headers={'X-CSRF-Token':''},json={'category':'mixed'})
        self.assertEqual(denied.status_code,403)


if __name__=='__main__':unittest.main()
