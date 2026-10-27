import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, modules = {}, globals = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => modules[name] || require(name), ...globals });
  return exports;
}
function component(language = 'en') {
  const i18n = load('i18n.ts', {}, { window: { localStorage: { getItem: () => language, setItem() {} } } });
  const planning = load('planningTypes.ts');
  const types = load('types.ts', { './i18n': i18n, './planningTypes': planning });
  const components = load('components.tsx', { './i18n': i18n, './types': types });
  return load('AnalysisOverview.tsx', { './i18n': i18n, './types': types, './components': components, './analytics.css': {} }).default;
}
function expand(value) {
  if (Array.isArray(value)) return value.flatMap(expand);
  if (value == null || typeof value === 'boolean') return [];
  if (typeof value !== 'object') return [value];
  if (typeof value.type === 'function') return expand(value.type(value.props));
  return [{ ...value, props: { ...value.props, children: expand(value.props.children) } }];
}
function elements(value) {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object') return [];
  return [value, ...elements(value.props?.children)];
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value == null || typeof value === 'boolean') return '';
  return typeof value === 'object' ? text(value.props?.children) : String(value);
}
function summary() {
  return {
    video_count: 3, analyzed_videos: 2,
    status_counts: { completed: 1, needs_review: 1, queued: 0, running: 0, failed: 0, blocked: 0, not_analyzed: 1 },
    storage_bytes: 1048576, footage_seconds: 90, duration_known: 3,
    duration_stats: { n: 3, mean: 30, median: 20, q1: 15, q3: 40, min: 10, max: 60 },
    duration_bins: [{ key: '0-10', count: 1 }, { key: '10-30', count: 1 }, { key: '30-60', count: 1 }, { key: '60+', count: 0 }],
    frames: { total: 10, usable: 6, ambiguous: 2, missing: 2, usable_ratio: 0.6 },
    quality_known: 2, quality_passed: 1, needs_review: 1,
    scores: { confirmed: 1, draft: 0, unscored: 2 },
    by_session: [{ session_id: 'session-1', date: '2026-07-25', athlete_id: 'athlete-1', duration_min: 180, video_count: 3, analyzed_videos: 2, review_needed: 1 }],
    measurement_count: 2,
    measurements: [
      { video_id: 'video-1', job_id: 'job-1', filename: 'mat-a.mov', date: '2026-07-25', category: 'mixed', method_version: 'coco17-v1', quality_passed: true, confirmed: false, metrics: { hip_sway_ratio: { label: '髋中点横向离散度', value: 0.0125, unit: '躯干长度' }, trunk_lean_deg: { label: '平均躯干倾角', value: 21.5, unit: '°' } } },
      { video_id: 'video-2', job_id: 'job-2', filename: 'mat-b.mov', date: '2026-07-25', category: 'attack', method_version: 'coco17-v1', quality_passed: false, confirmed: false, metrics: { trunk_lean_deg: { label: '平均躯干倾角', value: 0, unit: '°' } } },
    ],
    review_queue: [{ video_id: 'video-2', job_id: 'job-2', filename: 'mat-b.mov', date: '2026-07-25', usable_ratio: 0.5, total_frames: 4, ambiguous_frames: 2 }],
  };
}

test('frame-quality chart uses weighted counts with accessible values', () => {
  const view = expand(component()({ data: summary() }));
  const chart = elements(view).find(element => element.type === 'svg' && /Pose frame checks/.test(element.props['aria-label'] || ''));
  assert.ok(chart);
  assert.match(chart.props['aria-label'], /60%/);
  assert.match(chart.props['aria-label'], /6.*2.*2/);
  const segments = elements(chart).filter(element => element.type === 'circle');
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map(segment => segment.props.strokeDasharray), ['60 40', '20 80', '20 80']);
  assert.match(text(view), /Usable6/);
  assert.match(text(view), /Ambiguous2/);
  assert.match(text(view), /Missing2/);
});

test('empty or invalid frame partitions never draw a misleading full donut', () => {
  for (const frames of [
    { total: 0, usable: 0, ambiguous: 0, missing: 0, usable_ratio: null },
    { total: 10, usable: 8, ambiguous: 4, missing: 0, usable_ratio: 0.8 },
  ]) {
    const data = summary(); data.frames = frames; data.quality_known = 0;
    const view = expand(component()({ data }));
    assert.equal(elements(view).filter(element => element.type === 'circle').length, 0);
    assert.match(text(view), /No usable frame summary/);
    assert.doesNotMatch(text(view), /NaN|Infinity/);
  }
});

test('duration histogram preserves all four bins, visible counts and seconds', () => {
  const view = expand(component()({ data: summary() }));
  const chart = elements(view).find(element => element.type === 'svg' && /Clip duration/.test(element.props['aria-label'] || ''));
  assert.ok(chart);
  assert.match(chart.props['aria-label'], /0.10.*1.*10.30.*1.*30.60.*1.*60\+.*0/);
  assert.equal(elements(chart).filter(element => element.type === 'rect').length, 4);
  assert.match(text(view), /Clip duration \/ s/);
  assert.match(text(view), /Archived clip time \/ min1.5/);
  assert.match(text(view), /180/);
});

test('unknown durations keep null values and render a real empty state', () => {
  const data = summary();
  data.footage_seconds = null; data.duration_known = 0;
  data.duration_stats = { n: 0, mean: null, median: null, q1: null, q3: null, min: null, max: null };
  data.duration_bins = data.duration_bins.map(bin => ({ ...bin, count: 0 }));
  const view = expand(component()({ data }));
  assert.match(text(view), /Archived clip time \/ min—/);
  assert.match(text(view), /No known video durations/);
  assert.equal(elements(view).filter(element => element.type === 'svg' && /Clip duration/.test(element.props['aria-label'] || '')).length, 0);
});

test('stored measurements retain zero, missing values, units and source links without invented scores', () => {
  const view = expand(component()({ data: summary() }));
  const table = elements(view).find(element => element.type === 'table' && /Experimental/.test(element.props['aria-label'] || ''));
  assert.ok(table);
  const contents = text(table);
  assert.match(contents, /0.0125.*trunk lengths/);
  assert.match(contents, /—/);
  assert.match(contents, /0.*°/);
  assert.match(contents, /Experimental/);
  assert.match(contents, /coco17-v1/);
  assert.doesNotMatch(contents, /Improvement|Grade|Mean score|Confirmed coach score/);
  assert.ok(elements(table).some(element => element.type === 'a' && element.props.href === '#videos/video-1?job=job-1' && text(element) === 'mat-a.mov'));
  assert.ok(elements(view).some(element => element.type === 'a' && element.props.href === '#videos/video-2?job=job-2'));
});

test('optional provenance and unknown review counts stay readable without claiming verification', () => {
  const data = summary();
  data.measurements[0].method_version = null;
  data.measurements[0].metrics.hip_sway_ratio = { value: 0.25 };
  data.measurements[1].metrics.ankle_span_ratio = { value: 0.5 };
  data.measurements[1].confirmed = true;
  data.review_queue[0].usable_ratio = null;
  data.review_queue[0].total_frames = null;
  data.review_queue[0].ambiguous_frames = null;
  const view = expand(component()({ data }));
  const table = elements(view).find(element => element.type === 'table' && /Experimental/.test(element.props['aria-label'] || ''));
  assert.match(text(table), /Lateral hip midpoint dispersion.*0.25/);
  assert.match(text(table), /Mean 2D ankle span.*0.5/);
  assert.match(text(table), /Experimental/);
  assert.match(text(table), /Verified/);
  const queue = elements(view).find(element => element.type === 'ul');
  assert.match(text(queue), /Usable —/);
  assert.match(text(queue), /Ambiguous — \/ — frames/);
  assert.doesNotMatch(text(view), /undefined|null|NaN/);
});

test('latest-attempt status counts and coach-score workflow remain distinct', () => {
  const data = summary();
  data.video_count = 7;
  data.status_counts = { completed: 1, needs_review: 2, queued: 0, running: 1, failed: 1, blocked: 0, not_analyzed: 2 };
  const view = expand(component()({ data }));
  const status = elements(view).find(element => element.props.className === 'analytics-status-stack');
  assert.equal(status.props.role, 'img');
  assert.match(status.props['aria-label'], /Complete: 1, Pose checks needed: 2, Queued: 0, Analyzing: 1, Failed: 1, Blocked: 0, Not analyzed: 2/);
  const workflow = elements(view).find(element => element.props.className === 'analytics-score-workflow');
  assert.match(text(workflow), /Training scoresReviewed1Draft0Unscored2/);
  assert.doesNotMatch(text(workflow), /Mean|Median|\//);
});

test('a video-free summary provides empty states without drawing any data chart', () => {
  const data = summary();
  Object.assign(data, { video_count: 0, analyzed_videos: 0, quality_known: 0, quality_passed: 0, needs_review: 0, duration_known: 0, storage_bytes: 0, footage_seconds: null, measurement_count: 0, measurements: [], review_queue: [], by_session: [] });
  data.frames = { total: 0, usable: 0, ambiguous: 0, missing: 0, usable_ratio: null };
  data.duration_bins = data.duration_bins.map(bin => ({ ...bin, count: 0 }));
  data.duration_stats = { n: 0, mean: null, median: null, q1: null, q3: null, min: null, max: null };
  data.status_counts = Object.fromEntries(Object.keys(data.status_counts).map(key => [key, 0]));
  data.scores = { confirmed: 0, draft: 0, unscored: 0 };
  const view = expand(component()({ data }));
  assert.equal(elements(view).filter(element => element.props.role === 'img').length, 0);
  assert.match(text(view), /No archived videos/);
  assert.match(text(view), /No stored 2D measurements/);
  assert.match(text(view), /No videos waiting for pose checks/);
});

test('preview limits keep quality-passed measurements first and review sources bounded', () => {
  const data = summary();
  data.measurements = Array.from({ length: 14 }, (_, index) => ({ ...data.measurements[0], video_id: `video-${index}`, filename: `clip-${index}`, quality_passed: index > 0 }));
  data.measurement_count = 14;
  data.review_queue = Array.from({ length: 8 }, (_, index) => ({ ...data.review_queue[0], video_id: `review-${index}`, filename: `review-${index}` }));
  const view = expand(component()({ data }));
  const table = elements(view).find(element => element.type === 'table' && /Experimental/.test(element.props['aria-label'] || ''));
  const links = elements(table).filter(element => element.type === 'a');
  assert.equal(links.length, 12);
  assert.equal(text(links[0]), 'clip-1');
  assert.equal(elements(view).filter(element => element.type === 'a' && element.props.href?.startsWith('#videos/review-')).length, 6);
});

test('compact mode keeps charts and Insights link while omitting detailed ledgers', () => {
  const view = expand(component()({ data: summary(), compact: true }));
  assert.equal(elements(view).filter(element => element.type === 'svg' && element.props.role === 'img').length, 2);
  assert.ok(elements(view).some(element => element.type === 'a' && element.props.href === '#insights'));
  assert.equal(elements(view).filter(element => element.type === 'table').length, 0);
  assert.doesNotMatch(text(view), /Archived clip time|Awaiting verification|Session analysis/);
});

test('Chinese labels translate chart semantics and stored metric units', () => {
  const view = expand(component('zh')({ data: summary() }));
  const contents = text(view);
  assert.match(contents, /关键点帧核查/);
  assert.match(contents, /片段时长 \/ 秒/);
  assert.match(contents, /髋中点横向离散度/);
  assert.match(contents, /躯干长度/);
  assert.match(contents, /实验性/);
  assert.match(contents, /实验性二维测量/);
  assert.doesNotMatch(contents, /Awaiting verification|Frame quality|Clip duration|trunk lengths/);
});

test('closed measurement assessments show zero pending without changing raw quality counters', () => {
  const data=summary();data.review_counts={reviewed:2,pending:0,accepted:1,excluded:1,superseded:0};data.needs_review=0;data.review_queue=[];
  const view=expand(component()({data}));
  assert.match(text(view),/Analysis assessments/);
  assert.match(text(view),/Pending0/);
  assert.match(text(view),/Not adopted1/);
  assert.doesNotMatch(text(view),/Pose checks needed/);
  assert.equal(data.frames.ambiguous,2);
  assert.equal(data.status_counts.needs_review,1);
});

test('reopened analysis assessments return to the pending workflow', () => {
  const data=summary();data.review_counts={reviewed:1,pending:1,accepted:1,excluded:0,superseded:0};
  const view=expand(component()({data}));
  assert.match(text(view),/Pending1/);
  assert.ok(elements(view).some(e=>e.type==='a' && e.props.href?.includes('video-2')));
});

test('real capability coverage leads full and compact summaries and links only to returned source jobs', () => {
  for (const compact of [false, true]) for (const language of ['en', 'zh']) {
    const data = summary();
    data.capabilities = [
      { backend: 'rtmpose_tracking', processed_videos: 3, video_count: 3, first_video_id: 'source video', first_job_id: 'source job' },
      { backend: 'sam2', processed_videos: 1, video_count: 3, first_video_id: 'mask-video', first_job_id: 'mask-job' },
      { backend: 'action', processed_videos: 2, video_count: 3, first_video_id: 'action-video', first_job_id: 'action-job' },
      { backend: 'pose3d', processed_videos: 0, video_count: 3, first_video_id: null, first_job_id: null },
    ];
    const view = expand(component(language)({ data, compact }));
    const strip = elements(view).find(element => element.props.className === 'analytics-capabilities');
    assert.ok(strip); assert.match(text(strip), language === 'en' ? /Tracking3 \/ 3.*Person masks1 \/ 3.*Action analysis2 \/ 3.*3D skeleton0 \/ 3/ : /人物追踪3 \/ 3.*人物分割1 \/ 3.*动作分析2 \/ 3.*三维骨架0 \/ 3/);
    const links = elements(strip).filter(element => element.type === 'a');
    assert.equal(links.length, 3);
    assert.equal(links[0].props.href, '#videos/source%20video?job=source%20job');
    assert.doesNotMatch(text(strip), /score|grade|分数|评分|%/i);
    data.capabilities = [{ backend: 'action', processed_videos: 0, video_count: 1, first_video_id: null, first_job_id: null }];
    const filtered = expand(component(language)({ data, compact }));
    const filteredStrip = elements(filtered).find(element => element.props.className === 'analytics-capabilities');
    assert.match(text(filteredStrip), /0 \/ 1/); assert.equal(elements(filteredStrip).filter(element => element.type === 'a').length, 0);
  }
});
