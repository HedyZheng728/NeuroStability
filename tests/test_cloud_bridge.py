import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import httpx
from arena.cloud_bridge import JsonArtifacts

class ArtifactSyncTests(unittest.TestCase):
    def test_only_exact_json_uploaded_and_restart_skips_verified_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); base=root/'objects/videos/v/jobs/j';base.mkdir(parents=True)
            content=b'{ "frames": [], "synthetic": false }'
            (base/'pose.json').write_bytes(content);(base/'normalized.mp4').write_bytes(b'private video')
            requests=[]; remote={}
            def handler(req):
                requests.append((req.method,req.url.path))
                if req.method=='HEAD':
                    return httpx.Response(200,headers={'X-Content-SHA256':remote[req.url.path]}) if req.url.path in remote else httpx.Response(404)
                if req.method == 'GET': return httpx.Response(200, content=content)
                self.assertEqual(req.content,content)
                self.assertEqual(req.headers['X-Content-SHA256'],hashlib.sha256(content).hexdigest())
                remote[req.url.path]=req.headers['X-Content-SHA256']
                return httpx.Response(200,json={'ok':True,'sha256':req.headers['X-Content-SHA256']})
            with httpx.Client(transport=httpx.MockTransport(handler)) as client:
                sync=JsonArtifacts(root/'objects',root/'state.json','https://test','secret',client=client)
                sync('jobs',{'id':'j','video_id':'v','status':'completed'})
                self.assertEqual(len(requests),2)
                self.assertEqual(len(remote),1)
                self.assertFalse(any('mp4' in r[1] for r in requests))
                JsonArtifacts(root/'objects',root/'state.json','https://test','secret',client=client)('jobs',{'id':'j','video_id':'v','status':'completed'})
                self.assertEqual(len(requests),2)
                JsonArtifacts(root/'objects',root/'state.json','https://test','secret',client=client,verify=True)('jobs',{'id':'j','video_id':'v','status':'completed'})
                self.assertEqual(requests[-1][0],'GET')
            self.assertEqual((root/'state.json').stat().st_mode & 0o777,0o600)
    def test_cross_site_checkpoint_and_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);root.joinpath('objects').mkdir()
            state=root/'state.json';state.write_text(json.dumps({'url':'https://old','files':{}}))
            with self.assertRaises(ValueError):JsonArtifacts(root/'objects',state,'https://new','secret')
    def test_missing_local_json_is_restored_from_cloud_and_hash_verified(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); objects=root/'objects';objects.mkdir()
            content=b'{ "frames":[], "synthetic":false }'
            sha=hashlib.sha256(content).hexdigest(); calls=[]
            def handle(req):
                calls.append(req.method)
                return httpx.Response(200,headers={'X-Content-SHA256':sha},content=content if req.method=='GET' else b'')
            with httpx.Client(transport=httpx.MockTransport(handle)) as client:
                sync=JsonArtifacts(objects,root/'state.json','https://test','secret',client=client)
                sync('jobs',{'id':'j','video_id':'v','backend':'rtmpose','status':'completed'})
                self.assertEqual((objects/'videos/v/jobs/j/pose.json').read_bytes(),content)
                self.assertEqual(sync.downloaded,1)
                self.assertNotIn('PUT',calls)

    def test_results_only_disables_external_language_api_but_keeps_loopback(self):
        from unittest.mock import patch
        from arena.config import Settings
        from arena.remote_worker import RemoteWorker
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for i,url in enumerate(('https://provider.invalid/v1','http://127.0.0.1:11434/v1')):
                settings=Settings(data_dir=root,llm_base_url=url,llm_model='existing',llm_key='secret')
                with patch('arena.remote_worker.discover_settings',return_value=settings):
                    worker=RemoteWorker('https://test','secret',root/str(i),settings=settings,results_only=True)
                try:self.assertEqual(bool(worker.settings.llm_base_url),i==1)
                finally:worker.close()
    def test_continuous_startup_retries_transport_failure_and_stops_cleanly(self):
        from unittest.mock import Mock
        from arena.cloud_bridge import initial_sync
        sync=Mock();sync.run_once.side_effect=[httpx.ReadError('temporary network interruption'),{'conflicts':0}]
        stop=Mock();stop.is_set.return_value=False;stop.wait.return_value=False
        self.assertEqual(initial_sync(sync,stop),{'conflicts':0})
        self.assertEqual(sync.run_once.call_count,2)
        stop.wait.assert_called_once_with(3)
        sync=Mock();sync.run_once.side_effect=httpx.ReadError('offline')
        stop.wait.return_value=True
        self.assertIsNone(initial_sync(sync,stop))
        self.assertEqual(sync.run_once.call_count,1)
    def test_startup_auth_failure_and_once_mode_are_not_silently_retried(self):
        from unittest.mock import Mock
        from arena.cloud_bridge import initial_sync
        stop=Mock();stop.is_set.return_value=False
        sync=Mock();sync.run_once.side_effect=httpx.HTTPStatusError('unauthorized',request=httpx.Request('GET','https://test'),response=httpx.Response(401))
        with self.assertRaises(httpx.HTTPStatusError):initial_sync(sync,stop)
        stop.wait.assert_not_called()
        sync.run_once.side_effect=httpx.ReadError('offline')
        with self.assertRaises(httpx.ReadError):initial_sync(sync,stop,retry=False)
