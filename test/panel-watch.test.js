import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { diffLines, readCapped, watchWorktrees, CAP_BYTES } from '../panel/watch.js';
import { toLines, applyEdit } from '../panel/public/core.js';
import { makeRun, waitFor } from './panel-fixtures.js';

const CASOS = [
  { nome: 'substituicao', old: ['a', 'b', 'c'], novo: ['a', 'X', 'c'], esp: { startLine: 2, endLine: 2, lines: ['X'] } },
  { nome: 'insercao', old: ['a', 'b'], novo: ['a', 'x', 'b'], esp: { startLine: 2, endLine: 1, lines: ['x'] } },
  { nome: 'remocao', old: ['a', 'b', 'c'], novo: ['a', 'c'], esp: { startLine: 2, endLine: 2, lines: [] } },
  { nome: 'arquivo novo', old: [], novo: ['x', 'y'], esp: { startLine: 1, endLine: 0, lines: ['x', 'y'] } },
  { nome: 'esvaziou', old: ['a'], novo: [], esp: { startLine: 1, endLine: 1, lines: [] } },
  { nome: 'reescrita total', old: ['a'], novo: ['x', 'y'], esp: { startLine: 1, endLine: 1, lines: ['x', 'y'] } },
];

for (const c of CASOS) {
  test(`diffLines/applyEdit roundtrip: ${c.nome}`, () => {
    const d = diffLines(c.old, c.novo);
    assert.deepEqual(d, c.esp);
    assert.deepEqual(applyEdit(c.old, d), c.novo);
  });
}

test('diffLines de iguais é null', () => {
  assert.equal(diffLines(['a'], ['a']), null);
  assert.equal(diffLines([], []), null);
});

test('toLines: vazio, newline final, CRLF', () => {
  assert.deepEqual(toLines(''), []);
  assert.deepEqual(toLines('a\n'), ['a']);
  assert.deepEqual(toLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(toLines('a\n\n'), ['a', '']);
});

function watcher(f, opts = {}) {
  const events = [];
  const wt = watchWorktrees({
    runDir: f.runDir, repoDir: f.repo, baseSha: f.baseSha, baseTree: f.baseTree,
    onEvent: (ev) => events.push(ev), useWatch: false, debounceMs: 40, ...opts,
  });
  return { wt, events };
}

test('arquivo novo vira edit de insercao pura e dono', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const { wt, events } = watcher(f); t.after(() => wt.close());
  writeFileSync(join(f.runDir, 'worktrees', 'T-01', 'novo.py'), 'x\ny\n');
  wt.rescan();
  assert.deepEqual(events, [{ type: 'edit', task: 'T-01', file: 'novo.py', startLine: 1, endLine: 0, lines: ['x', 'y'] }]);
  assert.deepEqual(wt.owners.get('novo.py'), { task: 'T-01' });
});

test('write real com fs.watch chega em menos de 1s (rescan pega evento perdido)', async (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const { wt, events } = watcher(f, { useWatch: true }); t.after(() => wt.close());
  writeFileSync(join(f.runDir, 'worktrees', 'T-01', 'a.txt'), 'um\nDOIS\n');
  await waitFor(() => events.length > 0, 1000);
  assert.deepEqual(events[0], { type: 'edit', task: 'T-01', file: 'a.txt', startLine: 2, endLine: 2, lines: ['DOIS'] });
});

test('rajada vira UM evento (debounce)', async (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const { wt, events } = watcher(f); t.after(() => wt.close());
  const p = join(f.runDir, 'worktrees', 'T-01', 'a.txt');
  writeFileSync(p, 'um\nDOIS\n'); wt.poke('T-01', 'a.txt');
  writeFileSync(p, 'um\nDOIS!\n'); wt.poke('T-01', 'a.txt');
  writeFileSync(p, 'um\nFINAL\n'); wt.poke('T-01', 'a.txt');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].lines, ['FINAL']);
});

test('truncamento: arquivo maior que 64KB', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const { wt, events } = watcher(f); t.after(() => wt.close());
  const p = join(f.runDir, 'worktrees', 'T-01', 'grande.txt');
  writeFileSync(p, 'x'.repeat(CAP_BYTES + 100));
  const r = readCapped(p);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, CAP_BYTES);
  wt.rescan();
  assert.equal(events.length, 1);
  assert.ok(events[0].lines.join('\n').length <= CAP_BYTES);
});

test('binario: null byte vira edit sem linhas', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const { wt, events } = watcher(f); t.after(() => wt.close());
  const p = join(f.runDir, 'worktrees', 'T-01', 'img.png');
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x00, 0x4e]));
  assert.deepEqual(readCapped(p), { binary: true, text: '', truncated: false });
  wt.rescan();
  assert.deepEqual(events, [{ type: 'edit', task: 'T-01', file: 'img.png', startLine: 1, endLine: 0, lines: [] }]);
  wt.rescan();
  assert.equal(events.length, 1); // sem diff de texto possível: não re-emite a cada rescan
});

test('remocao de arquivo vira delete e dono deleted', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const { wt, events } = watcher(f); t.after(() => wt.close());
  unlinkSync(join(f.runDir, 'worktrees', 'T-01', 'a.txt'));
  wt.rescan();
  assert.deepEqual(events, [{ type: 'delete', task: 'T-01', file: 'a.txt' }]);
  assert.deepEqual(wt.owners.get('a.txt'), { task: 'T-01', deleted: true });
});

test('worktree removido nao quebra o rescan nem emite delete', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const { wt, events } = watcher(f); t.after(() => wt.close());
  wt.rescan();
  rmSync(join(f.runDir, 'worktrees', 'T-01'), { recursive: true, force: true });
  wt.rescan();
  assert.equal(events.length, 0);
});

test('_integration e .git sao ignorados', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const { wt, events } = watcher(f); t.after(() => wt.close());
  mkdirSync(join(f.runDir, 'worktrees', '_integration'), { recursive: true });
  writeFileSync(join(f.runDir, 'worktrees', '_integration', 'x.txt'), 'x');
  writeFileSync(join(f.runDir, 'worktrees', 'T-01', '.git'), 'gitdir: lugar-nenhum\n');
  wt.rescan();
  assert.equal(events.length, 0);
});