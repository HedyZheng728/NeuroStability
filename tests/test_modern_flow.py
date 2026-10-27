"""Isolated IO fixtures; actual pretrained inference is covered by opt-in model tests."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select, update
from arena import db
from arena.api import create_app
from arena.config import Settings
from arena.worker import run_once
from arena.video import preprocess


class ModernFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media=tempfile.TemporaryDirectory();cls.clip=Path(cls.media.name)/'clip.mp4'
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=black:s=160x120:r=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p',str(cls.clip)],check=True)

    @classmethod
    def tearDownClass(cls):cls.media.cleanup()

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.settings=Settings(data_dir=Path(self.tmp.name),admin_password='modern-test-password-123456')
        self.app=create_app(self.settings);self.ctx=self.app.state.ctx;self.client=TestClient(self.app).__enter__()
        login=self.client.post('/api/login',json={'username':'admin','password':self.settings.admin_password})
        self.client.headers['X-CSRF-Token']=login.json()['csrf']
        athlete=self.client.post('/api/athletes',json={'name':'isolated test'}).json()
        session=self.client.post('/api/sessions',json={'athlete_id':athlete['id'],'date':'2026-01-01'}).json()
        response=self.client.post('/api/videos',data={'session_id':session['id'],'category':'mixed','authorized':'true'},files={'file':('clip.mp4',self.clip.read_bytes(),'video/mp4')})
        self.assertEqual(response.status_code,201,response.text);self.video=response.json()

    def tearDown(self):self.client.__exit__(None,None,None);self.tmp.cleanup()

    def source(self, *, selected=None):
        normalized=Path(self.tmp.name)/'normalized.mp4';info=preprocess(self.clip,normalized,self.settings)
        pose={'layout':'coco17','backend':'rtmpose_tracking','synthetic':False,'width':160,'height':120,'sample_fps':10,
              'frames':[{'t':t,'people':[{'track_id':1,'keypoints':[[40+i,20+i,.9] for i in range(17)]}]} for t in (0,.1,.2)]}
        params={'target_track_id':selected} if selected else {}
        row=dict(id='source-job',video_id=self.video['id'],backend='rtmpose_tracking',status='needs_review',stage='done',progress=100,
            params=params,metadata=info,result={'synthetic':False,'tracking':{'tracks':[{'track_id':1}]}},error=None,worker_token=None,lease_until=None,created_at=db.now(),updated_at=db.now())
        self.ctx.db.add(db.jobs,row);prefix=f"videos/{self.video['id']}/jobs/source-job/"
        self.ctx.store.put(normalized,prefix+'normalized.mp4','video/mp4')
        file=Path(self.tmp.name)/'pose.json';file.write_text(json.dumps(pose));self.ctx.store.put(file,prefix+'pose.json','application/json')
        return row,pose

    def test_real_3d_source_is_reused_and_persisted_without_reinference(self):
        original,pose=self.source(selected=1)
        response=self.client.post('/api/videos/'+self.video['id']+'/jobs',json={'backend':'pose3d','source_pose_job_id':'source-job'})
        self.assertEqual(response.status_code,202,response.text);job=response.json();self.assertEqual(job['params']['target_track_id'],1)
        calls=[]
        class Backend:
            def reconstruct(inner,observed,metadata,progress,target_track_id=None):
                calls.append((observed,metadata,target_track_id));progress(70,'test reconstruction')
                return {'kind':'pose3d','synthetic':False,'experimental':True,'layout':'h36m17','coordinates':'root_relative_model_space','unit':'model_units',
                        'frames':[{'t':0,'people':[{'track_id':1,'joints':[[0.,float(i),i/10] for i in range(17)]}]}],
                        'summary':{'total_frames':1,'track_count':1},'method_version':'test-only','limitations':['isolated fixture']}
        with patch('arena.worker.get_backend',return_value=Backend()):self.assertTrue(run_once(self.ctx))
        done=self.client.get('/api/jobs/'+job['id']).json();self.assertIn(done['status'],('completed','needs_review'))
        self.assertEqual(len(calls),1);self.assertEqual(calls[0],(pose,original['metadata'],1))
        self.assertNotIn('frames',done['result']);self.assertEqual(done['result']['pose3d']['track_count'],1)
        artifact=self.client.get('/api/jobs/'+job['id']+'/pose3d');self.assertEqual(artifact.status_code,200,artifact.text)
        self.assertEqual(artifact.json()['source_pose_job_id'],'source-job')
        self.assertEqual(self.ctx.db.get(db.jobs,'source-job'),original)
        self.assertEqual(self.client.get('/api/jobs/'+job['id']+'/media',headers={'Range':'bytes=0-15'}).status_code,206)
        with TestClient(self.app) as outsider:self.assertEqual(outsider.get('/api/jobs/'+job['id']+'/pose3d').status_code,401)

    def test_source_bounds_backend_and_cross_video_are_validated(self):
        self.source()
        for payload in ({'backend':'pose3d','source_pose_job_id':'missing'},
                        {'backend':'pose3d','source_pose_job_id':'source-job','start_sec':.1},
                        {'backend':'pose3d','target_track_id':1},
                        {'backend':'action','source_pose_job_id':'source-job'},
                        {'backend':'action','roi':[0,0,1,1]},
                        {'backend':'pose3d','roi':[0,0,1,1]},
                        {'backend':'rtmpose_tracking','source_pose_job_id':'source-job'}):
            response=self.client.post('/api/videos/'+self.video['id']+'/jobs',json=payload)
            self.assertEqual(response.status_code,422,response.text)
        self.assertEqual(self.client.get('/api/jobs/source-job/pose3d').status_code,409)

    def test_reused_source_preserves_actual_clip_bounds_and_rejects_other_video(self):
        original, _ = self.source()
        with self.ctx.db.engine.begin() as c:
            c.execute(update(db.jobs).where(db.jobs.c.id=='source-job').values(metadata={**original['metadata'], 'time_offset':.5, 'duration':1.}))
        response=self.client.post('/api/videos/'+self.video['id']+'/jobs',json={'backend':'pose3d','source_pose_job_id':'source-job'})
        self.assertEqual(response.status_code,202,response.text)
        self.assertEqual(response.json()['params']['start_sec'],.5)
        self.assertEqual(response.json()['params']['end_sec'],1.5)
        self.ctx.db.add(db.videos,{**self.ctx.db.get(db.videos,self.video['id']),'id':'another-video'})
        with self.ctx.db.engine.begin() as c:c.execute(update(db.jobs).where(db.jobs.c.id=='source-job').values(video_id='another-video'))
        # Drop the unrelated active job solely in this isolated database.
        with self.ctx.db.engine.begin() as c:c.execute(db.jobs.delete().where(db.jobs.c.id==response.json()['id']))
        response=self.client.post('/api/videos/'+self.video['id']+'/jobs',json={'backend':'pose3d','source_pose_job_id':'source-job'})
        self.assertEqual(response.status_code,422,response.text)

    def test_action_worker_result_and_event_source_are_saved_without_grading(self):
        response=self.client.post('/api/videos/'+self.video['id']+'/jobs',json={'backend':'action'})
        self.assertEqual(response.status_code,202,response.text);job=response.json()
        class Backend:
            def classify(inner,path,metadata,progress):
                return {'kind':'recognition','synthetic':False,'experimental':True,'method_version':'isolated-action-fixture',
                        'candidate_label':'practice','candidates':[{'id':'practice','label':'practice','similarity':.2}],
                        'windows':[{'start_sec':0,'end_sec':1,'source_frame_times_sec':[0,.5,1]}],'limitations':['candidate only']}
        with patch('arena.worker.get_backend',return_value=Backend()):run_once(self.ctx)
        done=self.client.get('/api/jobs/'+job['id']).json();self.assertEqual(done['result']['candidates'][0]['similarity'],.2)
        self.assertNotIn('probabilities',done['result'])
        event=self.client.post('/api/videos/'+self.video['id']+'/events',json={'start_sec':0,'end_sec':1,'label':'edited observation','actor':'unknown','source_job_id':job['id'],'outcome':''})
        self.assertEqual(event.status_code,201,event.text);self.assertEqual(event.json()['source_job_id'],job['id'])
        self.assertEqual(event.json()['created_by'],'admin');self.assertEqual(event.json()['outcome'],'')
        for invalid in ({'source_job_id':'missing'},{'source_job_id':job['id'],'end_sec':4}):
            bad=self.client.post('/api/videos/'+self.video['id']+'/events',json={'start_sec':0,'end_sec':1,'label':'edited','actor':'unknown',**invalid})
            self.assertEqual(bad.status_code,422,bad.text)
        self.assertEqual(self.ctx.db.rows(select(db.manual_scores)),[])

    def test_schema_has_versioned_nullable_event_provenance(self):
        self.assertEqual(self.ctx.db.rows(select(db.schema)),[{'version':4}])
        with self.ctx.db.engine.begin() as c:
            c.exec_driver_sql('DROP TABLE events')
            c.exec_driver_sql('CREATE TABLE events (id VARCHAR(36) PRIMARY KEY, video_id VARCHAR(36) REFERENCES videos(id) ON DELETE CASCADE, start_sec FLOAT NOT NULL, end_sec FLOAT NOT NULL, label VARCHAR(100) NOT NULL, actor VARCHAR(20) NOT NULL, outcome VARCHAR(100) NOT NULL, notes TEXT NOT NULL, created_by VARCHAR(80) NOT NULL, created_at VARCHAR(40) NOT NULL)')
            c.exec_driver_sql("INSERT INTO events VALUES ('legacy-event',?,0,1,'original label','unknown','','original note','admin',?)",(self.video['id'],db.now()))
            c.exec_driver_sql('UPDATE schema_version SET version=3')
        self.ctx.db.initialize(self.settings.admin_password)
        self.assertEqual(self.ctx.db.rows(select(db.schema)),[{'version':4}])
        event=self.ctx.db.get(db.events,'legacy-event');self.assertEqual(event['label'],'original label');self.assertEqual(event['notes'],'original note');self.assertIsNone(event['source_job_id'])
        self.ctx.db.initialize(self.settings.admin_password)

