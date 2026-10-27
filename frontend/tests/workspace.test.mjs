import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(relative, modules = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => modules[name] || (name.endsWith('.css') ? {} : ['../AnalysisOverview', './AnalysisAssessment', './JointObservations', '../Pose3DPlayer', './ActionCandidates'].includes(name) ? { default() {} } : require(name)), ...globals });
  return exports;
}
const hooks = {
  memo: component => component,
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect() {}, useRef: value => ({ current: value }), useCallback: fn => fn,
};
function locale() {
  return load('i18n.ts', {}, { window: { localStorage: { getItem: () => null, setItem() {} } } });
}
function elements(value) {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object') return [];
  return [value, ...elements(value.props?.children)];
}
function categoryTypes(i18n) {
  return load('types.ts', { './i18n': i18n, './planningTypes': load('planningTypes.ts') });
}

test('unverified local prose is archived while source-checked references remain visible', () => {
  const types=categoryTypes(locale());
  const local={provider:'llm',model:'Qwen/Qwen2.5-1.5B-Instruct',text:'An unsupported judgment'};
  assert.equal(types.reviewDraftVisible(local),false);
  assert.equal(types.reviewDraftVisible({...local,facts:{language_output:{method:'extractive-source-v1'}}}),true);
  assert.equal(types.reviewDraftVisible({provider:'rules'}),true);
  assert.equal(types.reviewDraftVisible({provider:'llm',model:'configured-remote-model'}),true);
  const checked={...local,text:'AI 原文参考（已记录观察，待核对）\n教练起初双手撑垫。',facts:{language_output:{method:'extractive-source-v1'}}};
  assert.equal(types.draftDisplayText(checked),'教练起初双手撑垫。');
  assert.match(checked.text,/^AI 原文参考/,'Raw source audit text is retained');
});
function textContent(value) {
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (value == null || typeof value === 'boolean') return '';
  return typeof value === 'object' ? textContent(value.props?.children) : String(value);
}
function expand(value) {
  if (Array.isArray(value)) return value.flatMap(expand);
  if (!value || typeof value !== 'object') return value;
  if (typeof value.type === 'function') return expand(value.type(value.props));
  return { ...value, props: { ...value.props, children: expand(value.props.children) } };
}

test('signing in configures the server workspace timezone before showing records', () => {
  for (const timezone of ['America/Los_Angeles', undefined]) {
    let index = 0; const steps = [];
    const react = { ...hooks, useState(value) { const position = index++; return [position === 1 ? false : typeof value === 'function' ? value() : value, next => { if (position === 0) steps.push(['auth', next.username]); }]; } };
    const i18n = locale();
    const app = load('App.tsx', {
      react, './i18n': { ...i18n, useLocale: () => ({ locale: i18n.getLocale(), setLocale: i18n.setLocale }) }, './api': { configureApi() {} }, './components': {}, './types': {},
      './planningTypes': { setWorkspaceTimezone: value => steps.push(['timezone', value]) },
      ...Object.fromEntries(['Dashboard', 'Athletes', 'Sessions', 'VideoLibrary', 'Upload', 'Models', 'VideoDetail', 'Planning', 'Insights'].map(page => [`./pages/${page}`, { default() {} }])),
    }, { window: { location: { hash: '' } } });
    // App returns its sign-in screen once the startup request finishes.
    const login = app.default();
    login.props.signedIn({ username: 'coach', csrf: 'test', timezone });
    assert.deepEqual(steps.slice(0, 2), [['timezone', timezone || 'Asia/Shanghai'], ['auth', 'coach']]);
  }
});

test('new review requests use the selected language while existing drafts stay original', async () => {
  const i18n = locale();
  for (const language of ['en', 'zh']) {
    i18n.setLocale(language);
    const requests = []; const updates = [];
    const react = { ...hooks, useState(value) { return [value, next => updates.push(next)]; } };
    const review = load('pages/ReviewPanel.tsx', {
      react, '../i18n': i18n, '../components': {}, '../types': { ...categoryTypes(i18n), dateTime: () => '' },
      '../api': { post: async (path, body) => { requests.push({ path, body }); return { id: 'new-draft' }; } },
    });
    const original = 'Existing 中文 coach draft';
    const panel = review.default({ videoId: 'video-1', job: { id: 'job-1', result: {} }, report: { review: null, drafts: [{ id: 'draft-1', provider: 'rules', text: original }] }, reload() {}, notify() {} });
    const buttons = elements(panel).filter(element => element.type === 'button');
    await buttons.find(button => button.props.className === 'button secondary small').props.onClick();
    assert.equal(requests[0].path, '/videos/video-1/review-drafts');
    assert.equal(requests[0].body.language, language);
    assert.equal(requests[0].body.job_id, 'job-1');
    buttons.find(button => button.props.className === 'text-link').props.onClick();
    assert.ok(updates.includes(original));
  }
});

test('completed training reviews lead with actual observations and preserve their review account without claiming coach confirmation', async () => {
  const i18n = locale();
  for (const [language, title, observationLabel, complete, reviewer] of [
    ['en', 'Training review', 'Review observations', 'Review complete', 'Reviewer'],
    ['zh', '训练复盘', '复盘观察', '复盘完成', '复盘账号'],
  ]) {
    i18n.setLocale(language);
    const requests = [];
    const report = { review: { observations: 'Actual observed balance recovery.', next_action: 'Repeat the entry.', confirmed: true, confirmed_by: 'admin', draft_id: null, updated_at: '2026-07-25T03:00:00Z' }, drafts: [] };
    const review = load('pages/ReviewPanel.tsx', {
      react: hooks, '../i18n': i18n, '../components': {}, '../types': { ...categoryTypes(i18n), dateTime: value => value },
      '../api': { put: async (path, body) => requests.push({ path, body }) },
    });
    const panel = review.default({ videoId: 'video-1', report, reload() {}, notify() {} });
    assert.equal(panel.props.title, title);
    const form = elements(panel).find(element => element.type === 'form');
    assert.ok(form);
    assert.match(textContent(form), new RegExp(observationLabel));
    assert.match(textContent(form), new RegExp(complete));
    assert.match(textContent(form), new RegExp(`${reviewer}.*admin`));
    assert.equal(elements(form).find(element => element.type === 'textarea').props.value, report.review.observations);
    assert.doesNotMatch(textContent(form), /Coach confirmed|教练已确认|AI辅助生成|留待人工确认|当前未关联分析草稿|Confirm.*method suitability/);
    const references = elements(panel).find(element => element.type === 'details');
    assert.ok(references, 'Reference drafts stay available in a collapsed control');
    assert.notEqual(references.props.open, true);
    assert.ok(elements(panel).indexOf(form) < elements(panel).indexOf(references), 'Actual review precedes reference tools');
    await form.props.onSubmit({ preventDefault() {} });
    assert.equal(requests[0].path, '/videos/video-1/review');
    assert.equal(requests[0].body.observations, report.review.observations);
    assert.equal(requests[0].body.confirmed, true);
    assert.equal(requests[0].body.draft_id, undefined);
  }
});

test('linked language-model review drafts retain their original text, provider and synthetic flags', () => {
  const i18n = locale();
  const draft = { id: 'draft-1', provider: 'llm', model: 'configured-model', synthetic: true, text: 'AI review draft (unconfirmed; check against the data and video)', created_at: '2026-07-25T03:00:00Z' };
  const review = load('pages/ReviewPanel.tsx', { react: hooks, '../i18n': i18n, '../components': {}, '../types': { ...categoryTypes(i18n), dateTime: value => value }, '../api': {} });
  const panel = review.default({ videoId: 'video-1', report: { review: { draft_id: draft.id, observations: 'Checked observation.', confirmed: true }, drafts: [draft] }, reload() {}, notify() {} });
  assert.match(textContent(panel), /Linked language model draft/);
  assert.match(textContent(panel), /configured-model/);
  assert.ok(elements(panel).some(element => element.type === 'pre' && textContent(element) === draft.text));
  assert.ok(elements(panel).some(element => element.props?.value === true));
});

test('mixed videos can be filtered and their category is localized', () => {
  const i18n = locale(); const types = categoryTypes(i18n);
  for (const [language, label] of [['en', 'Mixed training'], ['zh', '混合训练']]) {
    i18n.setLocale(language);
    const requests = [];
    const library = load('pages/VideoLibrary.tsx', {
      react: hooks, '../i18n': i18n, '../types': types,
      '../api': { api(path) { requests.push(path); return Promise.resolve([]); } },
      '../components': { useData(loader) { loader(); return { data: [], loading: false, error: '' }; } },
    }, { URLSearchParams });
    const view = library.default({ initialCategory: 'mixed' });
    assert.ok(requests.includes('/videos?category=mixed'));
    assert.ok(elements(view).some(element => element.type === 'button' && element.props.className === 'active' && textContent(element) === label));
    assert.equal(i18n.t(types.categories.mixed.description).match(/\p{Script=Han}/u) == null, language === 'en');
  }
});

test('video library and dashboard refresh active jobs, stop on terminal states and clean up on navigation', () => {
  const i18n = locale();
  for (const page of ['VideoLibrary', 'Dashboard']) {
    for (const [status, loading, error, expected] of [
      ['queued', false, '', 1], ['running', false, '', 1],
      ['completed', false, '', 0], ['needs_review', false, '', 0],
      ['failed', false, '', 0], ['blocked', false, '', 0],
      ['queued', true, '', 0], ['queued', false, 'Connection lost', 0],
    ]) {
      const job = { id: 'job-1', video_id: 'video-1', status, backend: 'rtmpose', created_at: '2026-07-25T03:00:00Z' };
      const video = { id: 'video-1', filename: 'training.mov', size_bytes: 1024, category: 'mixed', latest_job: job };
      const data = page === 'VideoLibrary' ? [video] : { category_counts: { mixed: 1 }, recent_jobs: [job], recorded_minutes: 180 };
      const effects = []; const timers = new Map(); const cleared = [];
      let calls = 0; let refreshes = 0;
      const component = load(`pages/${page}.tsx`, {
        react: { ...hooks, useEffect: effect => effects.push(effect) },
        '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {},
        '../components': { useData() {
          const primary = calls++ === (page === 'Dashboard' ? 0 : 1);
          return primary ? { data, loading, error, reload: () => refreshes++ }
            : { data: [], loading: false, error: '', reload() {} };
        } },
      }, { URLSearchParams, window: {
        setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
        clearTimeout(id) { cleared.push(id); timers.delete(id); },
      } });
      component.default({ initialCategory: 'mixed' });
      const cleanups = effects.map(effect => effect());
      assert.equal(timers.size, expected, `${page}: ${status}, loading=${loading}, error=${error}`);
      for (const callback of timers.values()) callback();
      assert.equal(refreshes, expected);
      cleanups.forEach(cleanup => cleanup?.());
      assert.equal(timers.size, 0, 'Leaving the page cancels pending refreshes');
      assert.equal(cleared.length, expected);
    }
  }
});

test('dashboard keeps four training cards and links mixed videos only when present', () => {
  const i18n = locale(); const types = categoryTypes(i18n);
  for (const count of [0, 69]) {
    let call = 0;
    const dashboard = load('pages/Dashboard.tsx', {
      react: hooks, '../i18n': i18n, '../types': types, '../api': {},
      '../components': { useData() { return { data: call++ === 0 ? { category_counts: { mixed: count }, recent_jobs: [], recorded_minutes: 0 } : {}, loading: false, error: '' }; } },
    });
    const view = dashboard.default();
    assert.equal(elements(view).filter(element => element.type === 'a' && element.props.className?.startsWith('category-row ')).length, 4);
    const links = elements(view).filter(element => element.type === 'a' && element.props.href === '#videos?category=mixed');
    assert.equal(links.length, count ? 1 : 0);
    if (count) assert.match(textContent(links[0]), /Mixed training.*69/);
  }
  const planning = load('pages/Planning.tsx', {
    react: { ...hooks, useState: value => [typeof value === 'boolean' ? true : value, () => {}] },
    '../i18n': i18n, '../types': types, '../planningTypes': load('planningTypes.ts'), '../api': {},
    '../components': { useData: () => ({ data: { athletes: [{ id: 'athlete-1', name: 'Athlete' }], plans: [] } }) },
  });
  const focus = elements(planning.default({ notify() {} })).find(element => element.type === 'select' && element.props.name === 'category');
  assert.deepEqual(elements(focus).filter(element => element.type === 'option').map(option => option.props.value), ['stability', 'footwork', 'attack', 'defense']);
});

test('dashboard uses the stored reviewed score mean and keeps pose checks separate when scores are absent', () => {
  const i18n = locale(); const types = categoryTypes(i18n);
  for (const [scores, expectedLabel, expectedValue, expectedText] of [
    [{ n: 70, mean: 7.943 }, 'Training score', 7.943, '7.9/10'],
    [{ n: 1, mean: 0 }, 'Training score', 0, '0.0/10'],
    [{ n: 0, mean: null }, 'Pose checks', 66, '66videos'],
    [undefined, 'Pose checks', 66, '66videos'],
  ]) {
    let call = 0;
    const data = { category_counts: {}, recent_jobs: [], recorded_minutes: 180, analysis: { video_count: 70, analyzed_videos: 70, needs_review: 66, frames: { total: 11080 } }, review_scores: scores };
    const dashboard = load('pages/Dashboard.tsx', {
      react: hooks, '../i18n': i18n, '../types': types, '../api': {},
      '../components': { useData() { return { data: call++ === 0 ? data : {}, loading: false, error: '' }; } },
    });
    const view = dashboard.default();
    const stats = elements(view).filter(element => typeof element.type === 'function' && element.props?.label);
    assert.equal(stats.length, 4);
    assert.deepEqual(stats.map(element => element.props.value), [180, 70, expectedValue, 11080]);
    assert.equal(stats[2].props.label, expectedLabel);
    assert.equal(stats[2].props.href, '#insights');
    assert.match(textContent(stats[2].type(stats[2].props)), new RegExp(expectedText.replace('.', '\\.')));
    assert.equal(data.analysis.needs_review, 66);
  }
});

test('technical analysis states use neutral data-check labels in both languages', () => {
  const i18n = locale(); const types = categoryTypes(i18n);
  const components = load('components.tsx', { './i18n': i18n, './types': types });
  for (const [language, expected] of [['en', 'Analysis checks needed'], ['zh', '数据待核查']]) {
    i18n.setLocale(language);
    const status = components.Status({ value: 'needs_review' });
    assert.equal(textContent(status), expected);
    assert.equal(status.props.className, 'status warning');
  }
});

test('closed measurement assessments replace pending badges without changing the source job state', () => {
  const i18n = locale();
  const components = load('components.tsx', { './i18n': i18n, './types': categoryTypes(i18n) });
  assert.equal(typeof components.JobStatus, 'function', 'Job badges account for the persisted assessment');
  for (const [language, excluded, accepted, superseded, pending] of [
    ['en', 'Not adopted', 'Reviewed · experimental', 'Superseded', 'Analysis checks needed'],
    ['zh', '本次不采纳', '已核查·实验性', '已有后续分析', '数据待核查'],
  ]) {
    i18n.setLocale(language);
    const source = { id: 'source-pose', backend: 'rtmpose', status: 'needs_review', result: { synthetic: false, needs_review: true }, assessment: { decision: 'excluded' } };
    const before = JSON.stringify(source);
    assert.equal(textContent(expand(components.JobStatus({ job: source }))), excluded);
    assert.equal(components.JobStatus({ job: source }).props.className, 'status neutral');
    assert.equal(JSON.stringify(source), before, 'Closing an assessment preserves raw status and quality');
    for (const status of ['completed', 'needs_review']) {
      for (const [decision, label, tone] of [['accepted', accepted, 'success'], ['superseded', superseded, 'neutral'], ['pending', pending, 'warning']]) {
        const job = { ...source, status, assessment: { decision } };
        const badge = expand(components.JobStatus({ job }));
        assert.equal(textContent(badge), label);
        assert.equal(badge.props.className, `status ${tone}`);
      }
    }
    for (const status of ['queued', 'running', 'failed', 'blocked']) {
      assert.equal(textContent(expand(components.JobStatus({ job: { ...source, status } }))), textContent(components.Status({ value: status })));
    }
  }
});

test('video browsing reports available track data while detailed assessment keeps its decision', () => {
  const i18n=locale();const components=load('components.tsx',{'./i18n':i18n,'./types':categoryTypes(i18n)});
  const job={backend:'rtmpose_tracking',status:'needs_review',assessment:{decision:'excluded'},result:{kinematics:{tracks:[{track_id:1}]}}};
  assert.equal(textContent(expand(components.JobStatus({job,showAssessment:false}))),'Track data ready');
  assert.equal(textContent(expand(components.JobStatus({job}))),'Not adopted');
  assert.equal(job.status,'needs_review');
});

test('measurement assessment saves the selected source decision and role while displaying actual account history', async () => {
  const i18n = locale(); const types = categoryTypes(i18n);
  const current = { id: 'assessment-1', job_id: 'source-pose', decision: 'accepted', subject_role: 'athlete', reason: 'Usable measurements checked against the video.', reviewer: 'admin', updated_at: '2026-10-27T01:00:00Z' };
  const historical = { ...current, decision: 'excluded', subject_role: 'coach', reason: 'A coaching demonstration.', reviewer: 'reviewer-old', updated_at: '2026-10-26T01:00:00Z' };
  let data = { current, history: [{ id: 'history-1', job_id: 'source-pose', snapshot: historical, created_at: historical.updated_at }] };
  let cursor = 0; const values = []; const effectDependencies = []; const requests = []; let reloads = 0; let historyReloads = 0;
  const react = {
    ...hooks,
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; },
    useEffect(effect, dependencies) { const index = cursor++; if (!effectDependencies[index] || dependencies.some((value, at) => !Object.is(value, effectDependencies[index][at]))) { effectDependencies[index] = dependencies; effect(); } },
  };
  const client = load('api.ts', {}, { Headers, FormData, fetch: async (path, options) => {
    requests.push({ path, options });
    return { ok: true, status: 200, json: async () => options.method === 'PUT' ? { ...current, ...JSON.parse(options.body), updated_at: '2026-10-27T02:00:00Z' } : data };
  } });
  client.configureApi('assessment-csrf');
  const assessment = load('pages/AnalysisAssessment.tsx', {
    react, '../i18n': i18n, '../types': types, '../api': client,
    '../components': { useData(loader) { if (!requests.length) void loader(); return { data, loading: false, error: '', setData(update) { data = typeof update === 'function' ? update(data) : update; }, reload() { historyReloads++; } }; } },
  });
  const source = { id: 'source-pose', backend: 'rtmpose', status: 'needs_review', result: { synthetic: false, metrics: {} }, assessment: current };
  const render = (job = source) => { cursor = 0; return assessment.default({ job, reload() { reloads++; }, notify() {} }); };
  let view = render();
  assert.equal(view.props.title, 'Measurement assessment');
  assert.match(textContent(view), /Reviewer.*admin/);
  assert.doesNotMatch(textContent(view), /Coach approved|Coach confirmed|AI.*pending|教练已确认|AI.*待确认/);
  const history = elements(view).find(element => element.type === 'details');
  assert.ok(history);
  assert.notEqual(history.props.open, true);
  assert.match(textContent(history), /A coaching demonstration\..*reviewer-old/);
  assert.ok(elements(history).some(element => element.type === 'time' && element.props.dateTime === historical.updated_at));
  assert.equal(elements(view).find(element => element.props?.name === 'decision').props.value, 'accepted');
  assert.equal(elements(view).find(element => element.props?.name === 'subject_role').props.value, 'athlete');
  elements(view).find(element => element.props?.name === 'decision').props.onChange({ target: { value: 'excluded' } });
  elements(view).find(element => element.props?.name === 'subject_role').props.onChange({ target: { value: 'coach' } });
  elements(view).find(element => element.props?.name === 'reason').props.onChange({ target: { value: '  Only a coaching demonstration.  ' } });
  i18n.setLocale('zh'); view = render();
  assert.equal(view.props.title, '测量处理');
  assert.equal(elements(view).find(element => element.props?.name === 'reason').props.value, '  Only a coaching demonstration.  ', 'Changing language preserves unsaved input');
  await elements(view).find(element => element.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(requests[0].path, '/api/jobs/source-pose/assessment');
  const save = requests.find(request => request.options.method === 'PUT');
  assert.equal(save.path, '/api/jobs/source-pose/assessment');
  assert.deepEqual(JSON.parse(save.options.body), { decision: 'excluded', subject_role: 'coach', reason: 'Only a coaching demonstration.' });
  assert.equal(save.options.headers.get('X-CSRF-Token'), 'assessment-csrf');
  assert.equal(reloads, 1);
  assert.equal(historyReloads, 1);
  assert.equal(data.current.reviewer, 'admin');
  view = render();
  elements(view).find(element => element.props?.name === 'reason').props.onChange({ target: { value: ' ' } }); view = render();
  await elements(view).find(element => element.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(requests.filter(request => request.options.method === 'PUT').length, 1, 'A closed decision requires a reason');
  elements(view).find(element => element.props?.name === 'decision').props.onChange({ target: { value: 'pending' } }); view = render();
  await elements(view).find(element => element.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(requests.filter(request => request.options.method === 'PUT')[1].options.body), { decision: 'pending', subject_role: 'coach', reason: '' }, 'Reopening remains an explicit decision');
  data = { current: null, history: [] }; values.length = 0; effectDependencies.length = 0; view = render();
  assert.equal(elements(view).find(element => element.props?.name === 'decision').props.value, 'pending');
  assert.equal(elements(view).find(element => element.props?.name === 'subject_role').props.value, 'unknown');
  for (const job of [{ ...source, result: null }, { ...source, status: 'running' }, { ...source, backend: 'sample', result: { synthetic: true } }]) assert.equal(render(job), null);
});

test('manual category saves PATCH the video and update details, while failures retain current data', async () => {
  const i18n = locale(); const types = categoryTypes(i18n);
  for (const fails of [false, true]) {
    const requests = []; const notices = [];
    const video = { id: 'video-1', category: 'defense', filename: 'training.mov', size_bytes: 1024 };
    let data = { report: { video, jobs: [], events: [], drafts: [], review: null }, models: {} };
    const client = load('api.ts', {}, { Headers, FormData, fetch: async (path, options) => {
      requests.push({ path, options });
      return fails ? { ok: false, status: 500, json: async () => ({ detail: 'Save failed.' }) } : { ok: true, status: 200, json: async () => ({ ...video, category: 'attack' }) };
    } });
    const detail = load('pages/VideoDetail.tsx', {
      react: hooks, '../i18n': i18n, '../types': types, '../api': client,
      '../components': { useData: () => ({ data, setData: update => { data = update(data); } }) },
      '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {},
    }, { FormData: class extends FormData { constructor(form) { super(); this.set('category', form.category); } } });
    const view = detail.default({ id: video.id, notify: (message, kind) => notices.push({ message, kind }) });
    const form = elements(view).find(element => element.type === 'form' && elements(element).some(child => child.type === 'select' && child.props.name === 'category'));
    assert.ok(form, 'A category form is available on video details');
    const select = elements(form).find(element => element.type === 'select');
    assert.equal(select.props.defaultValue, 'defense');
    assert.equal(elements(select).filter(element => element.type === 'option').length, 5);
    await form.props.onSubmit({ preventDefault() {}, currentTarget: { category: 'attack' } });
    assert.equal(requests[0].path, '/api/videos/video-1/category');
    assert.equal(requests[0].options.method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[0].options.body), { category: 'attack' });
    assert.equal(data.report.video.category, fails ? 'defense' : 'attack');
    assert.equal(notices[0].kind, fails ? 'error' : 'success');
  }
});

test('manual scores start empty and reject missing, out-of-range scores or confirmation without comment', async () => {
  const i18n = locale(); const requests = [];
  const data = { report: { video: { id: 'video-1', category: 'mixed', filename: 'training.mov', size_bytes: 1024 }, jobs: [], events: [], drafts: [], review: null, score: null, score_history: [] }, models: {} };
  const detail = load('pages/VideoDetail.tsx', {
    react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n),
    '../api': { put: async (...args) => requests.push(args) },
    '../components': { useData: () => ({ data }) }, '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {},
  }, { FormData: class extends FormData { constructor(form) { super(); for (const [key, value] of Object.entries(form)) this.set(key, value); } } });
  const view = detail.default({ id: 'video-1', notify() {} });
  const form = elements(view).find(element => element.type === 'form' && elements(element).some(child => child.type === 'input' && child.props.name === 'score'));
  assert.ok(form, 'Video details provide a training score form');
  assert.ok(elements(view).some(element => element.props?.title === 'Training score'));
  assert.ok(elements(form).some(element => element.props?.label === 'Review comment'));
  assert.match(textContent(form), /Reviewed/);
  assert.doesNotMatch(textContent(form), /Coach comment|Confirmed by coach/);
  assert.equal(elements(form).find(element => element.props?.name === 'score').props.defaultValue, '');
  assert.equal(elements(form).find(element => element.props?.name === 'comment').props.defaultValue, '');
  assert.equal(elements(form).find(element => element.props?.name === 'confirmed').props.defaultChecked, false);
  for (const value of [{ score: '' }, { score: '-1' }, { score: '11' }, { score: 'NaN' }, { score: '7', comment: '  ', confirmed: 'on' }]) {
    await form.props.onSubmit({ preventDefault() {}, currentTarget: value });
  }
  assert.equal(requests.length, 0);
});

test('manual scores save actual input and preserve current score after a failed save', async () => {
  const i18n = locale(); const types = categoryTypes(i18n);
  for (const [rawScore, actualScore, comment, confirmed, fails] of [
    ['7.5', 7.5, 'Observed balance recovery.', true, false],
    ['0', 0, '', false, false],
    ['7.5', 7.5, 'Observed balance recovery.', true, true],
  ]) {
    const requests = []; const notices = []; let reloads = 0;
    const video = { id: 'video-1', category: 'mixed', filename: 'training.mov', size_bytes: 1024 };
    const score = { id: 'score-1', video_id: video.id, score: actualScore, comment, confirmed, assessor: 'coach', rubric_version: 'coach-review-10-v1', updated_at: '2026-07-25T03:00:00Z' };
    const previous = fails ? { ...score, score: 6, comment: 'Earlier observation.', confirmed: false, updated_at: '2026-07-25T02:00:00Z' } : null;
    let data = { report: { video, jobs: [], events: [], drafts: [], review: null, score: previous, score_history: [] }, models: {} };
    const client = load('api.ts', {}, { Headers, FormData, fetch: async (path, options) => {
      requests.push({ path, options });
      return fails ? { ok: false, status: 500, json: async () => ({ detail: 'Save failed.' }) } : { ok: true, status: 200, json: async () => score };
    } });
    const detail = load('pages/VideoDetail.tsx', {
      react: hooks, '../i18n': i18n, '../types': types, '../api': client,
      '../components': { useData: () => ({ data, reload() { reloads++; }, setData: update => { data = update(data); } }) },
      '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {},
    }, { FormData: class extends FormData { constructor(form) { super(); for (const [key, value] of Object.entries(form)) this.set(key, value); } } });
    const view = detail.default({ id: video.id, notify: (message, kind) => notices.push({ message, kind }) });
    const form = elements(view).find(element => element.type === 'form' && elements(element).some(child => child.type === 'input' && child.props.name === 'score'));
    assert.ok(form);
    await form.props.onSubmit({ preventDefault() {}, currentTarget: { score: rawScore, comment: `  ${comment}  `, ...(confirmed ? { confirmed: 'on' } : {}) } });
    assert.equal(requests[0].path, '/api/videos/video-1/score');
    assert.equal(requests[0].options.method, 'PUT');
    assert.deepEqual(JSON.parse(requests[0].options.body), { score: actualScore, comment, confirmed });
    assert.equal(data.report.score, fails ? previous : score);
    assert.equal(reloads, fails ? 0 : 1);
    assert.equal(notices[0].kind, fails ? 'error' : 'success');
  }
});

test('training score history retains original comments, account, timestamps and historical rubric versions', () => {
  const i18n = locale();
  const score = { id: 'score-1', video_id: 'video-1', score: 7.5, comment: 'Actual coach observation.', confirmed: true, assessor: 'coach-lee', rubric_version: 'coach-review-10-v1', updated_at: '2026-07-25T03:00:00Z' };
  const data = { report: { video: { id: 'video-1', category: 'mixed', filename: 'training.mov', size_bytes: 1024 }, jobs: [], events: [], drafts: [], review: null, score, score_history: [{ id: 'history-1', video_id: 'video-1', snapshot: score, created_at: '2026-07-25T03:00:00Z' }] }, models: {} };
  const detail = load('pages/VideoDetail.tsx', {
    react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {},
    '../components': { useData: () => ({ data }) }, '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {},
  });
  const view = detail.default({ id: 'video-1', notify() {} });
  const history = elements(view).find(element => element.type === 'details' && textContent(element).includes('Score history'));
  assert.ok(history);
  assert.notEqual(history.props.open, true);
  assert.match(textContent(history), /Actual coach observation\./);
  assert.match(textContent(history), /coach-lee/);
  assert.match(textContent(history), /Reviewer/);
  assert.match(textContent(history), /Reviewed/);
  assert.doesNotMatch(textContent(history), /Coach|Confirmed/);
  assert.match(textContent(history), /coach-review-10-v1/);
  assert.ok(elements(history).some(element => element.type === 'time' && element.props.dateTime === '2026-07-25T03:00:00Z'));
});

test('Insights displays reviewed training score statistics without turning missing values into zero', () => {
  const i18n = locale(); const calendar = load('planningTypes.ts');
  for (const [scores, expected] of [
    [{ n: 0, mean: null, median: null, q1: null, q3: null }, ['0', '—', '—', '—', '—']],
    [{ n: 2, mean: 7.5, median: 7.5, q1: 7, q3: 8 }, ['2', '7.5', '7.5', '7', '8']],
  ]) {
    let call = 0;
    const data = { filters: { start: calendar.localDate(-55), end: calendar.localDate(), athlete_id: null }, summary: {}, planning: {}, weekly: [], statistics: { duration_min: { n: 0 }, rpe: { n: 0 } }, category_counts: {}, manual_scores: scores };
    const insights = load('pages/Insights.tsx', {
      react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../planningTypes': calendar, '../api': {},
      '../components': { useData: () => ({ data: call++ === 0 ? data : [], loading: false, error: '' }) },
    }, { URLSearchParams });
    const view = expand(insights.default());
    const panel = elements(view).find(element => element.props?.title === 'Reviewed training scores / 10');
    assert.ok(panel);
    assert.deepEqual(elements(panel).filter(element => element.type === 'td').map(textContent), expected);
  }
});

test('Insights leads with completed reviews and exact approved score distribution before technical analysis', () => {
  const calendar = load('planningTypes.ts');
  for (const [language, reviewLabel, meanLabel, scoredLabel, minutesLabel, chartLabel, categoryLabel] of [
    ['en', 'Reviews complete', 'Mean training score', 'Scored videos', 'Training / min', 'Reviewed score distribution', 'Scores by category'],
    ['zh', '复盘完成', '平均训练评分', '已评分视频', '训练 / 分钟', '已审核评分分布', '专项评分'],
  ]) {
    const i18n = locale(); i18n.setLocale(language); let call = 0;
    const data = {
      filters: { start: '2026-07-25', end: '2026-07-25', athlete_id: null },
      summary: { session_count: 1, total_minutes: 180, reviewed_videos: 70, video_count: 70, load_au: null },
      planning: {}, weekly: [], statistics: { duration_min: { n: 1 }, rpe: { n: 0 } }, category_counts: { mixed: 70 },
      manual_scores: { n: 65, mean: 8.076923076923077, median: 8, q1: 8, q3: 8,
        distribution: [{ score: 7, n: 11 }, { score: 8, n: 38 }, { score: 9, n: 16 }],
        by_category: { mixed: { n: 65, mean: 8.076923076923077 } } },
      analysis: { video_count: 70, analyzed_videos: 70 },
    };
    const insights = load('pages/Insights.tsx', {
      react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../planningTypes': calendar, '../api': {},
      '../components': { useData: () => ({ data: call++ === 0 ? data : [], loading: false, error: '' }) },
    }, { URLSearchParams });
    const view = insights.default();
    const original = elements(view);
    const training = original.find(element => element.props?.summary === data.summary && element.props?.scores === data.manual_scores);
    const technical = original.find(element => element.props?.data === data.analysis);
    assert.ok(training, 'Training results are visible as the first report section');
    assert.ok(original.indexOf(training) < original.indexOf(technical));
    const rendered = expand(training);
    const kpis = elements(rendered).find(element => element.props.className === 'analytics-kpis');
    assert.deepEqual(Array.from(kpis.props.children, textContent), [`${reviewLabel}70 / 70`, `${meanLabel}8.1 / 10`, `${scoredLabel}65`, `${minutesLabel}180`]);
    const chart = elements(rendered).find(element => element.props.role === 'img' && element.props['aria-label']?.startsWith(chartLabel));
    assert.ok(chart);
    assert.match(chart.props['aria-label'], /7: 11.*8: 38.*9: 16/);
    const bars = elements(chart).filter(element => element.props.className === 'training-score-bar');
    assert.equal(bars.length, 3);
    assert.equal(bars[1].props.style.width, '100%');
    const category = elements(rendered).find(element => element.props?.title === categoryLabel);
    assert.match(textContent(category), /658\.1/);
    assert.ok(elements(category).some(element => element.type === 'a' && element.props.href === '#videos?category=mixed'));
    assert.doesNotMatch(textContent(rendered), /Grade|Improvement|Coach confirmed/);
  }
});

test('Insights charts retain exact decimal and zero scores, and leave unobserved categories empty', () => {
  const calendar = load('planningTypes.ts'); const i18n = locale();
  for (const [scores, hasChart] of [
    [{ n: 3, mean: 5.125, median: 7.25, q1: 3.625, q3: 7.6875, distribution: [{ score: 0, n: 1 }, { score: 7.25, n: 1 }, { score: 8.125, n: 1 }], by_category: { mixed: { n: 1, mean: 0 }, attack: { n: 2, mean: 7.6875 } } }, true],
    [{ n: 0, mean: null, median: null, q1: null, q3: null, distribution: [], by_category: {} }, false],
  ]) {
    let call = 0;
    const data = { filters: { start: '2026-07-25', end: '2026-07-25', athlete_id: null }, summary: { video_count: 6, reviewed_videos: 6, total_minutes: 180 }, planning: {}, weekly: [], statistics: { duration_min: { n: 1 }, rpe: { n: 0 } }, category_counts: {}, manual_scores: scores };
    const insights = load('pages/Insights.tsx', {
      react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../planningTypes': calendar, '../api': {},
      '../components': { useData: () => ({ data: call++ === 0 ? data : [], loading: false, error: '' }) },
    }, { URLSearchParams });
    const view = expand(insights.default());
    const chart = elements(view).find(element => element.props.role === 'img' && element.props['aria-label']?.startsWith('Reviewed score distribution'));
    assert.equal(Boolean(chart), hasChart);
    const category = elements(view).find(element => element.props?.title === 'Scores by category');
    assert.ok(category);
    const links = elements(category).filter(element => element.type === 'a');
    assert.deepEqual(links.map(element => element.props.href).sort(), hasChart ? ['#videos?category=attack', '#videos?category=mixed'] : []);
    if (hasChart) {
      assert.match(chart.props['aria-label'], /0: 1.*7\.25: 1.*8\.125: 1/);
      assert.match(textContent(chart), /8\.125/);
      assert.match(textContent(category), /Mixed training10/);
    } else {
      assert.match(textContent(view), /No reviewed scores/);
      assert.doesNotMatch(textContent(category), /0\.0|NaN|Infinity/);
    }
  }
});

test('Insights initially requests recorded history and displays server dates with batch analysis', () => {
  const i18n = locale(); const requests = []; let call = 0;
  const analysis = { video_count: 70, analyzed_videos: 70 };
  const data = { filters: { start: '2026-07-25', end: '2026-10-27', athlete_id: null }, summary: {}, planning: {}, weekly: [], statistics: { duration_min: { n: 1 }, rpe: { n: 0 } }, category_counts: { mixed: 70 }, manual_scores: { n: 0 }, analysis };
  const insights = load('pages/Insights.tsx', {
    react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../planningTypes': load('planningTypes.ts'),
    '../api': { api: path => { requests.push(path); return Promise.resolve([]); } },
    '../components': { useData(loader) { loader(); return { data: call++ === 0 ? data : [] }; } },
  }, { URLSearchParams });
  const view = insights.default();
  assert.equal(requests[0], '/insights', 'No recent-only window hides imported history');
  const inputs = elements(view).filter(element => element.type === 'input');
  assert.equal(inputs.find(element => element.props.name === 'start').props.defaultValue, '2026-07-25');
  assert.equal(inputs.find(element => element.props.name === 'end').props.defaultValue, '2026-10-27');
  assert.ok(elements(view).some(element => element.props?.data === analysis));
  const header = elements(view).find(element => element.props?.title === 'Insights');
  assert.ok(elements(header.props.action).some(element => element.type === 'a' && element.props.href?.startsWith('/api/insights/analyses.csv?start=2026-07-25')));
});

test('athlete profiles open the first recorded athlete and include available batch analysis', () => {
  const i18n = locale(); let call = 0;
  const analysis = { video_count: 70, analyzed_videos: 70 };
  const data = { athlete: { name: '001', created_at: '2026-07-25T03:00:00Z' }, sessions: [], video_count: 70, recorded_minutes: 180, recorded_load: null, trends: [], analysis };
  const athletes = load('pages/Athletes.tsx', {
    react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {},
    '../components': { useData: () => ({ data: call++ === 0 ? [{ id: 'athlete-1', name: '001' }] : data }) },
  });
  const view = athletes.default({ notify() {} });
  const profile = elements(view).find(element => typeof element.type === 'function' && element.props.id === 'athlete-1');
  assert.ok(profile, 'Existing athlete profile opens without an extra selection');
  assert.ok(elements(profile.type(profile.props)).some(element => element.props?.data === analysis));
});

test('source deep links select the stored analysis attempt instead of a newer different backend', () => {
  const i18n = locale(); const real = { id: 'real-job', backend: 'rtmpose', status: 'completed' };
  const data = { report: { video: { id: 'video-1', category: 'mixed', filename: 'training.mov', size_bytes: 1024 }, jobs: [{ id: 'newer-sample', backend: 'sample', status: 'completed' }, real], events: [], drafts: [], review: null }, models: {} };
  const player = function PosePlayer() {};
  const assessment = function AnalysisAssessment() {};
  const detail = load('pages/VideoDetail.tsx', {
    react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {},
    '../components': { useData: () => ({ data }) }, '../PosePlayer': { default: player }, './ReviewPanel': {}, './EventsPanel': {}, './AnalysisAssessment': { default: assessment },
  });
  const view = detail.default({ id: 'video-1', initialJobId: 'real-job', notify() {} });
  assert.equal(elements(view).find(element => element.type === player).props.job, real);
  const measurementPanel = elements(view).find(element => element.type === assessment);
  assert.equal(measurementPanel.props.job, real);
  assert.equal(measurementPanel.key, 'real-job');
  assert.ok(elements(view).indexOf(measurementPanel) > elements(view).findIndex(element => element.props?.title === 'Training score'), 'Coach scoring precedes advanced measurement controls');
});

test('athlete load stays unknown without recorded RPE and preserves actual zero load', () => {
  const i18n = locale();
  for (const [recorded_load, rpe, expected] of [[null, 5, '—'], [0, null, '—'], [0, 0, '0'], [150, 5, '150']]) {
    let call = 0; let hook = 0;
    const data = { athlete: { name: 'Athlete', created_at: '2026-07-25T03:00:00Z' }, sessions: [{ id: 'session-1', rpe }], video_count: 1, recorded_minutes: 30, recorded_load, trends: [] };
    const athletes = load('pages/Athletes.tsx', {
      react: { ...hooks, useState(value) { return [hook++ === 0 ? 'athlete-1' : value, () => {}]; } },
      '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {},
      '../components': { useData: () => ({ data: call++ === 0 ? [] : data }) },
    });
    const view = athletes.default({ notify() {} });
    const profile = elements(view).find(element => typeof element.type === 'function' && element.props.id === 'athlete-1');
    const stats = elements(profile.type(profile.props)).find(element => element.props?.className === 'profile-stats');
    assert.equal(textContent(elements(stats).filter(element => element.type === 'strong')[3]), expected);
  }
});

test('model capability status shows actual processed video and track totals in both languages', () => {
  const i18n=locale();
  for (const language of ['en','zh']) {
    i18n.setLocale(language);
    const data={tracking:{ready:true,reason:'',processed_jobs:4,processed_videos:3,track_count:12},rtmpose:{ready:true,reason:'',processed_jobs:70,processed_videos:70}};
    const models=load('pages/Models.tsx',{react:hooks,'../i18n':i18n,'../api':{},'../types':categoryTypes(i18n),'../components':{useData:()=>({data,loading:false,error:null,reload(){}})}});
    const view=models.default();
    assert.match(textContent(view), /3.*12/);
    assert.match(textContent(view), /70/);
    assert.doesNotMatch(textContent(view), /undefined|NaN/);
  }
});

test('tracked pose playback fetches stored poses and labels stable track IDs rather than frame order', () => {
  const i18n=locale();const requests=[];let hook=0;
  const points=Array.from({length:17},(_,i)=>[10+i,20+i,.9]);
  const pose={width:320,height:240,synthetic:false,frames:[{t:.2,people:[{track_id:8,bbox:[60,10,100,110],keypoints:points},{track_id:2,bbox:[10,10,40,110],keypoints:points}]}]};
  const player=load('PosePlayer.tsx',{'./i18n':i18n,react:{...hooks,useState:v=>[hook++===0?'analysis':hook===2?.2:typeof v==='function'?v():v,()=>{}]},'./api':{api:async path=>{requests.push(path);return pose;}},'./components':{useData:fn=>{fn();return {data:{jobId:'tracked',value:pose}};}}});
  const view=player.default({videoId:'v',job:{id:'tracked',backend:'rtmpose_tracking',metadata:{},result:{metrics:{}}},seekTime:null,onTime(){}});
  assert.deepEqual(requests,['/jobs/tracked/pose']);
  const labels=elements(view).filter(e=>e.type==='text').map(e=>textContent(e));
  assert.ok(labels.some(t=>/8/.test(t)));assert.ok(labels.some(t=>/2/.test(t)));
  assert.ok(elements(view).filter(e=>e.type==='rect').length>=2);
});

test('focusing a track submits the exact stored source job and explicit selected ID', async () => {
  const calls=[];const i18n=locale();
  const component=load('pages/VideoDetail.tsx',{react:hooks,'../i18n':i18n,'../api':{},'../components':{},'../types':categoryTypes(i18n),'../PosePlayer':{},'./ReviewPanel':{},'./EventsPanel':{}},{FormData:class {get(name){return name==='target_track_id'?'8':null;}}});
  const view=component.TrackFocus({job:{id:'stored-tracks',backend:'rtmpose_tracking',result:{tracking:{tracks:[{track_id:8,observed_frames:25}]}}},busy:false,start:async body=>calls.push(body)});
  const form=elements(view).find(e=>e.type==='form');assert.ok(form);
  await form.props.onSubmit({preventDefault(){},currentTarget:{}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].backend,'rtmpose_tracking');assert.equal(calls[0].source_pose_job_id,'stored-tracks');assert.equal(calls[0].target_track_id,8);
});

test('SAM2 playback loads actual saved polygons and renders a mask without pose or score inference', () => {
  const i18n=locale();const requests=[];let hook=0;
  const masks={width:320,height:240,frames:[{t:.2,masks:[{object_id:1,polygons:[[[10,10],[80,10],[70,100]]]}]}]};
  const player=load('PosePlayer.tsx',{'./i18n':i18n,react:{...hooks,useState:v=>[hook++===0?'analysis':hook===2?.2:typeof v==='function'?v():v,()=>{}]},'./api':{api:async path=>{requests.push(path);return masks;}},'./components':{useData:fn=>{fn();return {data:{jobId:'segmented',value:masks}};}}});
  const view=player.default({videoId:'v',job:{id:'segmented',backend:'sam2',metadata:{},result:{kind:'segmentation',segmentation:{segmented_frames:1,total_frames:1,object_count:1}}},seekTime:null,onTime(){}});
  assert.deepEqual(requests,['/jobs/segmented/segmentation']);
  const polygons=elements(view).filter(e=>e.type==='polygon');assert.equal(polygons.length,1);assert.equal(polygons[0].props.points,'10,10 80,10 70,100');
});

test('switching between delayed or failed same-type jobs never overlays the previous job payload', async () => {
  const i18n=locale();
  for (const backend of ['rtmpose_tracking','sam2']) {
    let hook=0;let previous=null;let phase='old';const loads=[];
    const old=backend==='sam2'?{width:320,height:240,frames:[{t:0,masks:[{object_id:1,polygons:[[[1,1],[3,1],[3,3]]]}]}]}:{width:320,height:240,frames:[{t:0,people:[{track_id:1,bbox:[0,0,10,10],keypoints:Array.from({length:17},()=>[1,1,.9])}]}]};
    const player=load('PosePlayer.tsx',{'./i18n':i18n,react:{...hooks,useState:v=>[hook++===0?'analysis':typeof v==='function'?v():v,()=>{}]},'./api':{api:path=>path.includes('old-job')?Promise.resolve(old):new Promise(()=>{})},'./components':{useData:fn=>{loads.push(fn());return {data:previous,error:phase==='failed'?'network error':'',loading:phase==='new'};}}});
    const render=id=>{hook=0;return player.default({videoId:'v',job:{id,backend,metadata:{},result:backend==='sam2'?{kind:'segmentation'}:{metrics:{}}},seekTime:null,onTime(){}});};
    render('old-job');previous=await loads[backend==='sam2'?1:0];
    assert.ok(previous,'use the previous real loader result, including its source identity');
    for (phase of ['new','failed']) {
      const view=render('new-job');
      assert.equal(elements(view).filter(e=>e.type==='svg').length,0,'old payload must not be rendered on new media');
    }
  }
});

test('dashboard exposes all six connected analysis capabilities with real readiness', () => {
  const i18n=locale();let call=0;
  const dashboard=load('pages/Dashboard.tsx',{react:hooks,'../i18n':i18n,'../types':categoryTypes(i18n),'../api':{},'../components':{useData(){return {data:call++===0?{category_counts:{},recent_jobs:[],recorded_minutes:180}:{rtmpose:{ready:true},tracking:{ready:true},sam2:{ready:true},action:{ready:true},pose3d:{ready:false},llm:{ready:true}},loading:false,error:''};}}});
  const links=elements(dashboard.default()).filter(e=>e.type==='a' && e.props.className==='studio-method');
  assert.equal(links.length,6);
  assert.deepEqual(links.map(link=>link.props.title),['RTMPose','ByteTrack','SAM2','Qwen3-VL-2B-Instruct','MotionBERT Lite','Review language model']);
  assert.ok(links.filter((_,index)=>index!==4).every(link=>textContent(link).includes('Available')));
  assert.match(textContent(links[3]), /Qwen3-VL/); assert.match(textContent(links[4]), /MotionBERT.*Not ready/); assert.match(textContent(links[5]), /Review language model/);
});


test('joint observation lines break at missing values and skipped samples', () => {
  const component = load('pages/JointObservations.tsx', { react: hooks, '../i18n': locale(), '../components': {}, './JointObservations.css': {} });
  const segments = component.jointSegments([
    { t: 0, left_knee: 0 }, { t: 0.1, left_knee: 72 },
    { t: 0.2, left_knee: null }, { t: 0.3, left_knee: 81 },
    { t: 0.4 }, { t: 0.5, left_knee: 90 }, { t: 0.8, left_knee: 95 },
    { t: 1.101, left_knee: 100 }, { t: 1.2, left_knee: Number.NaN },
    { t: 1.3, left_knee: 110 },
  ], 'left_knee');
  assert.deepEqual(JSON.parse(JSON.stringify(segments)), [
    [{ t: 0, value: 0 }, { t: 0.1, value: 72 }],
    [{ t: 0.3, value: 81 }],
    [{ t: 0.5, value: 90 }], [{ t: 0.8, value: 95 }],
    [{ t: 1.101, value: 100 }], [{ t: 1.3, value: 110 }],
  ]);
});

test('a missing 10 Hz sample is never interpolated as an observed joint path', () => {
  const component = load('pages/JointObservations.tsx', { react: hooks, '../i18n': locale(), '../components': {}, './JointObservations.css': {} });
  const points=[{t:0,left_knee:90},{t:0.2,left_knee:90}];
  assert.equal(component.jointSegments(points,'left_knee',10).length,2);
  assert.equal(component.jointSegments(points,'left_knee',5).length,1,'Adjacent 5 Hz samples remain connected');
});

test('joint observations show stored T IDs and measured summaries and seek exact source samples', () => {
  const i18n = locale(); const calls = [];
  const summary = { n: 3, min: 0, median: 74.25, max: 112.5 };
  const empty = { n: 0, min: null, median: null, max: null };
  const track = { track_id: 8, n_samples: 4, first_t: 0.125, last_t: 0.575,
    joints: { left_knee: summary, right_knee: empty, left_elbow: summary, right_elbow: empty, trunk_lean: summary },
    series: [{ t: 0.125, left_knee: 0, left_elbow: 21 }, { t: 0.225, left_knee: null, left_elbow: 23 }, { t: 0.475, left_knee: 74.25, left_elbow: null }, { t: 0.575, left_knee: 112.5, left_elbow: 31 }] };
  const job = { id: 'joint-job', metadata: { time_offset: 12 }, result: { kinematics: { method_version: 'joint-angles-2d-v1', experimental: true, unit: 'deg', tracks: [track, { ...track, track_id: 2, series: [{ t: 0.125, left_knee: 53 }] }] } } };
  let stateIndex = 0; const state = [];
  const react = { ...hooks, useState(initial) { const index = stateIndex++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], next => { state[index] = next; }]; } };
  const component = load('pages/JointObservations.tsx', { react, '../i18n': i18n, '../components': {}, './JointObservations.css': {} });
  const render = () => { stateIndex = 0; return component.default({ job, onSeek: time => calls.push(time) }); };
  for (const [language, title, badge, trackLabel, jointLabel] of [['en', 'Joint observations', 'Experimental', 'Track', 'Joint'], ['zh', '关节观测', '实验性', '轨迹', '关节']]) {
    i18n.setLocale(language);
    let view = render();
    assert.equal(view.props.title, title);
    assert.equal(textContent(view.props.action), badge);
    const selectors = elements(view).filter(element => element.type === 'select');
    assert.equal(selectors[0].props['aria-label'], trackLabel);
    assert.equal(selectors[1].props['aria-label'], jointLabel);
    assert.deepEqual(elements(selectors[0]).filter(element => element.type === 'option').map(element => textContent(element)), ['T8', 'T2']);
    const rows = elements(view).filter(element => element.type === 'tr');
    assert.match(textContent(rows[1]), /374.3°0.0–112.5°/);
    assert.match(textContent(rows[2]), /0——/);
    assert.doesNotMatch(textContent(view), /Athlete ID|运动员编号|Normal range|正常范围|Ability|能力评分/);
    const points = elements(view).filter(element => element.props['data-source-time'] != null);
    assert.deepEqual(points.map(element => element.props['data-source-time']), [12.125, 12.475, 12.575]);
    points[2].props.onClick({ stopPropagation() {} });
    assert.equal(calls.at(-1), 12.575, 'Click uses the unrounded stored timestamp plus clip offset');
    const paths = elements(view).filter(element => element.type === 'path' && element.props.className === 'joint-line');
    assert.equal(paths.length, 1, 'Only the final two consecutive observations form a line');
    assert.ok(!paths[0].props.d.startsWith('M60.00,'), 'The first point stays disconnected across the null observation');
    const chart = elements(view).find(element => element.props.role === 'slider');
    chart.props.onClick({ clientX: 780, currentTarget: { getBoundingClientRect: () => ({ left: 100, width: 720 }) } });
    assert.equal(calls.at(-1), 12.575, 'Touching the chart seeks the nearest actual sample');
    chart.props.onKeyDown({ key: 'Home', preventDefault() {} });
    assert.equal(calls.at(-1), 12.125);
    selectors[0].props.onChange({ target: { value: '2' } });
    view = render();
    assert.equal(elements(view).find(element => element.type === 'select').props.value, 2);
    assert.equal(elements(view).filter(element => element.props['data-source-time'] != null).length, 1);
    elements(view).find(element => element.type === 'select').props.onChange({ target: { value: '8' } });
    view = render();
    elements(view).filter(element => element.type === 'select')[1].props.onChange({ target: { value: 'right_knee' } });
    view = render();
    assert.equal(elements(view).filter(element => element.type === 'svg').length, 0, 'An unobserved joint has no invented chart points');
    elements(view).filter(element => element.type === 'select')[1].props.onChange({ target: { value: 'left_knee' } });
  }
  assert.equal(component.default({ job: { result: null }, onSeek() {} }), null);
  assert.equal(component.default({ job: { result: { kinematics: { tracks: [] } } }, onSeek() {} }), null);
});

test('video details connect joint observations to original source playback and prefer the best ready analysis method', () => {
  const i18n = locale(); const jointPanel = function JointObservations() {};
  for (const [models, expected] of [[{ rtmpose_tracking: { ready: true }, rtmpose: { ready: true } }, 'rtmpose_tracking'], [{ rtmpose_tracking: { ready: false }, rtmpose: { ready: true } }, 'rtmpose'], [{ preprocessing: { ready: true } }, 'preprocess']]) {
    const values = []; let hook = 0;
    const job = { id: 'actual-joint-job', backend: 'rtmpose_tracking', result: { kinematics: { tracks: [] } } };
    const data = { report: { video: { id: 'v', category: 'mixed', filename: 'video.mov', size_bytes: 1024 }, jobs: [job], events: [], drafts: [], review: null }, models };
    const component = load('pages/VideoDetail.tsx', {
      react: { ...hooks, useState(initial) { const position = hook++; return [typeof initial === 'function' ? initial() : initial, value => values.push([position, value])]; } },
      '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {}, '../components': { useData: () => ({ data }) },
      '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {}, './JointObservations': { default: jointPanel },
    });
    const view = component.default({ id: 'v', initialJobId: job.id, notify() {} });
    const observations = elements(view).find(element => element.type === jointPanel);
    assert.equal(observations.props.job, job);
    observations.props.onSeek(12.575);
    assert.equal(values.at(-1)[1], 12.575);
    const form = elements(view).find(element => typeof element.type === 'function' && element.type.name === 'AnalysisForm');
    const rendered = form.type(form.props);
    assert.equal(elements(rendered).find(element => element.type === 'select').props.value, expected);
  }
});


test('capability tabs open the latest stored matching output directly and preserve exact source deep links until a choice', () => {
  const i18n = locale(); const player = function PosePlayer() {};
  const jobs = [
    { id: 'actual-action', backend: 'action', status: 'needs_review', result: { kind: 'recognition', windows: [] } },
    { id: 'actual-3d', backend: 'pose3d', status: 'needs_review', metadata: {}, result: { kind: 'pose3d' } },
    { id: 'legacy-wham', backend: 'wham', status: 'blocked', result: null },
    { id: 'tracking-running', backend: 'rtmpose_tracking', status: 'running', result: null },
    { id: 'mask-result', backend: 'sam2', status: 'completed', metadata: {}, result: { kind: 'segmentation', segmentation: { segmented_frames: 7, total_frames: 8, object_count: 2 } } },
    { id: 'tracking-result', backend: 'rtmpose_tracking', status: 'needs_review', metadata: {}, result: { metrics: {}, tracking: { track_count: 2, tracks: [{ track_id: 8, observed_frames: 21 }, { track_id: 2, observed_frames: 17 }] } } },
    { id: 'pose-result', backend: 'rtmpose', status: 'completed', metadata: {}, result: { metrics: {} } },
    { id: 'exact-old-pose', backend: 'rtmpose', status: 'completed', metadata: {}, result: { metrics: {} } },
  ];
  let index = 0; const values = [];
  const react = { ...hooks, useState(initial) { const position = index++; if (!(position in values)) values[position] = typeof initial === 'function' ? initial() : initial; return [values[position], value => { values[position] = typeof value === 'function' ? value(values[position]) : value; }]; } };
  let data = { report: { video: { id: 'v', filename: 'Actual source.mov', category: 'mixed', size_bytes: 1024 }, jobs, events: [], drafts: [], review: null }, models: {} };
  const detail = load('pages/VideoDetail.tsx', { react, '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {}, '../components': { useData: () => ({ data }) }, '../PosePlayer': { default: player }, './ReviewPanel': {}, './EventsPanel': {} });
  const render = () => { index = 0; return detail.default({ id: 'v', initialJobId: 'exact-old-pose', notify() {} }); };
  let view = render();
  assert.equal(elements(view).find(element => element.type === player).props.job.id, 'exact-old-pose');
  assert.equal(elements(view).find(element => element.type === player).props.preferredMode, 'analysis');
  assert.equal(elements(view).filter(element => element.props.role === 'tab').length, 7);
  const click = name => elements(view).find(element => element.props.role === 'tab' && textContent(element).startsWith(name)).props.onClick();
  elements(view).find(element => typeof element.props.seek === 'function').props.seek(3.5);
  view = render();
  click('Tracking'); view = render();
  assert.equal(elements(view).find(element => element.type === player).props.seekTime, null, 'A prior source seek cannot switch a newly chosen capability back to original playback');
  assert.equal(elements(view).find(element => element.type === player).props.job.id, 'tracking-result');
  assert.equal(elements(view).find(element => element.type === player).props.preferredMode, 'analysis');
  data = { ...data, report: { ...data.report, jobs: [{ id: 'new-pose', backend: 'rtmpose', status: 'completed', result: { metrics: {} } }, ...jobs] } };
  view = render();
  assert.equal(elements(view).find(element => element.type === player).props.job.id, 'tracking-result', 'Polling does not replace an explicit capability choice');
  click('Masks'); view = render();
  assert.equal(elements(view).find(element => element.type === player).props.job.id, 'mask-result');
  click('Action analysis'); view = render();
  assert.equal(elements(view).find(element => element.type === player).props.job.id, 'actual-action');
  click('3D'); view = render();
  const skeleton = elements(view).find(element => element.props.job?.id === 'actual-3d' && element.props.onTime);
  assert.ok(skeleton, '3D capability opens the stored pose3d viewer');
  assert.notEqual(skeleton.type, player, 'Learned 3D output has its own orbit viewer');
  click('Original'); view = render();
  assert.equal(elements(view).find(element => element.type === player).props.preferredMode, 'original');
  const advanced = elements(view).find(element => element.type === 'details' && element.props.className === 'coach-advanced');
  assert.ok(advanced); assert.notEqual(advanced.props.open, true);
  const score = elements(view).find(element => element.props.title === 'Training score');
  assert.ok(elements(view).indexOf(score) < elements(view).indexOf(advanced));
});

test('capability actions run the requested real backend once and disclose unavailable dependencies', async () => {
  const i18n = locale(); const requests = [];
  const component = load('pages/VideoDetail.tsx', { react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {}, '../components': {}, '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {} });
  for (const [capability, backend, label] of [['tracking', 'rtmpose_tracking', 'Run tracking'], ['masks', 'sam2', 'Generate masks'], ['techniques', 'action', 'Analyze actions'], ['3d', 'pose3d', 'View 3D skeleton']]) {
    const panel = component.CapabilityPanel({ capability, models: { [backend]: { ready: true } }, busy: false, onRun: async value => requests.push(value) });
    const button = elements(panel).find(element => element.type === 'button');
    assert.equal(textContent(button), label);
    await button.props.onClick();
    assert.equal(requests.at(-1).backend, backend);
    const active = component.CapabilityPanel({ capability, models: { [backend]: { ready: true } }, busy: false, runningJob: { id: 'active', backend: 'rtmpose', status: 'running', progress: .3, stage: 'Processing frames' }, onRun() { throw new Error('must not run'); } });
    assert.ok(elements(active).filter(element => element.type === 'button').every(element => element.props.disabled));
    assert.match(textContent(active), /30%/);
  }
  for (const [capability, expected] of [['techniques', 'Model unavailable'], ['3d', 'Model unavailable']]) {
    const panel = component.CapabilityPanel({ capability, models: {}, busy: false, onRun() {} });
    assert.match(textContent(panel), new RegExp(expected));
    assert.ok(elements(panel).some(element => element.type === 'a' && element.props.href === '#models'));
    assert.equal(elements(panel).filter(element => element.type === 'button' && !element.props.disabled).length, 0);
  }
});

test('preferred player mode opens saved tracking and masks immediately and is reapplied on a source change', () => {
  const i18n = locale();
  for (const backend of ['rtmpose_tracking', 'sam2']) {
    const effects = []; const changes = [];
    const player = load('PosePlayer.tsx', { react: { ...hooks, useEffect: fn => effects.push(fn), useState(initial) { return [typeof initial === 'function' ? initial() : initial, value => changes.push(value)]; } }, './i18n': i18n, './api': {}, './components': { useData: () => ({ data: null }) } });
    const view = player.default({ videoId: 'v', job: { id: 'stored', backend, metadata: {}, result: backend === 'sam2' ? { kind: 'segmentation' } : { metrics: {} } }, preferredMode: 'analysis', showModeControls: false, seekTime: null, onTime() {} });
    assert.equal(elements(view).find(element => element.type === 'video').props.src, '/api/jobs/stored/media');
    effects[0]();
    assert.ok(changes.includes('analysis'), 'Changing the job retains the requested analysis mode');
    assert.equal(elements(view).filter(element => element.type === 'button').length, 0, 'Top-level tabs replace nested mode buttons');
  }
});


test('top-level AI review generates from the selected real source and preserves the completed human review', async () => {
  const i18n = locale(); const calls = []; let index = 0; const values = [];
  const storedReview = { observations: 'Actual confirmed balance recovery.', next_action: 'Repeat the entry.', confirmed: true, updated_at: '2026-07-25T03:00:00Z' };
  const realJob = { id: 'real-pose-source', backend: 'rtmpose', status: 'needs_review', metadata: {}, result: { metrics: {}, synthetic: false } };
  const data = { report: { video: { id: 'v', filename: 'Source.mov', category: 'mixed', size_bytes: 1024 }, jobs: [realJob], events: [], drafts: [{ id: 'stored-ai', provider: 'llm', model: 'Actual configured model', text: 'Stored evidence-based draft.' }], review: storedReview }, models: { llm: { ready: true } } };
  const detail = load('pages/VideoDetail.tsx', {
    react: { ...hooks, useState(initial) { const position = index++; if (!(position in values)) values[position] = typeof initial === 'function' ? initial() : initial; return [values[position], value => { values[position] = typeof value === 'function' ? value(values[position]) : value; }]; } },
    '../i18n': i18n, '../types': categoryTypes(i18n), '../api': { post: async (path, body) => { calls.push({ path, body }); return { id: 'new-ai', provider: 'llm', model: 'Actual configured model', text: 'New source-grounded draft.' }; } },
    '../components': { useData: () => ({ data, reload() {} }) }, '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {},
  });
  const render = () => { index = 0; return detail.default({ id: 'v', initialJobId: realJob.id, notify() {} }); };
  let view = render();
  elements(view).find(element => element.props.role === 'tab' && textContent(element) === 'AI review').props.onClick();
  view = render();
  assert.ok(elements(view).some(element => element.type === 'pre' && textContent(element) === 'Stored evidence-based draft.'));
  await elements(view).find(element => element.type === 'button' && textContent(element) === 'Generate AI review').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ path: '/videos/v/review-drafts', body: { job_id: 'real-pose-source', provider: 'llm', language: 'en' } }]);
  view = render();
  assert.ok(elements(view).some(element => element.type === 'pre' && textContent(element) === 'New source-grounded draft.'));
  assert.equal(data.report.review, storedReview);
  assert.equal(data.report.review.confirmed, true);
  assert.equal(data.report.review.observations, 'Actual confirmed balance recovery.');
});

test('track trails keep exact box centers separate by ID and inside the past two seconds', () => {
  const player = load('PosePlayer.tsx', { react: hooks, './i18n': locale(), './api': {}, './components': {} });
  const person = (track_id, x, y) => ({ track_id, bbox: [x, y, x + 10, y + 20], keypoints: [] });
  const frames = Array.from({ length: 25 }, (_, index) => ({ t: index / 10, people: [person(8, index, index * 2), person(2, 100 + index, 50), person(null, 900, 900)] }));
  const trails = player.trackTrails({ frames }, 2.2, 10);
  assert.equal(trails.length, 2);
  assert.deepEqual(Array.from(trails, trail => trail.track_id), [8, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(trails[0].points)), Array.from({ length: 21 }, (_, index) => [index + 7, index * 2 + 14]));
  assert.deepEqual(JSON.parse(JSON.stringify(trails[1].points)), Array.from({ length: 21 }, (_, index) => [index + 107, 60]));
  assert.ok(trails.every(trail => trail.points.length === 21), 'Future observations and points older than two seconds stay outside the trail');
});

test('track trails break at one missing 10 Hz observation, missing source frames and invalid boxes', () => {
  const player = load('PosePlayer.tsx', { react: hooks, './i18n': locale(), './api': {}, './components': {} });
  const person = x => ({ track_id: 8, bbox: [x, 0, x + 10, 20], keypoints: [] });
  const frames = [
    { t: 0, people: [person(0)] }, { t: .1, people: [person(1)] },
    { t: .2, people: [{ ...person(200), track_id: 2 }] },
    { t: .3, people: [person(3)] }, { t: .4, people: [person(4)] },
    { t: .6, people: [person(6)] }, { t: .7, people: [person(7)] },
    { t: .8, people: [{ ...person(8), bbox: [Number.NaN, 0, 30, 20] }] },
    { t: .9, people: [person(9)] }, { t: 1, people: [person(10)] },
  ];
  const trails = player.trackTrails({ frames }, 1, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(trails)), [
    { track_id: 8, points: [[5, 10], [6, 10]] },
    { track_id: 8, points: [[8, 10], [9, 10]] },
    { track_id: 8, points: [[11, 10], [12, 10]] },
    { track_id: 8, points: [[14, 10], [15, 10]] },
  ]);
});

test('tracking playback displays stored motion trails with stable ID colors and a working independent toggle', () => {
  const i18n = locale(); let index = 0; const values = [];
  const person = (track_id, x) => ({ track_id, bbox: [x, 10, x + 20, 50], keypoints: [] });
  const pose = { width: 320, height: 240, frames: [{ t: .1, people: [person(8, 10), person(3, 110)] }, { t: .2, people: [person(8, 20), person(3, 120)] }] };
  const react = { ...hooks, useState(initial) { const position = index++; if (!(position in values)) values[position] = position === 0 ? 'analysis' : position === 1 ? .2 : typeof initial === 'function' ? initial() : initial; return [values[position], value => { values[position] = value; }]; } };
  const player = load('PosePlayer.tsx', { react, './i18n': i18n, './api': {}, './components': { useData: () => ({ data: { jobId: 'actual-tracks', value: pose } }) } });
  const render = backend => { index = 0; return player.default({ videoId: 'v', job: { id: 'actual-tracks', backend, metadata: {}, result: { metrics: {}, sample_fps: 10 } }, seekTime: null, onTime() {} }); };
  let view = render('rtmpose_tracking');
  let trails = elements(view).filter(element => element.type === 'polyline');
  assert.deepEqual(trails.map(element => element.props.points), ['20,30 30,30', '120,30 130,30']);
  assert.deepEqual(trails.map(element => element.props.stroke), ['#ffb94f', '#27efbd']);
  const toggle = elements(view).find(element => element.type === 'label' && textContent(element) === 'Track trails');
  assert.ok(toggle); assert.equal(elements(toggle).find(element => element.type === 'input').props.checked, true);
  assert.equal(toggle.props.title, 'Image-plane box centers');
  elements(toggle).find(element => element.type === 'input').props.onChange({ target: { checked: false } });
  view = render('rtmpose_tracking');
  assert.equal(elements(view).filter(element => element.type === 'polyline').length, 0);
  assert.ok(elements(view).some(element => element.type === 'rect'), 'Turning trails off retains current boxes and T IDs');
  assert.equal(elements(render('rtmpose')).filter(element => element.type === 'polyline').length, 0, 'Untracked pose mode has no trajectory claim');
});


test('3D capability reuses a real tracked source and can lift all tracks without selecting an identity', async () => {
  const i18n = locale(); const requests = [];
  const component = load('pages/VideoDetail.tsx', { react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {}, '../components': {}, '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {} });
  const panel = component.CapabilityPanel({ capability: '3d', models: { pose3d: { ready: true } }, busy: false, sourcePoseJob: { id: 'actual-tracked-source', backend: 'rtmpose_tracking', result: { tracking: { tracks: [{ track_id: 8 }, { track_id: 3 }] } } }, onRun: async value => requests.push(value) });
  await elements(panel).find(element => element.type === 'button').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ backend: 'pose3d', source_pose_job_id: 'actual-tracked-source' }]);
});

test('action candidates preserve source PTS and save an edited event only after human action', async () => {
  const i18n = locale(); const calls = []; let index = 0; const values = [];
  const react = { ...hooks, useState(initial) { const position = index++; if (!(position in values)) values[position] = typeof initial === 'function' ? initial() : initial; return [values[position], next => { values[position] = next; }]; } };
  const component = load('pages/ActionCandidates.tsx', { react, '../i18n': i18n, '../api': { post: async (path, body) => calls.push({ path, body }) }, '../types': categoryTypes(i18n), '../components': {} });
  const window = { start_sec: .1234, end_sec: 3.3456, source_frame_times_sec: [9.1234, 10.4567, 12.3456], candidate_label: 'Original label', candidates: [{ id: 'entry', label: 'Original label', similarity: .23456 }, { id: 'other', label: 'Other', similarity: .12 }] };
  const original = JSON.stringify(window);
  const props = { videoId: 'v', job: { id: 'actual-action', backend: 'action', result: { kind: 'recognition', windows: [window] } }, reload() {}, notify() {}, onSeek() {} };
  const render = () => { index = 0; return component.CandidateWindow({ ...props, window }); };
  let view = render();
  assert.equal(calls.length, 0);
  assert.match(textContent(view), /0.235/); assert.doesNotMatch(textContent(view), /23.5%/);
  elements(view).find(element => element.type === 'input' && element.props.name === 'label').props.onChange({ target: { value: 'Coach edited label' } });
  view = render();
  await elements(view).find(element => element.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ path: '/videos/v/events', body: { start_sec: 9.1234, end_sec: 12.3456, label: 'Coach edited label', actor: 'unknown', outcome: '', notes: '', source_job_id: 'actual-action' } }]);
  assert.equal(JSON.stringify(window), original, 'Model candidates remain unchanged');
});

test('3D projection uses learned depth, keeps exact frame times and rejects stale job artifacts', () => {
  const component = load('Pose3DPlayer.tsx', { react: hooks, './i18n': locale(), './api': {}, './components': {} });
  const front = component.projectJoint([1, 0, 0], 0, 0, 1);
  const depth = component.projectJoint([1, 0, 1], 0, 0, 1);
  assert.notEqual(front[0], depth[0], 'Perspective uses z, not a 2D fallback');
  const rotated = component.projectJoint([0, 0, 1], 90, 0, 1);
  assert.ok(Math.abs(rotated[0] - 320) > 1);
  assert.equal(component.projectJoint([1, 2], 0, 0, 1), null);
  const value = { kind: 'pose3d', synthetic: false, layout: 'h36m17', frames: [{ t: .034, people: [] }, { t: .137, people: [] }] };
  assert.equal(component.pose3DForJob({ jobId: 'A', value }, 'B'), null);
  assert.equal(component.pose3DForJob({ jobId: 'A', value }, 'A'), value);
  assert.equal(component.nearestPose3DFrame(value.frames, .12).t, .137);
});

test('3D player renders stored learned joints for the selected track, seeks exact source PTS and hides stale or failed payloads', async () => {
  const i18n = locale(); const times = []; let index = 0; const values = [];
  const react = { ...hooks, useMemo: fn => fn(), useState(initial) { const position = index++; if (!(position in values)) values[position] = position === 0 ? .137 : typeof initial === 'function' ? initial() : initial; return [values[position], next => { values[position] = next; }]; } };
  const joints = shift => Array.from({ length: 17 }, (_, n) => [n / 17 + shift, -n / 17, n / 34]);
  const pose = { kind: 'pose3d', synthetic: false, layout: 'h36m17', coordinates: 'root_relative_model_space', unit: 'model_units', frames: [{ t: .034, people: [{ track_id: 8, joints: joints(0) }] }, { t: .137, people: [{ track_id: 8, joints: joints(0) }, { track_id: 2, joints: joints(.2) }] }] };
  let data = { jobId: 'actual-3d', value: pose }; let error = ''; let loader; const requests = [];
  const component = load('Pose3DPlayer.tsx', { react, './i18n': i18n, './api': { api: async path => { requests.push(path); return pose; } }, './components': { useData(fn) { loader = fn; return { data, error }; } } });
  let job = { id: 'actual-3d', metadata: { time_offset: 9.5 }, result: { kind: 'pose3d', sample_fps: 10 } };
  const render = () => { index = 0; return component.default({ job, seekTime: null, onTime: value => times.push(value) }); };
  let view = render();
  const loaded = await loader();
  assert.equal(loaded.jobId, job.id); assert.deepEqual(requests, ['/jobs/actual-3d/pose3d']);
  assert.equal(elements(view).filter(element => element.type === 'line').length, 16);
  assert.equal(elements(view).filter(element => element.type === 'circle').length, 17);
  assert.equal(elements(view).find(element => element.type === 'video').props.src, '/api/jobs/actual-3d/media');
  const trackSelect = elements(view).find(element => element.type === 'select');
  assert.deepEqual(elements(trackSelect).filter(element => element.type === 'option').map(element => textContent(element)), ['T2', 'T8']);
  const firstPoint = elements(view).find(element => element.type === 'circle').props.cx;
  trackSelect.props.onChange({ target: { value: '8' } });
  view = render();
  assert.notEqual(elements(view).find(element => element.type === 'circle').props.cx, firstPoint);
  elements(view).find(element => element.props['aria-label'] === '3D frame').props.onChange({ target: { value: '0' } });
  assert.equal(times.at(-1), 9.534);
  view = render();
  assert.match(textContent(view), /9\.534/);
  const beforeOrbit = elements(view).find(element => element.type === 'circle' && element.props.cy !== 220).props.cx;
  elements(view).find(element => element.props['aria-label'] === 'Azimuth').props.onChange({ target: { value: '90' } });
  view = render();
  assert.notEqual(elements(view).find(element => element.type === 'circle' && element.props.cy !== 220).props.cx, beforeOrbit);
  job = { ...job, id: 'new-3d' }; view = render();
  assert.equal(elements(view).filter(element => element.type === 'circle').length, 0, 'A loading new job cannot display the previous artifact');
  error = 'Request failed'; view = render();
  assert.equal(elements(view).filter(element => element.type === 'circle').length, 0, 'A failed new job cannot display the previous artifact');
  assert.match(textContent(view), /Request failed/);
  data = null;
});


test('visual action observations and unconfirmed hypotheses have no invented ranking or confidence', () => {
  const i18n = locale();
  const component = load('pages/ActionCandidates.tsx', { react: hooks, '../i18n': i18n, '../api': {}, '../types': categoryTypes(i18n), '../components': {} });
  const window = { start_sec: 0, end_sec: 1, source_frame_times_sec: [7.034, 8.137], visual_description: 'Person raises both arms while standing.', category_ids: ['standing', 'arms_raised'], candidates: [{ id: 'standing', label: 'Standing' }, { id: 'arms_raised', label: 'Arms raised' }, { id: 'movement', label: 'Moving' }, { id: 'contact', label: 'No person contact' }], wrestling_hypothesis: { id: 'entry', label: 'Possible entry', validated: false } };
  const props = { videoId: 'v', job: { id: 'real-qwen3-vl', result: { windows: [window] } }, window, reload() {}, notify() {}, onSeek() {} };
  const view = component.CandidateWindow(props);
  assert.doesNotMatch(textContent(view), /Person raises both arms while standing/);
  assert.match(textContent(view), /Unconfirmed hypothesis.*Possible entry/);
  assert.match(textContent(view), /Standing.*Arms raised.*Moving.*No person contact/);
  assert.doesNotMatch(textContent(view), /Cosine|similarity|confidence|%|—|0\.000/i);
  assert.equal(elements(view).filter(element => element.type === 'ol').length, 0);
  const noHypothesis = component.CandidateWindow({ ...props, window: { ...window, wrestling_hypothesis: null } });
  assert.doesNotMatch(textContent(noHypothesis), /Unconfirmed hypothesis|Possible entry/);
  const panel = component.default(props);
  assert.match(textContent(panel), /Qwen3-VL/); assert.doesNotMatch(textContent(panel), /X-CLIP/);
  const method = elements(panel).find(element => element.type === 'details');
  assert.ok(method); assert.notEqual(method.props.open, true);
  assert.match(textContent(method), /Person raises both arms while standing/);
  assert.equal(i18n.t(categoryTypes(i18n).backendNames.action), 'Qwen3-VL · Action analysis');
});

test('persisted events link to their exact source analysis without exposing source UUIDs', () => {
  const i18n = locale();
  const component = load('pages/EventsPanel.tsx', { react: hooks, '../i18n': i18n, '../api': {}, '../types': categoryTypes(i18n), '../components': {} });
  const source = 'f3dc10cf-25c7-4248-9dd0-ff5d239780bd';
  const view = component.default({ videoId: 'video with spaces', events: [{ id: 'from-model', start_sec: 7.034, end_sec: 8.137, label: 'Reviewed action', actor: 'unknown', outcome: '', notes: '', source_job_id: source }, { id: 'manual', start_sec: 10, end_sec: 11, label: 'Manual action', actor: 'athlete', outcome: '', notes: '' }], ready: true, currentTime: 0, seek() {}, reload() {}, notify() {} });
  const links = elements(view).filter(element => element.type === 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].props.href, `#videos/video%20with%20spaces?job=${source}`);
  assert.equal(textContent(links[0]), 'View analysis source');
  assert.ok(!textContent(view).includes(source));
  assert.deepEqual(elements(view).filter(element => element.props.className === 'actor-label').map(textContent), ['Athlete']);
});

test('fixed model taxonomy and evidence localize while saved event labels remain unchanged', () => {
  const i18n = locale();
  const component = load('pages/ActionCandidates.tsx', { react: hooks, '../i18n': i18n, '../api': {}, '../types': categoryTypes(i18n), '../components': {} });
  const window = { start_sec: 0, end_sec: 1, source_frame_times_sec: [0, 1], category_id: 'wrestling_pair', category_ids: ['wrestling_pair'], evidence_id: 'people_in_contact', candidates: [{ id: 'wrestling_pair', label: '双人摔跤 / 对练' }], candidate_label: '双人摔跤 / 对练', visual_description: '画面可见两人身体接触或相互控制', wrestling_hypothesis: { id: 'single_leg_tackle', label: '抱单腿摔候选', validated: false } };
  const props = { videoId: 'v', job: { id: 'actual-vl', result: { windows: [window], limitations: '视觉模型生成的动作候选，需人工确认；具体摔跤技术仅为未验证假设。不能据此判定攻防身份、胜负或运动能力。' } }, window, reload() {}, notify() {}, onSeek() {} };
  const panel = component.CandidateWindow(props);
  assert.match(textContent(panel), /Wrestling pair \/ practice/);
  assert.doesNotMatch(textContent(panel), /Two people are visibly in physical contact or controlling each other/);
  assert.match(textContent(component.default(props)), /Two people are visibly in physical contact or controlling each other/);
  assert.match(textContent(panel), /Single leg tackle candidate/);
  assert.doesNotMatch(textContent(panel), /\p{Script=Han}/u);
  assert.doesNotThrow(() => component.default(props), 'Historical string limitations remain readable');
  const events = load('pages/EventsPanel.tsx', { react: hooks, '../i18n': i18n, '../api': {}, '../types': categoryTypes(i18n), '../components': {} });
  const view = events.default({ videoId: 'v', events: [{ id: 'manual', start_sec: 0, end_sec: 1, label: '双人摔跤 / 对练', actor: 'unknown', outcome: '', notes: '' }], ready: true, currentTime: 0, seek() {}, reload() {}, notify() {} });
  assert.match(textContent(view), /双人摔跤 \/ 对练/, 'Human event text stays verbatim');
});

test('3D side panel displays only returned frame, track and person observation counts', () => {
  const i18n = locale();
  const component = load('pages/VideoDetail.tsx', { react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {}, '../components': {}, '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {} });
  const panel = component.CapabilityPanel({ capability: '3d', job: { result: { kind: 'pose3d', pose3d: { frame_count: 131, track_ids: [2, 8], person_observation_count: 247 } } }, models: {}, busy: false, onRun() {} });
  assert.match(textContent(panel), /Frames.*131/); assert.match(textContent(panel), /Tracks.*2/); assert.match(textContent(panel), /Person observations.*247/);
});

test('persisted candidate events prevent duplicate submission after reload and preserve the recorded human name', () => {
  const i18n = locale(); const scrolled = [];
  const component = load('pages/ActionCandidates.tsx', { react: hooks, '../i18n': i18n, '../api': {}, '../types': categoryTypes(i18n), '../components': {} }, { document: { getElementById: id => ({ scrollIntoView: () => scrolled.push(id) }) } });
  const window = { start_sec: 0, end_sec: 1, source_frame_times_sec: [9.034, 10.137], candidates: [{ id: 'bodyweight', label: '徒手体能 / 热身' }], candidate_label: '徒手体能 / 热身' };
  const event = { id: 'saved', source_job_id: 'actual-vl', start_sec: 9.034, end_sec: 10.137, label: '教练记录的实际名称' };
  const props = { videoId: 'v', job: { id: 'actual-vl' }, window, events: [event], reload() {}, notify() {}, onSeek() {} };
  const view = component.CandidateWindow(props);
  assert.equal(elements(view).filter(element => element.type === 'form').length, 0);
  assert.match(textContent(view), /教练记录的实际名称/);
  const button = elements(view).find(element => element.type === 'button' && textContent(element) === 'View timeline');
  assert.ok(button); button.props.onClick(); assert.deepEqual(scrolled, ['event-timeline']);
  for (const changed of [{ ...event, source_job_id: 'other' }, { ...event, start_sec: 1, end_sec: 2 }]) {
    assert.ok(elements(component.CandidateWindow({ ...props, events: [changed] })).some(element => element.type === 'form'));
  }
});

test('summary job status names real action candidates without changing advanced assessments', () => {
  const i18n = locale();
  const component = load('components.tsx', { react: hooks, './i18n': i18n, './types': categoryTypes(i18n) });
  const base = { backend: 'action', status: 'needs_review', result: { kind: 'recognition', synthetic: false, windows: [{ source_frame_times_sec: [0, 1] }] }, assessment: { decision: 'pending' } };
  const render = (job, showAssessment) => expand(component.JobStatus({ job, showAssessment }));
  assert.equal(textContent(render(base, false)), 'Action candidates ready');
  assert.equal(textContent(render(base, true)), i18n.t('数据待核查'));
  for (const changed of [{ ...base, status: 'running' }, { ...base, result: { ...base.result, synthetic: true } }, { ...base, result: { ...base.result, windows: [] } }]) assert.notEqual(textContent(render(changed, false)), 'Action candidates ready');
  i18n.setLocale('zh'); assert.equal(textContent(render(base, false)), '动作候选已生成');
});

test('research models are collapsed separately from available production capabilities', () => {
  const i18n = locale(); const data = Object.fromEntries(Object.keys(categoryTypes(i18n).modelNames).map(key => [key, { ready: !['fsw', 'wham'].includes(key), reason: key }]));
  const component = load('pages/Models.tsx', { react: hooks, '../i18n': i18n, '../api': {}, '../types': categoryTypes(i18n), '../components': { useData: () => ({ data, loading: false, error: '', reload() {} }) } });
  const view = component.default(); const research = elements(view).find(element => element.type === 'details');
  assert.ok(research); assert.notEqual(research.props.open, true); assert.match(textContent(research), /Research extensions/);
  for (const name of ['FSW-Net', 'WHAM', 'Synthetic sample']) assert.match(textContent(research), new RegExp(name));
  const main = elements(view).find(element => element.props.title === i18n.t('分析能力'));
  assert.ok(main); assert.match(textContent(main), /Qwen3-VL.*MotionBERT/);
  assert.doesNotMatch(textContent(main), /FSW-Net|WHAM|Synthetic sample/);
});


test('3D results link to the actual source track analysis only when its stored ID exists', () => {
  const i18n = locale();
  const component = load('pages/VideoDetail.tsx', { react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {}, '../components': {}, '../PosePlayer': {}, './ReviewPanel': {}, './EventsPanel': {} });
  for (const source of [{ params: { source_pose_job_id: 'source tracks' } }, { result: { source_pose_job_id: 'source tracks' } }]) {
    const job = { ...source, result: { kind: 'pose3d', ...source.result } };
    const panel = component.CapabilityPanel({ capability: '3d', job, videoId: 'actual video', models: {}, busy: false, onRun() {} });
    const link = elements(panel).find(element => element.type === 'a' && textContent(element) === 'View source tracks');
    assert.ok(link); assert.equal(link.props.href, '#videos/actual%20video?job=source%20tracks');
  }
  const empty = component.CapabilityPanel({ capability: '3d', job: { result: { kind: 'pose3d' } }, videoId: 'v', models: {}, busy: false, onRun() {} });
  assert.equal(elements(empty).filter(element => element.type === 'a').length, 0);
});


test('dashboard latest analyses keep only the newest attempt per video and backend while retaining new failures and exact links', () => {
  const i18n = locale(); let call = 0;
  const jobs = [
    { id: 'new-ok-1', video_id: 'video 1', backend: 'action', status: 'needs_review' },
    { id: 'new-bad2', video_id: 'video-2', backend: 'action', status: 'failed' },
    { id: 'mask-ok1', video_id: 'video 1', backend: 'sam2', status: 'completed' },
    { id: 'old-bad1', video_id: 'video 1', backend: 'action', status: 'failed' },
    { id: 'old-ok-2', video_id: 'video-2', backend: 'action', status: 'completed' },
    { id: 'orphan01', backend: 'action', status: 'failed' },
    { id: 'orphan02', backend: 'action', status: 'completed' },
  ];
  const data = { category_counts: {}, recent_jobs: jobs, recorded_minutes: 180 };
  const dashboard = load('pages/Dashboard.tsx', { react: hooks, '../i18n': i18n, '../types': categoryTypes(i18n), '../api': {}, '../components': { useData: () => ({ data: call++ === 0 ? data : {}, loading: false, error: '' }) } });
  const view = dashboard.default();
  assert.match(textContent(view), /Latest video analyses/);
  const table = elements(view).find(element => element.type === 'table');
  assert.match(textContent(table), /new-ok-1.*new-bad2.*mask-ok1.*orphan01.*orphan02/);
  assert.doesNotMatch(textContent(table), /old-bad1|old-ok-2/);
  assert.ok(elements(table).some(element => element.props.job?.id === 'new-bad2' && element.props.job.status === 'failed'));
  assert.deepEqual(elements(table).filter(element => element.type === 'a').map(element => element.props.href), ['#videos/video%201?job=new-ok-1', '#videos/video-2?job=new-bad2', '#videos/video%201?job=mask-ok1']);
  assert.equal(jobs.length, 7, 'Stored history is unchanged');
});
