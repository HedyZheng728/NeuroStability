"""Incremental, conflict-safe synchronization of the original SQLite records.

No video files are read or uploaded. Cloud deletions retain the local archive;
local deletions retain cloud records. Divergent edits require explicit resolution.
"""
import argparse
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import signal
import sqlite3
import threading
from urllib.parse import quote

import httpx

from .remote_worker import DEFAULT_CONFIG, connection_config, save_json, validate_url

log = logging.getLogger(__name__)
TABLES = ('schema_version', 'users', 'athletes', 'sessions', 'training_plans',
          'videos', 'jobs', 'review_drafts', 'reviews', 'review_history',
          'manual_scores', 'score_history', 'analysis_assessments',
          'analysis_assessment_history', 'events')


def fingerprint(row):
    if row is None:
        return None
    normalized = {key: int(value) if isinstance(value, float) and value.is_integer() else value for key, value in row.items()}
    return hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()


class ResultSync:
    def __init__(self, database_path, state_path, url, token, *, client=None, on_record=None):
        validate_url(url)
        if not token or any(c in token for c in '\r\n'):
            raise ValueError('Private worker token is required')
        self.database_path = Path(database_path).resolve(strict=True)
        self.state_path = Path(state_path).resolve()
        if self.state_path == self.database_path:
            raise ValueError('Sync checkpoint must be separate from the original database')
        self.url, self.token = url.rstrip('/'), token
        self.client = client or httpx.Client(timeout=60, follow_redirects=False, trust_env=False)
        self.owns_client = client is None
        self.on_record = on_record

    def close(self):
        if self.owns_client:
            self.client.close()

    def request(self, method, path, **kwargs):
        response = self.client.request(method, self.url + '/api/worker/sync/' + path,
                                       headers={'Authorization': 'Bearer ' + self.token}, **kwargs)
        if response.status_code != 409:
            response.raise_for_status()
        return response

    def _snapshot(self):
        # Opening readonly prevents initialization, migration, or incidental writes.
        connection = sqlite3.connect(self.database_path.as_uri() + '?mode=ro', uri=True, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute('BEGIN')
            result = {}
            for table in TABLES:
                primary = 'version' if table == 'schema_version' else 'id'
                result[table] = {str(row[primary]): dict(row) for row in connection.execute(f'SELECT * FROM {table}')}
            return result
        finally:
            connection.close()

    def _pull(self, table, key, row, expected_hash):
        primary = 'version' if table == 'schema_version' else 'id'
        connection = sqlite3.connect(self.database_path.as_uri() + '?mode=rw', uri=True, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute('PRAGMA foreign_keys=ON')
            connection.execute('BEGIN IMMEDIATE')
            current = connection.execute(f'SELECT * FROM {table} WHERE {primary}=?', (key,)).fetchone()
            if fingerprint(dict(current) if current else None) != expected_hash:
                return False
            columns = [r[1] for r in connection.execute(f'PRAGMA table_info({table})')]
            if set(columns) != set(row) or str(row[primary]) != key:
                raise ValueError('Cloud row does not match original SQLite schema')
            update = ','.join(f'{c}=excluded.{c}' for c in columns if c != primary)
            connection.execute(f"INSERT INTO {table}({','.join(columns)}) VALUES({','.join('?' for _ in columns)}) "
                               f'ON CONFLICT({primary}) ' + (f'DO UPDATE SET {update}' if update else 'DO NOTHING'),
                               [row[c] for c in columns])
            connection.commit()
            return True
        finally:
            connection.close()

    def run_once(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = self.state_path.with_suffix(self.state_path.suffix + '.lock')
        descriptor = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(descriptor, 'r+') as lease:
            fcntl.flock(lease, fcntl.LOCK_EX)
            return self._run_locked()

    def _run_locked(self):
        state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {'records': {}, 'conflicts': {}}
        state.setdefault('conflicts', {})
        if state.get('url', self.url) != self.url:
            raise ValueError('Record checkpoint belongs to another website')
        state['url'] = self.url
        snapshots = self._snapshot()
        counts = {'pushed': 0, 'pulled': 0, 'conflicts': 0, 'unchanged': 0, 'archived': 0}

        def checkpoint():
            save_json(self.state_path, state)

        def conflict(identifier, reason):
            counts['conflicts'] += 1
            state['conflicts'][identifier] = reason
            log.warning('Record synchronization conflict %s: %s', identifier, reason)
            checkpoint()

        def accepted(identifier, row, revision, deleted=False):
            state['records'][identifier] = {'hash': fingerprint(row), 'revision': revision, 'deleted': deleted}
            state['conflicts'].pop(identifier, None)
            checkpoint()

        for table in TABLES:
            manifest, cursor = {}, None
            while True:
                page = self.request('GET', 'manifest/' + table, params={'cursor': cursor or '', 'limit': 500}).json()
                for item in page['records']:
                    manifest[str(item['key'])] = item
                next_cursor = page.get('cursor')
                if not next_cursor:
                    break
                if cursor is not None and next_cursor <= cursor:
                    raise ValueError('Cloud manifest cursor did not advance')
                cursor = next_cursor
            local = snapshots[table]
            baseline_keys = {identifier.split('/', 1)[1] for identifier in state['records'] if identifier.startswith(table + '/')}
            for key in sorted(set(local) | set(manifest) | baseline_keys):
                identifier = table + '/' + key
                row, remote, baseline = local.get(key), manifest.get(key), state['records'].get(identifier)
                if table == 'jobs' and row and row.get('status') in ('queued', 'running'):
                    # Local analysis owns these jobs; cloud workers must never claim them.
                    counts['unchanged'] += 1
                    continue
                local_hash = fingerprint(row)
                route = 'records/' + table + '/' + quote(key, safe='')
                if remote and remote['deleted']:
                    # Keep the original record as an archive, but never recreate cloud tombstones.
                    if baseline and baseline.get('deleted') and baseline['hash'] != local_hash:
                        conflict(identifier, 'local edit after cloud deletion; original archive retained')
                    else:
                        accepted(identifier, row, remote['revision'], True)
                        counts['archived'] += 1
                    continue
                if row is None and baseline and baseline.get('hash') is not None:
                    counts['archived'] += 1  # A local deletion is never an implicit cloud deletion or restore.
                    continue
                if remote and baseline and remote['revision'] == baseline['revision'] and local_hash == baseline['hash']:
                    counts['unchanged'] += 1
                    if row is not None and self.on_record and (table != 'jobs' or row.get('status') not in ('queued', 'running')):
                        self.on_record(table, row)
                    continue
                if remote and (not baseline or remote['revision'] != baseline['revision']):
                    value = self.request('GET', route).json()
                    # A delete or another edit between manifest and read is checked again next cycle.
                    if value.get('deleted'):
                        accepted(identifier, row, value['revision'], True)
                        counts['archived'] += 1
                        continue
                    cloud_row = value['row']
                    if table == 'jobs' and cloud_row.get('status') in ('queued', 'running'):
                        # RemoteWorker owns cloud leases in an isolated task database.
                        counts['unchanged'] += 1
                        continue
                    if fingerprint(cloud_row) == local_hash:
                        accepted(identifier, row, value['revision'])
                        counts['unchanged'] += 1
                    elif row is None or baseline and local_hash == baseline['hash'] and not baseline.get('deleted'):
                        try:
                            pulled = self._pull(table, key, cloud_row, local_hash)
                        except sqlite3.IntegrityError:
                            conflict(identifier, 'referenced record or unique value differs; both copies retained')
                            continue
                        if not pulled:
                            conflict(identifier, 'local record changed during cloud read')
                            continue
                        row = cloud_row
                        accepted(identifier, row, value['revision'])
                        counts['pulled'] += 1
                    else:
                        conflict(identifier, 'both copies differ without a shared unchanged baseline')
                        continue
                elif row is not None:
                    if baseline and (baseline.get('deleted') or not remote):
                        conflict(identifier, 'cloud record disappeared; original archive retained')
                        continue
                    try:
                        response = self.request('PUT', route, json={'row': row, 'expected_revision': remote['revision'] if remote else None})
                    except httpx.HTTPStatusError as exc:
                        if exc.response.status_code not in (413, 422):
                            raise
                        conflict(identifier, f'cloud rejected this record ({exc.response.status_code}); original retained')
                        continue
                    if response.status_code == 409:
                        conflict(identifier, 'cloud record changed before compare-and-swap')
                        continue
                    accepted(identifier, row, response.json()['revision'])
                    counts['pushed'] += 1
                if row is not None and self.on_record and (table != 'jobs' or row.get('status') not in ('queued', 'running')):
                    self.on_record(table, row)
        return counts

    def serve(self, stop=None, poll_seconds=2):
        stop = stop or threading.Event()
        delay = poll_seconds
        while not stop.is_set():
            try:
                self.run_once()
                delay = poll_seconds
            except (httpx.HTTPError, OSError, ValueError, sqlite3.Error):
                log.warning('Record sync unavailable; original records and checkpoint retained', exc_info=True)
                delay = min(60, max(poll_seconds, delay * 2))
            stop.wait(delay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--url')
    parser.add_argument('--database', type=Path, default=Path(os.getenv('ARENA_DATA_DIR', 'data')) / 'arena.db')
    parser.add_argument('--state', type=Path)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    url, token = connection_config(args.config, args.url)
    if not url or not token:
        parser.exit(2, '请先配置 data/cloudflare-worker.json 中的 url 和私有 token。\n')
    sync = ResultSync(args.database, args.state or args.database.parent / 'result-sync' / 'state.json', url, token)
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    try:
        if args.once:
            print(json.dumps(sync.run_once(), ensure_ascii=False))
        else:
            sync.serve(stop)
    finally:
        sync.close()


if __name__ == '__main__':
    main()
