import hashlib
import io
import json
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

from scripts import install_rtmpose as installer


def archive_bytes(names=('export/model.onnx',)):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        for name in names:
            z.writestr(name, b'unit-test-archive-payload')
    return out.getvalue()


class ModelInstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_installer(self, *args):
        with patch('sys.argv', ['install_rtmpose.py', '--download', '--output', str(self.root), *args]):
            installer.main()

    def test_explicit_curl_transport_installs_sources_and_hashes(self):
        def transfer(command, **kwargs):
            self.assertEqual(command[1], '--disable', '不得继承可能含 insecure 的 .curlrc')
            self.assertIn('--fail', command)
            self.assertIn('--max-filesize', command)
            self.assertIn('=https', command)
            self.assertNotIn('--insecure', command)
            Path(command[command.index('--output') + 1]).write_bytes(archive_bytes())
            return subprocess.CompletedProcess(command, 0)

        with patch('shutil.which', return_value='/test/curl'), patch('subprocess.run', side_effect=transfer) as curl:
            self.run_installer('--transport', 'curl')
        self.assertEqual(curl.call_count, 2)
        manifest = json.loads((self.root / 'manifest.json').read_text())
        for name, url in installer.MODELS.items():
            content = (self.root / f'{name}.onnx').read_bytes()
            self.assertEqual(content, b'unit-test-archive-payload')
            self.assertEqual(manifest[name]['source_url'], url)
            self.assertEqual(manifest[name]['sha256'], hashlib.sha256(content).hexdigest())

    def test_cached_weights_are_reused_only_while_hash_and_source_match(self):
        with patch('urllib.request.OpenerDirector.open', side_effect=lambda *a, **k: io.BytesIO(archive_bytes())):
            self.run_installer()
        (self.root / 'pose.onnx').write_bytes(b'changed after install')
        with patch('urllib.request.OpenerDirector.open', side_effect=lambda *a, **k: io.BytesIO(archive_bytes())) as download:
            self.run_installer()
        self.assertEqual(download.call_count, 1)
        self.assertEqual(download.call_args.args[0], installer.MODELS['pose'])
        self.assertEqual((self.root / 'pose.onnx').read_bytes(), b'unit-test-archive-payload')

    def test_invalid_archive_cannot_replace_an_existing_model_or_create_manifest(self):
        (self.root / 'detector.onnx').write_bytes(b'existing unverified model')
        with patch('urllib.request.OpenerDirector.open', side_effect=lambda *a, **k: io.BytesIO(archive_bytes(('a.onnx', 'b.onnx')))):
            with self.assertRaisesRegex(ValueError, '模型包'):
                self.run_installer()
        self.assertEqual((self.root / 'detector.onnx').read_bytes(), b'existing unverified model')
        self.assertFalse((self.root / 'manifest.json').exists())

    def test_https_redirect_cannot_downgrade_before_downloading_weights(self):
        handler = installer.HTTPSOnlyRedirectHandler()
        request = urllib.request.Request(installer.MODELS['pose'])
        for target in ('http://example.org/weights.zip', 'ftp://example.org/weights.zip'):
            with self.subTest(target=target), self.assertRaises(urllib.error.URLError):
                handler.redirect_request(request, None, 302, 'Found', {}, target)
        redirected = handler.redirect_request(request, None, 302, 'Found', {}, 'https://example.org/weights.zip')
        self.assertEqual(redirected.full_url, 'https://example.org/weights.zip')

    def test_failed_curl_does_not_install_partial_download(self):
        def broken(command, **kwargs):
            Path(command[command.index('--output') + 1]).write_bytes(b'partial download')
            raise subprocess.CalledProcessError(35, command)

        with patch('shutil.which', return_value='/test/curl'), patch('subprocess.run', side_effect=broken):
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_installer('--transport', 'curl')
        self.assertFalse((self.root / 'detector.onnx').exists())
        self.assertFalse((self.root / 'manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
