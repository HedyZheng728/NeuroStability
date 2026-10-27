import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export async function fixture(name) {
 const mf = new Miniflare({modules:true, scriptPath:fileURLToPath(new URL('../dist/worker.js', import.meta.url)), compatibilityDate:'2026-05-21', d1Databases:{DB:name}, bindings:{ARENA_WORKER_TOKEN:'test-private-worker', ARENA_RESULTS_ONLY:'true'}});
 const db = await mf.getD1Database('DB');
 for (const name of ['0001_schema.sql','0002_result_storage.sql','0003_result_sync.sql']) {
  const sql=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
  await db.exec(sql.replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 }
 const call=(path,options={})=>mf.dispatchFetch('https://test'+path,{...options,headers:{authorization:'Bearer test-private-worker',...options.headers}});
 return {mf,db,call};
}
test('no R2 binding: exact historical JSON sync, authentication and video rejection', async()=>{
 const {mf,db,call}=await fixture('results-sync');
 try {
  await db.prepare("INSERT INTO athletes VALUES('a','001','Level 1','2026')").run();
  await db.prepare("INSERT INTO sessions VALUES('s','a','2026-07-25','',180,NULL,'','2026')").run();
  await db.prepare("INSERT INTO videos VALUES('v','s','mixed','private.mov','videos/v/source.mov','',350000000,'uploaded','2026','2026')").run();
  await db.prepare("INSERT INTO jobs(id,video_id,backend,status,stage,progress,params,result,created_at,updated_at) VALUES('j','v','rtmpose','completed','',100,'{}','{}','2026','2026')").run();
  const bytes=Buffer.from('{ "width":100, "height":100, "frames":[], "synthetic":false }');
  const hash=createHash('sha256').update(bytes).digest('hex');
  const path='/api/worker/sync/artifacts/j/pose.json';
  let response=await call(path,{method:'PUT',headers:{'X-Content-SHA256':hash},body:bytes});
  assert.equal(response.status,200,await response.text());
  response=await call(path); assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  assert.equal(response.headers.get('X-Content-SHA256'),hash);
  assert.equal((await call(path,{method:'HEAD'})).headers.get('X-Content-SHA256'),hash);
  assert.equal((await call('/api/worker/sync/artifacts/j/normalized.mp4',{method:'PUT',body:bytes})).status,409);
  assert.equal((await mf.dispatchFetch('https://test'+path)).status,401);
  assert.equal((await call(path,{method:'PUT',headers:{'X-Content-SHA256':'0'.repeat(64)},body:bytes})).status,409);
  const health=await (await call('/healthz')).json(); assert.equal(health.status,'ok');
 }finally{await mf.dispose();}
});

test('historical publication is immutable under concurrent different JSON versions',async()=>{
 const {mf,db,call}=await fixture('immutable-results');
 try{
  await db.prepare("INSERT INTO athletes VALUES('a','001','L1','2026')").run();
  await db.prepare("INSERT INTO sessions VALUES('s','a','2026-07-25','',180,NULL,'','2026')").run();
  await db.prepare("INSERT INTO videos VALUES('v','s','mixed','private.mov','videos/v/source.mov','',1,'uploaded','2026','2026')").run();
  await db.prepare("INSERT INTO jobs(id,video_id,backend,status,stage,progress,params,result,created_at,updated_at) VALUES('j','v','rtmpose','completed','',100,'{}','{}','2026','2026')").run();
  const path='/api/worker/sync/artifacts/j/pose.json';
  const variants=[Buffer.from('{"revision":1}'),Buffer.from('{"revision":2}')];
  const responses=await Promise.all(variants.map(body=>call(path,{method:'PUT',body,headers:{'X-Content-SHA256':createHash('sha256').update(body).digest('hex')}})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const winner=responses.findIndex(r=>r.status===200);
  assert.deepEqual(Buffer.from(await(await call(path)).arrayBuffer()),variants[winner]);
  const pointer=await db.prepare("SELECT storage_key FROM job_artifacts WHERE job_id='j' AND worker_token='historical-sync'").first();
  assert.match(pointer.storage_key,/sync-artifacts\/[a-f0-9]{64}\/pose.json$/);
 }finally{await mf.dispose();}
});

test('D1-only cloud task reads verified local video and restores terminal record without cloud video', {timeout:90000},async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const execute=promisify(execFile), root=fileURLToPath(new URL('../../',import.meta.url));
 const folder=await mkdtemp(join(tmpdir(),'arena-results-local-e2e-'));
 const {mf,db}=await fixture('results-local-e2e');
 try{
  const url=await mf.ready;
  await execute('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x120:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p',join(folder,'source.mp4')]);
  const setup=`
import os,json,shutil,hashlib
from pathlib import Path
from arena import db
from arena.config import Settings
from arena.result_sync import ResultSync
p=Path(os.environ['E2E_FOLDER']);d=db.Database(Settings(data_dir=p,database_url='sqlite:///'+str(p/'arena.db')));d.initialize('test-password-only')
s='2026-10-28T00:00:00Z'
d.add(db.athletes,dict(id='a',name='Test athlete',level='test',created_at=s))
d.add(db.sessions,dict(id='s',athlete_id='a',date='2026-07-25',objective='',duration_min=180,rpe=None,notes='',created_at=s))
key='videos/v/source.mp4';f=p/'objects'/key;f.parent.mkdir(parents=True);shutil.copyfile(p/'source.mp4',f)
d.add(db.videos,dict(id='v',session_id='s',category='mixed',filename='source.mp4',storage_key=key,sha256=hashlib.sha256(f.read_bytes()).hexdigest(),size_bytes=f.stat().st_size,status='uploaded',authorized_at=s,created_at=s))
x=ResultSync(p/'arena.db',p/'state.json',os.environ['E2E_URL'],'test-private-worker');print(json.dumps(x.run_once()));x.close();d.engine.dispose()
`;
  const env={...process.env,E2E_FOLDER:folder,E2E_URL:url.origin};
  const first=await execute(join(root,'.venv/bin/python'),['-c',setup],{cwd:root,env});assert.equal(JSON.parse(first.stdout).conflicts,0);
  const raw='temporary-local-e2e-cookie',sessionHash=createHash('sha256').update(raw).digest('hex');
  const user=await db.prepare('SELECT id FROM users LIMIT 1').first();
  await db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?)').bind(sessionHash,user.id,'csrf',Math.floor(Date.now()/1000)+3600).run();
  const headers={cookie:'arena_session='+raw,'x-csrf-token':'csrf','content-type':'application/json',origin:url.origin};
  const queued=await fetch(new URL('/api/videos/v/jobs',url),{method:'POST',headers,body:JSON.stringify({backend:'preprocess',sample_acknowledged:false})});
  assert.equal(queued.status,202,await queued.clone().text());const job=await queued.json();
  const processing=`
import os,json,threading
from pathlib import Path
from arena.config import Settings
from arena.remote_worker import RemoteWorker
from arena.result_sync import ResultSync
from arena.cloud_bridge import JsonArtifacts
p=Path(os.environ['E2E_FOLDER']);w=RemoteWorker(os.environ['E2E_URL'],'test-private-worker',p/'outbox',settings=Settings(data_dir=p,sample_enabled=False),results_only=True)
try: assert w.cycle(threading.Event())
finally:w.close()
a=JsonArtifacts(p/'objects',p/'artifacts.json',os.environ['E2E_URL'],'test-private-worker')
s=ResultSync(p/'arena.db',p/'state.json',os.environ['E2E_URL'],'test-private-worker',on_record=a)
print(json.dumps(s.run_once()));s.close();a.close()
assert list((p/'objects/videos/v/jobs').glob('*/normalized.mp4'))
`;
  const done=await execute(join(root,'.venv/bin/python'),['-c',processing],{cwd:root,env,timeout:60000});assert.equal(JSON.parse(done.stdout).conflicts,0);
  const response=await fetch(new URL('/api/videos/v/report',url),{headers});assert.equal(response.status,200);const report=await response.json();
  const completed=report.jobs.find(j=>j.id===job.id);assert.equal(completed.status,'completed');assert.ok(completed.metadata.duration>0);
  assert.equal(report.video.media_location,'local');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM result_objects').first()).n,0);
  assert.equal((await fetch(new URL('/api/jobs/'+job.id+'/media',url),{headers})).status,409);
  const dashboard=await(await fetch(new URL('/api/dashboard',url),{headers})).json();assert.equal(dashboard.video_count,1);assert.equal(dashboard.recorded_minutes,180);
 }finally{await mf.dispose();await rm(folder,{recursive:true,force:true});}
});
