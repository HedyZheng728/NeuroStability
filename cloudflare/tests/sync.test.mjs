import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

let mf, db;
const athlete = { id: 'a', name: 'Original', level: 'elite', created_at: '2026-01-01' };
async function call(path, { method = 'GET', data, token = true } = {}) {
  return mf.dispatchFetch(`http://localhost/api/worker/sync/${path}`, { method, headers: { ...(token ? { authorization: 'Bearer secret' } : {}), 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
}
test.before(async () => {
  const output = await build({ stdin: { contents: `import {syncRoute} from './src/sync.ts'; import {D1ResultStore} from './src/result-store.ts'; import {APIError,json} from './src/auth.ts'; export default {async fetch(r,e){try{e.MEDIA=new D1ResultStore(e.DB);return await syncRoute(r,e)||new Response('',{status:404})}catch(x){return json({error:x.message},x.status||500)}}}`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, format: 'esm', write: false });
  mf = new Miniflare({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2026-01-01', d1Databases: { DB: 'sync-test' }, bindings: { ARENA_WORKER_TOKEN: 'secret' } });
  db = await mf.getD1Database('DB');
  for (const file of ['0001_schema.sql', '0002_result_storage.sql', '0003_result_sync.sql']) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    // D1 exec's newline splitting does not support multiline triggers.
    await db.exec(sql.replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
  }
});
test.after(async () => { await mf?.dispose(); });
test('sync requires worker bearer and only accepts original table/column names', async () => {
  assert.equal((await call('manifest/users', { token: false })).status, 401);
  assert.equal((await call('manifest/auth_sessions')).status, 404);
  assert.equal((await call('records/athletes/a', { method: 'PUT', data: { expected_revision: null, row: { ...athlete, injected: 1 } } })).status, 422);
});
test('CAS is atomic under concurrent writes and original browser writes change revisions', async () => {
  let r = await call('records/athletes/a', { method: 'PUT', data: { row: athlete, expected_revision: null } });
  assert.equal(r.status, 200, await r.clone().text());
  const initial = await r.json();
  const writes = await Promise.all(['One', 'Two'].map(name => call('records/athletes/a', { method: 'PUT', data: { row: { ...athlete, name }, expected_revision: initial.revision } })));
  assert.deepEqual(writes.map(x => x.status).sort(), [200, 409]);
  const winner = await (await call('records/athletes/a')).json();
  await db.prepare('UPDATE athletes SET level=? WHERE id=?').bind('updated', 'a').run();
  const manifest = await (await call('manifest/athletes?limit=1')).json();
  assert.notEqual(manifest.records[0].revision, winner.revision);
  assert.equal(manifest.records[0].key, 'a');
  assert.equal(manifest.cursor, 'a');
  assert.deepEqual((await (await call('manifest/athletes?cursor=a')).json()).records, []);
});
test('tombstones prevent resurrection and credentials/history JSON preserve exact values', async () => {
  await db.prepare('DELETE FROM athletes WHERE id=?').bind('a').run();
  const tombstone = await (await call('records/athletes/a')).json();
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.row, null);
  assert.equal((await call('records/athletes/a', { method: 'PUT', data: { row: athlete, expected_revision: null } })).status, 409);
  const user = { id: 'u', username: 'coach', password_hash: 'raw:scrypt-or-pbkdf-hash' };
  assert.equal((await call('records/users/u', { method: 'PUT', data: { row: user, expected_revision: null } })).status, 200);
  assert.deepEqual((await (await call('records/users/u')).json()).row, user);
  const schema = { version: 4 };
  assert.equal((await call('records/schema_version/4', { method: 'PUT', data: { row: schema, expected_revision: null } })).status, 200);
});

test('original primary key updates retain an old-key tombstone', async () => {
  await db.prepare('UPDATE schema_version SET version=5 WHERE version=4').run();
  const old = await (await call('records/schema_version/4')).json();
  assert.equal(old.deleted, true);
  assert.equal(old.row, null);
  const current = await (await call('records/schema_version/5')).json();
  assert.deepEqual(current.row, { version: 5 });
});

test('large result sync stores bounded D1 rows and restores exact original JSON bytes', async () => {
  await db.exec("INSERT INTO athletes VALUES('large-a','Large','elite','now'); INSERT INTO sessions VALUES('large-s','large-a','2026-01-01','train',10,NULL,'','now'); INSERT INTO videos VALUES('large-v','large-s','stability','local.mp4','/private/original.mp4','abc',1,'ready','now','now');");
  const raw = ' \n' + JSON.stringify({ synthetic: false, kinematics: { tracks: [{ track_id: 1, series: { x: 'x'.repeat(1600000) } }] } }) + '\n ';
  const row = { id:'large-j', video_id:'large-v', backend:'rtmpose_tracking', status:'completed', stage:'done', progress:100, params:'{}', metadata:null, result:raw, error:null, lease_until:null, worker_token:null, created_at:'now', updated_at:'now' };
  const response = await call('records/jobs/large-j', { method:'PUT', data:{ row, expected_revision:null } });
  assert.equal(response.status, 200, (await response.clone().text()).slice(0,500));
  const stored = await db.prepare('SELECT result FROM jobs WHERE id=?').bind('large-j').first();
  assert.ok(stored.result.length < 1000);
  assert.ok(JSON.parse(stored.result)._full_result_key);
  assert.equal((await (await call('records/jobs/large-j')).json()).row.result, raw);
  assert.equal((await call('records/jobs/large-j', { method:'PUT', data:{ row, expected_revision:null } })).status,409);
  assert.equal((await (await call('records/jobs/large-j')).json()).row.result, raw);
});
test('foreign-key conflicts preserve both copies without blocking later synchronization', async()=>{
 const row={id:'no-parent-session',athlete_id:'absent',date:'2026-07-25',objective:'',duration_min:180,rpe:null,notes:'',created_at:'2026'};
 const response=await call('records/sessions/no-parent-session',{method:'PUT',data:{row,expected_revision:null}});
 assert.equal(response.status,409);
 assert.equal(await db.prepare("SELECT id FROM sessions WHERE id='no-parent-session'").first(),null);
 assert.equal(await db.prepare("SELECT revision FROM sync_versions WHERE table_name='sessions' AND record_key='no-parent-session'").first(),null);
});
