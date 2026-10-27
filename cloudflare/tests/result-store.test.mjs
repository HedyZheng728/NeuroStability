import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

async function load(entry) {
    const out = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const { mediaRoute } = await load('../src/media.ts');
test('result-only media configuration rejects browser video uploads and local media requests', async () => {
    const env = { MEDIA: { resultsOnly: true } };
    const config = await mediaRoute(new Request('https://test/api/upload-config'), env);
    assert.equal((await config.json()).mode, 'local');
    for (const [method, path] of [['POST', '/api/uploads'], ['POST', '/api/videos'], ['GET', '/api/videos/v/media'], ['HEAD', '/api/jobs/j/media']]) {
        await assert.rejects(mediaRoute(new Request(`https://test${path}`, { method }), env), e => e.status === 409 && e.message.includes('local_media_only'));
    }
});

test('D1 JSON storage preserves UTF-8 bytes, digest, range reads, overwrite and delete', async () => {
    const { D1ResultStore } = await load('../src/result-store.ts');
    const mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', compatibilityDate: '2026-01-01', d1Databases: { DB: 'result-test' } });
    try {
        const db = await mf.getD1Database('DB');
        const sql = await readFile(new URL('../migrations/0002_result_storage.sql', import.meta.url), 'utf8');
        await db.exec(sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(';\n'));
        const store = new D1ResultStore(db), data = Buffer.from(JSON.stringify({ text: '摔跤🙂'.repeat(70000) }));
        const hash = createHash('sha256').update(data).digest('hex');
        await store.put('v/result.json', data, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: hash } });
        assert.equal((await store.head('v/result.json')).customMetadata.sha256, hash);
        assert.deepEqual(Buffer.from(await (await store.get('v/result.json')).arrayBuffer()), data);
        assert.deepEqual(Buffer.from(await (await store.get('v/result.json', { range: { offset: 7, length: 19 } })).arrayBuffer()), data.subarray(7, 26));
        const max = await db.prepare('SELECT MAX(length(data)) AS size FROM result_chunks').first();
        assert.ok(max.size <= 256 * 1024);
        await assert.rejects(store.put('v/source.mp4', data), e => e.status === 409);
        await assert.rejects(store.put('v/invalid.json', 'bad'), e => e.status === 422);
        await assert.rejects(store.put('v/wrong.json', '{}', { customMetadata: { sha256: '0'.repeat(64) } }), e => e.status === 422);
        assert.equal(await store.head('v/invalid.json'), null);
        await store.put('v/result.json', '{"updated":true}');
        assert.deepEqual(await (await store.get('v/result.json')).json(), { updated: true });
        assert.deepEqual((await store.list({ prefix: 'v/' })).objects.map(o => o.key), ['v/result.json']);
        await store.delete(['v/result.json']);
        assert.equal(await store.get('v/result.json'), null);
    } finally { await mf.dispose(); }
});

test('D1 multipart hides partial uploads, verifies SHA/JSON, and atomically publishes complete 8 MiB parts', async () => {
    const { D1ResultStore } = await load('../src/result-store.ts');
    const mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', compatibilityDate: '2026-01-01', d1Databases: { DB: 'multipart-test' } });
    try {
        const db = await mf.getD1Database('DB');
        const sql = await readFile(new URL('../migrations/0002_result_storage.sql', import.meta.url), 'utf8');
        await db.exec(sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(';\n'));
        const store = new D1ResultStore(db), data = Buffer.from(JSON.stringify({ series: 'x'.repeat(8 * 1024 * 1024 + 10) }));
        const hash = createHash('sha256').update(data).digest('hex');
        const upload = await store.createMultipartUpload('v/pose.json', { customMetadata: { sha256: hash }, httpMetadata: { contentType: 'application/json' } });
        const one = await upload.uploadPart(1, data.subarray(0, 8 * 1024 * 1024));
        assert.equal(await store.head('v/pose.json'), null);
        const resumed = store.resumeMultipartUpload('v/pose.json', upload.uploadId);
        const two = await resumed.uploadPart(2, data.subarray(8 * 1024 * 1024));
        await assert.rejects(resumed.complete([one]), e => e.status === 422);
        await db.prepare("UPDATE result_uploads SET state='finalizing' WHERE id=?").bind(upload.uploadId).run();
        await assert.rejects(resumed.uploadPart(1, '{}'), e => e.status === 409);
        await db.prepare("UPDATE result_uploads SET state='open' WHERE id=?").bind(upload.uploadId).run();
        assert.equal(await store.head('v/pose.json'), null);
        await resumed.complete([one, two]);
        assert.deepEqual(Buffer.from(await (await store.get('v/pose.json')).arrayBuffer()), data);
        const bad = await store.createMultipartUpload('v/bad.json');
        const part = await bad.uploadPart(1, Buffer.from('invalid'));
        await assert.rejects(bad.complete([part]), e => e.status === 422);
        assert.equal(await store.head('v/bad.json'), null);
        await bad.abort();
        await assert.rejects(store.put('v/huge.json', new Uint8Array(16 * 1024 * 1024 + 1)), e => e.status === 413);
    } finally { await mf.dispose(); }
});

test('result-only worker completion retains source checks and requires pose JSON without normalized video', async () => {
    const { workerRoute } = await load('../src/jobs.ts');
    const { D1ResultStore } = await load('../src/result-store.ts');
    const mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', compatibilityDate: '2026-01-01', d1Databases: { DB: 'jobs-result-test' } });
    try {
        const db = await mf.getD1Database('DB');
        for (const migration of ['0001_schema.sql', '0002_result_storage.sql']) {
            const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
            await db.exec(sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(';\n'));
        }
        await db.prepare("INSERT INTO athletes VALUES('a','athlete','club','2026-10-28')").run();
        await db.prepare("INSERT INTO sessions VALUES('s','a','2026-10-28','',10,NULL,'','2026-10-28')").run();
        await db.prepare("INSERT INTO videos(id,session_id,category,filename,storage_key,sha256,size_bytes,status,authorized_at,created_at) VALUES('v','s','stability','source.mp4','local/source.mp4',?,10,'uploaded','2026-10-28','2026-10-28')").bind('a'.repeat(64)).run();
        await db.prepare("INSERT INTO jobs(id,video_id,backend,status,stage,progress,params,created_at,updated_at,worker_token,lease_until) VALUES('j','v','rtmpose','running','running',0,'{}','2026-10-28','2026-10-28','lease',?)").bind(Math.floor(Date.now() / 1000) + 180).run();
        const env = { DB: db, MEDIA: new D1ResultStore(db), ARENA_WORKER_TOKEN: 'worker' };
        const call = (path, method = 'GET', data, raw) => workerRoute(new Request(`https://test${path}`, { method, headers: { authorization: 'Bearer worker', 'x-worker-lease': 'lease', 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : raw }), env);
        await assert.rejects(call('/api/worker/jobs/j/source'), e => e.status === 409 && e.message.includes('local_media_only'));
        await assert.rejects(call('/api/worker/jobs/j/artifacts/normalized.mp4', 'PUT', null, 'video'), e => e.status === 409);
        const completion = { worker_token: 'lease', status: 'completed', metadata: { duration: 10 }, result: { synthetic: false } };
        await assert.rejects(call('/api/worker/jobs/j/complete', 'POST', completion), e => e.status === 422 && e.message.includes('pose.json'));
        await assert.rejects(call('/api/worker/jobs/j/artifacts/pose.json', 'PUT', null, 'bad-json'), e => e.status === 422);
        assert.equal((await call('/api/worker/jobs/j/artifacts/pose.json', 'PUT', null, '{"frames":[]}')).status, 200);
        assert.equal((await call('/api/worker/jobs/j/complete', 'POST', completion)).status, 200);
        assert.equal((await db.prepare("SELECT status FROM jobs WHERE id='j'").first()).status, 'completed');
    } finally { await mf.dispose(); }
});

test('expired finalization can retry while an older finalizer cannot publish over the retry', async () => {
    const { D1ResultStore } = await load('../src/result-store.ts');
    const mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', compatibilityDate: '2026-01-01', d1Databases: { DB: 'finalization-lease-test' } });
    try {
        const db = await mf.getD1Database('DB');
        const sql = await readFile(new URL('../migrations/0002_result_storage.sql', import.meta.url), 'utf8');
        await db.exec(sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(';\n'));
        const store = new D1ResultStore(db);
        const upload = await store.createMultipartUpload('v/pose.json');
        const part = await upload.uploadPart(1, '{"preserved":true}');
        await db.prepare("UPDATE result_uploads SET state='finalizing',finalize_until=0,finalize_token='interrupted' WHERE id=?").bind(upload.uploadId).run();
        await upload.complete([part]);
        assert.deepEqual(await (await store.get('v/pose.json')).json(), { preserved: true });

        const pending = await store.createMultipartUpload('v/race.json');
        const initial = await pending.uploadPart(1, '{"version":1}');
        let release, signal;
        const blocked = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { signal = resolve; });
        // Pause one real D1 publication after it has verified bytes, simulating a stalled invocation.
        let pause = true;
        const wrapped = { prepare: sql => db.prepare(sql), batch: async statements => {
            if (pause) { pause = false; signal(); await blocked; }
            return db.batch(statements);
        } };
        const old = new D1ResultStore(wrapped).resumeMultipartUpload('v/race.json', pending.uploadId).complete([initial]);
        const oldOutcome = old.then(value => ({ value }), error => ({ error }));
        await reached;
        await db.prepare('UPDATE result_uploads SET finalize_until=0 WHERE id=?').bind(pending.uploadId).run();
        await pending.complete([initial]);
        // A later explicit replacement must remain intact when the stalled invocation resumes.
        await store.put('v/race.json', '{"version":2}');
        release();
        assert.equal((await oldOutcome).error?.status, 409);
        assert.deepEqual(await (await store.get('v/race.json')).json(), { version: 2 });

        const timedOut = await store.createMultipartUpload('v/timeout.json');
        const retained = await timedOut.uploadPart(1, '{"retry":true}');
        let expire = true;
        const expireBeforePublish = { prepare: sql => db.prepare(sql), batch: async statements => {
            if (expire) {
                expire = false;
                await db.prepare('UPDATE result_uploads SET finalize_until=0 WHERE id=?').bind(timedOut.uploadId).run();
            }
            return db.batch(statements);
        } };
        await assert.rejects(new D1ResultStore(expireBeforePublish).resumeMultipartUpload('v/timeout.json', timedOut.uploadId).complete([retained]), e => e.status === 409);
        await timedOut.complete([retained]);
        assert.deepEqual(await (await store.get('v/timeout.json')).json(), { retry: true });

        const abandoned = await store.createMultipartUpload('v/abandoned.json');
        await abandoned.uploadPart(1, '{}');
        await db.prepare("UPDATE result_uploads SET state='finalizing',finalize_until=0,finalize_token='expired' WHERE id=?").bind(abandoned.uploadId).run();
        await abandoned.abort();
        assert.equal(await db.prepare('SELECT id FROM result_uploads WHERE id=?').bind(abandoned.uploadId).first(), null);
        assert.equal((await db.prepare('SELECT count(*) AS count FROM result_chunks WHERE upload_id=?').bind(abandoned.uploadId).first()).count, 0);
    } finally { await mf.dispose(); }
});
