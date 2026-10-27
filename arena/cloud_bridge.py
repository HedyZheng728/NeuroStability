"""Local analysis and automatic result synchronization; no R2 or source-video upload."""
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import signal
import sqlite3
import threading
import tempfile
import time
from urllib.parse import quote

import httpx
from sqlalchemy.engine import make_url

from .remote_worker import (DEFAULT_CONFIG, RemoteWorker, configure, connection_config,
                            digest, discover_settings, save_json, validate_url)
from .result_sync import ResultSync

log = logging.getLogger(__name__)
NAMES = ('pose.json', 'pose3d.json', 'segmentation.json', 'result.json')

class JsonArtifacts:
    def __init__(self, objects, state, url, token, *, client=None, verify=False):
        validate_url(url)
        self.objects, self.path = Path(objects).resolve(), Path(state)
        self.url, self.token = url.rstrip('/'), token
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {'url': self.url, 'files': {}}
        if self.state.get('url') != self.url:
            raise ValueError('Artifact checkpoint belongs to another website; use a separate state directory')
        self.client = client or httpx.Client(timeout=120, follow_redirects=False, trust_env=False)
        self.owns_client, self.verify = client is None, verify
        self.verified = self.uploaded = self.downloaded = 0
        self.state.setdefault("missing", {})

    def close(self):
        if self.owns_client:
            self.client.close()

    def __call__(self, table, row):
        if table != 'jobs' or row.get('status') not in ('completed', 'needs_review', 'failed', 'blocked'):
            return
        for field in ('id', 'video_id'):
            if not isinstance(row.get(field), str) or any(c in row[field] for c in ('/', '\\')) or row[field] in ('.', '..'):
                raise ValueError('Unsafe job identifier')
        for name in NAMES:
            key = f"videos/{row['video_id']}/jobs/{row['id']}/{name}"
            file = self.objects / key
            if not file.is_file():
                expected = {'rtmpose': 'pose.json', 'rtmpose_tracking': 'pose.json', 'sample': 'pose.json', 'sam2': 'segmentation.json', 'pose3d': 'pose3d.json'}.get(row.get('backend'))
                if name != expected:
                    continue
                missing = self.state['missing'].get(key, {})
                if not self.verify and missing.get('updated_at') == row.get('updated_at') and time.time() - missing.get('checked', 0) < 3600:
                    continue
                route = self.url + '/api/worker/sync/artifacts/' + quote(row['id'], safe='') + '/' + name
                headers = {'Authorization': 'Bearer ' + self.token}
                response = self.client.head(route, headers=headers)
                if response.status_code == 404:
                    self.state['missing'][key] = {'checked': time.time(), 'updated_at': row.get('updated_at')}
                    self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    save_json(self.path, self.state)
                    continue
                response.raise_for_status()
                expected_hash = response.headers.get('X-Content-SHA256')
                if not expected_hash or len(expected_hash) != 64:
                    raise ValueError('Cloud JSON checksum missing')
                file.parent.mkdir(parents=True, exist_ok=True)
                # Do not follow a symlink or replace an existing local file while restoring.
                current = self.objects
                for part in Path(key).parts:
                    current = current / part
                    if current.is_symlink(): raise ValueError('Symlink analysis files are not synchronized')
                temporary = None
                try:
                    with tempfile.NamedTemporaryFile(dir=file.parent, delete=False) as out:
                        temporary = Path(out.name); actual = hashlib.sha256(); total = 0
                        with self.client.stream('GET', route, headers=headers) as saved:
                            saved.raise_for_status()
                            for chunk in saved.iter_bytes():
                                total += len(chunk)
                                if total > 16 * 1024 * 1024: raise ValueError('Cloud JSON exceeds 16MiB')
                                actual.update(chunk); out.write(chunk)
                        out.flush(); os.fsync(out.fileno())
                    if actual.hexdigest() != expected_hash: raise ValueError('Cloud JSON checksum mismatch')
                    try: os.link(temporary, file)
                    except FileExistsError:
                        if digest(file) != expected_hash: raise ValueError('Local JSON differs; neither copy replaced')
                    self.downloaded += 1
                    self.state['missing'].pop(key, None)
                finally:
                    if temporary: temporary.unlink(missing_ok=True)
            current = self.objects
            for part in Path(key).parts:
                current = current / part
                if current.is_symlink():
                    raise ValueError('Symlink analysis files are not synchronized')
            if not file.resolve().is_relative_to(self.objects):
                raise ValueError('Analysis file escaped local storage')
            before = file.stat()
            stamp = [before.st_size, before.st_mtime_ns]
            previous = self.state['files'].get(key)
            if previous and previous['stamp'] == stamp and not self.verify:
                continue
            checksum = digest(file)
            route = self.url + '/api/worker/sync/artifacts/' + quote(row['id'], safe='') + '/' + name
            headers = {'Authorization': 'Bearer ' + self.token, 'X-Content-SHA256': checksum}
            response = self.client.head(route, headers=headers)
            if response.status_code == 200 and response.headers.get('X-Content-SHA256') == checksum:
                if self.verify:
                    with self.client.stream('GET', route, headers=headers) as saved:
                        saved.raise_for_status()
                        actual = hashlib.sha256()
                        for chunk in saved.iter_bytes(): actual.update(chunk)
                    if actual.hexdigest() != checksum:
                        raise ValueError('Cloud JSON bytes differ; original preserved')
                self.verified += 1
            elif response.status_code == 404:
                if not 0 < before.st_size <= 16 * 1024 * 1024:
                    raise ValueError('JSON result exceeds the 16MiB per-file limit; original preserved')
                with file.open('rb') as source:
                    response = self.client.put(route, headers={**headers, 'Content-Type': 'application/json', 'Content-Length': str(before.st_size)}, content=source)
                response.raise_for_status()
                if response.json().get('sha256') != checksum:
                    raise ValueError('Cloud result checksum was not acknowledged')
                self.uploaded += 1
            else:
                response.raise_for_status()
                raise ValueError('Saved cloud artifact differs; both copies preserved')
            after = file.stat()
            if [after.st_size, after.st_mtime_ns] != stamp:
                raise ValueError('Analysis file changed during synchronization; will retry')
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.state['files'][key] = {'stamp': stamp, 'sha256': checksum}
            save_json(self.path, self.state)


def initial_sync(sync, stop, *, retry=True):
    """Resume initial synchronization after transient outages, without retrying bad credentials."""
    delay = 3
    while not stop.is_set():
        try:
            return sync.run_once()
        except (httpx.TransportError, httpx.HTTPStatusError) as error:
            if not retry or isinstance(error, httpx.HTTPStatusError) and error.response.status_code < 500 and error.response.status_code != 429:
                raise
            log.warning('Initial sync interrupted; checkpoint retained; retry in %s seconds', delay)
            if stop.wait(delay):
                return None
            delay = min(60, delay * 2)
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--configure', metavar='HTTPS_URL')
    parser.add_argument('--url')
    parser.add_argument('--once', action='store_true', help='Synchronize current records and JSON, then exit')
    parser.add_argument('--verify', action='store_true', help='Recheck cloud SHA256 for every JSON artifact')
    parser.add_argument('--interval', type=int, default=60)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    os.umask(0o077)
    if args.configure:
        for path in configure(args.config, args.configure): print(path)
        return
    if args.interval < 15:
        parser.error('--interval must be at least 15 seconds')
    url, token = connection_config(args.config, args.url)
    if not url or not token:
        parser.exit(2, '请先运行 python -m arena.cloud_bridge --configure https://实际网站地址\n')
    settings = discover_settings()
    database_url = make_url(settings.database_url or f"sqlite:///{settings.data_dir / 'arena.db'}")
    if database_url.get_backend_name() != 'sqlite' or not database_url.database:
        parser.exit(2, '本地结果同步需要现有 SQLite 数据库；不会转换或覆盖其他数据库。\n')
    scope = hashlib.sha256(url.rstrip('/').encode()).hexdigest()[:16]
    folder = settings.data_dir / 'result-sync' / scope
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    # A consistent private backup precedes any cloud-to-local reconciliation.
    backup = folder / 'before-sync.db'
    if not backup.exists():
        from contextlib import closing
        with closing(sqlite3.connect(Path(database_url.database).resolve().as_uri() + '?mode=ro', uri=True)) as original, closing(sqlite3.connect(backup)) as target:
            original.backup(target)
            target.execute("PRAGMA journal_mode=DELETE")
        backup.chmod(0o600)
    artifacts = JsonArtifacts(settings.data_dir / 'objects', folder / 'artifacts.json', url, token, verify=args.verify)
    sync = ResultSync(database_url.database, folder / 'records.json', url, token, on_record=artifacts)
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    worker = None; thread = None
    try:
        counts = initial_sync(sync, stop, retry=not args.once)
        if counts is None: return
        log.info('Results synchronized: %s; JSON uploaded=%s verified=%s', counts, artifacts.uploaded, artifacts.verified)
        if counts['conflicts']:
            log.warning('Divergent records retained; see private result-sync checkpoint')
        if args.once: return
        worker = RemoteWorker(url, token, settings.data_dir / 'remote-outbox' / scope, settings=settings, results_only=True)
        thread = threading.Thread(target=sync.serve, args=(stop, args.interval), daemon=True)
        thread.start()
        worker.serve(stop)
    finally:
        stop.set()
        if thread: thread.join(timeout=150)
        if worker: worker.close()
        sync.close(); artifacts.close()

if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, httpx.HTTPError, sqlite3.Error) as error:
        raise SystemExit(str(error)) from None
