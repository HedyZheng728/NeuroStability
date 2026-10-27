"""Loopback-only browser interface for local FFmpeg; independent of the Arena API."""
import json
import mimetypes
import secrets
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit
from uuid import uuid4

from .video_prepare import EXTENSIONS, PreparationCancelled, prepare_video, validate_limits

MAX_SOURCE_BYTES = 20 * 1024**3
CHUNK_BYTES = 4 * 1024**2
PAGE = Path(__file__).resolve().parents[1] / 'scripts' / 'video_prepare.html'


@dataclass
class Task:
    id: str
    source: Path
    size: int
    uploaded: int = 0
    status: str = 'uploading'
    progress: dict = field(default_factory=lambda: {'stage': 'uploading', 'fraction': 0})
    error: str = ''
    folder: Path | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)


class Manager:
    def __init__(self, output_root, options):
        self.output_root = Path(output_root).resolve()
        self.output_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.incoming = tempfile.TemporaryDirectory(prefix='arena-video-input-')
        self.options, self.tasks = options, {}
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='video-preparation')
        self.lock = threading.Lock()

    def create(self, filename, size):
        name = Path(str(filename).replace('\\', '/')).name
        if not name or len(name) > 200 or name in ('.', '..') or any(ord(c) < 32 for c in name) or Path(name).suffix.lower() not in EXTENSIONS:
            raise ValueError('Choose an MP4, MOV, M4V, MKV or WebM video')
        if type(size) is not int or not 0 < size <= MAX_SOURCE_BYTES:
            raise ValueError('Choose a non-empty video up to 20 GiB')
        if shutil.disk_usage(self.incoming.name).free < size * 2 + 512 * 1024**2:
            raise ValueError('Not enough free disk space for the source and prepared clips')
        with self.lock:
            if sum(t.status in ('uploading', 'queued', 'running') for t in self.tasks.values()) >= 2:
                raise ValueError('Finish or cancel the active video first')
            id = uuid4().hex
            source = Path(self.incoming.name) / id / name
            source.parent.mkdir(mode=0o700)
            source.touch(mode=0o600)
            task = self.tasks[id] = Task(id, source, size)
            return task

    def snapshot(self, task):
        with task.lock:
            result = {'id': task.id, 'filename': task.source.name, 'size': task.size, 'uploaded': task.uploaded,
                      'status': task.status, 'progress': dict(task.progress), 'error': task.error,
                      'folder': str(task.folder) if task.folder else None, 'clips': []}
            if task.folder and (task.folder / 'manifest.json').exists():
                result['clips'] = json.loads((task.folder / 'manifest.json').read_text())['clips']
            return result

    def run(self, task):
        def progress(value):
            with task.lock:
                task.progress = value
                if value.get('folder'):
                    task.folder = Path(value['folder'])
        try:
            with task.lock:
                task.status = 'running'
            prepare_video(task.source, self.output_root, progress=progress, cancel=task.cancel, **self.options)
            with task.lock:
                task.status = 'complete'
        except PreparationCancelled:
            with task.lock:
                task.status = 'cancelled'
        except Exception as exc:
            with task.lock:
                task.status, task.error = 'failed', str(exc)
        finally:
            task.source.unlink(missing_ok=True)

    def close(self):
        for task in self.tasks.values():
            task.cancel.set()
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.incoming.cleanup()


class PreparationHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def server_close(self):
        super().server_close()
        manager = getattr(self, 'manager', None)
        if manager is not None:
            manager.close()
            self.manager = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Do not log filenames or per-launch tokens.

    def send(self, code, body=b'', content_type='application/json', headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        valid_hosts = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        host = self.headers.get('Host', '')
        if host not in valid_hosts:
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in {f'http://{name}' for name in valid_hosts}:
            return False
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
        except Exception:
            return False
        cookie = cookies.get(self.server.cookie_name)
        token = self.headers.get('X-Arena-Token') or (cookie.value if cookie else '')
        return secrets.compare_digest(token, self.server.token)

    def task(self, id):
        task = self.server.manager.tasks.get(id)
        if task is None:
            raise FileNotFoundError('Task not found. Select the video again after restarting the tool.')
        return task

    def body_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 <= length <= 16384:
            raise ValueError('Invalid request size')
        value = json.loads(self.rfile.read(length) or b'{}')
        if not isinstance(value, dict):
            raise ValueError('Invalid request')
        return value

    def handle_request(self):
        self.connection.settimeout(30)
        path = [unquote(p) for p in urlsplit(self.path).path.strip('/').split('/')]
        if path == [''] and self.command == 'GET':
            if self.headers.get('Host') not in {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}:
                return self.send(403, {'error': 'Access denied'})
            return self.send(200, PAGE.read_bytes(), 'text/html; charset=utf-8')
        if not self.authorized():
            return self.send(403, {'error': 'Open the tool using its launch link'})
        manager = self.server.manager
        if path == ['api', 'authorize'] and self.command == 'POST':
            return self.send(200, {'max_source_bytes': MAX_SOURCE_BYTES, 'chunk_bytes': CHUNK_BYTES,
                                  'max_bytes': manager.options.get('max_bytes', 100*1024**2),
                                  'max_seconds': manager.options.get('max_seconds', 300)}, headers={
                'Set-Cookie': f'{self.server.cookie_name}={self.server.token}; HttpOnly; SameSite=Strict; Path=/'})
        if path == ['api', 'uploads'] and self.command == 'POST':
            value = self.body_json()
            task = manager.create(value.get('filename', ''), value.get('size'))
            return self.send(201, manager.snapshot(task))
        if len(path) == 3 and path[:2] == ['api', 'uploads'] and self.command == 'PUT':
            task = self.task(path[2])
            offset, length = int(self.headers.get('X-Upload-Offset', '-1')), int(self.headers.get('Content-Length', '-1'))
            with task.lock:
                if task.status != 'uploading' or offset != task.uploaded:
                    return self.send(409, {'error': 'Upload offset changed; resume from the last received byte'})
                if not 0 < length <= CHUNK_BYTES or offset + length > task.size:
                    return self.send(413, {'error': 'Upload chunk exceeds the file size or chunk limit'})
                with task.source.open('ab') as output:
                    remaining = length
                    while remaining:
                        data = self.rfile.read(min(65536, remaining))
                        if not data:
                            raise ValueError('Upload interrupted. Resume this video.')
                        output.write(data)
                        task.uploaded += len(data)
                        remaining -= len(data)
                return self.send(200, {'uploaded': task.uploaded})
        if len(path) == 3 and path[:2] == ['api', 'jobs'] and self.command == 'GET':
            return self.send(200, manager.snapshot(self.task(path[2])))
        if len(path) == 4 and path[:2] == ['api', 'jobs'] and self.command == 'POST':
            task = self.task(path[2])
            if path[3] == 'start':
                with task.lock:
                    if task.status != 'uploading' or task.uploaded != task.size:
                        return self.send(409, {'error': 'Video is incomplete or processing has already started'})
                    task.status = 'queued'
                manager.pool.submit(manager.run, task)
                return self.send(202, {'status': 'queued'})
            if path[3] == 'cancel':
                task.cancel.set()
                with task.lock:
                    if task.status == 'uploading':
                        task.status = 'cancelled'
                        task.source.unlink(missing_ok=True)
                return self.send(200, manager.snapshot(task))
        if len(path) == 3 and path[0] == 'files' and self.command == 'GET':
            task = self.task(path[1])
            value = manager.snapshot(task)
            names = ['manifest.json'] + [clip['filename'] for clip in value['clips']]
            if not task.folder or path[2] not in names or Path(path[2]).name != path[2]:
                raise FileNotFoundError('File not found')
            return self.send_file(task.folder / path[2])
        if path == ['api', 'quit'] and self.command == 'POST':
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return self.send(200, {'status': 'closing'})
        raise FileNotFoundError('Not found')

    def send_file(self, file):
        size = file.stat().st_size
        start, end, code = 0, size - 1, 200
        if self.headers.get('Range'):
            try:
                unit, spec = self.headers['Range'].split('=', 1)
                left, right = spec.split('-', 1)
                if unit != 'bytes' or ',' in spec:
                    raise ValueError()
                start = int(left) if left else max(0, size - int(right))
                end = min(size - 1, int(right)) if right and left else size - 1
                if not 0 <= start <= end < size:
                    raise ValueError()
            except ValueError:
                return self.send(416, headers={'Content-Range': f'bytes */{size}'})
            code = 206
        self.send_response(code)
        self.send_header('Content-Type', mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Disposition', "inline; filename*=UTF-8''" + quote(file.name))
        if code == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        with file.open('rb') as data:
            data.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = data.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def dispatch(self):
        try:
            self.handle_request()
        except FileNotFoundError as exc:
            self.send(404, {'error': str(exc)})
        except (ValueError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except OSError:
            self.send(507, {'error': 'Cannot read or write the local file. Check free disk space and permissions.'})

    do_GET = do_POST = do_PUT = dispatch


def make_server(output_root, *, port=8765, prepare_options=None):
    validate_limits(**(prepare_options or {}))
    server = PreparationHTTPServer(('127.0.0.1', port), Handler)
    server.token = secrets.token_urlsafe(32)
    server.cookie_name = f'arena_prepare_{server.server_port}'
    try:
        server.manager = Manager(output_root, prepare_options or {})
    except Exception:
        server.server_close()
        raise
    return server
