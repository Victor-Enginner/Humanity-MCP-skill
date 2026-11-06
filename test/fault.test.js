// test/fault.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crashedRuns, append, rows, latest } from '../lib/ledger.js';

const G = ['-c', 'user.email=swarm@test', '-c', 'user.name=swarm'];
const git = (a, cwd) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8' }).trim();
const cli = (a) => execFileSync(process.execPath, [join(import.meta.dirname, '..', 'run.js'), ...a],
  { cwd: import.meta.dirname, encoding: 'utf8' }).trim();

function setup() {
  const repoDir = mkdtempSync(join(tmpdir(), 'swarm-fault-repo-'));
  cpSync(join(import.meta.dirname, 'fixtures', 'site'), repoDir, { recursive: true });
  mkdirSync(join(repoDir, 'styles'), { recursive: true });
  git(['init', '-q', '-b', 'main'], repoDir);
  // Identidade repo-local (ruling I1 da Task 4; emenda edfad4a): o `-c` do helper git() NAO
  // chega ao subprocesso run.js, e o pre-check do cmdInit le a config do repo.
  git(['config', 'user.email', 'swarm@test'], repoDir);
  git(['config', 'user.name', 'swarm'], repoDir);
  git(['add', '.'], repoDir); git(['commit', '-q', '-m', 'base'], repoDir);
  const workspace = mkdtempSync(join(tmpdir(), 'swarm-fault-ws-'));
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  const plan = join(workspace, 'plan.md');
  writeFileSync(plan, '## T-01 a\n- paths: styles/**\n- depends_on: -\n- verify: -\n\n## T-02 b\n- paths: components/**\n- depends_on: -\n- verify: -\n');
  cli(['plan', '--run', meta.runDir, '--file', plan]);
  return { ...meta, repoDir, workspace };
}

test('worker sem report e sem commit, com pid morto, e detectado como crash', () => {
  const s = setup();
  cli(['start', '--run', s.runDir, '--task', 'T-01']);
  append(s.runDir, { task: 'T-01', state: 'running', rc: null, start: '2026-11-05T00:00:00Z',
    end: null, branch: `swarm/${s.runId}/T-01`, log: null, tokens: null, pid: 999999 });
  const dead = crashedRuns(s.runDir, () => false);
  assert.deepEqual(dead.map((r) => r.task), ['T-01']);
});

test('abort derruba todos os worktrees e o checkout do usuario fica intacto', () => {
  const s = setup();
  const headBefore = git(['rev-parse', 'HEAD'], s.repoDir);
  const a = JSON.parse(cli(['start', '--run', s.runDir, '--task', 'T-01']));
  const b = JSON.parse(cli(['start', '--run', s.runDir, '--task', 'T-02']));
  writeFileSync(join(a.workDir, 'styles', 'base.css'), 'body { padding: 4px; }\n');
  cli(['abort', '--run', s.runDir]);
  assert.equal(existsSync(a.workDir), false);
  assert.equal(existsSync(b.workDir), false);
  assert.equal(git(['rev-parse', 'HEAD'], s.repoDir), headBefore);
  assert.match(readFileSync(join(s.runDir, 'status.tsv'), 'utf8'), /T-01\tdiscarded/);
  // o teste que prende o vazamento de ref: `worktree remove` nao apaga branch
  assert.equal(git(['branch', '--list', 'swarm/*'], s.repoDir).trim(), '');
});

test('nenhum merge parcial: onda incompleta nao entra na integracao', () => {
  const s = setup();
  const a = JSON.parse(cli(['start', '--run', s.runDir, '--task', 'T-01']));
  writeFileSync(join(a.workDir, 'styles', 'base.css'), 'body { padding: 4px; }\n');
  git(['add', '.'], a.workDir); git(['commit', '-q', '-m', 'so T-01'], a.workDir);
  writeFileSync(join(s.runDir, 'tasks', 'T-01', 'attempt-1', 'report.md'),
    '## Summary\nok\n- touched: styles/base.css\n- tokens: 10\n');
  cli(['finish', '--run', s.runDir, '--task', 'T-01', '--rc', '0']);
  cli(['start', '--run', s.runDir, '--task', 'T-02']);
  const integ = JSON.parse(cli(['integrate', '--run', s.runDir]));
  assert.equal(integ.blockedOn, 'T-02');
  assert.equal(rows(s.runDir).filter((r) => r.state === 'merged').length, 0);
});

test('timeout vira estado no ledger, nunca sucesso', () => {
  const s = setup();
  cli(['start', '--run', s.runDir, '--task', 'T-01']);
  cli(['finish', '--run', s.runDir, '--task', 'T-01', '--rc', '124']);
  assert.equal(latest(s.runDir, 'T-01').state, 'timeout');
});

test('worker que morre sem reportar fecha como failed com rc registrado', () => {
  const s = setup();
  cli(['start', '--run', s.runDir, '--task', 'T-02']);
  cli(['finish', '--run', s.runDir, '--task', 'T-02', '--rc', '2']);
  const r = latest(s.runDir, 'T-02');
  assert.equal(r.state, 'failed');
  assert.equal(r.rc, '2');
});

// ---------------------------------------------------------------------------
// Emenda do controlador (carry das Tasks 10 e 11, item 2): os tres testes NOVOS
// que fazem o TDD desta Task. Antes do item 3 eles falham de proposito.
// O quarto veio da contra-emenda 001d8aa (achado M-2): nasce VERDE de proposito —
// prende o caso positivo da lista vazia. Se `touchedList` voltasse a ser `list`
// em lib/report.js, o `-` fantasma geraria TOUCHED-DECLARED-NOT-DONE aqui.

test('tarefa running SEM pid gravado nao e crash: desconhecido nao e morto (carry Task 10, item i)', () => {
  const s = setup();
  cli(['start', '--run', s.runDir, '--task', 'T-01']);
  assert.deepEqual(crashedRuns(s.runDir, () => false), []);
  assert.match(cli(['status', '--run', s.runDir]), /T-01\s+running/);
});

test('touched declarado sem diff-real reprova: TOUCHED-DECLARED-NOT-DONE (carry Task 10, item ii)', () => {
  const s = setup();
  const a = JSON.parse(cli(['start', '--run', s.runDir, '--task', 'T-01']));
  writeFileSync(join(a.workDir, 'styles', 'base.css'), 'body { padding: 4px; }\n');
  git(['add', '.'], a.workDir); git(['commit', '-q', '-m', 'deimei'], a.workDir);
  writeFileSync(join(s.runDir, 'tasks', 'T-01', 'attempt-1', 'report.md'),
    '## Summary\ndei de menos\n- touched: styles/base.css, styles/ghost.css\n- tokens: 10\n');
  const r = JSON.parse(cli(['finish', '--run', s.runDir, '--task', 'T-01', '--rc', '0']));
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(JSON.stringify(r.findings), /TOUCHED-DECLARED-NOT-DONE/);
  assert.equal(latest(s.runDir, 'T-01').state, 'failed');
});

test('diff-real sem touched declarado reprova: TOUCHED-DONE-NOT-DECLARED', () => {
  const s = setup();
  const a = JSON.parse(cli(['start', '--run', s.runDir, '--task', 'T-01']));
  writeFileSync(join(a.workDir, 'styles', 'base.css'), 'body { padding: 4px; }\n');
  git(['add', '.'], a.workDir); git(['commit', '-q', '-m', 'escondi'], a.workDir);
  writeFileSync(join(s.runDir, 'tasks', 'T-01', 'attempt-1', 'report.md'),
    '## Summary\nnao declarei nada\n- touched: -\n- tokens: 10\n');
  const r = JSON.parse(cli(['finish', '--run', s.runDir, '--task', 'T-01', '--rc', '0']));
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(JSON.stringify(r.findings), /TOUCHED-DONE-NOT-DECLARED/);
});

test('touched vazio com diff zero passa: lista vazia nao e mentira (prende o touchedList)', () => {
  const s = setup();
  cli(['start', '--run', s.runDir, '--task', 'T-01']);
  writeFileSync(join(s.runDir, 'tasks', 'T-01', 'attempt-1', 'report.md'),
    '## Summary\nnao havia o que fazer\n- touched: -\n- tokens: 0\n');
  const r = JSON.parse(cli(['finish', '--run', s.runDir, '--task', 'T-01', '--rc', '0']));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(latest(s.runDir, 'T-01').state, 'gated');
});
