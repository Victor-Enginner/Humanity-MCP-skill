// test/run.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

test('init recusa rc 2 com email presente e user.name ausente, sem criar runs/', () => {
  const { repoDir, workspace } = setup();
  // O global do host TEM user.name: sem GIT_CONFIG_GLOBAL/SYSTEM apontando para arquivo vazio, o
  // `--unset` local cairia no global e o teste voltaria a depender da maquina — o vicio que o
  // setup() acima paga para evitar. Aqui o cenario e o do operador: email configurado, nome nao.
  git(['config', '--unset', 'user.name'], repoDir);
  const vazio = join(workspace, 'gitconfig-vazio');
  writeFileSync(vazio, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: vazio, GIT_CONFIG_SYSTEM: vazio };
  // A identidade do merge tem DUAS metades: email sozinho passava no init e morria rc 128 no
  // meio do run, tarde demais para o operador entender o que houve.
  assert.throws(() => execFileSync(process.execPath,
    [join(import.meta.dirname, '..', 'run.js'), 'init', '--repo', repoDir, '--workspace', workspace],
    { cwd: workspace, encoding: 'utf8', env }),
    (e) => e.status === 2 && /user\.name/.test(String(e.stderr)));
  assert.equal(existsSync(join(workspace, 'runs')), false);
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

// ---------------------------------------------------------------------------
// Fix round da Task 9 (1eab369) — testes cobrindo I1 (retry vivo, task desconhecida,
// prompt antes do prepare, base.txt por attempt) e I2 (gitIn mudo). O contrato do
// `cli()` é o do `execFileSync`: rc != 0 LANÇA com `.status` (o código do CLI) e
// `.stderr` (a mensagem); as recusas são assertadas aí, não no stdout.

// `cliRaw` é o `cli()` sem a exceção: devolve {status, stdout, stderr} e existe só
// para a I2 — vazar `fatal:` do git no stderr de um start/finish VERDE é invisível
// pelo execFileSync que descarta stdout de sucesso; preciso ler o stderr cru.
function cliRaw(args, cwd) {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'run.js'), ...args],
    { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

test('start de tarefa com dependencia gated mas nao integrada recusa com codigo 2', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  writeFileSync(join(workspace, 'plan.md'), PLAN);
  cli(['plan', '--run', meta.runDir, '--file', join(workspace, 'plan.md')]);
  // I2 na face verde: o start de onda 1 tentava `rev-parse --verify` numa ref que ainda
  // nao existe e o finish tentava `merge-base` com ela — com stderr herdado, todo start
  // e finish de onda 1 imprimia `fatal:` no stderr do CLI. Verde com barulho ainda e
  // barulho: o dry run da Task 13 le stderr como sinal.
  const s = cliRaw(['start', '--run', meta.runDir, '--task', 'T-01']);
  assert.equal(s.status, 0, s.stderr);
  assert.ok(!/fatal/.test(s.stderr), `gitIn vazou stderr do git no start de onda 1: ${s.stderr}`);
  const out = JSON.parse(s.stdout);
  writeFileSync(join(out.workDir, 'styles', 'tokens.css'), ':root { --bg: #fefefe; }\n');
  git(['add', '.'], out.workDir); git(['commit', '-q', '-m', 'tokens'], out.workDir);
  writeFileSync(join(meta.runDir, 'tasks', 'T-01', 'attempt-1', 'report.md'),
    '## Summary\nok\n- touched: styles/tokens.css\n- tokens: 100\n');
  const f = cliRaw(['finish', '--run', meta.runDir, '--task', 'T-01', '--rc', '0']);
  assert.equal(f.status, 0, f.stderr);
  assert.ok(!/fatal/.test(f.stderr), `gitIn vazou stderr do git no finish de onda 1: ${f.stderr}`);
  assert.equal(JSON.parse(f.stdout).ok, true);
  // T-01 esta `gated` — a barragem so abre com `merged`. O `start` de T-02 morre em rc 2.
  assert.throws(() => cli(['start', '--run', meta.runDir, '--task', 'T-02']),
    (e) => e.status === 2 && /rode integrate primeiro/.test(String(e.stderr)));
  assert.equal(existsSync(join(meta.runDir, 'worktrees', 'T-02')), false);
});

test('retry vivo: start --attempt 2 apos gate de onda falho re-corta e sai 0 (I1)', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  const failPlan = join(workspace, 'fail-plan.md');
  writeFileSync(failPlan, `# plano
## T-01 tokens
- paths: styles/**
- depends_on: -
- verify: node -e "process.exit(1)"

## T-02 cabecalho
- paths: components/**
- depends_on: T-01
- verify: -
`);
  cli(['plan', '--run', meta.runDir, '--file', failPlan]);
  const a = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-01']));
  writeFileSync(join(a.workDir, 'styles', 'tokens.css'), ':root { --bg: #fefefe; }\n');
  git(['add', '.'], a.workDir); git(['commit', '-q', '-m', 'tokens'], a.workDir);
  writeFileSync(join(meta.runDir, 'tasks', 'T-01', 'attempt-1', 'report.md'),
    '## Summary\nok\n- touched: styles/tokens.css\n- tokens: 100\n');
  assert.equal(JSON.parse(cli(['finish', '--run', meta.runDir, '--task', 'T-01', '--rc', '0'])).ok, true);
  const integ = JSON.parse(cli(['integrate', '--run', meta.runDir]));
  assert.equal(integ.merged.length, 0, JSON.stringify(integ));
  assert.match(readFileSync(join(meta.runDir, 'status.tsv'), 'utf8'), /T-01\tfailed/);
  // forense deliberado do gate-fail: ref e worktree ficam — e exatamente o cenario em que
  // o `start --attempt 2` do protocolo do operador morria em git fatal rc 1 (I1).
  assert.match(git(['branch', '--list', 'swarm/*'], repoDir), /T-01/);
  const r = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-01', '--attempt', '2']));
  assert.equal(r.task, 'T-01');
  assert.equal(r.attempt, 2);
  assert.match(r.branch, /\/T-01$/);
  assert.ok(existsSync(r.workDir));
  assert.ok(existsSync(join(meta.runDir, 'tasks', 'T-01', 'attempt-2', 'prompt.md')));
  // o re-corte partiu da head da integracao (pos-reset == base do run): base.txt diz isto
  const base2 = readFileSync(join(meta.runDir, 'tasks', 'T-01', 'attempt-2', 'base.txt'), 'utf8').trim();
  assert.equal(base2, git(['rev-parse', 'HEAD'], r.workDir));
  // worktree vivo: escrever e commitar dentro dele funciona (o protocolo de falha completo e da Task 12)
  writeFileSync(join(r.workDir, 'styles', 'novo.css'), '.n { gap: 4px; }\n');
  git(['add', '.'], r.workDir); git(['commit', '-q', '-m', 'retry'], r.workDir);
  assert.match(readFileSync(join(meta.runDir, 'status.tsv'), 'utf8'), /T-01\trunning/);
});

test('start persiste a base cortada em tasks/<id>/attempt-N/base.txt (I1 c)', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  writeFileSync(join(workspace, 'plan.md'), PLAN);
  cli(['plan', '--run', meta.runDir, '--file', join(workspace, 'plan.md')]);
  const out = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-01']));
  const baseFile = join(meta.runDir, 'tasks', 'T-01', 'attempt-1', 'base.txt');
  assert.ok(existsSync(baseFile), 'cmdStart deve gravar a base do corte no attempt-dir');
  const base = readFileSync(baseFile, 'utf8').trim();
  // igual ao HEAD do worktree logo apos o start (sem commit do worker) — e na onda 1 e o
  // baseSha do run por construcao; e isto, nao re-derivacao, que o finish diffar.
  assert.equal(base, git(['rev-parse', 'HEAD'], out.workDir));
  assert.equal(base, meta.baseSha);
});

test('start com --task que nao existe no plano e PlanError com codigo 2 (I1 a)', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  writeFileSync(join(workspace, 'plan.md'), PLAN);
  cli(['plan', '--run', meta.runDir, '--file', join(workspace, 'plan.md')]);
  assert.throws(() => cli(['start', '--run', meta.runDir, '--task', 'T-99']),
    (e) => e.status === 2 && /task nao existe no plano: T-99/.test(String(e.stderr)));
  assert.equal(existsSync(join(meta.runDir, 'worktrees', 'T-99')), false);
});

test('prompt imutavel checado antes do prepare: recusa com use attempt 2 e sem worktree orfa (I1 b)', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  writeFileSync(join(workspace, 'plan.md'), PLAN);
  cli(['plan', '--run', meta.runDir, '--file', join(workspace, 'plan.md')]);
  const a = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-01']));
  // mesmo attempt, sem falha no meio: recusa rc 2 com a dica do attempt seguinte
  assert.throws(() => cli(['start', '--run', meta.runDir, '--task', 'T-01']),
    (e) => e.status === 2 && /use attempt 2/.test(String(e.stderr)));
  // nenhum segundo start aconteceu: uma linha running so, e o worktree segue sendo o primeiro
  const running = readFileSync(join(meta.runDir, 'status.tsv'), 'utf8')
    .split(/\r?\n/).filter((l) => l.startsWith('T-01\trunning'));
  assert.equal(running.length, 1);
  assert.equal(a.workDir, join(meta.runDir, 'worktrees', 'T-01').replaceAll('\\', '/'));
  // tarefa nova com prompt pre-criado: a checagem cai ANTES do prepare — dir ausente apos o throw
  mkdirSync(join(meta.runDir, 'tasks', 'T-02', 'attempt-1'), { recursive: true });
  writeFileSync(join(meta.runDir, 'tasks', 'T-02', 'attempt-1', 'prompt.md'), 'contrabando\n');
  assert.throws(() => cli(['start', '--run', meta.runDir, '--task', 'T-02']),
    (e) => e.status === 2 && /use attempt 2/.test(String(e.stderr)));
  assert.equal(existsSync(join(meta.runDir, 'worktrees', 'T-02')), false);
});

// ---------------------------------------------------------------------------
// Fix ROUND 2 da Task 9 (achado I-residual do re-review do round 1). O retry do `cmdStart`
// chamava `removeWorktree` SO quando o diretorio do worktree existia. Quem roda o
// `git worktree prune` e o `removeWorktree` (lib/isolate.js:88-91), entao com o DIR apagado por
// fora (humano, explorer, antivírus) por um `failed`/`timeout` a inscricao fica stale: o
// `branch -D` falha em silencio (`cannot delete branch ... used by worktree`) e o `prepare`
// reedita `fatal: a branch named ... already exists` — a assinatura exata do I1 original, rc 1.

test('retry com worktree APAGADO POR FORA: attempt 2 sai 0 com worktree novo (round 2)', () => {
  const { repoDir, workspace } = setup();
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  const failPlan = join(workspace, 'fail-plan.md');
  writeFileSync(failPlan, `# plano
## T-01 tokens
- paths: styles/**
- depends_on: -
- verify: node -e "process.exit(1)"

## T-02 cabecalho
- paths: components/**
- depends_on: T-01
- verify: -
`);
  cli(['plan', '--run', meta.runDir, '--file', failPlan]);
  const a = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-01']));
  writeFileSync(join(a.workDir, 'styles', 'tokens.css'), ':root { --bg: #fefefe; }\n');
  git(['add', '.'], a.workDir); git(['commit', '-q', '-m', 'tokens'], a.workDir);
  writeFileSync(join(meta.runDir, 'tasks', 'T-01', 'attempt-1', 'report.md'),
    '## Summary\nok\n- touched: styles/tokens.css\n- tokens: 100\n');
  assert.equal(JSON.parse(cli(['finish', '--run', meta.runDir, '--task', 'T-01', '--rc', '0'])).ok, true);
  const integ = JSON.parse(cli(['integrate', '--run', meta.runDir]));
  assert.equal(integ.merged.length, 0, JSON.stringify(integ));
  assert.match(readFileSync(join(meta.runDir, 'status.tsv'), 'utf8'), /T-01\tfailed/);

  // O cenario: so o DIRETORIO morre — a inscricao do git worktree e a ref ficam (forense).
  const dirAntiga = join(meta.runDir, 'worktrees', 'T-01');
  rmSync(dirAntiga, { recursive: true, force: true });
  assert.equal(existsSync(dirAntiga), false);
  const wtStale = git(['worktree', 'list', '--porcelain'], repoDir);
  assert.match(wtStale, /T-01/, 'a inscricao da worktree precisa continuar la (cenario real)');
  assert.match(wtStale, /prunable/, 'sem inscricao stale nao ha cenario nenhum sendo testado');

  // `start --attempt 2` tem de ser VERDE: removeWorktree incondicional prunea, o `branch -D`
  // passa a pegar a ref e o prepare re-corta sem o fatal.
  const r = cliRaw(['start', '--run', meta.runDir, '--task', 'T-01', '--attempt', '2']);
  assert.equal(r.status, 0, `start attempt 2 morreu: rc=${r.status} stderr=${r.stderr}`);
  assert.ok(!/already exists/.test(r.stderr), `fatal do I1 voltou: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.attempt, 2);
  assert.ok(existsSync(out.workDir), 'o attempt 2 tem de sair com worktree fisicamente nova');
  assert.equal(existsSync(join(meta.runDir, 'tasks', 'T-01', 'attempt-2', 'prompt.md')), true);
  // inscricao limpa: nada prunable sobra no repo
  assert.ok(!/prunable/.test(git(['worktree', 'list', '--porcelain'], repoDir)),
    'o retry deixou inscricao stale no git worktree list');
  // worktree vivo e util: o worker do attempt 2 consegue trabalhar e commitar nele
  writeFileSync(join(out.workDir, 'styles', 'novo.css'), '.n { gap: 4px; }\n');
  git(['add', '.'], out.workDir); git(['commit', '-q', '-m', 'retry round 2'], out.workDir);
  assert.match(readFileSync(join(meta.runDir, 'status.tsv'), 'utf8'), /T-01\trunning/);
});
