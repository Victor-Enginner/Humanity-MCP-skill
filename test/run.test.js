// test/run.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS } from '../run.js';

const G = ['-c', 'user.email=swarm@test', '-c', 'user.name=swarm'];
const git = (args, cwd) => execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8' }).trim();

function cli(args, cwd) {
  return execFileSync(process.execPath, [join(import.meta.dirname, '..', 'run.js'), ...args],
    { cwd, encoding: 'utf8' }).trim();
}

function setup() {
  const repoDir = mkdtempSync(join(tmpdir(), 'swarm-cli-repo-'));
  git(['init', '-q', '-b', 'main'], repoDir);
  // Identidade repo-local (ruling I1 da Task 4, carry-in): o `integrate` faz merge de verdade e o
  // `init` pre-checha `git config user.email`. Sem estas duas linhas o teste dependeria da
  // identidade global do host — exatamente o que a Task 4 declarou viola de constraint.
  git(['config', 'user.email', 'swarm@test'], repoDir);
  git(['config', 'user.name', 'swarm'], repoDir);
  mkdirSync(join(repoDir, 'styles'), { recursive: true });
  mkdirSync(join(repoDir, 'components'), { recursive: true });
  writeFileSync(join(repoDir, 'styles', 'tokens.css'), ':root { --bg: #ffffff; }\n');
  writeFileSync(join(repoDir, 'components', 'x.css'), '.x { padding: 8px; }\n');
  writeFileSync(join(repoDir, 'index.html'), '<h1>base</h1>\n');
  git(['add', '.'], repoDir); git(['commit', '-q', '-m', 'base'], repoDir);
  const workspace = mkdtempSync(join(tmpdir(), 'swarm-cli-ws-'));
  return { repoDir, workspace };
}

const PLAN = `# plano
## T-01 tokens
- paths: styles/**
- depends_on: -
- verify: -

## T-02 cabecalho
- paths: components/**
- depends_on: T-01
- verify: -
`;

test('COMMANDS e a lista fechada que as skills podem citar', () => {
  assert.deepEqual(COMMANDS, ['init', 'plan', 'start', 'finish', 'integrate', 'status', 'abort']);
});

test('init cria runs/<id>/ com run.json', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  assert.ok(existsSync(join(meta.runDir, 'run.json')));
  assert.equal(meta.baseSha, git(['rev-parse', 'HEAD'], repoDir));
});

test('plan valida, grava waves.json e povoa o ledger', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  const planFile = join(workspace, 'plan.md');
  writeFileSync(planFile, PLAN);
  cli(['plan', '--run', meta.runDir, '--file', planFile]);
  const waves = JSON.parse(readFileSync(join(meta.runDir, 'waves.json'), 'utf8'));
  assert.deepEqual(waves, [['T-01'], ['T-02']]);
  assert.match(readFileSync(join(meta.runDir, 'status.tsv'), 'utf8'), /T-01\tplanned/);
});

test('plan recusa plano com lote disputado e sai com codigo 2', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  const bad = join(workspace, 'bad.md');
  writeFileSync(bad, '## T-01 a\n- paths: styles/x.css\n- depends_on: -\n\n## T-02 b\n- paths: styles/y.css\n- depends_on: -\n');
  assert.throws(() => cli(['plan', '--run', meta.runDir, '--file', bad]), /disputam/);
});

test('start cria worktree, prompt e linha running', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  const planFile = join(workspace, 'plan.md');
  writeFileSync(planFile, PLAN);
  cli(['plan', '--run', meta.runDir, '--file', planFile]);
  const out = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-01']));
  assert.ok(existsSync(out.workDir));
  assert.ok(existsSync(out.prompt));
  assert.match(readFileSync(out.prompt, 'utf8'), /styles/);
  assert.match(readFileSync(join(meta.runDir, 'status.tsv'), 'utf8'), /T-01\trunning/);
});

test('finish com report fora do lote vira failed e nao gated', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  writeFileSync(join(workspace, 'plan.md'), PLAN);
  cli(['plan', '--run', meta.runDir, '--file', join(workspace, 'plan.md')]);
  const { workDir } = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-01']));
  writeFileSync(join(workDir, 'components', 'invasao.css'), '.i { gap: 3px; }\n');
  git(['add', '.'], workDir); git(['commit', '-q', '-m', 'invadiu'], workDir);
  const reportDir = join(meta.runDir, 'tasks', 'T-01', 'attempt-1');
  writeFileSync(join(reportDir, 'report.md'),
    '## Summary\ninvasao\n- touched: components/invasao.css\n- tokens: 100\n');
  const g = JSON.parse(cli(['finish', '--run', meta.runDir, '--task', 'T-01', '--rc', '0']));
  assert.equal(g.ok, false);
  assert.equal(g.findings[0].id, 'SCOPE-OUTSIDE-LOT');
  assert.match(readFileSync(join(meta.runDir, 'status.tsv'), 'utf8'), /T-01\tfailed/);
});

test('finish com trabalho limpo vira gated e integrate mergea em ordem', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  writeFileSync(join(workspace, 'plan.md'), PLAN);
  cli(['plan', '--run', meta.runDir, '--file', join(workspace, 'plan.md')]);
  const a = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-01']));
  writeFileSync(join(a.workDir, 'styles', 'tokens.css'), ':root { --bg: #fefefe; padding: 8px; }\n');
  git(['add', '.'], a.workDir); git(['commit', '-q', '-m', 'tokens'], a.workDir);
  writeFileSync(join(meta.runDir, 'tasks', 'T-01', 'attempt-1', 'report.md'),
    '## Summary\nok\n- touched: styles/tokens.css\n- tokens: 100\n');
  assert.equal(JSON.parse(cli(['finish', '--run', meta.runDir, '--task', 'T-01', '--rc', '0'])).ok, true);

  // FIXURA EMENDADA (desvio D3 do report): o rascunho da brief dava `start` em T-02 com T-01 ainda
  // `gated`, o que a emenda 1 do Step 4 recusa ("rode integrate primeiro"). O fixuro foi corrigido
  // na direcao da intencao: integra a onda 1 antes de abrir a 2 — que e o protocolo do e2e da
  // Task 11 e a barragem da spec.
  const i1 = JSON.parse(cli(['integrate', '--run', meta.runDir]));
  assert.deepEqual(i1.merged, ['T-01'], JSON.stringify(i1));
  assert.equal(i1.conflicts.length, 0);

  const b = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-02']));
  // Emenda 1: o worktree da onda 2 sai do head da integracao e ja contem a entrega da onda 1.
  assert.match(readFileSync(join(b.workDir, 'styles', 'tokens.css'), 'utf8'), /#fefefe/);
  writeFileSync(join(b.workDir, 'components', 'x.css'), '.x { padding: 16px; }\n');
  git(['add', '.'], b.workDir); git(['commit', '-q', '-m', 'header'], b.workDir);
  writeFileSync(join(meta.runDir, 'tasks', 'T-02', 'attempt-1', 'report.md'),
    '## Summary\nok\n- touched: components/x.css\n- tokens: 100\n');
  // Emenda 2: finish diffa contra baseOf (merge-base com a integracao), nunca baseSha cru — se
  // diffasse contra run.baseSha, styles/tokens.css da onda 1 viraria SCOPE-OUTSIDE-LOT de T-02.
  assert.equal(JSON.parse(cli(['finish', '--run', meta.runDir, '--task', 'T-02', '--rc', '0'])).ok, true);

  // Carry-in da Task 8, item (d): o gate.json registra tokenSource nao-nulo (gate de cor armada).
  const g1 = JSON.parse(readFileSync(join(meta.runDir, 'tasks', 'T-01', 'attempt-1', 'gate.json'), 'utf8'));
  assert.equal(g1.tokenSource, 'styles/tokens.css');

  const i2 = JSON.parse(cli(['integrate', '--run', meta.runDir]));
  assert.deepEqual(i2.merged, ['T-02'], JSON.stringify(i2));
  assert.equal(i2.conflicts.length, 0);

  const st = readFileSync(join(meta.runDir, 'status.tsv'), 'utf8');
  assert.match(st, /T-01\tmerged/);
  assert.match(st, /T-02\tmerged/);
  // Carry-in da Task 4, item (c): o integrate final apaga as refs integradas; com a ultima onda
  // fechada, a de integracao tambem. O `git branch` do humano nao acumula nada.
  assert.equal(git(['branch', '--list', 'swarm/*'], repoDir).trim(), '');
  // A pilha integrada existe e contem as duas entregas (a worktree fica detachada, nao apagada:
  // e dela que o e2e da Task 11 le os arquivos).
  const dir = join(meta.runDir, 'worktrees', '_integration');
  assert.match(readFileSync(join(dir, 'styles', 'tokens.css'), 'utf8'), /#fefefe/);
  assert.match(readFileSync(join(dir, 'components', 'x.css'), 'utf8'), /16px/);
});

test('status tabula e abort derruba worktrees', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  writeFileSync(join(workspace, 'plan.md'), PLAN);
  cli(['plan', '--run', meta.runDir, '--file', join(workspace, 'plan.md')]);
  const a = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-01']));
  assert.match(cli(['status', '--run', meta.runDir]), /T-01 +running/);
  cli(['abort', '--run', meta.runDir]);
  assert.equal(existsSync(a.workDir), false);
  assert.match(readFileSync(join(meta.runDir, 'status.tsv'), 'utf8'), /T-01\tdiscarded/);
  assert.equal(git(['branch', '--list', 'swarm/*'], repoDir).trim(), '');
});
