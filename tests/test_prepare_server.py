import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import httpx


class PreparationServerTests(unittest.TestCase):
    def setUp(self):
        from arena.prepare_server import make_server
        self.tmp = tempfile.TemporaryDirectory(prefix='arena-prepare-server-test-')
        self.root = Path(self.tmp.name)
        self.server = make_server(self.root / 'output', port=0, prepare_options={'max_seconds': 2, 'overlap': 0.2})
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = httpx.Client(base_url=f'http://127.0.0.1:{self.server.server_port}', trust_env=False, timeout=10)
        self.client.headers['X-Arena-Token'] = self.server.token

    def tearDown(self):
        if hasattr(self, 'client'):
            self.client.close()
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            self.tmp.cleanup()

    def new(self, size, name='fixture.mp4'):
        response = self.client.post('/api/uploads', json={'filename': name, 'size': size})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()['id']

    def wait_done(self, id):
        for _ in range(150):
            value = self.client.get(f'/api/jobs/{id}').json()
            if value['status'] in ('complete', 'failed', 'cancelled'):
                return value
            time.sleep(0.03)
        self.fail('Task did not finish')

    def test_token_host_and_origin_protect_all_file_and_mutation_routes(self):
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual(self.client.post('/api/uploads', headers={'X-Arena-Token': ''}, json={'filename': 'a.mp4', 'size': 20}).status_code, 403)
        self.assertEqual(self.client.post('/api/uploads', headers={'Origin': 'https://example.com'}, json={'filename': 'a.mp4', 'size': 20}).status_code, 403)
        self.assertEqual(self.client.get('/api/jobs/nope', headers={'Host': 'attacker.invalid'}).status_code, 403)
        self.assertEqual(self.client.get('/files/nope/manifest.json', headers={'X-Arena-Token': ''}).status_code, 403)

    def test_occupied_port_keeps_original_bind_error(self):
        from arena.prepare_server import make_server
        with self.assertRaises(OSError):
            make_server(self.root / 'other', port=self.server.server_port)

    def test_cli_reopens_existing_local_instance_instead_of_port_conflict(self):
        output = self.root / 'output'
        (output / '.tool.json').write_text(json.dumps({'port': self.server.server_port, 'token': self.server.token,
            'options': {'max_bytes': 100*1024**2, 'max_seconds': 2, 'overlap': 0.2}}))
        script = Path(__file__).resolve().parents[1] / 'scripts' / 'prepare_video.py'
        result = subprocess.run([sys.executable, str(script), '--no-open', '--output', str(output),
            '--port', str(self.server.server_port), '--max-seconds', '2', '--overlap', '0.2'], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_upload_offsets_are_resumable_and_cannot_skip_or_exceed_expected_size(self):
        id = self.new(8)
        self.assertEqual(self.client.put(f'/api/uploads/{id}', content=b'abcd', headers={'X-Upload-Offset': '0'}).status_code, 200)
        self.assertEqual(self.client.put(f'/api/uploads/{id}', content=b'ZZ', headers={'X-Upload-Offset': '0'}).status_code, 409)
        self.assertEqual(self.client.post(f'/api/jobs/{id}/start').status_code, 409)
        self.assertEqual(self.client.get(f'/api/jobs/{id}').json()['uploaded'], 4)
        self.assertEqual(self.client.put(f'/api/uploads/{id}', content=b'efghi', headers={'X-Upload-Offset': '4'}).status_code, 413)
        self.assertEqual(self.client.put(f'/api/uploads/{id}', content=b'efgh', headers={'X-Upload-Offset': '4'}).status_code, 200)

    def test_real_video_upload_processing_manifest_download_and_byte_range(self):
        source = self.root / 'source.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30:d=3', '-c:v', 'libx264', '-g', '15', str(source)], check=True)
        data = source.read_bytes()
        id = self.new(len(data), '../女子 QA.mp4')
        midpoint = len(data)//2
        for offset, part in ((0, data[:midpoint]), (midpoint, data[midpoint:])):
            self.assertEqual(self.client.put(f'/api/uploads/{id}', content=part, headers={'X-Upload-Offset': str(offset)}).status_code, 200)
        self.assertEqual(self.client.post(f'/api/jobs/{id}/start').status_code, 202)
        self.assertEqual(self.client.post(f'/api/jobs/{id}/start').status_code, 409)
        done = self.wait_done(id)
        self.assertEqual(done['status'], 'complete', done)
        manifest = self.client.get(f'/files/{id}/manifest.json').json()
        self.assertEqual(manifest['source']['filename'], '女子 QA.mp4')
        self.assertGreater(len(manifest['clips']), 1)
        file_url = f"/files/{id}/{manifest['clips'][0]['filename']}"
        response = self.client.get(file_url)
        self.assertEqual(response.status_code, 200)
        part = self.client.get(file_url, headers={'Range': 'bytes=0-15'})
        self.assertEqual(part.status_code, 206)
        self.assertEqual(part.content, response.content[:16])
        self.assertEqual(self.client.get(file_url, headers={'Range': 'bytes=999999999-'}).status_code, 416)
        self.assertEqual(self.client.get(f'/files/{id}/source.mp4').status_code, 404)
        self.assertFalse(self.server.manager.tasks[id].source.exists())

    def test_cancelling_upload_and_processing_errors_never_look_complete(self):
        id = self.new(10)
        self.assertEqual(self.client.post(f'/api/jobs/{id}/cancel').status_code, 200)
        self.assertEqual(self.client.get(f'/api/jobs/{id}').json()['status'], 'cancelled')
        self.assertEqual(self.client.put(f'/api/uploads/{id}', content=b'123', headers={'X-Upload-Offset': '0'}).status_code, 409)
        id = self.new(8)
        self.client.put(f'/api/uploads/{id}', content=b'badvideo', headers={'X-Upload-Offset': '0'})
        self.client.post(f'/api/jobs/{id}/start')
        failed = self.wait_done(id)
        self.assertEqual(failed['status'], 'failed')
        self.assertTrue(failed['error'])


if __name__ == '__main__':
    unittest.main()
