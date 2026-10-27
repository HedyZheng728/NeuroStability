import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourcePath = new URL('../src/i18n.ts', import.meta.url);
function load(saved, blocked = false) {
  assert.ok(existsSync(sourcePath), 'The locale module must exist');
  const values = new Map(saved ? [['arena.locale', saved]] : []);
  const localStorage = { getItem(key) { if (blocked) throw new Error('Storage unavailable'); return values.get(key) ?? null; }, setItem(key, value) { if (blocked) throw new Error('Storage unavailable'); values.set(key, value); } };
  const document = { documentElement: { lang: '' }, title: '', querySelector() { return null; } };
  const exports = {};
  const code = ts.transpileModule(readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require, window: { localStorage }, navigator: { language: 'zh-CN', languages: ['zh-CN'] }, document, Set, Map });
  return { ...exports, values, document };
}

test('fresh visits default to English independent of browser language', () => {
  const i18n = load();
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(i18n.t('训练场次'), 'Sessions');
  assert.equal(i18n.tx('Training plans', '训练计划'), 'Training plans');
  assert.equal(i18n.document.documentElement.lang, 'en');
});
test('explicit language choice persists and is restored', () => {
  const i18n = load();
  i18n.setLocale('zh');
  assert.equal(i18n.values.get('arena.locale'), 'zh');
  assert.equal(load('zh').t('训练场次'), '训练场次');
  assert.equal(i18n.document.documentElement.lang, 'zh-CN');
});
test('blocked storage still permits switching languages', () => {
  const i18n = load(undefined, true);
  assert.equal(i18n.getLocale(), 'en');
  assert.doesNotThrow(() => i18n.setLocale('zh'));
  assert.equal(i18n.t('训练场次'), '训练场次');
  i18n.setLocale('en');
  assert.equal(i18n.t('训练场次'), 'Sessions');
});
test('switching back preserves the original translation source', () => {
  const i18n = load();
  const original = '训练场次';
  const displayed = i18n.t(original);
  i18n.setLocale('zh');
  assert.equal(i18n.t(original), original);
  assert.equal(i18n.t(displayed), original);
  i18n.setLocale('en');
  assert.equal(i18n.t(original), displayed);
  assert.equal(i18n.tx('Planned: 45 min', '计划：45 分钟'), 'Planned: 45 min');
  assert.equal(i18n.t('A coach’s own note'), 'A coach’s own note');
});
test('known backend metrics, errors and progress are translated', () => {
  const i18n = load();
  assert.equal(i18n.t('髋中点横向离散度'), 'Lateral hip midpoint dispersion');
  assert.equal(i18n.t('用户名或密码错误'), 'Incorrect username or password.');
  assert.equal(i18n.t('训练计划不存在'), 'Training plan not found.');
  assert.equal(i18n.t('预处理：规范画面并去除音轨'), 'Preprocessing video');
  assert.equal(i18n.t('Value error, 片段终点必须晚于起点'), 'End time must follow start time.');
});
test('quality details preserve values and localize keys in both languages', () => {
  const i18n = load();
  assert.equal(i18n.qualityText({ total_frames: 50, usable_ratio: 0.8 }), '{\n  "Total frames": 50,\n  "Usable ratio": 0.8\n}');
  i18n.setLocale('zh');
  assert.equal(i18n.qualityText({ total_frames: 50 }), '{\n  "总帧数": 50\n}');
});
test('dynamic server diagnostics keep useful details in English', () => {
  const i18n = load();
  assert.equal(i18n.t('未就绪：缺少 动作分类器 本地权重文件'), 'Not ready: Missing Action classifier local weights file');
  assert.equal(i18n.t('无法读取 FSW bundle（JSONDecodeError）'), 'Cannot read FSW bundle (JSONDecodeError)');
});
test('every static Chinese translation used by existing UI has an English entry', () => {
  const i18n = load();
  const paths = ['App.tsx', 'components.tsx', 'PosePlayer.tsx', 'api.ts', 'types.ts', ...['Athletes', 'Dashboard', 'EventsPanel', 'Models', 'ReviewPanel', 'Sessions', 'Upload', 'VideoDetail', 'VideoLibrary'].map(name => `pages/${name}.tsx`)];
  for (const path of paths) {
    const file = ts.createSourceFile(path, readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 't' && ts.isStringLiteral(node.arguments[0]) && /\p{Script=Han}/u.test(node.arguments[0].text)) {
        assert.doesNotMatch(i18n.t(node.arguments[0].text), /\p{Script=Han}/u, `${path}: ${node.arguments[0].text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
});
