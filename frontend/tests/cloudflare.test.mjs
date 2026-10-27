import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto, pbkdf2Sync, createHmac } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(fetch) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, fetch, Headers, FormData, Blob, crypto: webcrypto, TextEncoder, Uint8Array, AbortController, setTimeout });
  return exports;
}
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('cloud login preserves existing PBKDF2 password without transmitting password or derived key', async () => {
  const password = 'existing-private-test-password', salt = '0123456789abcdef', nonce = 'one-use-nonce';
  const paths = [];
  const client = load(async (path, options) => {
    paths.push(path);
    if (path === '/healthz') return reply({ status: 'ok', authentication: 'browser-proof-v1' });
    const body = JSON.parse(options.body);
    if (path.endsWith('/challenge')) return reply({ challenge_id: 'c', salt, nonce, iterations: 260000 });
    assert.equal(body.proof, createHmac('sha256', pbkdf2Sync(password, salt, 260000, 32, 'sha256')).update(nonce).digest('hex'));
    assert.ok(!('password' in body));
    return reply({ username: 'admin', csrf: 'csrf' });
  });
  assert.equal(typeof client.loginAccount, 'function');
  assert.equal((await client.loginAccount('admin', password)).username, 'admin');
  assert.deepEqual(paths, ['/healthz', '/api/login/challenge', '/api/login']);
});

test('local login discovers the existing protocol without probing protected unknown API routes', async () => {
  const paths = [];
  const client = load(async (path, options) => {
    paths.push(path);
    if (path === '/healthz') return reply({ status: 'ok', version: '0.1.0' });
    if (path.endsWith('/challenge')) return reply({ detail: 'Please sign in' }, 401);
    assert.equal(JSON.parse(options.body).password, 'local-password');
    return reply({ username: 'admin' });
  });
  assert.equal(typeof client.loginAccount, 'function');
  await client.loginAccount('admin', 'local-password');
  assert.deepEqual(paths, ['/healthz', '/api/login']);
  const failed = load(async () => reply({ detail: 'Rate limited' }, 429));
  await assert.rejects(() => failed.loginAccount('admin', 'local-password'), error => error.status === 429);
});

test('cloud upload splits large files and completes without reading entire file into memory', async () => {
  const parts = [], progress = [], file = new Blob([new Uint8Array(8 * 1024 * 1024 + 17)]);
  Object.defineProperty(file, 'name', { value: 'training.mp4' });
  file.arrayBuffer = () => { throw new Error('Whole-file buffering is forbidden'); };
  const client = load(async (path, options) => {
    if (path === '/api/uploads') return reply({ id: 'upload', video_id: 'video', part_size: 8 * 1024 * 1024 }, 201);
    if (path.includes('/parts/')) { assert.equal(options.headers.get('Content-Type'), 'application/octet-stream'); parts.push(options.body.size); return reply({ etag: 'part' }); }
    assert.equal(path, '/api/uploads/upload/complete');
    return reply({ id: 'video' }, 201);
  });
  assert.equal(typeof client.uploadVideo, 'function');
  const video = await client.uploadVideo(file, { session_id: 'session', category: 'mixed', authorized: true }, { mode: 'multipart', max_size_bytes: 512 * 1024 * 1024, part_size: 8 * 1024 * 1024 }, value => progress.push(value));
  assert.equal(video.id, 'video');
  assert.deepEqual(parts, [8 * 1024 * 1024, 17]);
  assert.equal(progress.at(-1), 1);
});

test('upload limits reject before network and aborted upload cleans up its private parts', async () => {
  let calls = 0;
  const file = new Blob(['training']); Object.defineProperty(file, 'name', { value: 'training.mp4' });
  const controller = new AbortController();
  const client = load(async (path, options) => {
    calls++;
    if (path === '/api/uploads') return reply({ id: 'upload', part_size: 8388608 }, 201);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    controller.abort(); throw new DOMException('Aborted', 'AbortError');
  });
  assert.equal(typeof client.uploadVideo, 'function');
  await assert.rejects(() => client.uploadVideo(file, {}, { mode: 'multipart', max_size_bytes: 1, part_size: 8388608 }));
  assert.equal(calls, 0);
  await assert.rejects(() => client.uploadVideo(file, {}, { mode: 'multipart', max_size_bytes: 100, part_size: 8388608 }, undefined, controller.signal));
  assert.equal(calls, 3);
});

 test('results-only upload never transfers a raw video or opens cloud upload', async () => {
  let requests = 0;
  const client = load(async () => { requests++; return reply({}); });
  const file = new Blob(['private source']);
  await assert.rejects(() => client.uploadVideo(file, {}, { mode: 'local', max_size_bytes: 512 * 1024 * 1024, part_size: 0 }), error => error.status === 409);
  assert.equal(requests, 0);
});
