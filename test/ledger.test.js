// test/ledger.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, append, rows, latest, stateOf, crashedRuns } from '../lib/ledger.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'swarm-ledger-'));
const row = (over) => ({
  task: 'T-01', state: 'planned', rc: null, start: null, end: null,
  branch: null, log: null, tokens: null, pid: null, ...over,
});

test('createLedger escreve cabecalho e recusa recriacao', () => {
  const d = fresh();
  createLedger(d);
  assert.equal(readFileSync(join(d, 'status.tsv'), 'utf8'),
    'task\tstate\trc\tstart\tend\tbranch\tlog\ttokens\tpid\n');
  assert.throws(() => createLedger(d), /single-writer/);
});

test('append eh append-only: duas linhas para a mesma tarefa coexistem', () => {
  const d = fresh(); createLedger(d);
  append(d, row({ state: 'running', pid: 4242 }));
  append(d, row({ state: 'reported', rc: 0, pid: null }));
  const r = rows(d);
  assert.equal(r.length, 2);
  assert.equal(latest(d, 'T-01').state, 'reported');
  assert.deepEqual(stateOf(d), new Map([['T-01', 'reported']]));
});

test('append recusa estado desconhecido', () => {
  const d = fresh(); createLedger(d);
  assert.throws(() => append(d, row({ state: 'quase' })), /estado invalido/);
});

test('append recusa linha sem coluna explicita', () => {
  const d = fresh(); createLedger(d);
  assert.throws(() => append(d, { task: 'T-01', state: 'planned' }), /sem colunas/);
});

test('append recusa escrever antes do ledger existir', () => {
  assert.throws(() => append(fresh(), row()), /sem ledger/);
});

test('crashedRuns: running sem pid vivo', () => {
  const d = fresh(); createLedger(d);
  append(d, row({ task: 'T-01', state: 'running', pid: 111 }));
  append(d, row({ task: 'T-02', state: 'running', pid: 222 }));
  const dead = crashedRuns(d, (pid) => pid === 222);
  assert.deepEqual(dead.map((r) => r.task), ['T-01']);
});

test('latest devolve null para tarefa desconhecida', () => {
  const d = fresh(); createLedger(d);
  assert.equal(latest(d, 'T-99'), null);
});
