import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function dates() {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/planningTypes.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, Intl, Date });
  return exports;
}

test('workspace calendar uses Shanghai day across UTC midnight and calendar offsets', () => {
  const calendar = dates();
  const instant = new Date('2024-12-31T18:00:00Z');
  assert.equal(calendar.localDate(0, instant), '2025-01-01');
  assert.equal(calendar.localDate(-1, instant), '2024-12-31');
  assert.equal(calendar.localDate(-32, instant), '2024-11-30');
});

test('configured workspace timezone applies calendar offsets across daylight saving', () => {
  const calendar = dates();
  calendar.setWorkspaceTimezone('America/New_York');
  const instant = new Date('2026-11-01T03:30:00Z');
  assert.equal(calendar.getWorkspaceTimezone(), 'America/New_York');
  assert.equal(calendar.localDate(0, instant), '2026-10-31');
  assert.equal(calendar.localDate(1, instant), '2026-11-01');
  calendar.setWorkspaceTimezone();
  assert.equal(calendar.getWorkspaceTimezone(), 'Asia/Shanghai');
});
