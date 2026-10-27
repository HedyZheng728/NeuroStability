import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Miniflare } from 'miniflare';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const partSize = 8 * 1024 * 1024;

test('real browser upload -> D1/R2 -> outgoing Python worker -> authenticated media and reports', { timeout: 120_000 }, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'arena-cloud-e2e-'));
    const workerToken = 'generated-test-worker-secret-never-production';
    const mf = new Miniflare({
        modules: true,
        scriptPath: fileURLToPath(new URL('../dist/worker.js', import.meta.url)),
        compatibilityDate: '2026-01-01',
        host: '127.0.0.1', port: 0,
        d1Databases: { DB: 'actual-network-e2e-db' },
        r2Buckets: { MEDIA: 'actual-network-e2e-private-media' },
        bindings: { ARENA_WORKER_TOKEN: workerToken, ARENA_TIMEZONE: 'Asia/Shanghai' },
    });
    try {
        const url = await mf.ready;
        assert.equal(url.hostname, '127.0.0.1');
        const db = await mf.getD1Database('DB');
        const schema = await readFile(new URL('../migrations/0001_schema.sql', import.meta.url), 'utf8');
        await db.exec(schema.replace(/^\s*--.*$/gm, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(';\n'));
        const salt = 'only-generated-e2e-fixture-salt';
        const password = 'only-generated-e2e-fixture-password';
        const derived = pbkdf2Sync(password, salt, 260000, 32, 'sha256');
        await db.prepare('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)')
            .bind('e2e-original-user-id', 'e2e-coach', `${salt}:${derived.toString('hex')}`).run();

        let cookie, csrf;
        async function request(path, { method = 'GET', data, raw, authenticated = true, headers = {} } = {}) {
            const h = { ...(authenticated && cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...headers };
            if (data !== undefined) h['content-type'] = 'application/json';
            if (method !== 'GET' && method !== 'HEAD') h.origin = url.origin;
            return fetch(new URL(path, url), { method, headers: h, body: data === undefined ? raw : JSON.stringify(data), redirect: 'error' });
        }
        async function json(path, options = {}, expected = 200) {
            const response = await request(path, options), text = await response.text();
            assert.equal(response.status, expected, `${path}: ${text}`);
            return text ? JSON.parse(text) : null;
        }
        const challenge = await json('/api/login/challenge', { method: 'POST', authenticated: false, data: { username: 'e2e-coach' } });
        const login = await request('/api/login', { method: 'POST', authenticated: false, data: {
            username: 'e2e-coach', challenge_id: challenge.challenge_id,
            proof: createHmac('sha256', derived).update(challenge.nonce).digest('hex'),
        } });
        assert.equal(login.status, 200, await login.clone().text());
        cookie = login.headers.get('set-cookie').split(';')[0];
        csrf = (await login.json()).csrf;
        assert.ok(cookie && csrf);
        assert.equal((await json('/api/me')).username, 'e2e-coach');

        const sourcePath = join(folder, 'generated.mp4');
        await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=10',
            '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-movflags', '+faststart', sourcePath], { timeout: 30_000 });
        // A valid MP4 free box exercises the full 8MiB boundary without a large
        // decoded video or any model invocation. FFmpeg must accept the container.
        const padding = Buffer.alloc(partSize + 13);
        padding.writeUInt32BE(padding.length, 0);
        padding.write('free', 4, 'ascii');
        const source = Buffer.concat([await readFile(sourcePath), padding]);
        await writeFile(sourcePath, source);
        const originalProbe = JSON.parse((await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', sourcePath])).stdout);
        assert.ok(originalProbe.streams.some(stream => stream.codec_type === 'audio'));
        assert.ok(Math.abs(Number(originalProbe.format.duration) - 1) < .1);

        const athlete = await json('/api/athletes', { method: 'POST', data: { name: 'Generated clip workflow test', level: 'test fixture' } }, 201);
        const session = await json('/api/sessions', { method: 'POST', data: {
            athlete_id: athlete.id, date: '2026-10-28', duration_min: 1, rpe: null, objective: 'Generated video transport verification',
        } }, 201);
        const upload = await json('/api/uploads', { method: 'POST', data: {
            session_id: session.id, category: 'mixed', authorized: true, filename: 'generated.mp4', size_bytes: source.length,
            // Browser deliberately defers fingerprinting to the private computer.
        } }, 201);
        assert.equal(upload.part_size, partSize);
        for (let offset = 0, part = 1; offset < source.length; offset += partSize, part++) {
            await json(`/api/uploads/${upload.id}/parts/${part}`, {
                method: 'PUT', raw: source.subarray(offset, offset + partSize), headers: { 'content-type': 'application/octet-stream' },
            });
        }
        const video = await json(`/api/uploads/${upload.id}/complete`, { method: 'POST' }, 201);
        assert.equal(video.sha256, '');
        assert.equal(video.size_bytes, source.length);
        const queued = await json(`/api/videos/${video.id}/jobs`, { method: 'POST', data: { backend: 'preprocess' } }, 202);
        assert.equal(queued.status, 'queued');
        assert.equal((await request(`/api/jobs/${queued.id}/media`)).status, 409);

        const sentinel = join(folder, 'original-database-must-not-be-opened.db');
        const originalDatabase = Buffer.from('An original local database must never be opened or modified by remote processing.');
        await writeFile(sentinel, originalDatabase);
        const python = `
import json, os
from pathlib import Path
from arena.config import Settings
from arena.remote_worker import RemoteWorker
folder = Path(os.environ['ARENA_E2E_FOLDER'])
original = folder / 'original-database-must-not-be-opened.db'
before = original.read_bytes()
settings = Settings(data_dir=folder/'original-data-must-not-be-created', database_url=f'sqlite:///{original}',
    sample_enabled=False, detector_path='uninstalled-e2e', pose_path='uninstalled-e2e', sam2_path='uninstalled-e2e',
    fsw_bundle='uninstalled-e2e', action_model_path='uninstalled-e2e', pose3d_model_path='uninstalled-e2e',
    review_model_path='uninstalled-e2e', llm_base_url='', llm_model='', llm_key='')
client = RemoteWorker(os.environ['ARENA_E2E_URL'], os.environ['ARENA_WORKER_TOKEN'], folder/'outbox', settings=settings)
try:
    cycles = [client.cycle(), client.cycle()]
    print(json.dumps({'cycles': cycles, 'original_unchanged': before == original.read_bytes(),
        'pending': len(list((folder/'outbox').glob('task-*'))),
        'original_data_created': (folder/'original-data-must-not-be-created').exists()}))
finally:
    client.close()
`;
        let run;
        try {
            run = await execute(join(root, '.venv/bin/python'), ['-c', python], {
                cwd: root, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
                env: { ...process.env, ARENA_E2E_FOLDER: folder, ARENA_E2E_URL: url.origin, ARENA_WORKER_TOKEN: workerToken },
            });
        } catch (error) {
            assert.fail(`Actual Python worker failed: ${error.stderr || error.message}`);
        }
        const local = JSON.parse(run.stdout.trim());
        assert.deepEqual(local, { cycles: [true, false], original_unchanged: true, pending: 0, original_data_created: false });
        assert.deepEqual(await readFile(sentinel), originalDatabase);

        const job = await json(`/api/jobs/${queued.id}`);
        assert.equal(job.status, 'completed');
        assert.equal(job.progress, 100);
        assert.equal(job.result, null);
        assert.equal(job.metadata.audio_removed, true);
        assert.equal(job.metadata.rotation_normalized, true);
        assert.equal(job.metadata.width, 160);
        assert.equal(job.metadata.height, 120);
        assert.equal(job.metadata.time_offset, 0);
        assert.ok(Math.abs(job.metadata.source_duration - 1) < .1);
        assert.equal((await json(`/api/videos/${video.id}`)).sha256, sha256(source));
        const stored = await db.prepare('SELECT metadata,result FROM jobs WHERE id=?').bind(job.id).first();
        assert.deepEqual(JSON.parse(stored.metadata), job.metadata);
        assert.equal(stored.result, null);
        assert.equal((await db.prepare('SELECT count(*) AS count FROM worker_completions WHERE job_id=?').bind(job.id).first()).count, 1);

        assert.equal((await request(`/api/videos/${video.id}/media`, { authenticated: false })).status, 401);
        assert.equal((await request(`/api/jobs/${job.id}/media`, { authenticated: false })).status, 401);
        assert.equal((await request(`/api/worker/jobs/${job.id}/source`, { authenticated: false })).status, 401);
        const normalizedResponse = await request(`/api/jobs/${job.id}/media`);
        assert.equal(normalizedResponse.status, 200);
        assert.equal(normalizedResponse.headers.get('cache-control'), 'no-store');
        const normalized = Buffer.from(await normalizedResponse.arrayBuffer());
        assert.ok(normalized.length < source.length / 100);
        const normalizedPath = join(folder, 'normalized.mp4');
        await writeFile(normalizedPath, normalized);
        const normalizedProbe = JSON.parse((await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', normalizedPath])).stdout);
        assert.deepEqual(normalizedProbe.streams.map(stream => stream.codec_type), ['video']);
        assert.ok(Math.abs(Number(normalizedProbe.format.duration) - job.metadata.duration) < .01);
        const ranged = await request(`/api/jobs/${job.id}/media`, { headers: { range: 'bytes=4-31' } });
        assert.equal(ranged.status, 206);
        assert.equal(ranged.headers.get('content-range'), `bytes 4-31/${normalized.length}`);
        assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), normalized.subarray(4, 32));
        const sourceRange = await request(`/api/videos/${video.id}/media`, { headers: { range: 'bytes=0-31' } });
        assert.equal(sourceRange.status, 206);
        assert.deepEqual(Buffer.from(await sourceRange.arrayBuffer()), source.subarray(0, 32));
        const artifact = await db.prepare('SELECT * FROM job_artifacts WHERE job_id=? AND name=?').bind(job.id, 'normalized.mp4').first();
        assert.equal(artifact.sha256, sha256(normalized));
        const r2 = await mf.getR2Bucket('MEDIA');
        assert.equal((await r2.head(artifact.storage_key)).customMetadata.sha256, sha256(normalized));

        const report = await json(`/api/videos/${video.id}/report`);
        assert.equal(report.video.id, video.id);
        assert.equal(report.video.sha256, sha256(source));
        assert.deepEqual(report.jobs.find(item => item.id === job.id).metadata, job.metadata);
        assert.deepEqual(report.drafts, []);
        const insights = await json('/api/insights?start=2026-10-28&end=2026-10-28');
        assert.equal(insights.analysis.video_count, 1);
        assert.equal(insights.analysis.storage_bytes, source.length);
        assert.equal(insights.analysis.duration_known, 1);
        assert.equal(insights.analysis.analyzed_videos, 0);
        assert.deepEqual(insights.analysis.measurements, []);
        const profile = await json(`/api/athletes/${athlete.id}/profile`);
        assert.equal(profile.recorded_load, null);
        assert.deepEqual(profile.trends, []);
        assert.equal((await json('/api/models')).preprocessing.ready, true);

        // Explicit 3000-frame / three-person keypoint fixtures exercise analyzer
        // arithmetic and dense-result transport. No model runs or human performance
        // claims are made from this generated blank-video fixture.
        const denseSourcePath = join(folder, 'generated-300sec.mp4');
        await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x480:r=10',
            '-t', '300', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', denseSourcePath], { timeout: 30_000 });
        const denseSource = await readFile(denseSourcePath);
        const denseUpload = await json('/api/uploads', { method: 'POST', data: {
            session_id: session.id, category: 'mixed', authorized: true, filename: 'generated-300sec.mp4', size_bytes: denseSource.length,
        } }, 201);
        await json(`/api/uploads/${denseUpload.id}/parts/1`, { method: 'PUT', raw: denseSource });
        const denseVideo = await json(`/api/uploads/${denseUpload.id}/complete`, { method: 'POST' }, 201);
        const denseJob = await json(`/api/videos/${denseVideo.id}/jobs`, { method: 'POST', data: { backend: 'rtmpose_tracking' } }, 202);
        const densePython = `
import json, os
from pathlib import Path
from arena.config import Settings
from arena.engine import analyze
from arena.remote_worker import RemoteWorker, ARTIFACTS, digest, save_json
from arena.video import preprocess
folder = Path(os.environ['ARENA_E2E_FOLDER'])
settings = Settings(sample_enabled=False, detector_path='uninstalled-e2e', pose_path='uninstalled-e2e',
    sam2_path='uninstalled-e2e', fsw_bundle='uninstalled-e2e', action_model_path='uninstalled-e2e',
    pose3d_model_path='uninstalled-e2e', review_model_path='uninstalled-e2e', llm_base_url='', llm_model='', llm_key='')
client = RemoteWorker(os.environ['ARENA_E2E_URL'], os.environ['ARENA_WORKER_TOKEN'], folder/'dense-outbox', settings=settings)
try:
    claim = client.request('POST', 'claim', json={'worker_id': client.worker_id, 'backends': ['rtmpose_tracking']}).json()
    assert claim['job']['id'] == os.environ['ARENA_E2E_JOB']
    task = folder/'dense-outbox'/'task-dense-fixture'
    artifacts = task/'objects'/'videos'/claim['video']['id']/'jobs'/claim['job']['id']
    artifacts.mkdir(parents=True)
    source = task/'downloaded-source'
    source_sha = client.download(claim, 'source', source, claim['video'])
    metadata = preprocess(source, artifacts/'normalized.mp4', settings)
    points = [(320,40),(310,35),(330,35),(300,40),(340,40),(280,120),(350,110),(250,180),(380,175),
              (220,240),(400,245),(290,270),(350,265),(270,350),(370,345),(250,440),(390,435)]
    people = [{'track_id': track, 'keypoints': [[x+track*5,y,.95] for x,y in points]} for track in (1,2,3)]
    pose = {'layout':'coco17','width':640,'height':480,'backend':'rtmpose_tracking','synthetic':False,
            'frames':[{'t': i/10, 'people':people} for i in range(3000)]}
    full = {**analyze(pose), 'kind':'pose', 'backend':'rtmpose_tracking', 'synthetic':False, 'sample_fps':10,
            'provenance':{'test_fixture':'generated keypoints for transport tests; no model inference'}}
    encoded = json.dumps(full,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode()
    assert len(encoded) > 1024*1024
    (folder/'expected-dense-result.json').write_bytes(encoded)
    (artifacts/'pose.json').write_text(json.dumps(pose,ensure_ascii=False,allow_nan=False))
    state = {'claim':claim,'complete':{'worker_token':claim['job']['worker_token'],'status':'needs_review',
        'stage':'Explicit generated keypoint transport fixture','metadata':metadata,'result':full,'error':None,
        'source_sha256':source_sha},'artifacts':{}}
    for name, content_type in ARTIFACTS.items():
        path=artifacts/name
        if path.is_file():
            state['artifacts'][name]={'size_bytes':path.stat().st_size,'sha256':digest(path),'content_type':content_type}
    save_json(task/'state.json',state)
    client.synchronize(task,state)
    print(json.dumps({'full_bytes':len(encoded),'spilled':state['complete']['result_artifact'],
        'compact_bytes':len(json.dumps(state['complete']['result']).encode())}))
finally:
    client.close()
`;
        const denseRun = await execute(join(root, '.venv/bin/python'), ['-c', densePython], {
            cwd: root, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, ARENA_E2E_FOLDER: folder, ARENA_E2E_URL: url.origin,
                ARENA_WORKER_TOKEN: workerToken, ARENA_E2E_JOB: denseJob.id },
        });
        const denseLocal = JSON.parse(denseRun.stdout.trim());
        assert.equal(denseLocal.spilled, true);
        assert.ok(denseLocal.full_bytes > 1024 * 1024);
        assert.ok(denseLocal.compact_bytes < 512 * 1024);
        const expectedFull = JSON.parse(await readFile(join(folder, 'expected-dense-result.json'), 'utf8'));
        const restored = await json(`/api/jobs/${denseJob.id}`);
        assert.equal(restored.status, 'needs_review');
        assert.deepEqual(restored.result, expectedFull);
        assert.equal(restored.result.kinematics.tracks.length, 3);
        assert.ok(restored.result.kinematics.tracks.every(track => track.series.length === 3000));
        const denseStored = await db.prepare('SELECT result FROM jobs WHERE id=?').bind(denseJob.id).first();
        assert.ok(denseStored.result.length < 512 * 1024);
        assert.ok(JSON.parse(denseStored.result).kinematics.tracks.every(track => !('series' in track)));
        assert.ok(!('_full_result_key' in restored.result));
        const denseReport = await json(`/api/videos/${denseVideo.id}/report`);
        assert.deepEqual(denseReport.jobs.find(item => item.id === denseJob.id).result, expectedFull);
        const denseArtifact = await db.prepare('SELECT * FROM job_artifacts WHERE job_id=? AND name=?').bind(denseJob.id, 'result.json').first();
        assert.equal(denseArtifact.size_bytes, denseLocal.full_bytes);
        assert.equal(denseArtifact.sha256, sha256(await readFile(join(folder, 'expected-dense-result.json'))));
    } finally {
        await mf.dispose();
        await rm(folder, { recursive: true, force: true });
    }
});
