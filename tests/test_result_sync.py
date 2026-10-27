import json
import sqlite3
from pathlib import Path
from urllib.parse import unquote

import httpx
import unittest
import tempfile

from arena.result_sync import ResultSync, TABLES, fingerprint

ROOT = Path(__file__).resolve().parents[1]


class Cloud:
    """HTTP transport backed by the real migrated SQLite schema, isolated per test."""
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        for name in ('0001_schema.sql', '0003_result_sync.sql'):
            self.db.executescript((ROOT / 'cloudflare/migrations' / name).read_text())
        self.calls = []
        self.fail_next_put = False
        self.conflict_next_put = False
        self.reject_table = None
        self.fail_after_put_table = None
        self.client = httpx.Client(transport=httpx.MockTransport(self.handle))

    def handle(self, request):
        self.calls.append((request.method, request.url.path))
        assert request.headers['authorization'] == 'Bearer private-token'
        assert '/media' not in request.url.path
        parts = request.url.path.split('/')
        mode, table = parts[4:6]
        if mode == 'manifest':
            rows = self.db.execute('SELECT record_key AS key,revision,deleted FROM sync_versions WHERE table_name=? AND record_key>? ORDER BY record_key', (table, request.url.params.get('cursor', ''))).fetchall()
            return httpx.Response(200, json={'records': [dict(r) for r in rows], 'cursor': None})
        key = unquote(parts[6])
        primary = 'version' if table == 'schema_version' else 'id'
        if request.method == 'PUT':
            if table == self.reject_table:
                return httpx.Response(422, json={'error': 'invalid row'})
            if self.fail_next_put:
                self.fail_next_put = False
                raise httpx.ConnectError('offline', request=request)
            if self.conflict_next_put:
                self.conflict_next_put = False
                return httpx.Response(409, json={'error': 'conflict'})
            data = json.loads(request.content)
            version = self.db.execute('SELECT revision FROM sync_versions WHERE table_name=? AND record_key=?', (table, key)).fetchone()
            if (version['revision'] if version else None) != data['expected_revision']:
                return httpx.Response(409, json={'error': 'conflict'})
            row = data['row']
            cols = list(row)
            update = ','.join(f'{c}=excluded.{c}' for c in cols if c != primary)
            self.db.execute(f"INSERT INTO {table}({','.join(cols)}) VALUES({','.join('?' for _ in cols)}) ON CONFLICT({primary}) " + (f'DO UPDATE SET {update}' if update else 'DO NOTHING'), list(row.values()))
            self.db.commit()
            if table == self.fail_after_put_table:
                self.fail_after_put_table = None
                raise httpx.ReadError('connection lost after cloud commit', request=request)
        version = self.db.execute('SELECT revision,deleted FROM sync_versions WHERE table_name=? AND record_key=?', (table, key)).fetchone()
        if version is None:
            return httpx.Response(404)
        row = self.db.execute(f'SELECT * FROM {table} WHERE {primary}=?', (key,)).fetchone()
        return httpx.Response(200, json={**dict(version), 'row': dict(row) if row else None})


def setup(tmp_path):
    local = tmp_path / 'arena.db'
    db = sqlite3.connect(local)
    db.executescript((ROOT / 'cloudflare/migrations/0001_schema.sql').read_text())
    db.execute("INSERT INTO users VALUES('u','coach','original:hash')")
    db.execute("INSERT INTO athletes VALUES('a','Athlete','elite','2026-01-01')")
    db.execute("INSERT INTO sessions VALUES('s','a','2026-01-01','train',20,NULL,'','now')")
    db.execute("INSERT INTO videos VALUES('v','s','stability','private.mp4','/private/source.mp4','abc',123,'ready','now','now')")
    db.execute("INSERT INTO jobs VALUES('j','v','rtmpose_tracking','completed','done',100,'{  \"exact\": true }',NULL,'{ \"dense\": [1, 2] }',NULL,NULL,NULL,'now','now')")
    db.execute("INSERT INTO review_history VALUES('h','v','{ \"original\":  true }','now')")
    db.execute("INSERT INTO schema_version VALUES(4)")
    db.execute("INSERT INTO training_plans VALUES('p','a','2026-01-01','stability','train',20,'planned','s','now')")
    db.execute("INSERT INTO review_drafts VALUES('d','v','j','local','model',0,'draft','{ \"facts\": true }','now')")
    db.execute("INSERT INTO reviews VALUES('r','v','d','observed','next',1,'coach','now')")
    db.execute("INSERT INTO manual_scores VALUES('m','v',8.5,'good',1,'coach','v1','now')")
    db.execute("INSERT INTO score_history VALUES('sh','v','{ \"score\": 8.5 }','now')")
    db.execute("INSERT INTO analysis_assessments VALUES('as','j','accepted','athlete','valid','coach','now')")
    db.execute("INSERT INTO analysis_assessment_history VALUES('ah','j','{ \"decision\": \"accepted\" }','now')")
    db.execute("INSERT INTO events VALUES('e','v','j',1,2,'throw','athlete','success','event note','coach','now')")
    db.commit()
    cloud = Cloud(tmp_path / 'cloud.db')
    state = tmp_path / 'private' / 'state.json'
    sync = ResultSync(local, state, 'http://localhost', 'private-token', client=cloud.client)
    return db, cloud, sync, local, state



class ResultSyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.fixture = setup(Path(self.temporary.name))

    def tearDown(self):
        self.fixture[0].close()
        self.fixture[1].db.close()
        self.fixture[1].client.close()
        self.temporary.cleanup()

    def test_preserves_original_records_passwords_and_json_without_source_upload(self):
        db, cloud, sync, _, state = self.fixture
        report = sync.run_once()
        assert report['pushed'] == 15
        for table in TABLES:
            assert db.execute(f'SELECT * FROM {table}').fetchall() == [tuple(r) for r in cloud.db.execute(f'SELECT * FROM {table}')]
        assert state.stat().st_mode & 0o077 == 0
        cloud.calls.clear()
        assert sync.run_once()['pushed'] == 0
        assert all('/manifest/' in path for _, path in cloud.calls)


    def test_bidirectional_changes_and_conflicts_preserve_both_sides(self):
        db, cloud, sync, _, _ = self.fixture
        sync.run_once()
        cloud.db.execute("UPDATE athletes SET name='Cloud edit' WHERE id='a'")
        cloud.db.commit()
        assert sync.run_once()['pulled'] == 1
        assert db.execute("SELECT name FROM athletes").fetchone()[0] == 'Cloud edit'
        db.execute("UPDATE athletes SET name='Local edit' WHERE id='a'")
        db.commit()
        cloud.db.execute("UPDATE athletes SET name='Concurrent cloud edit' WHERE id='a'")
        cloud.db.commit()
        assert sync.run_once()['conflicts'] == 1
        assert db.execute('SELECT name FROM athletes').fetchone()[0] == 'Local edit'
        assert cloud.db.execute('SELECT name FROM athletes').fetchone()[0] == 'Concurrent cloud edit'


    def test_first_sync_collision_and_tombstones_never_overwrite_or_resurrect(self):
        db, cloud, sync, _, _ = self.fixture
        cloud.db.execute("INSERT INTO athletes VALUES('a','Other','elite','now')")
        cloud.db.commit()
        assert sync.run_once()['conflicts'] >= 1
        assert cloud.db.execute('SELECT name FROM athletes').fetchone()[0] == 'Other'
        # Pair equal values, then a cloud deletion keeps the original local archive.
        cloud.db.execute("UPDATE athletes SET name='Athlete',created_at='2026-01-01'")
        cloud.db.commit()
        sync.run_once()
        cloud.db.execute("DELETE FROM review_history WHERE id='h'")
        cloud.db.commit()
        sync.run_once()
        sync.run_once()
        assert db.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 1
        assert cloud.db.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 0
        # A local deletion likewise neither deletes cloud nor restores local automatically.
        db.execute("DELETE FROM jobs WHERE id='j'")
        db.commit()
        sync.run_once()
        assert db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 0
        assert cloud.db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 1


    def test_retry_after_network_failure_and_cas_conflict_uses_private_checkpoint(self):
        db, cloud, sync, local, state = self.fixture
        cloud.fail_next_put = True
        with self.assertRaises(httpx.ConnectError):
            sync.run_once()
        retry = ResultSync(local, state, 'http://localhost', 'private-token', client=cloud.client)
        assert retry.run_once()['pushed'] == 15
        db.execute("UPDATE athletes SET level='new' WHERE id='a'")
        db.commit()
        cloud.conflict_next_put = True
        assert retry.run_once()['conflicts'] == 1
        assert retry.run_once()['pushed'] == 1


    def test_cloud_queue_stays_isolated_and_cancel_wins_over_local_result(self):
        db, cloud, sync, _, _ = self.fixture
        sync.run_once()
        cloud.db.execute("UPDATE jobs SET status='queued',result=NULL,progress=0 WHERE id='j'")
        cloud.db.commit()
        assert sync.run_once()['pulled'] == 0
        assert db.execute('SELECT status FROM jobs').fetchone()[0] == 'completed'
        db.execute("UPDATE jobs SET status='running',progress=20 WHERE id='j'")
        db.commit()
        cloud.db.execute("UPDATE jobs SET status='cancelled' WHERE id='j'")
        cloud.db.commit()
        assert sync.run_once()['conflicts'] == 0
        db.execute("UPDATE jobs SET status='completed',progress=100,stage='local terminal result' WHERE id='j'")
        db.commit()
        assert sync.run_once()['conflicts'] == 1
        assert cloud.db.execute('SELECT status FROM jobs').fetchone()[0] == 'cancelled'

    def test_integral_float_fingerprints_match_d1_transport(self):
        assert fingerprint({'score': 8.0, 'result': '{"v":8.0}'}) == fingerprint({'score': 8, 'result': '{"v":8.0}'})
        assert fingerprint({'result': '{"v":8.0}'}) != fingerprint({'result': '{"v":8}'})

    def test_rejected_record_does_not_block_other_tables(self):
        _, cloud, sync, _, state = self.fixture
        cloud.reject_table = 'review_history'
        report = sync.run_once()
        assert report['pushed'] == 14
        assert report['conflicts'] == 1
        assert cloud.db.execute('SELECT count(*) FROM events').fetchone()[0] == 1
        assert 'review_history/h' in json.loads(state.read_text())['conflicts']

    def test_restart_after_cloud_commit_before_checkpoint_does_not_overwrite(self):
        _, cloud, sync, local, state = self.fixture
        cloud.fail_after_put_table = 'athletes'
        with self.assertRaises(httpx.ReadError):
            sync.run_once()
        assert len(json.loads(state.read_text())['records']) == 2
        revision = cloud.db.execute("SELECT revision FROM sync_versions WHERE table_name='athletes'").fetchone()[0]
        restarted = ResultSync(local, state, 'http://localhost', 'private-token', client=cloud.client)
        assert restarted.run_once()['pushed'] == 12
        assert cloud.db.execute("SELECT revision FROM sync_versions WHERE table_name='athletes'").fetchone()[0] == revision

    def test_new_cloud_job_is_pulled_only_after_terminal_completion(self):
        db, cloud, sync, _, state = self.fixture
        sync.run_once()
        cloud.db.execute("INSERT INTO jobs SELECT 'cloud-job',video_id,backend,'queued','queued',0,params,NULL,NULL,NULL,NULL,NULL,created_at,updated_at FROM jobs WHERE id='j'")
        cloud.db.commit()
        sync.run_once()
        assert db.execute("SELECT count(*) FROM jobs WHERE id='cloud-job'").fetchone()[0] == 0
        assert 'jobs/cloud-job' not in json.loads(state.read_text())['records']
        cloud.db.execute("UPDATE jobs SET status='completed',result='{ \"cloud\": true }' WHERE id='cloud-job'")
        cloud.db.commit()
        assert sync.run_once()['pulled'] == 1
        assert db.execute("SELECT result FROM jobs WHERE id='cloud-job'").fetchone()[0] == '{ "cloud": true }'

    def test_local_queued_job_is_published_only_after_terminal_completion(self):
        db, cloud, sync, _, state = self.fixture
        sync.run_once()
        callbacks = []
        sync.on_record = lambda table, row: callbacks.append((table, row.get('id')))
        db.execute("INSERT INTO jobs SELECT 'local-job',video_id,backend,'queued','queued',0,params,NULL,NULL,NULL,NULL,NULL,created_at,updated_at FROM jobs WHERE id='j'")
        db.commit()
        sync.run_once()
        assert cloud.db.execute("SELECT count(*) FROM jobs WHERE id='local-job'").fetchone()[0] == 0
        assert cloud.db.execute("SELECT count(*) FROM sync_versions WHERE table_name='jobs' AND record_key='local-job'").fetchone()[0] == 0
        assert 'jobs/local-job' not in json.loads(state.read_text())['records']
        assert ('jobs', 'local-job') not in callbacks
        db.execute("UPDATE jobs SET status='running',progress=20 WHERE id='local-job'")
        db.commit()
        sync.run_once()
        assert cloud.db.execute("SELECT count(*) FROM jobs WHERE id='local-job'").fetchone()[0] == 0
        db.execute("UPDATE jobs SET status='completed',progress=100,result='{ \"local\": true }' WHERE id='local-job'")
        db.commit()
        assert sync.run_once()['pushed'] == 1
        assert cloud.db.execute("SELECT result FROM jobs WHERE id='local-job'").fetchone()[0] == '{ "local": true }'
        assert ('jobs', 'local-job') in callbacks
