import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
const digest = b => createHash('sha256').update(b).digest('hex');
const salt = '0123456789abcdef0123456789abcdef', password = 'test-only-long-password';
const derived = pbkdf2Sync(password, salt, 260000, 32, 'sha256');
const mf = new Miniflare({ modules: true, scriptPath: fileURLToPath(new URL('../dist/worker.js', import.meta.url)), compatibilityDate: '2026-01-01', d1Databases: { DB: 'test-db' }, r2Buckets: { MEDIA: 'test-media' }, bindings: { ARENA_WORKER_TOKEN: 'test-worker-secret-only', ARENA_TIMEZONE: 'Asia/Shanghai' } });
let db, r2, cookie, csrf, athlete, session, video, job;
async function call(path, { method = 'GET', data, raw, auth = true, worker = false, headers = {} } = {}) {
    const h = { ...(auth ? { cookie, 'x-csrf-token': csrf } : {}), ...(worker ? { authorization: 'Bearer test-worker-secret-only' } : {}), ...headers };
    if (data !== undefined)
        h['content-type'] = 'application/json';
    return mf.dispatchFetch(`http://localhost${path}`, { method, headers: h, body: data !== undefined ? JSON.stringify(data) : raw });
}
async function value(path, options, expected = 200) { const r = await call(path, options), t = await r.text(); assert.equal(r.status, expected, `${path}: ${t}`); return t ? JSON.parse(t) : null; }
async function loginProof() { const c = await value('/api/login/challenge', { method: 'POST', auth: false, data: { username: 'imported-coach' } }, 200), proof = createHmac('sha256', derived).update(c.nonce).digest('hex'); return { username: 'imported-coach', challenge_id: c.challenge_id, proof }; }
const metadata = { source_duration: 15, duration: 10, time_offset: 2, width: 640, height: 480, sample_fps: 5 };
const poseResult = { synthetic: false, method_version: 'fixture-v1', kind: 'pose', quality: { total_frames: 20, usable_frames: 20, ambiguous_frames: 0, missing_frames: 0, minimum_usable_frames: 10, minimum_coverage: .6, confidence_threshold: .35 }, metrics: { hip_sway_ratio: { label: '髋中点', value: .1, unit: '躯干长度', formula: 'sd/median' }, trunk_lean_deg: { label: '躯干倾角', value: 3, unit: '°', formula: 'mean' }, ankle_span_ratio: { label: '踝距', value: .2, unit: '躯干长度', formula: 'mean' } }, limitations: ['实验性二维代理指标，受机位、透视、镜头移动、遮挡与动作类型影响。'], specialty_score: null };
test.before(async () => { db = await mf.getD1Database('DB'); r2 = await mf.getR2Bucket('MEDIA'); const schema = await readFile(new URL('../migrations/0001_schema.sql', import.meta.url), 'utf8'); await db.exec(schema.replace(/^\s*--.*$/gm, '').split(';').map(statement => statement.replace(/\s+/g, ' ').trim()).filter(Boolean).join(';\n')); await db.prepare('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)').bind('test-user', 'imported-coach', `${salt}:${derived.toString('hex')}`).run(); });
test.after(async () => { await mf.dispose(); });
test('imported PBKDF2 hashes authenticate through one-use challenge; cookie, CSRF and origin protect browser APIs', async () => {
    assert.equal((await call('/api/athletes', { auth: false })).status, 401);
    const proof = await loginProof(), response = await call('/api/login', { method: 'POST', auth: false, data: proof });
    assert.equal(response.status, 200);
    const login = await response.json();
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrf = login.csrf;
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
    assert.equal(login.username, 'imported-coach');
    assert.equal((await call('/api/login', { method: 'POST', auth: false, data: proof })).status, 401);
    assert.equal((await value('/api/me')).timezone, 'Asia/Shanghai');
    const expired = await loginProof(); await db.prepare('UPDATE login_challenges SET expires=0 WHERE id=?').bind(expired.challenge_id).run(); assert.equal((await call('/api/login', { method: 'POST', auth: false, data: expired })).status, 401);
    const wrong = await loginProof(); assert.equal((await call('/api/login', { method: 'POST', auth: false, data: { ...wrong, proof: '0'.repeat(64) } })).status, 401);
    assert.equal((await call('/api/athletes', { method: 'POST', headers: { 'x-csrf-token': '' }, data: { name: 'blocked' } })).status, 403);
    assert.equal((await call('/api/athletes', { method: 'POST', headers: { origin: 'https://evil.test' }, data: { name: 'blocked' } })).status, 403);
    assert.equal((await call('/api/worker/claim', { method: 'POST', auth: false, data: { worker_id: 'w', backends: ['preprocess'] } })).status, 401);
    assert.equal((await call('/healthz', { auth: false })).headers.get('x-content-type-options'), 'nosniff');
});
test('athletes, plans and sessions preserve validation and atomic plan linking', async () => {
    athlete = await value('/api/athletes', { method: 'POST', data: { name: ' Test Athlete ', level: ' club ' } }, 201);
    assert.equal(athlete.name, 'Test Athlete');
    assert.equal((await call('/api/athletes', { method: 'POST', data: { name: 'invalid', unrecognized: 1 } })).status, 422);
    const plan = await value('/api/plans', { method: 'POST', data: { athlete_id: athlete.id, date: '2026-10-28', category: 'stability', planned_minutes: 40 } }, 201);
    const attempts = await Promise.all([1, 2].map(() => call('/api/sessions', { method: 'POST', data: { athlete_id: athlete.id, date: '2026-10-28', duration_min: 35, rpe: null, plan_id: plan.id } })));
    assert.deepEqual(attempts.map(r => r.status).sort(), [201, 409]);
    session = await attempts.find(r => r.status === 201).json();
    assert.equal(session.rpe, null);
    assert.equal((await value('/api/plans'))[0].status, 'completed');
    assert.equal((await call(`/api/plans/${plan.id}`, { method: 'PATCH', data: { status: 'cancelled' } })).status, 409);
    assert.equal((await call('/api/sessions', { method: 'POST', data: { athlete_id: athlete.id, date: '2026-02-30' } })).status, 422);
    assert.equal((await call(`/api/sessions/${session.id}`, { method: 'PUT', data: { athlete_id: athlete.id, date: '2026-10-28', rpe: 11 } })).status, 422);
});
test('private multipart source upload has exact sizes, concurrent parts, resume and idempotent completion', async () => {
    const content = Buffer.alloc(8 * 1024 * 1024 + 13, 65), hash = digest(content);
    const upload = await value('/api/uploads', { method: 'POST', data: { session_id: session.id, category: 'stability', authorized: true, filename: '../source.mp4', size_bytes: content.length, sha256: hash } }, 201);
    assert.equal(upload.part_size, 8 * 1024 * 1024);
    assert.equal((await call(`/api/uploads/${upload.id}/parts/2`, { method: 'PUT', raw: Buffer.alloc(1) })).status, 422);
    const parts = await Promise.all([call(`/api/uploads/${upload.id}/parts/1`, { method: 'PUT', raw: content.subarray(0, upload.part_size) }), call(`/api/uploads/${upload.id}/parts/2`, { method: 'PUT', raw: content.subarray(upload.part_size) })]);
    for (const part of parts)
        assert.equal(part.status, 200, await part.text());
    video = await value(`/api/uploads/${upload.id}/complete`, { method: 'POST' }, 201);
    assert.equal(video.filename, 'source.mp4');
    assert.equal(video.sha256, hash);
    assert.equal((await value(`/api/uploads/${upload.id}/complete`, { method: 'POST' }, 201)).id, video.id);
    assert.equal((await call(`/api/videos/${video.id}/media`, { auth: false })).status, 401);
    const ranged = await call(`/api/videos/${video.id}/media`, { headers: { range: 'bytes=5-15' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 5-15/${content.length}`);
    assert.equal((await ranged.arrayBuffer()).byteLength, 11);
    assert.equal((await call(`/api/videos/${video.id}/media`, { headers: { range: 'bytes=99999999-' } })).status, 416);
    assert.ok(!('storage_key' in await value(`/api/videos/${video.id}`)));
    assert.equal((await call(`/api/uploads/${upload.id}`, { method: 'DELETE' })).status, 409);
});
test('worker leases fence stale uploads and completion while artifacts publish only after complete', async () => {
    job = await value(`/api/videos/${video.id}/jobs`, { method: 'POST', data: { backend: 'preprocess' } }, 202);
    assert.equal((await call(`/api/videos/${video.id}/jobs`, { method: 'POST', data: { backend: 'rtmpose' } })).status, 409);
    assert.equal((await call(`/api/videos/${video.id}`, { method: 'DELETE' })).status, 409);
    const first = await value('/api/worker/claim', { method: 'POST', worker: true, auth: false, data: { worker_id: 'test-a', backends: ['preprocess'] } });
    const old = first.job.worker_token;
    assert.equal(first.video.sha256, video.sha256);
    const source = await call(`/api/worker/jobs/${job.id}/source`, { worker: true, auth: false, headers: { 'x-worker-lease': old } });
    assert.equal(source.status, 200);
    assert.equal(source.headers.get('x-content-sha256'), video.sha256);
    await source.arrayBuffer();
    await db.prepare('UPDATE jobs SET lease_until=0 WHERE id=?').bind(job.id).run();
    const claim = await value('/api/worker/claim', { method: 'POST', worker: true, auth: false, data: { worker_id: 'test-b', backends: ['preprocess'] } });
    job = claim.job;
    assert.notEqual(old, job.worker_token);
    assert.equal((await call(`/api/worker/jobs/${job.id}/heartbeat`, { method: 'POST', worker: true, auth: false, data: { worker_token: old } })).status, 409);
    const completion = { worker_token: job.worker_token, status: 'completed', stage: 'complete', metadata, result: null, error: null };
    assert.equal((await call(`/api/worker/jobs/${job.id}/complete`, { method: 'POST', worker: true, auth: false, data: completion })).status, 422);
    assert.equal((await call(`/api/worker/jobs/${job.id}/artifacts/evil.txt`, { method: 'PUT', worker: true, auth: false, headers: { 'x-worker-lease': job.worker_token }, raw: 'bad' })).status, 422);
    const artifact = Buffer.from('normalized-test-fixture'), artifactHash = digest(artifact);
    const init = await value(`/api/worker/jobs/${job.id}/artifacts/normalized.mp4/init`, { method: 'POST', worker: true, auth: false, data: { worker_token: job.worker_token, size_bytes: artifact.length, sha256: artifactHash, content_type: 'video/mp4' } }, 201);
    await value(`/api/worker/jobs/${job.id}/artifacts/normalized.mp4?upload_id=${init.upload_id}&part=1`, { method: 'PUT', worker: true, auth: false, headers: { 'x-worker-lease': job.worker_token }, raw: artifact });
    const finish = { worker_token: job.worker_token, upload_id: init.upload_id, size_bytes: artifact.length, sha256: artifactHash };
    await value(`/api/worker/jobs/${job.id}/artifacts/normalized.mp4/finalize`, { method: 'POST', worker: true, auth: false, data: finish });
    await value(`/api/worker/jobs/${job.id}/artifacts/normalized.mp4/finalize`, { method: 'POST', worker: true, auth: false, data: finish });
    assert.equal((await call(`/api/jobs/${job.id}/media`)).status, 409);
    await value(`/api/worker/jobs/${job.id}/complete`, { method: 'POST', worker: true, auth: false, data: completion });
    await value(`/api/worker/jobs/${job.id}/complete`, { method: 'POST', worker: true, auth: false, data: completion });
    assert.equal((await call(`/api/worker/jobs/${job.id}/complete`, { method: 'POST', worker: true, auth: false, data: { ...completion, stage: 'changed' } })).status, 409);
    assert.equal(await (await call(`/api/jobs/${job.id}/media`)).text(), 'normalized-test-fixture');
    assert.equal((await call(`/api/worker/jobs/${job.id}/artifacts/normalized.mp4`, { method: 'PUT', worker: true, auth: false, headers: { 'x-worker-lease': old }, raw: 'stale' })).status, 409);
});
test('manual score and review snapshots retain current row IDs, booleans and immutable history', async () => {
    assert.equal((await call(`/api/videos/${video.id}/score`, { method: 'PUT', data: { score: 8, confirmed: true } })).status, 422);
    const one = await value(`/api/videos/${video.id}/score`, { method: 'PUT', data: { score: 7.5, comment: 'first', confirmed: true } }), two = await value(`/api/videos/${video.id}/score`, { method: 'PUT', data: { score: 8, comment: 'second', confirmed: false } });
    assert.equal(one.id, two.id);
    const scores = await value(`/api/videos/${video.id}/score`);
    assert.equal(scores.history.length, 2);
    assert.equal(scores.history[0].snapshot.confirmed, true);
    assert.equal(scores.history[0].snapshot.score, 7.5);
    assert.equal(scores.current.confirmed, false);
    const r1 = await value(`/api/videos/${video.id}/review`, { method: 'PUT', data: { observations: 'first observation', confirmed: true } }), r2 = await value(`/api/videos/${video.id}/review`, { method: 'PUT', data: { observations: 'second', confirmed: false } });
    assert.equal(r1.id, r2.id);
    const report = await value(`/api/videos/${video.id}/report`);
    assert.equal(report.review_history.length, 2);
    assert.equal(report.review_history[0].snapshot.confirmed, true);
    assert.equal(report.review.observations, 'second');
});
test('legacy analyses, source ranges, assessment gates and event provenance survive migration', async () => {
    const id = '11111111-1111-1111-1111-111111111111', stamp = '2026-10-28T10:00:00Z';
    await db.prepare('INSERT INTO jobs(id,video_id,backend,status,stage,progress,params,metadata,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id, video.id, 'rtmpose', 'completed', 'done', 100, '{}', JSON.stringify(metadata), JSON.stringify(poseResult), stamp, stamp).run();
    await r2.put(`videos/${video.id}/jobs/${id}/pose.json`, '{"legacy":true}');
    assert.deepEqual(await (await call(`/api/jobs/${id}/pose`)).json(), { legacy: true });
    assert.equal((await call(`/api/jobs/${id}/assessment`, { method: 'PUT', data: { decision: 'accepted', subject_role: 'unknown', reason: 'not identified' } })).status, 409);
    await value(`/api/jobs/${id}/assessment`, { method: 'PUT', data: { decision: 'accepted', subject_role: 'athlete', reason: 'coach checked target' } });
    await value(`/api/jobs/${id}/assessment`, { method: 'PUT', data: { decision: 'pending', subject_role: 'athlete' } });
    assert.equal((await value(`/api/jobs/${id}/assessment`)).history.length, 2);
    const event = await value(`/api/videos/${video.id}/events`, { method: 'POST', data: { start_sec: 2, end_sec: 3, label: 'coached action', actor: 'athlete' } }, 201);
    assert.equal((await call(`/api/videos/${video.id}/events`, { method: 'POST', data: { start_sec: 14, end_sec: 20, label: 'outside' } })).status, 422);
    await value(`/api/events/${event.id}`, { method: 'DELETE' }, 204);
    const draft = await value(`/api/videos/${video.id}/review-drafts`, { method: 'POST', data: { job_id: id, provider: 'rules', language: 'en' } }, 201);
    assert.ok(draft.text.includes('Evidence-based'));
    assert.equal(draft.synthetic, false);
    video.analysisId = id;
});
test('LLM draft queue preserves saved review evidence and publishes exactly one draft', async () => {
    const queued = await value(`/api/videos/${video.id}/review-drafts`, { method: 'POST', data: { job_id: video.analysisId, provider: 'llm', language: 'zh' } }, 202);
    const claim = await value('/api/worker/claim', { method: 'POST', worker: true, auth: false, data: { worker_id: 'language-worker', backends: ['review_draft'] } });
    assert.equal(claim.job.id, queued.job_id);
    assert.equal(claim.source_job.id, video.analysisId);
    assert.equal(claim.review.observations, 'second');
    const data = { worker_token: claim.job.worker_token, status: 'completed', stage: 'draft ready', draft: { text: 'Local model draft test fixture', model: 'test-local-language-model', facts: claim.job.params.facts } };
    await value(`/api/worker/jobs/${claim.job.id}/complete`, { method: 'POST', worker: true, auth: false, data });
    await value(`/api/worker/jobs/${claim.job.id}/complete`, { method: 'POST', worker: true, auth: false, data });
    const drafts = await value(`/api/videos/${video.id}/review-drafts`);
    assert.equal(drafts.filter(d => d.id === queued.id).length, 1);
    assert.equal((await value(`/api/videos/${video.id}/report`)).review.observations, 'second');
});
test('dashboard, profile, insights, ZIP/CSV and online capabilities retain API response shapes', async () => {
    const dashboard = await value('/api/dashboard');
    assert.equal(dashboard.athlete_count, 1);
    assert.equal(dashboard.session_count, 1);
    assert.equal(dashboard.video_count, 1);
    assert.ok(dashboard.analysis);
    const profile = await value(`/api/athletes/${athlete.id}/profile`);
    assert.equal(profile.recorded_minutes, 35);
    assert.equal(profile.recorded_load, null);
    assert.ok(Array.isArray(profile.trends));
    const insights = await value('/api/insights');
    assert.ok(insights.analysis);
    assert.equal((await call('/api/insights?start=2026-11-01&end=2026-10-01')).status, 422);
    assert.ok((await (await call('/api/insights/analyses.csv')).text()).includes('job_id'));
    const zip = Buffer.from(await (await call('/api/insights/export')).arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    await value('/api/worker/heartbeat', { method: 'POST', worker: true, auth: false, data: { worker_id: 'capable', models: { rtmpose: { ready: true, reason: 'reported by local worker' }, preprocessing: { ready: true }, llm: { ready: true } } } });
    let models = await value('/api/models');
    assert.equal(models.rtmpose.ready, true);
    assert.equal(models.preprocessing.ready, true);
    assert.equal(models.rtmpose.processed_jobs, 1);
    assert.equal(models.llm.processed_jobs, 1);
    await db.prepare('UPDATE worker_capabilities SET last_seen=0').run();
    models = await value('/api/models');
    assert.equal(models.rtmpose.ready, false);
    assert.equal(models.rtmpose.processed_jobs, 1);
});
test('blocked jobs finish without fabricated results and deleted videos cannot be reclaimed', async () => {
    const j = await value(`/api/videos/${video.id}/jobs`, { method: 'POST', data: { backend: 'rtmpose' } }, 202);
    const claim = await value('/api/worker/claim', { method: 'POST', worker: true, auth: false, data: { worker_id: 'missing-deps', backends: ['rtmpose'] } });
    await value(`/api/worker/jobs/${j.id}/complete`, { method: 'POST', worker: true, auth: false, data: { worker_token: claim.job.worker_token, status: 'blocked', stage: 'unavailable', error: 'local dependency unavailable' } });
    assert.equal((await value(`/api/jobs/${j.id}`)).result, null);
    await value(`/api/videos/${video.id}`, { method: 'DELETE' }, 204);
    assert.equal((await call(`/api/videos/${video.id}`)).status, 404);
    assert.equal((await call('/api/worker/claim', { method: 'POST', worker: true, auth: false, data: { worker_id: 'late', backends: ['rtmpose'] } })).status, 204);
    const objects = await r2.list({ prefix: `videos/${video.id}/` });
    assert.equal(objects.objects.length, 0);
});
test('fresh sources may defer hashing to local worker and immutable legacy hashes cannot be replaced', async () => {
    const content = Buffer.from('fresh-source'), hash = digest(content);
    assert.equal((await value('/api/upload-config')).mode, 'multipart');
    const u = await value('/api/uploads', { method: 'POST', data: { session_id: session.id, category: 'mixed', authorized: true, filename: 'fresh.mov', size_bytes: content.length } }, 201);
    await value(`/api/uploads/${u.id}/parts/1`, { method: 'PUT', raw: content });
    const v = await value(`/api/uploads/${u.id}/complete`, { method: 'POST' }, 201);
    assert.equal(v.sha256, '');
    const queued = await value(`/api/videos/${v.id}/jobs`, { method: 'POST', data: { backend: 'preprocess' } }, 202), claimed = await value('/api/worker/claim', { method: 'POST', worker: true, auth: false, data: { worker_id: 'hash-worker', backends: ['preprocess'] } });
    assert.equal(claimed.job.id, queued.id);
    await value(`/api/worker/jobs/${queued.id}/artifacts/normalized.mp4`, { method: 'PUT', worker: true, auth: false, headers: { 'x-worker-lease': claimed.job.worker_token }, raw: content });
    const completion = { worker_token: claimed.job.worker_token, status: 'completed', metadata, stage: 'done' };
    assert.equal((await call(`/api/worker/jobs/${queued.id}/complete`, { method: 'POST', worker: true, auth: false, data: completion })).status, 422);
    await value(`/api/worker/jobs/${queued.id}/complete`, { method: 'POST', worker: true, auth: false, data: { ...completion, source_sha256: hash } });
    assert.equal((await value(`/api/videos/${v.id}`)).sha256, hash);
    const second = await value(`/api/videos/${v.id}/jobs`, { method: 'POST', data: { backend: 'preprocess' } }, 202), next = await value('/api/worker/claim', { method: 'POST', worker: true, auth: false, data: { worker_id: 'hash-worker', backends: ['preprocess'] } });
    assert.equal((await call(`/api/worker/jobs/${second.id}/complete`, { method: 'POST', worker: true, auth: false, data: { ...completion, worker_token: next.job.worker_token, source_sha256: '0'.repeat(64) } })).status, 422);
    await value(`/api/worker/jobs/${second.id}/complete`, { method: 'POST', worker: true, auth: false, data: { worker_token: next.job.worker_token, status: 'failed', error: 'integrity rejected' } });
    await value(`/api/videos/${v.id}`, { method: 'DELETE' }, 204);
});

async function newSource(name='test.mp4') {
    const bytes=Buffer.from('isolated-api-test-source'),u=await value('/api/uploads',{method:'POST',data:{session_id:session.id,category:'stability',authorized:true,filename:name,size_bytes:bytes.length,sha256:digest(bytes)}},201);
    await value(`/api/uploads/${u.id}/parts/1`,{method:'PUT',raw:bytes});
    return value(`/api/uploads/${u.id}/complete`,{method:'POST'},201);
}

test('large result artifacts preserve exact API data while D1 stores only compact evidence',async()=>{
    const v=await newSource('dense.mp4'),queued=await value(`/api/videos/${v.id}/jobs`,{method:'POST',data:{backend:'rtmpose_tracking'}},202),claimed=await value('/api/worker/claim',{method:'POST',worker:true,auth:false,data:{worker_id:'dense-worker',backends:['rtmpose_tracking']}}),token=claimed.job.worker_token;
    assert.equal(claimed.job.id,queued.id);
    const jointNames=['left_knee','right_knee','left_elbow','right_elbow','trunk_lean'];
    const full={...poseResult,tracking:{track_count:3,tracks:[{track_id:1},{track_id:2},{track_id:3}]},kinematics:{method_version:'joint-angles-2d-v1',experimental:true,unit:'deg',tracks:[1,2,3].map(track_id=>({track_id,n_samples:3000,first_t:0,last_t:299.9,joints:{left_knee:{n:3000,min:70,max:140,median:100}},series:Array.from({length:3000},(_,i)=>({t:i/10,...Object.fromEntries(jointNames.map((name,j)=>[name,90+Math.sin(i/10+j+track_id)*30]))}))}))},series:[{t:1,trunk_lean_deg:4,hip_x_px:123,ankle_span_px:34}],future_evidence:{exact:['retained',null,0,false]}};
    const serialized=Buffer.from(JSON.stringify(full));assert.ok(serialized.length>1024*1024);
    const compact={...full,kinematics:{...full.kinematics,tracks:full.kinematics.tracks.map(({series,...summary})=>summary)}};
    for(const[name,content]of[['normalized.mp4',Buffer.from('normalized-dense')],['pose.json',Buffer.from('{"frames":[]}')]]) await value(`/api/worker/jobs/${queued.id}/artifacts/${name}`,{method:'PUT',worker:true,auth:false,headers:{'x-worker-lease':token},raw:content});
    const completion={worker_token:token,status:'completed',stage:'dense done',metadata,result:compact,result_artifact:true};
    assert.equal((await call(`/api/worker/jobs/${queued.id}/complete`,{method:'POST',worker:true,auth:false,data:completion})).status,422);
    const init=await value(`/api/worker/jobs/${queued.id}/artifacts/result.json/init`,{method:'POST',worker:true,auth:false,data:{worker_token:token,size_bytes:serialized.length,sha256:digest(serialized),content_type:'application/json'}},201);
    const part=await value(`/api/worker/jobs/${queued.id}/artifacts/result.json?upload_id=${init.upload_id}&part=1`,{method:'PUT',worker:true,auth:false,headers:{'x-worker-lease':token},raw:serialized});
    await value(`/api/worker/jobs/${queued.id}/artifacts/result.json/finalize`,{method:'POST',worker:true,auth:false,data:{worker_token:token,upload_id:init.upload_id,parts:[part],size_bytes:serialized.length,sha256:digest(serialized)}});
    assert.equal((await call(`/api/worker/jobs/${queued.id}/complete`,{method:'POST',worker:true,auth:false,data:{...completion,result:{...compact,method_version:'different-summary'}}})).status,422);
    await value(`/api/worker/jobs/${queued.id}/complete`,{method:'POST',worker:true,auth:false,data:completion});
    await value(`/api/worker/jobs/${queued.id}/complete`,{method:'POST',worker:true,auth:false,data:completion});
    const stored=await db.prepare('SELECT result FROM jobs WHERE id=?').bind(queued.id).first(),record=JSON.parse(stored.result);assert.ok(record._full_result_key.endsWith('/result.json'));assert.equal(record.kinematics.tracks[0].series,undefined);assert.ok(Buffer.byteLength(stored.result)<serialized.length/10);
    assert.deepEqual((await value(`/api/jobs/${queued.id}`)).result,full);
    assert.deepEqual((await value(`/api/videos/${v.id}`)).latest_job.result,full);
    assert.deepEqual((await value('/api/videos')).find(row=>row.id===v.id).latest_job.result,compact);
    const report=await value(`/api/videos/${v.id}/report`);assert.deepEqual(report.jobs.find(row=>row.id===queued.id).result,full);assert.ok(!JSON.stringify(report).includes('_full_result_key'));
    const csv=await(await call('/api/insights/analyses.csv')).text(),zip=Buffer.from(await(await call('/api/insights/export')).arrayBuffer());assert.ok(!csv.includes('_full_result_key'));assert.ok(!zip.includes(Buffer.from('_full_result_key')));
    assert.equal((await call(`/api/jobs/${queued.id}/cancel`,{method:'POST'})).status,409);
    await value(`/api/videos/${v.id}`,{method:'DELETE'},204);
});

test('cancellation fences running workers and frees active job uniqueness for queued and running tasks',async()=>{
    const v=await newSource('cancel.mp4'),queued=await value(`/api/videos/${v.id}/jobs`,{method:'POST',data:{backend:'wham'}},202);
    assert.equal((await call(`/api/jobs/${queued.id}/cancel`,{method:'POST',headers:{'x-csrf-token':''}})).status,403);
    const cancelled=await value(`/api/jobs/${queued.id}/cancel`,{method:'POST'});assert.equal(cancelled.status,'failed');assert.equal(cancelled.error,'Cancelled');assert.equal(cancelled.worker_token,null);
    const running=await value(`/api/videos/${v.id}/jobs`,{method:'POST',data:{backend:'preprocess'}},202),claim=await value('/api/worker/claim',{method:'POST',worker:true,auth:false,data:{worker_id:'cancel-worker',backends:['preprocess']}});assert.equal(claim.job.id,running.id);
    await value(`/api/worker/jobs/${running.id}/artifacts/normalized.mp4`,{method:'PUT',worker:true,auth:false,headers:{'x-worker-lease':claim.job.worker_token},raw:'staged-before-cancel'});
    const stopped=await value(`/api/jobs/${running.id}/cancel`,{method:'POST'});assert.equal(stopped.stage,'Cancelled');assert.equal(stopped.lease_until,null);
    assert.equal((await call(`/api/worker/jobs/${running.id}/heartbeat`,{method:'POST',worker:true,auth:false,data:{worker_token:claim.job.worker_token}})).status,409);
    assert.equal((await call(`/api/worker/jobs/${running.id}/complete`,{method:'POST',worker:true,auth:false,data:{worker_token:claim.job.worker_token,status:'completed',metadata,stage:'stale'}})).status,409);
    assert.equal((await call(`/api/worker/jobs/${running.id}/artifacts/normalized.mp4`,{method:'PUT',worker:true,auth:false,headers:{'x-worker-lease':claim.job.worker_token},raw:'stale'})).status,409);
    const replacement=await value(`/api/videos/${v.id}/jobs`,{method:'POST',data:{backend:'preprocess'}},202);assert.notEqual(replacement.id,running.id);await value(`/api/jobs/${replacement.id}/cancel`,{method:'POST'});
    await value(`/api/videos/${v.id}`,{method:'DELETE'},204);
    assert.equal((await call('/api/jobs/missing/cancel',{method:'POST'})).status,404);
});

test('seventy videos return compact latest summaries without fetching private full-result objects',async()=>{
    const full={...poseResult,kinematics:{method_version:'joint-angles-2d-v1',experimental:true,unit:'deg',tracks:[{track_id:1,n_samples:4000,joints:{left_knee:{n:4000,min:65,max:140,median:100}},series:Array.from({length:4000},(_,i)=>({t:i/10,left_knee:90+Math.sin(i)*30,right_knee:95+Math.cos(i)*30,left_elbow:120+Math.sin(i/3)*20,right_elbow:110+Math.cos(i/3)*20,trunk_lean:Math.sin(i/10)*15}))}]}};
    const serialized=Buffer.from(JSON.stringify(full)),hash=digest(serialized),stamp='2026-10-28T16:00:00.000Z',ids=[];
    assert.ok(serialized.length>512*1024);
    const compact={...full,kinematics:{...full.kinematics,tracks:full.kinematics.tracks.map(({series,...summary})=>summary)}};
    for(let start=0;start<70;start+=10){
        const statements=[];
        for(let i=start;i<start+10;i++){
            const id=`collection-video-${i}`,jobId=`collection-job-${i}`,key=`videos/${id}/jobs/${jobId}/result.json`;ids.push({id,jobId,key});
            await r2.put(key,serialized,{customMetadata:{sha256:hash},httpMetadata:{contentType:'application/json'}});
            statements.push(db.prepare('INSERT INTO videos(id,session_id,category,filename,storage_key,sha256,size_bytes,status,authorized_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,session.id,'stability',`recording-${i}.mp4`,`videos/${id}/source.mp4`,'a'.repeat(64),42,'uploaded',stamp,stamp));
            statements.push(db.prepare('INSERT INTO jobs(id,video_id,backend,status,stage,progress,params,metadata,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(jobId,id,'rtmpose_tracking','completed','complete',100,'{}',JSON.stringify(metadata),JSON.stringify({...compact,_full_result_key:key}),stamp,stamp));
        }
        await db.batch(statements);
    }
    const collection=await value('/api/videos');assert.equal(collection.length,70);assert.ok(!JSON.stringify(collection).includes('_full_result_key'));
    for(const row of collection){assert.deepEqual(row.latest_job.result,compact);assert.equal(row.latest_job.result.kinematics.tracks[0].series,undefined);}
    assert.deepEqual((await value(`/api/videos/${ids[0].id}`)).latest_job.result,full);
    assert.deepEqual((await value(`/api/jobs/${ids[0].jobId}`)).result,full);
    // A real missing R2 object must not prevent browsing the saved collection summaries.
    await r2.delete(ids.at(-1).key);assert.equal((await value('/api/videos')).length,70);
    await db.prepare("DELETE FROM videos WHERE id LIKE 'collection-video-%'").run();
    for(const row of ids)await r2.delete(row.key);
});

test('logout revokes session immediately and clears cookie',async()=>{
 const result=await call('/api/logout',{method:'POST'});assert.equal(result.status,204);assert.ok(result.headers.get('set-cookie').includes('Max-Age=0'));assert.equal((await call('/api/me')).status,401);
});
