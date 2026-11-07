// test/e2e.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { COMMANDS } from '../run.js';

const G = ['-c', 'user.email=swarm@test', '-c', 'user.name=swarm'];
const git = (a, cwd) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8' }).trim();
const RUN = join(import.meta.dirname, '..', 'run.js');
const cli = (a, cwd = import.meta.dirname) =>
  execFileSync(process.execPath, [RUN, ...a], { cwd, encoding: 'utf8' }).trim();

const PLAN = `# plano
## T-01 tokens
- paths: styles/**
- depends_on: -
- verify: node build.mjs

## T-02 cabecalho
- paths: components/header/**
- depends_on: T-01
- verify: node build.mjs

## T-03 rodape
- paths: components/footer/**
- depends_on: T-01
- verify: node build.mjs
`;

function swarmSetup() {
  const repoDir = mkdtempSync(join(tmpdir(), 'swarm-e2e-repo-'));
  cpSync(join(import.meta.dirname, 'fixtures', 'site'), repoDir, { recursive: true });
  mkdirSync(join(repoDir, 'components', 'header'), { recursive: true });
  mkdirSync(join(repoDir, 'components', 'footer'), { recursive: true });
  writeFileSync(join(repoDir, 'components', 'header', '.gitkeep'), '');
  writeFileSync(join(repoDir, 'components', 'footer', '.gitkeep'), '');
  git(['init', '-q', '-b', 'main'], repoDir);
  // Identidade repo-local (ruling I1 da Task 4): o `-c` do helper git() deste arquivo NAO chega
  // ao subprocesso run.js, e o `integrate` faz merge de verdade. Sem estas duas linhas o e2e
  // dependeria da identidade global do host — a copia exata do padrao de run.test.js.
  git(['config', 'user.email', 'swarm@test'], repoDir);
  git(['config', 'user.name', 'swarm'], repoDir);
  git(['add', '.'], repoDir); git(['commit', '-q', '-m', 'base'], repoDir);
  const workspace = mkdtempSync(join(tmpdir(), 'swarm-e2e-ws-'));
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  writeFileSync(join(workspace, 'plan.md'), PLAN);
  cli(['plan', '--run', meta.runDir, '--file', join(workspace, 'plan.md')]);
  return { ...meta, repoDir, workspace, headBefore: git(['rev-parse', 'HEAD'], repoDir) };
}

function worker(s, taskId, writes) {
  const w = JSON.parse(cli(['start', '--run', s.runDir, '--task', taskId]));
  for (const [rel, text] of Object.entries(writes)) {
    const abs = join(w.workDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  git(['add', '.'], w.workDir); git(['commit', '-q', '-m', taskId], w.workDir);
  writeFileSync(join(s.runDir, 'tasks', taskId, 'attempt-1', 'report.md'),
    `## Summary\nevi\n- touched: ${Object.keys(writes).join(', ')}\n- tokens: 50\n`);
  return { ...w, result: JSON.parse(cli(['finish', '--run', s.runDir, '--task', taskId, '--rc', '0'])) };
}

test('tres agentes em lotes disjuntos produzem uma onda integrada', () => {
  const s = swarmSetup();
  // Desvio justificado (armadilha conhecida do brief, item 4 do controlador): o texto original era
  // IDÊNTICO ao tokens.css da fixture, o `git commit` do helper morria em "nothing to commit" e o
  // teste não exercitava nada. Um token extra material mantém a intenção (worker toca styles/**).
  const a = worker(s, 'T-01', { 'styles/tokens.css': ':root { --bg: oklch(0.99 0.002 260); --ink: oklch(0.2 0.01 260); --surface: oklch(0.96 0.005 260); }\n' });
  assert.equal(a.result.ok, true, JSON.stringify(a.result));

  // A barragem da spec é o protocolo testado, não uma conveniência: T-02 e T-03 dependem de T-01,
  // então o `start` deles só acontece depois de `integrate` fechar a onda 1 — e é isso que põe os
  // arquivos de T-01 dentro do worktree deles (emenda da Task 8, item 1 da Task 9). Este teste é o
  // lugar onde a suíte prova que a onda seguinte trabalha sobre a anterior.
  const i1 = JSON.parse(cli(['integrate', '--run', s.runDir]));
  assert.deepEqual(i1.merged, ['T-01'], JSON.stringify(i1));
  assert.equal(i1.conflicts.length, 0);

  const b = worker(s, 'T-02', { 'components/header/header.css': '.h { padding: 8px; }\n' });
  const c = worker(s, 'T-03', { 'components/footer/footer.css': '.f { padding: 16px; }\n' });
  assert.equal(b.result.ok, true); assert.equal(c.result.ok, true);

  const integ = JSON.parse(cli(['integrate', '--run', s.runDir]));
  assert.equal(integ.conflicts.length, 0, JSON.stringify(integ));
  const dir = join(s.runDir, 'worktrees', '_integration');
  assert.ok(existsOk(join(dir, 'components', 'header', 'header.css')));
  assert.ok(existsOk(join(dir, 'components', 'footer', 'footer.css')));
  assert.match(cli(['status', '--run', s.runDir]), /T-02\s+merged/);
});

test('o checkout do usuario nao foi tocado: mesmo HEAD e mesma branch', (t) => {
  const s = swarmSetup();
  worker(s, 'T-01', { 'styles/tokens.css': ':root { --bg: #ffffff; }\n' });
  cli(['integrate', '--run', s.runDir]);
  assert.equal(git(['rev-parse', 'HEAD'], s.repoDir), s.headBefore);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], s.repoDir), 'main');
  assert.equal(git(['status', '--porcelain'], s.repoDir), '');
});

test('sabotador que toca fora do lote e barrado e fica fora da integracao', () => {
  const s = swarmSetup();
  worker(s, 'T-01', { 'styles/tokens.css': ':root { --bg: oklch(0.99 0.002 260); }\n' });
  // Emenda da barragem (fix round Task 9 / revisão): T-02 depende de T-01, entao sem o `integrate`
  // aqui o `start` do sabotador morreria em PlanError rc 2 antes de qualquer gate — a barragem da
  // dependencia nao e a barragem do lote, e este teste e sobre a do lote.
  cli(['integrate', '--run', s.runDir]);
  const sab = worker(s, 'T-02', {
    'components/header/header.css': '.h { padding: 8px; }\n',
    'components/footer/footer.css': '.f { color: #ff0000; }\n',
  });
  assert.equal(sab.result.ok, false);
  assert.equal(sab.result.findings[0].id, 'SCOPE-OUTSIDE-LOT');

  const ok = worker(s, 'T-03', { 'components/footer/footer.css': '.f { padding: 16px; }\n' });
  assert.equal(ok.result.ok, true);
  const integ = JSON.parse(cli(['integrate', '--run', s.runDir]));
  assert.match(JSON.stringify(integ), /T-02|swarm\/.*\/T-02/);
  assert.equal(existsOk(join(s.runDir, 'worktrees', '_integration', 'components', 'header', 'header.css')), false);
});

const existsOk = (p) => { try { readFileSync(p); return true; } catch { return false; } };

test('--run relativo: worktree nasce no workspace, nao dentro do repo alvo (emenda B-1 da Task 13)', () => {
  const s = swarmSetup();
  // O dry run do libra dirigiu o CLI com `--run runs/<id>` a partir do workspace: o `git worktree
  // add` do isolate resolve caminho relativo contra o cwd do repo ALVO, e o worktree nasceu dentro
  // do produto enquanto o prompt prometia o workspace. Todo setup desta suite usa runDir absoluto
  // (mkdtemp), por isso os 132 testes nao pegaram — este dirige o CLI do jeito que o plano manda.
  const w = JSON.parse(cli(['start', '--run', join('runs', s.runId), '--task', 'T-01'], s.workspace));
  assert.equal(isAbsolute(w.workDir), true, JSON.stringify(w));
  assert.ok(existsOk(join(s.workspace, 'runs', s.runId, 'worktrees', 'T-01', 'styles', 'tokens.css')));
  assert.equal(existsOk(join(s.repoDir, 'runs', s.runId, 'worktrees', 'T-01', 'styles', 'tokens.css')), false);
});
