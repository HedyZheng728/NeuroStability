import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server');
function load(file, modules = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => modules[name] || require(name), ...globals });
  return exports;
}
const i18n = { t: value => value, tx: (en) => en };
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
function harness(file, modules = {}) {
  const values = [], effects = [], pending = [];
  let stateIndex = 0, effectIndex = 0, dirty = false;
  const hooks = {
    useState(initial) { const index = stateIndex++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], next => { const value = typeof next === 'function' ? next(values[index]) : next; dirty ||= value !== values[index]; values[index] = value; }]; },
    useRef: value => ({ current: value }),
    useMemo: fn => fn(),
    useEffect(fn, deps) { const index = effectIndex++; if (!effects[index] || deps.some((value, position) => value !== effects[index].deps[position])) pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: fn() }; }); },
  };
  const timers = new Map(); let now = 0, timerId = 0;
  const module = load(file, { react: hooks, ...modules }, { window: { setInterval(fn) { timers.set(++timerId, fn); return timerId; }, clearInterval(id) { timers.delete(id); } }, performance: { now: () => now } });
  let props, view;
  function render(next = props) { props = next; let count = 0; do { dirty = false; stateIndex = effectIndex = 0; view = module.default(props); while (pending.length) pending.shift()(); assert.ok(++count < 10, 'Rendering converges'); } while (dirty); return view; }
  return { module, render, get view() { return view; }, timers, advance(ms) { now += ms; for (const callback of [...timers.values()]) callback(); return render(); }, unmount() { for (const effect of effects) effect?.cleanup?.(); } };
}
const job = { id: 'pose-job', backend: 'rtmpose_tracking', status: 'completed', metadata: { duration: 2, time_offset: 12, fps: 10 }, result: { metrics: {}, sample_fps: 10 } };
const pose = { width: 640, height: 360, frames: [{ t: 0, people: [{ track_id: 1, bbox: [0, 0, 100, 200], keypoints: [[20, 30, .9]] }] }, { t: 2, people: [] }] };
function player(data = pose) {
  return harness('PosePlayer.tsx', { './i18n': i18n, './api': {}, './components': { Synthetic: () => null, useData: () => ({ data: data ? { jobId: job.id, value: data } : null, loading: false, error: '' }) } });
}
const props = { videoId: 'private-video', job, seekTime: null, onTime() {}, resultsOnly: true, preferredMode: 'analysis' };

test('results-only analysis renders stored geometry and bounded timeline without a media element', () => {
  const view = player().render(props);
  assert.equal(elements(view).filter(element => element.type === 'video').length, 0);
  assert.ok(elements(view).some(element => element.type === 'circle'));
  const slider = elements(view).find(element => element.type === 'input' && element.props.type === 'range');
  assert.ok(slider); assert.equal(slider.props.min, 0); assert.equal(slider.props.max, 2);
  assert.match(text(view), /Source 12.00 s/);
});

test('original and unavailable results give a local-only or missing-data card without media URLs', () => {
  for (const preferredMode of ['original', 'analysis']) {
    const view = player(null).render({ ...props, preferredMode });
    assert.equal(elements(view).filter(element => element.type === 'video' || element.props.src).length, 0);
    assert.match(text(view), preferredMode === 'original' ? /Original video stays on the analysis computer/ : /No saved visualization/);
    assert.equal(elements(view).filter(element => element.type === 'input' && element.props.type === 'range').length, 0);
  }
});

test('source markers and slider seek stay within the clip and report original source time', () => {
  const times = []; const runtime = player();
  runtime.render({ ...props, seekTime: 99, onTime: time => times.push(time) });
  let slider = elements(runtime.view).find(element => element.props.type === 'range');
  assert.equal(slider.props.value, 2); assert.equal(times.at(-1), 14);
  runtime.render({ ...props, seekTime: 0, onTime: time => times.push(time) });
  slider = elements(runtime.view).find(element => element.props.type === 'range');
  assert.equal(slider.props.value, 0); assert.equal(times.at(-1), 12);
  slider.props.onChange({ target: { value: '1.25' } }); runtime.render();
  assert.equal(times.at(-1), 13.25);
});

test('standalone playback stops at the final frame and cleans up timers on pause and unmount', () => {
  const runtime = player(); runtime.render(props);
  const button = () => elements(runtime.view).find(element => element.type === 'button' && /^(Play|Pause)$/.test(text(element)));
  button().props.onClick(); runtime.render(); assert.equal(runtime.timers.size, 1);
  runtime.advance(500); assert.equal(elements(runtime.view).find(element => element.props.type === 'range').props.value, .5);
  button().props.onClick(); runtime.render(); assert.equal(runtime.timers.size, 0);
  button().props.onClick(); runtime.render(); runtime.advance(3000); assert.equal(runtime.timers.size, 0);
  assert.equal(elements(runtime.view).find(element => element.props.type === 'range').props.value, 2);
  button().props.onClick(); runtime.render(); assert.equal(runtime.timers.size, 1);
  runtime.unmount(); assert.equal(runtime.timers.size, 0);
});

test('local deployments retain the original video player', () => {
  const view = player().render({ ...props, resultsOnly: false, preferredMode: 'original' });
  assert.equal(elements(view).find(element => element.type === 'video').props.src, '/api/videos/private-video/media');
});

test('cloud upload shows local workspace instructions even without sessions and never offers file selection', () => {
  const runtime = harness('pages/Upload.tsx', { '../i18n': i18n, '../api': {}, '../types': {}, '../components': { useData: () => ({ data: { sessions: [], athletes: [], config: { mode: 'local' } }, loading: false, error: '' }) } });
  const view = runtime.render({ notify() {} });
  assert.ok(elements(view).some(element => element.props.title === 'Upload on the analysis computer'));
  assert.match(text(view), /Open the local workspace on your analysis computer/);
  assert.equal(elements(view).filter(element => element.type === 'input' && element.props.type === 'file').length, 0);
  assert.ok(elements(view).some(element => element.type === 'a' && element.props.href === '#videos'));
  assert.equal(elements(view).filter(element => element.props.href?.includes('127.0.0.1')).length, 0);
});

test('stored masks render and seek on the independent cloud timeline', () => {
  const masks = { width: 640, height: 360, frames: [{ t: 0, masks: [{ object_id: 1, polygons: [[[10, 20], [50, 60], [30, 80]]] }] }, { t: 2, masks: [] }] };
  const runtime = player(masks);
  const view = runtime.render({ ...props, job: { ...job, backend: 'sam2', result: { kind: 'segmentation' } } });
  assert.equal(elements(view).filter(element => element.type === 'polygon').length, 1);
  assert.doesNotMatch(renderToStaticMarkup(view), /<video|\/media/);
  elements(view).find(element => element.props.type === 'range').props.onChange({ target: { value: '2' } });
  runtime.render(); assert.equal(elements(runtime.view).filter(element => element.type === 'polygon').length, 0);
});

test('2D timeline derives missing duration from observations and disables empty clips without invalid values', () => {
  const runtime = player();
  runtime.render({ ...props, job: { ...job, metadata: {} } });
  assert.equal(elements(runtime.view).find(element => element.props.type === 'range').props.max, 2);
  const empty = player({ ...pose, frames: [] }).render({ ...props, job: { ...job, metadata: {} } });
  const range = elements(empty).find(element => element.props.type === 'range');
  assert.equal(range.props.max, 0); assert.equal(range.props.disabled, true);
  assert.doesNotMatch(renderToStaticMarkup(empty), /NaN|Infinity|<video/);
});

test('3D cloud rendering never requests media and keeps exact frame seeking plus independent playback', () => {
  const pose3d = { kind: 'pose3d', synthetic: false, layout: 'h36m17', frames: [0, .1, .2].map(t => ({ t, people: [{ track_id: 1, joints: Array.from({ length: 17 }, (_, i) => [i / 20, i / 20, 0]) }] })) };
  const runtime = harness('Pose3DPlayer.tsx', { './i18n': i18n, './api': {}, './Pose3DPlayer.css': {}, './components': { useData: () => ({ data: { jobId: job.id, value: pose3d }, loading: false }) } });
  const times = []; const onTime = value => times.push(value);
  runtime.render({ job, seekTime: null, resultsOnly: true, onTime });
  assert.doesNotMatch(renderToStaticMarkup(runtime.view), /<video|\/media/);
  const slider = elements(runtime.view).find(element => element.props['aria-label'] === '3D frame');
  slider.props.onChange({ target: { value: '1' } }); runtime.render(); assert.equal(times.at(-1), 12.1);
  const play = elements(runtime.view).find(element => element.type === 'button' && text(element) === 'Play');
  assert.ok(play); play.props.onClick(); runtime.render(); assert.equal(runtime.timers.size, 1);
  runtime.advance(1000); assert.equal(runtime.timers.size, 0); assert.equal(times.at(-1), 12.2);
  const local = runtime.render({ job, seekTime: null, resultsOnly: false, onTime });
  assert.match(renderToStaticMarkup(local), /<video/);
});

test('video details propagate results-only mode to saved 2D and 3D capabilities without processed media metadata', () => {
  const types = load('types.ts', { './i18n': i18n, './planningTypes': load('planningTypes.ts') });
  const player2d = function Player2D() {}, player3d = function Player3D() {};
  const jobs = [{ ...job, metadata: undefined }, { ...job, id: '3d-job', backend: 'pose3d', metadata: undefined, result: { kind: 'pose3d' } }];
  const data = { report: { video: { id: 'v', filename: 'source.mp4', size_bytes: 1024, category: 'mixed', media_location: 'local' }, jobs, events: [], drafts: [], review: null }, models: {} };
  const runtime = harness('pages/VideoDetail.tsx', { '../i18n': i18n, '../types': types, '../api': {}, '../components': { useData: () => ({ data }) }, '../PosePlayer': { default: player2d }, '../Pose3DPlayer': { default: player3d }, './CoachWorkspace.css': {}, ...Object.fromEntries(['ActionCandidates', 'ReviewPanel', 'EventsPanel', 'AnalysisAssessment', 'JointObservations'].map(name => [`./${name}`, {}])) });
  runtime.render({ id: 'v', initialJobId: job.id, notify() {} });
  let player = elements(runtime.view).find(element => element.type === player2d);
  assert.equal(player.props.resultsOnly, true); assert.equal(player.props.preferredMode, 'analysis');
  elements(runtime.view).find(element => element.props.role === 'tab' && text(element) === '3D').props.onClick(); runtime.render();
  player = elements(runtime.view).find(element => element.type === player3d);
  assert.ok(player); assert.equal(player.props.resultsOnly, true); assert.equal(player.props.job.id, '3d-job');
});
