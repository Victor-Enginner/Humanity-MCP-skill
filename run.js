#!/usr/bin/env node
// run.js — o único dono do estado do swarm. `start` não faz spawn de processo: prepara worktree +
// prompt e imprime o JSON que o orquestrador (o host) entrega ao subagente. É a decisão de design
// do M1 — o dispatcher é o host, o dono do estado é este CLI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePlan, computeWaves, validateWaves, PlanError } from './lib/plan.js';
import { createLedger, append, rows, latest, stateOf, crashedRuns, stamp } from './lib/ledger.js';
import { initRun, readRun } from './lib/meta.js';
import { prepare, prepareIntegration, integrationPath, branchName, touchedFiles, mergeInOrder, removeWorktree, worktreePath } from './lib/isolate.js';
import { parseReport, scopeCheck } from './lib/report.js';
import { gateTask, gateWave } from './lib/gate.js';
import { loadFloor, loadTheme, repoConventions } from './lib/briefing.js';
import { renderPrompt, writePrompt } from './lib/prompt.js';

export const COMMANDS = ['init', 'plan', 'start', 'finish', 'integrate', 'status', 'abort'];
export const MAX_WORKERS = 3;
const SEED = join(import.meta.dirname, 'seed');

const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');

function opts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  return o;
}

function wavesOf(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'waves.json'), 'utf8'));
}

function tasksOf(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'tasks.json'), 'utf8'));
}

function cmdInit(o) {
  // Pre-checar a identidade do humano (carry-in da Task 4, item i): `integrate` faz merge de
  // produção na worktree de integração, e merge sem identidade morre rc 128 no meio de um run —
  // tarde demais para o operador entender o que houve. Checar aqui, no único momento em que
  // recusar ainda é barato: `git config user.email` e `user.name` resolvem repo-local e global, na
  // ordem do git — as DUAS metades, porque email sozinho também morre rc 128 no merge.
  let email = '';
  try { email = gitIn(o.repo, ['config', 'user.email']); } catch { email = ''; }
  if (!email) {
    throw new PlanError('git config user.email ausente: o merge de producao exige a identidade do humano — configure-a antes de rodar init');
  }
  let name = '';
  try { name = gitIn(o.repo, ['config', 'user.name']); } catch { name = ''; }
  if (!name) {
    throw new PlanError('git config user.name ausente: o merge de producao exige a identidade do humano — configure-a antes de rodar init');
  }
  const meta = initRun({ workspaceRoot: o.workspace, repoDir: o.repo });
  createLedger(meta.runDir);
  out(meta);
  return 0;
}

function cmdPlan(o) {
  const run = readRun(o.run);
  const tasks = parsePlan(readFileSync(o.file, 'utf8'));
  const waves = computeWaves(tasks);
  validateWaves(waves);
  writeFileSync(join(o.run, 'tasks.json'), JSON.stringify(tasks, null, 2) + '\n');
  writeFileSync(join(o.run, 'waves.json'), JSON.stringify(waves.map((w) => w.map((t) => t.id)), null, 0));
  for (const t of tasks) {
    append(o.run, { task: t.id, state: 'planned', rc: null, start: null, end: null,
      branch: branchName(run.runId, t.id), log: null, tokens: null, pid: null });
  }
  out({ tasks: tasks.length, waves: waves.map((w) => w.map((t) => t.id)) });
  return 0;
}

// `gitIn` é o único git que o run.js fala. `execFileSync` SEM shell: com shell, o Git Bash reinterpreta
// `/F` e consome argumentos que eram para o git (o mesmo erro que a gate da Task 7 pagou para aprender).
// Retorna stdout utf8 já trimado — os itens 1 e 2 abaixo leem SHA por aqui, e devolver o buffer cru ou
// engolir a saída (o `stdio: 'ignore'` que o rascunho do `cmdAbort` trazia) quebra os dois caminhos.
// `stdio: ['ignore','pipe','ignore']` (fix round da Task 9, I2 do revisor): os caminhos de catch
// esperados — rev-parse --verify da ref de integração ANTES da onda 1, merge-base sem integração —
// imprimem `fatal: Needed a single revision` no stderr do CLI em todo start/finish de onda 1. O
// dry run da Task 13 lê stderr como sinal e um net zero falso custa mais que um git mudo.
function gitIn(repoDir, args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// Base de diff de UMA tarefa: o commit onde a branch dela nasceu. O VALOR ARMADO é o que `cmdStart`
// persistiu em `attempt-N/base.txt` — re-derivar por merge-base é fallback para runs anteriores à
// emenda, e tem uma janela falsa: depois que a branch da tarefa É a integração (merged, ref ainda
// viva), merge-base devolve o tip da própria tarefa, o diff dá vazio, e a gate diria `ok:true,
// touched:[]` de um trabalho inteiro. Sem integração nem base.txt (onda 1) cai no baseSha do run.
function baseOf(repoDir, run, branch) {
  try {
    return gitIn(repoDir, ['merge-base', branch, `swarm/${run.runId}/integration`]);
  } catch {
    return run.baseSha;
  }
}

function cmdStart(o) {
  const run = readRun(o.run);
  const task = tasksOf(o.run).find((t) => t.id === o.task);
  if (!task) throw new PlanError(`task nao existe no plano: ${o.task}`);
  const attempt = Number(o.attempt ?? 1);
  // Prompt imutável é contrato (Task 8), e o worktree não pode nascer antes da checagem dele:
  // um `start --attempt 1` repetido lançava dentro de writePrompt DEPOIS do prepare e deixava
  // worktree órfã sem linha no ledger. (fix round Task 9, minor do revisor.)
  if (existsSync(join(o.run, 'tasks', task.id, `attempt-${attempt}`, 'prompt.md'))) {
    throw new PlanError(`prompt do attempt ${attempt} de ${task.id} ja existe — use attempt ${attempt + 1}`);
  }
  // Barragem da spec (§ "Ledger como barragem": a onda seguinte só abre quando a atual passa na
  // gate) virada código, não instrução: tarefa com dependência não integrada não ganha worktree.
  const states = stateOf(o.run);
  const faltando = task.dependsOn.filter((d) => states.get(d) !== 'merged');
  if (faltando.length) {
    throw new PlanError(`${task.id}: depende de ${faltando.join(', ')} e nao esta liberada — rode integrate primeiro`);
  }
  // RETRY (fix round Task 9, I1 do revisor — sem isto o `start --attempt N` do protocolo do
  // operador morria em `fatal: a branch ... already exists`): um `failed`/`timeout` deixa ref e
  // worktree de propósito (forense: gate.json e logs ficam), mas o re-corte precisa deles fora.
  // `removeWorktree` INCONDICIONAL (round 2 da mesma revisão, I-residual): quem roda o
  // `git worktree prune` é ele (lib/isolate.js:88-91) e o `existsSync` interno já é dele; gated
  // por existsSync AQUI era o bug — se o humano apagou o diretório por fora a inscrição fica
  // stale, o `branch -D` falha em silêncio ("used by worktree") e o prepare reedita o fatal.
  // O mesmo padrão vale para `dropTask` e `cmdAbort`.
  const estadoAtual = states.get(task.id) ?? 'planned';
  const branchAntiga = branchName(run.runId, task.id);
  if (['failed', 'timeout'].includes(estadoAtual)) {
    removeWorktree({ repoDir: run.repoDir, dir: worktreePath(o.run, task.id) });
    try { gitIn(run.repoDir, ['branch', '-D', branchAntiga]); } catch { /* sem ref: nada a limpar */ }
  }
  // Onda > 1 trabalha SOBRE o que a onda anterior entregou: o worktree sai do head da branch de
  // integração, não do baseSha do run. Sem isto, `depends_on` não entrega nada ao worker além do
  // nome, e a pilha de ondas é teatro. (Achado da Task 8; ver a emenda do prompt dela.)
  // `rev-parse --verify` é quem responde "existe": na primeira onda a ref ainda não foi criada,
  // execFileSync lança, e o base do run é a resposta certa mesmo.
  const integRef = `swarm/${run.runId}/integration`;
  let baseSha = run.baseSha;
  try { baseSha = gitIn(run.repoDir, ['rev-parse', '--verify', integRef]); } catch { /* onda 1 */ }
  const { dir, branch } = prepare({ repoDir: run.repoDir, runDir: o.run, runId: run.runId, taskId: task.id, baseSha });
  // A base do corte vai em arquivo ANTES do prompt: é o que `cmdFinish` diffa, e persistir aqui é
  // o único momento em que o CLI sabe o valor por construção, sem re-derivar.
  const attemptDir = join(o.run, 'tasks', task.id, `attempt-${attempt}`);
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(join(attemptDir, 'base.txt'), `${baseSha}\n`);
  const promptFile = writePrompt({
    runDir: o.run, taskId: task.id, attempt,
    text: renderPrompt({
      task, waveNumber: wavesOf(o.run).findIndex((w) => w.includes(task.id)) + 1,
      run: { workDir: dir.replaceAll('\\', '/'), branch,
        reportPath: join(o.run, 'tasks', task.id, `attempt-${attempt}`, 'report.md').replaceAll('\\', '/') },
      floor: loadFloor(SEED),
      theme: loadTheme(SEED, o.theme ?? 'neutro-editorial'),
      conventions: repoConventions(run.repoDir),
    }),
  });
  append(o.run, { task: task.id, state: 'running', rc: null, start: stamp(), end: null,
    branch, log: promptFile.replaceAll('\\', '/'), tokens: null, pid: null });
  out({ task: task.id, workDir: dir.replaceAll('\\', '/'), branch, prompt: promptFile.replaceAll('\\', '/'), attempt });
  return 0;
}

// `tokenValues` NÃO é opcional de enfeite: `lintCss` (lib/sloplint.js:117) só roda a
// SLOP-OFF-TOKEN-COLOR quando recebe o array, e sem ele a regra que o piso cita em prosa fica
// arquivada sem nunca ter disparado — que foi o achado 2 da Task 8. `null` (arquivo de tokens não
// existe) é diferente de `[]` (tema sem cores): com `[]` toda cor literal vira achado, e num repo
// legado como o `libra` isso reprovaria tarefa por tarefa sem culpa do worker. Por isso o
// `tokenSource` vai junto no `gate.json`: o dry run da Task 13 precisa conseguir dizer quanto da
// gate estava de fato armada.
function cssEntries(o, run, task, files) {
  const tokensRel = (o.tokens ?? 'styles/tokens.css').replaceAll('\\', '/');
  const tokensAbs = join(worktreePath(o.run, task.id), tokensRel);
  const tokenValues = existsSync(tokensAbs)
    ? [...readFileSync(tokensAbs, 'utf8').matchAll(/--[\w-]+\s*:\s*([^;]+);/g)].map((m) => m[1].trim())
    : null;
  const entries = files.filter((f) => f.file.endsWith('.css')).map((f) => ({
    path: f.file,
    tokenValues,
    text: (() => { try { return readFileSync(join(worktreePath(o.run, task.id), f.file), 'utf8'); } catch { return ''; } })(),
  }));
  // `tokenSource` no `gate.json`: sem ele o reador do dry run não distingue "gate de cor armada"
  // de "repo sem tokens.css, regra arquivada" — o achado 2 da Task 8 exatamente.
  return { entries, tokenSource: tokenValues === null ? null : tokensRel };
}

function cmdFinish(o) {
  const run = readRun(o.run);
  const task = tasksOf(o.run).find((t) => t.id === o.task);
  const attempt = Number(o.attempt ?? 1);
  const workDir = worktreePath(o.run, task.id);
  const reportFile = join(o.run, 'tasks', task.id, `attempt-${attempt}`, 'report.md');
  const hasReport = existsSync(reportFile);
  const report = parseReport(hasReport ? readFileSync(reportFile, 'utf8') : '');
  const rc = Number(o.rc ?? 0);
  if (rc !== 0) {
    // 124 é a CONVENÇÃO COM O DISPATCHER (emenda Task 12; Step 2 do plano): o host devolve 124
    // quando mata o agente no tempo dele — aqui o número sozinho É confiável, porque vem do
    // `--rc` que o operador jura ter observado, não da saída crua de execSync. A gate de ONDA é
    // outra coisa e continua chaveando em `build.timedOut` (Task 7 regra 2): lá o 124 de um
    // comando que saiu 124 por conta própria não seria timeout. Qualquer outro rc != 0 -> 'failed'.
    const estado = rc === 124 ? 'timeout' : 'failed';
    append(o.run, { task: task.id, state: estado, rc, start: latest(o.run, task.id).start, end: stamp(),
      branch: task && latest(o.run, task.id).branch, log: reportFile.replaceAll('\\', '/'), tokens: report.tokens, pid: null });
    out({ ok: false, reason: 'worker reportou rc != 0', findings: [] });
    return 0;
  }
  // Consequência obrigatória da emenda do `cmdStart`: uma tarefa de onda > 1 NÃO sai do
  // `run.baseSha`, então diffar contra `run.baseSha` mostraria os arquivos da onda anterior como
  // se o worker tivesse tocado neles — e a gate reprovaria a tarefa certa. A base é o valor que o
  // `cmdStart` cortou, gravado em `attempt-N/base.txt`; `baseOf` (merge-base) fica só como fallback
  // para attempt iniciado antes desta emenda — re-derivar tem a janela falsa do comentário do
  // `baseOf` (branch já dentro da integração → diff vazio → `ok:true` mentindo). (fix round Task 9.)
  const baseFile = join(o.run, 'tasks', task.id, `attempt-${attempt}`, 'base.txt');
  const baseSha = existsSync(baseFile) ? readFileSync(baseFile, 'utf8').trim() : baseOf(run.repoDir, run, latest(o.run, task.id).branch);
  const files = touchedFiles({ workDir, baseSha });
  const scope = scopeCheck({ dirs: task.dirs, files });
  const { entries, tokenSource } = cssEntries(o, run, task, files);
  let gate = gateTask({ scope, cssEntries: entries });
  // Coerção touched (emenda Task 12, item 3): no caminho rc == 0 COM report, o conjunto declarado
  // na linha `- touched:` e o diff real recomposto contra `attempt-N/base.txt` têm de ser o MESMO
  // conjunto, dos dois sentidos: declarado-sem-toque é TOUCHED-DECLARED-NOT-DONE (promessa não
  // cumprida), toque-sem-declarado é TOUCHED-DONE-NOT-DECLARED (trabalho escondido). Um finding
  // por arquivo, com `file`. É achado NOSSO, somado ao veredito da gate — não substitui o
  // scopeCheck: o SCOPE-OUTSIDE-LOT continua a gate própria dele (diff vs LOTE), e um worker pode
  // violar as duas e o JSON traz os dois tipos. Sem report não há declaração a confrontar: a
  // coerção fica muda (o report ausente é caso do rc/dispatcher, não do touched).
  if (hasReport) {
    const declared = new Set(report.touched);
    const real = new Set(files.map((f) => f.file));
    const coercions = [];
    for (const f of report.touched) if (!real.has(f)) coercions.push({
      id: 'TOUCHED-DECLARED-NOT-DONE', file: f, line: null,
      message: 'declarado no - touched: do report mas ausente no diff real do git',
    });
    for (const f of files) if (!declared.has(f.file)) coercions.push({
      id: 'TOUCHED-DONE-NOT-DECLARED', file: f.file, line: null,
      message: 'presente no diff real do git mas ausente no - touched: declarado',
    });
    if (coercions.length) gate = { ...gate, ok: false, findings: [...gate.findings, ...coercions] };
  }
  writeFileSync(join(o.run, 'tasks', task.id, `attempt-${attempt}`, 'gate.json'),
    JSON.stringify({ ...gate, tokenSource, files }, null, 2) + '\n');
  append(o.run, { task: task.id, state: gate.ok ? 'gated' : 'failed', rc: 0,
    start: latest(o.run, task.id).start, end: stamp(), branch: latest(o.run, task.id).branch,
    log: reportFile.replaceAll('\\', '/'), tokens: report.tokens, pid: null });
  out({ ...gate, blocked: report.blocked, touched: files.map((f) => f.file) });
  // O JSON é o protocolo: `ok:false` com findings já É a resposta, e o consumidor (o orquestrador,
  // os fixtures da Task 11) lê o stdout por execFileSync — código de saída 1 aqui faria o chamador
  // tratar como erro de CLI uma veredito de gate perfeitamente reportado. Erro de CLI é exceção
  // (rc 2 em PlanError); veredito, ainda que "não", sai 0.
  return 0;
}

// cmdIntegrate — VERSÃO FINAL (substitui o rascunho do plano, nota de implementação do Step 4 e
// carry-ins da Task 4): UMA passada de mergeInOrder por onda com a pilha reconstruída das tarefas
// ainda `gated` das ondas até aqui (as `merged` já estão no head da integração e suas refs sumiram);
// `gateWave` por onda quando o plano declara `verify`, com `gates/wave-<n>.json`; linhas no ledger
// `merged`/`failed`/`timeout` — `timeout` quando `build.timedOut === true`, e nessa onda NÃO avança
// para `merged`; o catch de erro não-colisão do `mergeInOrder` é deste CLI (carry-in Task 4, ii);
// e as refs `swarm/<runId>/<task>` integradas são apagadas com suas worktrees, com a
// `swarm/<runId>/integration` apagada (detach antes: git recusa apagar ref checkoutada) quando a
// última onda fecha (carry-in Task 4, iii). Onda incompleta não toca a integração: `blockedOn`.
async function cmdIntegrate(o) {
  const run = readRun(o.run);
  const states = stateOf(o.run);
  const waves = wavesOf(o.run);
  const tasks = tasksOf(o.run);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const idOfBranch = new Map(tasks.map((t) => [branchName(run.runId, t.id), t.id]));
  const st = (id) => states.get(id) ?? 'planned';

  const row = (id, state, rc, log) => {
    const prev = latest(o.run, id);
    append(o.run, { task: id, state, rc, start: prev?.start ?? null, end: stamp(),
      branch: branchName(run.runId, id), log, tokens: prev?.tokens ?? null, pid: null });
    states.set(id, state);
  };
  // Apagar ref exige matar a worktree antes: o git recusa `branch -D` de branch checkoutada, e é
  // obrigação deste CLI limpar a refstore (o `git branch` do humano não pode acumular uma linha
  // por tarefa por run). A de integração é a exceção decorada: detach, não remove — o diretório
  // fica com o resultado integrado para o operador e para o e2e da Task 11 lerem.
  // `removeWorktree` sem guard existsSync AQUI também (round 2 Task 9): com o diretório apagado
  // por fora é o prune dele que desfaz a inscrição stale, e sem ela o `branch -D` de baixo
  // falhava em silêncio deixando a ref para trás.
  const dropTask = (id) => {
    removeWorktree({ repoDir: run.repoDir, dir: worktreePath(o.run, id) });
    try { gitIn(run.repoDir, ['branch', '-D', branchName(run.runId, id)]); } catch { /* ref já sumiu */ }
  };

  const merged = [];
  const conflicts = [];
  let blockedOn = null;
  let lastBuild = null;
  let integ = null;
  const ensureInteg = () => {
    if (!integ) {
      integ = existsSync(integrationPath(o.run))
        ? { dir: integrationPath(o.run) }
        : prepareIntegration({ repoDir: run.repoDir, runDir: o.run, runId: run.runId, baseSha: run.baseSha });
    }
    return integ;
  };
  const resetToInteg = (prevHead) => { try { gitIn(integ.dir, ['reset', '--hard', prevHead]); } catch { /* melhor esforço */ } };

  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    // "nenhum merge parcial": a onda só toca a integração quando TODAS as suas tarefas passaram
    // na gate de tarefa. Onda incompleta devolve o primeiro id não-gated e para, sem criar ref.
    const notReady = wave.find((id) => !['gated', 'merged'].includes(st(id)));
    if (notReady) { blockedOn = notReady; break; }
    const gatedNow = wave.filter((id) => st(id) === 'gated');
    if (!gatedNow.length) continue; // onda já fechada em integrate anterior

    ensureInteg();
    const pile = [];
    for (const w of waves.slice(0, i + 1)) for (const id of w) if (st(id) === 'gated') pile.push(id);
    const branches = pile.map((id) => branchName(run.runId, id));
    const prevHead = gitIn(integ.dir, ['rev-parse', 'HEAD']);

    let res;
    try {
      res = mergeInOrder({ integrationDir: integ.dir, branches });
    } catch (e) {
      // Carry-in Task 4 (ii): `mergeInOrder` LANÇA em erro não-colisão (identidade ausente, branch
      // inexistente, repo corrompido) — este CLI é o dono do catch. A pilha volta ao ponto anterior
      // (merges parciais da passada não são integráveis sem a onda toda) e a onda falha por inteiro.
      resetToInteg(prevHead);
      const erro = String(e?.message ?? e).trim();
      conflicts.push({ wave: i + 1, branches, files: [], error: erro });
      for (const id of gatedNow) row(id, 'failed', null, null);
      break;
    }
    for (const c of res.conflicts) conflicts.push({ ...c, task: idOfBranch.get(c.branch) ?? null });
    const okIds = res.merged.map((b) => idOfBranch.get(b)).filter(Boolean);
    const badIds = res.conflicts.map((c) => idOfBranch.get(c.branch)).filter(Boolean);
    for (const id of badIds) row(id, 'failed', null, null);
    if (badIds.length) {
      // Colisão: o `mergeInOrder` NÃO para na branch culpada — ele aborta o merge dela e segue
      // mergeando o resto da pilha (isolate.js:65-84 é a autoridade). `res.merged` é o que entrou,
      // antes E depois da colisão: está no head da integração, vira `merged` e perde a ref; as
      // culpadas viram `failed`. A onda NÃO fechou (tem `failed`), então as seguintes não abrem;
      // o retry (`cmdStart`, fix round I1) re-corta as failed do head atual da integração e o
      // próximo `integrate` mergeia só o que falta — as `merged` já estão dentro, sem ref.
      for (const id of okIds) { row(id, 'merged', null, null); dropTask(id); merged.push(id); }
      break;
    }

    // Gate de onda: só aqui o M1 roda shell, e só quando o plano declarou verify (a primeira
    // verificação declarada da onda). CSS lintido contra a worktree de integração — o estado real
    // que a onda entregou — com os tokens dali, na mesma semântica do item C2 da tarefa.
    const verify = wave.map((id) => byId.get(id)?.verify).find((v) => v) ?? null;
    const gateFile = join(o.run, 'gates', `wave-${i + 1}.json`).replaceAll('\\', '/');
    mkdirSync(join(o.run, 'gates'), { recursive: true });
    const tokensRel = (o.tokens ?? 'styles/tokens.css').replaceAll('\\', '/');
    const tokensAbs = join(integ.dir, tokensRel);
    const tokenValues = existsSync(tokensAbs)
      ? [...readFileSync(tokensAbs, 'utf8').matchAll(/--[\w-]+\s*:\s*([^;]+);/g)].map((m) => m[1].trim())
      : null;
    let gate = { level: 'wave', ok: true, findings: [], build: null };
    if (verify) {
      const touched = gitIn(integ.dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', prevHead, 'HEAD'])
        .split(/\r?\n/).filter(Boolean);
      const cssE = touched.filter((f) => f.endsWith('.css')).map((f) => ({
        path: f,
        tokenValues,
        text: (() => { try { return readFileSync(join(integ.dir, f), 'utf8'); } catch { return ''; } })(),
      }));
      gate = await gateWave({ dir: integ.dir, verify, cssEntries: cssE });
    }
    if (gate.build) lastBuild = gate.build;
    writeFileSync(gateFile, JSON.stringify({ wave: i + 1, verify, ...gate,
      tokenSource: tokenValues === null ? null : tokensRel }, null, 2) + '\n');
    if (gate.ok) {
      for (const id of okIds) { row(id, 'merged', null, gateFile); dropTask(id); merged.push(id); }
      continue;
    }
    // A onda não passou na própria gate: a integração volta ao ponto anterior (uma onda falha
    // não contamina a pilha, e as refs das tarefas ficam para o forense/retry), as linhas saem
    // `timeout` se o build não terminou dentro do prazo — consumidor do estado: Task 12 distingue
    // "quebrou" de "não terminou" — e `failed` senão.
    resetToInteg(prevHead);
    const estado = gate.build && gate.build.timedOut === true ? 'timeout' : 'failed';
    for (const id of okIds) row(id, estado, gate.build ? gate.build.rc : null, gateFile);
    break;
  }

  // Última onda fechada => a ref de integração também sai (detach primeiro; o diretório fica com
  // o resultado — é dele que o e2e da Task 11 e o operador leem a pilha final).
  const allMerged = waves.flat().every((id) => st(id) === 'merged');
  if (allMerged && existsSync(integrationPath(o.run))) {
    const dir = integrationPath(o.run);
    try { gitIn(dir, ['checkout', '--detach']); } catch { /* já detachada */ }
    try { gitIn(run.repoDir, ['branch', '-D', `swarm/${run.runId}/integration`]); } catch { /* já sumiu */ }
  }

  out({ merged, conflicts, ...(blockedOn ? { blockedOn } : {}), ...(lastBuild ? { build: lastBuild } : {}) });
  return 0;
}

function cmdStatus(o) {
  const lines = rows(o.run);
  const width = 8;
  const text = lines.map((r) => `${r.task.padEnd(width)} ${r.state.padEnd(10)} ${r.tokens || ''}`.trimEnd()).join('\n');
  process.stdout.write(text + '\n');
  // Placeholder de M2: toda linha de M1 grava pid:null e o crashedRuns curto-circuita antes daqui — troque quando o pid tracking chegar, ou processo morto vira falso negativo.
  const dead = crashedRuns(o.run, (pid) => pid !== 0 && existsSync(join(o.run, 'worktrees')));
  if (dead.length) out({ crashed: dead.map((r) => r.task) });
  return 0;
}

function cmdAbort(o) {
  const run = readRun(o.run);
  for (const t of tasksOf(o.run)) {
    const dir = worktreePath(o.run, t.id);
    // Sem guard existsSync aqui (round 2 Task 9): removeWorktree prunea a inscrição stale mesmo
    // com o diretório apagado por fora, e o `branch -D` de baixo deixa de falhar em silêncio.
    removeWorktree({ repoDir: run.repoDir, dir });
    // `git worktree remove` NAO apaga a ref: sem isto, o `git branch` do humano acumula
    // uma linha swarm/<runId>/... por tarefa, por run. A refstore e compartilhada por
    // construcao do git, e limpar ela e obrigacao deste CLI, nao do worktree.
    try { gitIn(run.repoDir, ['branch', '-D', branchName(run.runId, t.id)]); } catch { /* nunca nasceu */ }
    append(o.run, { task: t.id, state: 'discarded', rc: null, start: latest(o.run, t.id)?.start ?? null,
      end: stamp(), branch: branchName(run.runId, t.id), log: null, tokens: null, pid: null });
  }
  const integ = integrationPath(o.run);
  // Sem guard existeSync: removeWorktree e quem roda o prune (lib/isolate.js:88-91), e o guard
  // interno dele ja cuida do dir ausente. Sync com o plano (1a71bcb), residual da round 2.
  removeWorktree({ repoDir: run.repoDir, dir: integ });
  try { gitIn(run.repoDir, ['branch', '-D', `swarm/${run.runId}/integration`]); } catch { /* nunca existiu */ }
  out({ aborted: true });
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.includes(cmd)) throw new PlanError(`comando desconhecido: ${cmd} (use ${COMMANDS.join('|')})`);
  const o = opts(rest);
  // B-1 (dry run da Task 13): `--run runs/<id>` relativo fazia o `git worktree add` (cwd = repo
  // alvo) criar o worktree DENTRO do produto, enquanto o prompt prometia o workspace. Caminhos
  // absolutos na fronteira valem para todo comando — repo/workspace tambem sao passados a git/fs
  // cujo cwd nao e o do operador.
  for (const k of ['run', 'repo', 'workspace']) if (o[k]) o[k] = resolve(o[k]);
  const table = { init: cmdInit, plan: cmdPlan, start: cmdStart, finish: cmdFinish,
    integrate: cmdIntegrate, status: cmdStatus, abort: cmdAbort };
  return table[cmd](o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = e instanceof PlanError ? 2 : 1; }
}
