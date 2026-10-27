import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyticsSummary, planningSummary, statistics, dateFilters, acceptanceError, exportCsv, exportZip, factsFor, rulesDraft, readSnapshot, quality, csvValue } from '../dist/analytics.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = (script, input) => {
  const run = spawnSync(`${root}.venv/bin/python`, ['-c', script], { cwd: root, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};
const filters = { start: '2026-01-01', end: '2026-03-31', athlete_id: null };
const today = '2026-02-16';
const qualityCounts = { total_frames: 20, usable_frames: 15, ambiguous_frames: 0, missing_frames: 5, confidence_threshold: .35, minimum_usable_frames: 10, minimum_coverage: .6 };
const result = { synthetic: false, kind: 'pose', method_version: 'fixture-v1', sample_fps: 5, roi: [.1,.2,.7,.6], quality: qualityCounts, metrics: { hip_sway_ratio: { value: .125, unit: '躯干长度', label: '髋中点', formula: 'sd/median', private: 'excluded' }, trunk_lean_deg: { value: 12.25, unit: '°', label: '躯干倾斜', formula: 'mean' }, ankle_span_ratio: { value: null, unit: '躯干长度', label: '跨度', formula: 'mean' }, other: {value: null, label: '其他', unit: 'unit', formula: 'none'} }, model_sha256: { detector: 'a'.repeat(64), pose: 'b'.repeat(64), secret: 'do-not-export' }, limitations: ['髋中点不是人体真实重心；图像坐标不能推断力量、真实速度或竞技能力。'], specialty_score: null, kinematics: { method_version: 'k1', summary: {n:20}, tracks: [{id:1,summary:{n:20},series:[123]}], series:[456] } };
function fixture() {
  const sessions = [
    {id:'s1',athlete_id:'a1',date:'2026-01-04',duration_min:45,rpe:null,objective:'private-objective',notes:'private-note'},
    {id:'s2',athlete_id:'a1',date:'2026-01-05',duration_min:30,rpe:0},
    {id:'s3',athlete_id:'a2',date:'2026-02-16',duration_min:60,rpe:8},
  ];
  const videos = ['v1','v2','v3','v4','v5','v6','v7','v8'].map((id,i)=>({id,session_id:sessions[i%3].id,athlete_id:sessions[i%3].athlete_id,date:sessions[i%3].date,category:['stability','footwork','attack','defense','mixed'][i%5],filename:`private-${id}.mp4`,size_bytes:100+i}));
  const job=(id,video_id,backend='rtmpose',status='completed',r=structuredClone(result),time='2026-02-01T12:00:00Z')=>({id,video_id,backend,status,params:{start_sec:1.25,end_sec:3.75,target_track_id:2,source_pose_job_id:'p1'},metadata:{source_duration:31.5},result:r,created_at:time});
  const jobs = [job('j1','v1'),job('j1new','v1','rtmpose','queued',null,'2026-02-02T12:00:00Z'),job('j2','v2'),job('j3','v3'),job('j4','v4','rtmpose','needs_review',{...result,needs_review:true,quality:{...qualityCounts,usable_frames:5,missing_frames:15}}),job('j5','v5','sample','completed',{...result,synthetic:true}),job('j6','v6','rtmpose_tracking','completed',{...result,tracking:{track_count:2},selected_track_id:1}),job('j7','v7','rtmpose','failed',{}),job('j8','v8','rtmpose','completed',{...result,quality:{total_frames:5,usable_frames:3,ambiguous_frames:0,missing_frames:3}}),job('seg','v2','sam2','completed',{synthetic:false,kind:'segmentation',segmentation:{total_frames:20,segmented_frames:10,object_count:2,prompted_objects:2},method_version:'sam2',limitations:[]}),job('act','v3','action','completed',{synthetic:false,kind:'recognition',windows:[{source_frame_times_sec:[.1,.3]}],candidate_label:'model candidate',method_version:'action',limitations:['pending']}),job('3d','v4','pose3d','completed',{synthetic:false,kind:'pose3d',pose3d:{frame_count:20,person_observation_count:22,segment_count:1,track_ids:[1,2],private:123},method_version:'3d',limitations:[]}),job('ignore','outside')];
  jobs[4].metadata.source_duration=10;
  const score={score_id:'score1',video_id:'v1',session_id:'s1',athlete_id:'a1',date:sessions[0].date,category:'stability',rubric_version:'historical-v0',score:7.25,confirmed:true,updated_at:'2026-01-04T12:00:00Z'};
  const measurement={job_id:'j2',video_id:'v2',session_id:'s2',athlete_id:'a1',date:sessions[1].date,category:'footwork',draft_id:'d2',params:jobs[2].params,result:structuredClone(result)};
  return {sessions,videos,jobs,plans:[{id:'p1',athlete_id:'a1',date:'2026-01-04',category:'stability',planned_minutes:45,status:'planned',session_id:'s1',session_date:'2026-01-04'},{id:'p2',athlete_id:'a2',date:'2026-02-16',category:'attack',planned_minutes:60,status:'planned',session_id:'future-session',session_date:'2026-02-17'},{id:'p3',athlete_id:'a1',date:'2026-02-20',category:'defense',planned_minutes:20,status:'planned',session_id:null,session_date:null},{id:'p4',athlete_id:'a1',date:'2026-01-09',category:'footwork',planned_minutes:10,status:'cancelled',session_id:null,session_date:null}],measurements:[measurement],reviewed:[{video_id:'v2'}],scores:[score,{...score,score_id:'score2',video_id:'v3',score:9.5,category:'attack'}],current_scores:[{video_id:'v1',confirmed:true},{video_id:'v3',confirmed:false}],events:[{id:'e1',video_id:'v1',session_id:'s1',athlete_id:'a1',date:'2026-01-04',category:'stability',start_sec:.25,end_sec:1.5,label:'  =SUM(1,2)',actor:'athlete',outcome:'\tformula',notes:'private-event-note'}],assessments:[{job_id:'j2',decision:'accepted'},{job_id:'j3',decision:'excluded'},{job_id:'j6',decision:'superseded'}]};
}
const parityScript = `import sys,json,base64,io,zipfile
from datetime import date
from arena import analytics,planning
from arena.review import facts_for,rules_draft
p=json.load(sys.stdin); d=p['data']; f=p['filters']; t=date.fromisoformat(p['today'])
z=zipfile.ZipFile(io.BytesIO(planning.export_zip(d,f,today=t)))
entries={n:z.read(n).decode() for n in z.namelist()}
manifest=json.loads(entries['manifest.json']);manifest.pop('exported_at');entries['manifest.json']=manifest;entries['data_dictionary.json']=json.loads(entries['data_dictionary.json'])
facts=[facts_for(j) for j in d['jobs'] if j['id'] in ('j2','seg','act','3d')]
print(json.dumps({'analytics':analytics.summarize(d),'planning':planning.summarize(d,f,today=t),'csv':analytics.export_csv(d).decode(),'entries':entries,'facts':facts,'drafts':[[rules_draft(x,l) for l in ('zh','en')] for x in facts]},ensure_ascii=False,allow_nan=False))`;

test('summary and evidence drafts preserve Python eligibility, deduplication, coverage, dates and history', () => {
  const data=fixture(), expected=python(parityScript,{data,filters,today});
  assert.deepEqual(analyticsSummary(data),expected.analytics);
  assert.deepEqual(planningSummary(data,filters,today),expected.planning);
  const facts=data.jobs.filter(j=>['j2','seg','act','3d'].includes(j.id)).map(factsFor);
  assert.deepEqual(facts,expected.facts);
  assert.deepEqual(facts.map(f=>['zh','en'].map(l=>rulesDraft(f,l))),expected.drafts);
  assert.equal(analyticsSummary(data).scores.draft,1);
  assert.equal(analyticsSummary(data).review_counts.pending,3);
});

test('research ZIP and attempt CSV preserve allowlists, dictionary, provenance and formula safety', () => {
  const data=fixture(), expected=python(parityScript,{data,filters,today});
  const csv=new TextDecoder().decode(exportCsv(data));assert.equal(csv,expected.csv);
  const entries=python(`import sys,json,base64,io,zipfile
p=json.load(sys.stdin);z=zipfile.ZipFile(io.BytesIO(base64.b64decode(p['zip'])))
assert z.testzip() is None
entries={n:z.read(n).decode() for n in z.namelist()}
m=json.loads(entries['manifest.json']);m.pop('exported_at');entries['manifest.json']=m;entries['data_dictionary.json']=json.loads(entries['data_dictionary.json'])
print(json.dumps(entries,ensure_ascii=False))`,{zip:Buffer.from(exportZip(data,filters,today)).toString('base64')});
  assert.deepEqual(entries,expected.entries);
  for(const value of Object.values(entries)){assert.ok(!JSON.stringify(value).includes('private-note'));assert.ok(!JSON.stringify(value).includes('private-event-note'));assert.ok(!JSON.stringify(value).includes('private-objective'));}
  assert.ok(entries['events.csv'].includes("'  =SUM"));
});

test('acceptance gates and Type 7 statistics match Python across boundaries', () => {
  const jobs=fixture().jobs.filter(j=>j.result);jobs.push({id:'bad',backend:'sam2',result:{kind:'segmentation',segmentation:{total_frames:10,segmented_frames:11,object_count:1}}},{id:'bool',backend:'rtmpose',result:{...result,quality:{...qualityCounts,usable_frames:true}}});
  const vectors=[[],[1],[1,2],[1,4,8],[10,2,5,12],[0,0,0]],roles=['athlete','coach','unknown'];
  const expected=python(`import sys,json
from arena.analytics import acceptance_error,quality
from arena.planning import statistics
p=json.load(sys.stdin);print(json.dumps({'errors':[[acceptance_error(j,r) for r in p['roles']] for j in p['jobs']],'stats':[statistics(x) for x in p['vectors']],'quality':[quality(j['result']) for j in p['jobs']]}))`,{jobs,vectors,roles});
  assert.deepEqual(jobs.map(j=>roles.map(r=>acceptanceError(j,r))),expected.errors);
  assert.deepEqual(vectors.map(statistics),expected.stats);
  assert.deepEqual(jobs.map(j=>quality(j.result)),expected.quality);
});

test('empty summary, missing RPE, invalid partitions and inclusive date defaults retain nulls', () => {
  const data=Object.fromEntries(['sessions','plans','videos','measurements','reviewed','scores','events','jobs','current_scores','assessments'].map(k=>[k,[]]));
  const expected=python(parityScript,{data,filters,today});
  assert.deepEqual(analyticsSummary(data),expected.analytics);assert.deepEqual(planningSummary(data,filters,today),expected.planning);
  assert.deepEqual(dateFilters(null,null,null,'2026-03-01'),{start:'2026-01-05',end:'2026-03-01',athlete_id:null});
  assert.throws(()=>dateFilters('2026-02-17','2026-02-16'),/开始日期/);
  assert.throws(()=>dateFilters('2026-02-30','2026-03-01'),/日期/);
});

test('readSnapshot uses real D1 joins, inclusive dates and exact confirmed draft eligibility', async () => {
  const generated = python(`import sys,json
from sqlalchemy import create_engine,insert
from arena import db,planning
p=json.load(sys.stdin);d=p['data'];e=create_engine('sqlite:///:memory:');db.meta.create_all(e)
stamp='2026-01-01T00:00:00+00:00'
with e.begin() as c:
 c.execute(insert(db.athletes),[{'id':a,'name':'private-athlete-name','level':'private-level','created_at':stamp} for a in ('a1','a2')])
 for r in d['sessions']: c.execute(insert(db.sessions),dict({'objective':'','notes':'','created_at':stamp},**r))
 c.execute(insert(db.sessions),{'id':'outside-date','athlete_id':'a1','date':'2025-12-31','objective':'outside','notes':'','duration_min':20,'rpe':4,'created_at':stamp})
 for r in d['plans']:
  row={k:v for k,v in r.items() if k!='session_date'}
  if row['session_id']=='future-session': row['session_id']=None
  c.execute(insert(db.plans),dict(objective='',created_at=stamp,**row))
 for r in d['videos']:
  row={k:v for k,v in r.items() if k not in ('date','athlete_id')}
  c.execute(insert(db.videos),dict(storage_key='private-path',sha256='a'*64,status='ready',authorized_at=stamp,created_at=stamp,**row))
 c.execute(insert(db.videos),{'id':'outside','session_id':'outside-date','category':'mixed','filename':'private-outside','size_bytes':15,'storage_key':'private-path','sha256':'a'*64,'status':'ready','authorized_at':stamp,'created_at':stamp})
 for r in d['jobs']: c.execute(insert(db.jobs),dict(stage='complete',progress=100,updated_at=stamp,**r))
 for i,j in enumerate([r for r in d['jobs'] if r['backend'] in ('rtmpose','rtmpose_tracking') and r['status']!='queued']):
  draft={'id':'d'+j['id'],'video_id':j['video_id'],'job_id':j['id'],'provider':'rules','model':'rules-v1','synthetic':j['id']=='j1','text':'private-draft','facts':{},'created_at':stamp}
  c.execute(insert(db.drafts),draft)
  c.execute(insert(db.reviews),{'id':'r'+str(i),'video_id':j['video_id'],'draft_id':draft['id'],'observations':'private-observations','next_action':'private-action','confirmed':True,'confirmed_by':'private-reviewer','updated_at':stamp})
 for i,r in enumerate(d['assessments']): c.execute(insert(db.analysis_assessments),dict(id='assessment'+str(i),subject_role='athlete',reason='private-reason',reviewer='private-reviewer',updated_at=stamp,**r))
 for i,r in enumerate(d['current_scores']): c.execute(insert(db.manual_scores),dict(id='ms'+str(i),score=7.25,comment='private-score-comment',assessor='private-assessor',rubric_version='stored-historical-v0',updated_at=stamp,**r))
 for r in d['events']:
  row={k:v for k,v in r.items() if k not in ('session_id','athlete_id','date','category')}
  c.execute(insert(db.events),dict(created_by='private-author',created_at=stamp,**row))
with e.connect() as c: statements=list(c.connection.driver_connection.iterdump())
order={t.name:i for i,t in enumerate(db.meta.sorted_tables)}
creates=[s for s in statements if s.startswith('CREATE')]
inserts=sorted([s for s in statements if s.startswith('INSERT')],key=lambda s:order[s.split('\"')[1]])
dump='\\n'.join(' '.join(statement.splitlines()) for statement in creates+inserts)
print(json.dumps({'sql':dump,'snapshots':[planning.read_snapshot(e,f) for f in p['filters']]},ensure_ascii=False))`, { data: fixture(), filters: [filters, {...filters,athlete_id:'a1'}, {...filters,start:'2026-01-05',end:'2026-01-05'}] });
  const { Miniflare } = await import('miniflare');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } }', compatibilityDate: '2026-05-21', d1Databases: ['DB'] });
  try {
    const db=await mf.getD1Database('DB');
    await db.exec(generated.sql);
    const selections=[filters,{...filters,athlete_id:'a1'},{...filters,start:'2026-01-05',end:'2026-01-05'}];
    for(let i=0;i<selections.length;i++) {
      const actual=await readSnapshot(db,selections[i]);
      assert.deepEqual(actual,generated.snapshots[i]);
      assert.deepEqual(analyticsSummary(actual),analyticsSummary(generated.snapshots[i]));
      assert.deepEqual(planningSummary(actual,selections[i],today),planningSummary(generated.snapshots[i],selections[i],today));
    }
  } finally { await mf.dispose(); }
});

test('rules draft decimal formatting preserves Python tie-to-even rounding', () => {
  const values=[.03125,.09375,-.03125,1.23445,1.23455,1e23,1e-9,-1e-9];
  const facts=values.map(value=>({...factsFor(fixture().jobs[2]),metrics:{hip_sway_ratio:{value,label:'指标',unit:'unit'}}}));
  const expected=python(`import sys,json
from arena.review import rules_draft
p=json.load(sys.stdin);print(json.dumps([[rules_draft(f,l) for l in ('zh','en')] for f in p],ensure_ascii=False))`,facts);
  assert.deepEqual(facts.map(f=>['zh','en'].map(language=>rulesDraft(f,language))),expected);
});


test('CSV formula safety matches Python whitespace handling without coercing numbers', () => {
  const values=[null,0,-2.5,true,'=formula',' +formula','\tvalue','\rvalue','\nvalue','\u0085=hidden','\u001c@hidden','ordinary','中文', ' \u3000-formula'];
  const expected=python(`import sys,json
from arena.planning import csv_value
print(json.dumps([csv_value(v) for v in json.load(sys.stdin)],ensure_ascii=False))`,values);
  assert.deepEqual(values.map(csvValue),expected);
});
