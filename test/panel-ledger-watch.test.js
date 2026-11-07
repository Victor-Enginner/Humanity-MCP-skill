import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { append } from '../lib/ledger.js';
import { watchLedger } from '../panel/ledger-watch.js';
import { makeRun } from './panel-fixtures.js';

const row = (task, state, rc = null) => ({ task, state, rc, start: null, end: null, branch: null, log: null, tokens: null, pid: null });

test('append no status.tsv vira state na ordem, rc fiel', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const events = [];
  const lw = watchLedger({ runDir: f.runDir, onEvent: (ev) => events.push(ev), pollMs: 60000 });
  t.after(() => lw.close());
  append(f.runDir, row('T-01', 'running'));
  append(f.runDir, row('T-01', 'gated', 0));
  lw.poll();
  assert.deepEqual(events, [
    { type: 'state', task: 'T-01', state: 'running', rc: null },
    { type: 'state', task: 'T-01', state: 'gated', rc: 0 },
  ]);
  lw.poll();
  assert.equal(events.length, 2); // sem append novo, sem evento
});

test('gate file vira gate com ok/rc/timedOut; build null vira rc null', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const events = [];
  const lw = watchLedger({ runDir: f.runDir, onEvent: (ev) => events.push(ev), pollMs: 60000 });
  t.after(() => lw.close());
  mkdirSync(join(f.runDir, 'gates'));
  writeFileSync(join(f.runDir, 'gates', 'wave-1.json'), JSON.stringify({
    wave: 1, ok: false, build: { rc: 1, timedOut: false }, findings: [],
  }));
  lw.poll();
  writeFileSync(join(f.runDir, 'gates', 'wave-2.json'), JSON.stringify({ wave: 2, ok: true, build: null, findings: [] }));
  lw.poll();
  assert.deepEqual(events, [
    { type: 'gate', wave: 1, ok: false, rc: 1, timedOut: false },
    { type: 'gate', wave: 2, ok: true, rc: null, timedOut: false },
  ]);
});

test('gate timeout e reescrita da mesma onda', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const events = [];
  const lw = watchLedger({ runDir: f.runDir, onEvent: (ev) => events.push(ev), pollMs: 60000 });
  t.after(() => lw.close());
  mkdirSync(join(f.runDir, 'gates'));
  const p = join(f.runDir, 'gates', 'wave-1.json');
  writeFileSync(p, JSON.stringify({ wave: 1, ok: false, build: { rc: 124, timedOut: true } }));
  lw.poll();
  assert.deepEqual(events[0], { type: 'gate', wave: 1, ok: false, rc: 124, timedOut: true });
  // reescrita (retry de integrate): mtime muda → novo evento
  const futuro = new Date(Date.now() + 5000);
  writeFileSync(p, JSON.stringify({ wave: 1, ok: true, build: { rc: 0, timedOut: false } }));
  utimesSync(p, futuro, futuro);
  lw.poll();
  assert.deepEqual(events[1], { type: 'gate', wave: 1, ok: true, rc: 0, timedOut: false });
});

test('JSON parcial nao vira evento; proximo poll pega', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  const events = [];
  const lw = watchLedger({ runDir: f.runDir, onEvent: (ev) => events.push(ev), pollMs: 60000 });
  t.after(() => lw.close());
  mkdirSync(join(f.runDir, 'gates'));
  const p = join(f.runDir, 'gates', 'wave-1.json');
  writeFileSync(p, '{"wave": 1, "ok": tr');
  lw.poll();
  assert.equal(events.length, 0);
  writeFileSync(p, JSON.stringify({ wave: 1, ok: true, build: null }));
  lw.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, true);
});

test('gates pre-existentes viram evento no boot; estados nao', (t) => {
  const f = makeRun(); t.after(() => f.cleanup());
  mkdirSync(join(f.runDir, 'gates'));
  writeFileSync(join(f.runDir, 'gates', 'wave-1.json'), JSON.stringify({ wave: 1, ok: true, build: { rc: 0, timedOut: false } }));
  const events = [];
  const lw = watchLedger({ runDir: f.runDir, onEvent: (ev) => events.push(ev), pollMs: 60000 });
  t.after(() => lw.close());
  assert.deepEqual(events, [{ type: 'gate', wave: 1, ok: true, rc: 0, timedOut: false }]);
});