# M1 — Suíte fina de swarm (dispatcher sobre o host) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Executar um swarm de 3 agentes editando um mesmo site em worktrees git isolados, com lotes de diretório declarados e verificados, integração sequencial determinística e gates sem LLM — sem supervisor MCP e sem runtime portátil.

**Architecture:** Um CLI fino em Node (`run.js`) é o único dono do estado: ele valida o plano, cria worktrees, renderiza prompts imutáveis, verifica o que cada worker realmente tocou contra o lote declarado e integra branches em ordem de ondas. Os workers são subagentes do host apontados por caminho absoluto; a fronteira é instrução e a **verificação post-hoc** é o que a torna regra.

**Tech Stack:** Node 24 (ESM puro, `node:test`, `node:assert`), git CLI, zero dependências de runtime, zero step de build.

**Spec:** `docs/superpowers/specs/2026-11-05-swarm-suite-design.md` — este plano implementa **somente o milestone M1** (seção 9 da spec), mais os testes 1-3 da seção 8.

## Global Constraints

- Node >= 20, ESM (`"type": "module"`), **nenhuma dependência externa**, nenhum bundler/transpiler (spec D11).
- Single-writer: **só o CLI escreve** `plan.md`, `waves.json`, `status.tsv`, `run.json`. Worker escreve apenas dentro de `tasks/<id>/attempt-N/` e no próprio worktree (spec D5).
- Worker **nunca** roda `git merge`, `git push`, `git checkout` fora do seu worktree, nem cria branch (spec D4).
- Concorrência = **3**, constante no código, sem flag (spec D9).
- Nada escreve no pendrive; nenhum caminho cai em home da máquina hospedeira. Todo estado sob `runDir`, passado por parâmetro (spec D6).
- O repositório alvo é sempre **parâmetro** (`--repo`), nunca hardcoded.
- Windows 11: sem `/tmp`, sem `date -Is`, sem tmux, sem symlink, sem shell pipes quando `execFileSync` resolver; separadores tratados por `normalize()`.
- Testes com `node --test "test/**/*.test.js"` (**não** `node --test test/`: no Node 24 o argumento de diretório é tratado como um único arquivo de teste e falha). Um commit por tarefa, mensagem em PT-BR no estilo dos commits existentes (`swarm: <o que a tarefa entrega>`).
- Textos de UI e docs em PT-BR; comentários de código só quando o *porquê* não for óbvio.
- Identidade git nos testes: sempre `-c user.email=swarm@test -c user.name=swarm`, nunca depender de config global.

## File Structure

```
tools/SWARM/
  package.json                     # ESM, scripts.test = node --test
  .gitignore                       # runs/, tmp/, node_modules/
  run.js                           # CLI: init plan start finish integrate status abort
  lib/
    paths.js                       # normalize, scopeDir, isAncestor, setsOverlap, ownsFile
    plan.js                        # parsePlan, computeWaves, validateWaves, nextWave
    ledger.js                      # status.tsv append-only, latest, stateOf, crashedRuns
    meta.js                        # run.json: initRun, readRun
    isolate.js                     # worktrees, touchedFiles, mergeInOrder, remoção
    report.js                      # parseReport, scopeCheck
    sloplint.js                    # 4 regras determinísticas com id
    gate.js                        # gateTask (sem toolchain), gateWave (toolchain 1x)
    briefing.js                    # floor, tema, convenções do repo alvo
    prompt.js                      # renderPrompt, writePrompt (imutável)
  skills/
    swarm-orchestrator/SKILL.md    # como planejar, startar, ler ledger, integrar
    swarm-worker/SKILL.md          # contrato do worker: fronteira, commit, report
    swarm-integrator/SKILL.md      # como resolver colisão e reportar regressão
  seed/
    floor.md                       # piso visual inalienável
    themes/verde-fluxo.md
    themes/neutro-editorial.md
    ATTRIBUTION.md                 # MIT/Apache/CC-BY das fontes (spec seção 11)
  test/
    paths.test.js  plan.test.js  ledger.test.js  isolate.test.js
    report.test.js sloplint.test.js gate.test.js  prompt.test.js
    run.test.js    skills.test.js   e2e.test.js   fault.test.js
    fixtures/site/                 # mini-site estático, sem git (o teste cria)
```

Cada módulo tem uma responsabilidade e é testável isoladamente. `run.js` é a única costura que toca disco do mundo real.

---

### Task 1: Base do repositório + `lib/paths.js`

**Files:**
- Create: `package.json`, `.gitignore`, `lib/paths.js`, `test/paths.test.js`

**Interfaces:**
- Produces: `normalize(p: string): string`, `scopeDir(pattern: string): string`, `isAncestor(dir: string, path: string): boolean`, `setsOverlap(dirsA: string[], dirsB: string[]): string[] | null`, `ownsFile(dirs: string[], file: string): boolean`

- [ ] **Step 1: Criar o package.json e o .gitignore**

```json
{
  "name": "swarm-suite",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": { "test": "node --test \"test/**/*.test.js\"" }
}
```

```gitignore
runs/
tmp/
node_modules/
```

- [ ] **Step 2: Escrever os testes que falham**

```js
// test/paths.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, scopeDir, isAncestor, setsOverlap, ownsFile } from '../lib/paths.js';

test('normalize: barra invertida, ./ e barra final', () => {
  assert.equal(normalize('.\\apps/web/'), 'apps/web');
  assert.equal(normalize('apps\\web'), 'apps/web');
});

test('scopeDir: arquivo literal vira o diretorio dele', () => {
  assert.equal(scopeDir('styles/tokens.css'), 'styles');
  assert.equal(scopeDir('index.html'), '.');
});

test('scopeDir: para de cortar no primeiro segmento com wildcard', () => {
  assert.equal(scopeDir('apps/web/app/(frontend)/(marketing)/**'), 'apps/web/app/(frontend)/(marketing)');
  assert.equal(scopeDir('components/header.*'), 'components');
});

test('isAncestor: diretorio e ancestral do arquivo dentro dele, e de si mesmo', () => {
  assert.equal(isAncestor('styles', 'styles/base.css'), true);
  assert.equal(isAncestor('styles', 'styles'), true);
  assert.equal(isAncestor('styles', 'stylesheets/base.css'), false);
  assert.equal(isAncestor('.', 'index.html'), true);
});

test('setsOverlap: par que disputa o mesmo lote volta com os nomes', () => {
  assert.deepEqual(setsOverlap(['apps/web/components'], ['apps/web/components/marketing']),
    ['apps/web/components <-> apps/web/components/marketing']);
  assert.equal(setsOverlap(['apps/web/components'], ['apps/web/messages']), null);
});

test('ownsFile: lote possui tudo dentro, nada fora', () => {
  assert.equal(ownsFile(['apps/web/app/(frontend)/(marketing)'], 'apps/web/app/(frontend)/(marketing)/page.tsx'), true);
  assert.equal(ownsFile(['apps/web/components'], 'apps/web/lib/auth.ts'), false);
});
```

- [ ] **Step 3: Rodar para confirmar falha**

Run: `node --test test/paths.test.js`
Expected: FAIL — `Cannot find module '../lib/paths.js'`

- [ ] **Step 4: Implementar**

```js
// lib/paths.js

export function normalize(p) {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function scopeDir(pattern) {
  const segs = normalize(pattern).split('/');
  const firstWild = segs.findIndex((s) => /[*?]/.test(s));
  if (firstWild === -1) return segs.slice(0, -1).join('/') || '.';
  return segs.slice(0, firstWild).join('/') || '.';
}

export function isAncestor(dir, path) {
  const d = normalize(dir), p = normalize(path);
  if (d === '.') return true;
  return p === d || p.startsWith(d + '/');
}

export function setsOverlap(dirsA, dirsB) {
  const hits = [];
  for (const a of dirsA) for (const b of dirsB) {
    if (isAncestor(a, b) || isAncestor(b, a)) hits.push(`${a} <-> ${b}`);
  }
  return hits.length ? hits : null;
}

export function ownsFile(dirs, file) {
  return dirs.some((d) => isAncestor(d, file));
}
```

- [ ] **Step 5: Rodar para confirmar passagem**

Run: `node --test test/paths.test.js`
Expected: PASS (6 testes)

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore lib/paths.js test/paths.test.js
git commit -m "swarm: base do repo e posse de lote por diretorio"
```

---

### Task 2: `lib/plan.js` — parse, ondas, validação de lotes

**Files:**
- Create: `lib/plan.js`, `test/plan.test.js`

**Interfaces:**
- Consumes: `scopeDir`, `setsOverlap` de `lib/paths.js`
- Produces: `class PlanError`; `parsePlan(md: string): Task[]`; `computeWaves(tasks: Task[]): Task[][]`; `validateWaves(waves: Task[][]): void` (lança `PlanError`); `nextWave(tasks: Task[], states: Map<string,string>): Task[]`. `Task = { id: string, title: string, dirs: string[], dependsOn: string[], verify: string | null }`

- [ ] **Step 1: Escrever os testes que falham**

```js
// test/plan.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanError, parsePlan, computeWaves, validateWaves, nextWave } from '../lib/plan.js';

const MD = `# plano

## T-01 tokens de cor
- paths: styles/tokens.css
- depends_on: -
- verify: node build.mjs

## T-02 cabecalho
- paths: components/header.*, styles/header.css
- depends_on: T-01
- verify: -

## T-03 rodape
- paths: components/footer/**
- depends_on: T-01
- verify: -
`;

test('parsePlan le tarefas, dependencias e lote', () => {
  const tasks = parsePlan(MD);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks[1].dirs, ['components/header', 'styles']);
  assert.deepEqual(tasks[1].dependsOn, ['T-01']);
  assert.equal(tasks[0].verify, 'node build.mjs');
  assert.equal(tasks[2].verify, null);
});

test('parsePlan: sem tarefa lanca PlanError', () => {
  assert.throws(() => parsePlan('# nada aqui'), PlanError);
});

test('parsePlan: dependencia inexistente lanca PlanError', () => {
  assert.throws(() => parsePlan('## T-01 x\n- paths: a\n- depends_on: T-99\n'), PlanError);
});

test('parsePlan: lote vazio lanca PlanError', () => {
  assert.throws(() => parsePlan('## T-01 x\n- paths: -\n'), PlanError);
});

test('computeWaves agrupa T-02 e T-03 na onda 2', () => {
  const waves = computeWaves(parsePlan(MD));
  assert.deepEqual(waves.map((w) => w.map((t) => t.id)), [['T-01'], ['T-02', 'T-03']]);
});

test('computeWaves: ciclo lanca PlanError', () => {
  const md = '## T-01 a\n- paths: x\n- depends_on: T-02\n\n## T-02 b\n- paths: y\n- depends_on: T-01\n';
  assert.throws(() => computeWaves(parsePlan(md)), /ciclo/);
});

test('validateWaves: tarefas da mesma onda nao podem disputar diretorio', () => {
  const md = '## T-01 a\n- paths: styles/base.css\n- depends_on: -\n\n## T-02 b\n- paths: styles/tokens.css\n- depends_on: -\n';
  assert.throws(() => validateWaves(computeWaves(parsePlan(md))), /disputam/);
});

test('validateWaves: lote raiz exige onda sozinha', () => {
  const md = '## T-01 a\n- paths: index.html\n- depends_on: -\n\n## T-02 b\n- paths: styles\n- depends_on: -\n';
  assert.throws(() => validateWaves(computeWaves(parsePlan(md))), /onda 1/);
});

test('validateWaves aceita o plano canonicos', () => {
  assert.doesNotThrow(() => validateWaves(computeWaves(parsePlan(MD))));
});

test('nextWave devolve o que esta desbloqueado dado o estado atual', () => {
  const tasks = parsePlan(MD);
  assert.deepEqual(nextWave(tasks, new Map([['T-01', 'planned']])).map((t) => t.id), ['T-01']);
  assert.deepEqual(nextWave(tasks, new Map([['T-01', 'gated']])).map((t) => t.id), ['T-02', 'T-03']);
  assert.deepEqual(nextWave(tasks, new Map([['T-01', 'failed']])).map((t) => t.id), []);
});
```

- [ ] **Step 2: Rodar para confirmar falha**

Run: `node --test test/plan.test.js`
Expected: FAIL — `Cannot find module '../lib/plan.js'`

- [ ] **Step 3: Implementar**

```js
// lib/plan.js
import { scopeDir, setsOverlap } from './paths.js';

export class PlanError extends Error {}

const HEADING = /^## (T-\d{2,})\s+(.+)$/;
const FIELD = /^-\s+(paths|depends_on|verify):\s*(.*)$/;
const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

export function parsePlan(md) {
  const tasks = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(HEADING);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), dirs: [], dependsOn: [], verify: null };
      tasks.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = line.match(FIELD);
    if (!f) continue;
    const v = f[2].trim();
    if (f[1] === 'paths') cur.dirs = list(v).map(scopeDir);
    else if (f[1] === 'depends_on') cur.dependsOn = v === '-' ? [] : list(v);
    else cur.verify = v === '-' ? null : v;
  }
  if (!tasks.length) throw new PlanError('plano sem tarefas: use "## T-01 <titulo>"');
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) throw new PlanError('id de tarefa duplicado');
  for (const t of tasks) {
    if (!t.dirs.length) throw new PlanError(`${t.id}: campo paths vazio — declare o lote`);
    for (const d of t.dependsOn) if (!ids.has(d)) throw new PlanError(`${t.id}: depende de ${d}, que nao existe`);
  }
  return tasks;
}

export function computeWaves(tasks) {
  const placed = new Set();
  const waves = [];
  while (placed.size < tasks.length) {
    const ready = tasks.filter((t) => !placed.has(t.id) && t.dependsOn.every((d) => placed.has(d)));
    if (!ready.length) {
      throw new PlanError(`ciclo de dependencia: ${tasks.filter((t) => !placed.has(t.id)).map((t) => t.id).join(', ')}`);
    }
    waves.push(ready);
    for (const t of ready) placed.add(t.id);
  }
  return waves;
}

export function validateWaves(waves) {
  const problems = [];
  waves.forEach((wave, i) => {
    for (let a = 0; a < wave.length; a++) {
      for (let b = a + 1; b < wave.length; b++) {
        const hits = setsOverlap(wave[a].dirs, wave[b].dirs);
        if (hits) problems.push(`onda ${i + 1}: ${wave[a].id} e ${wave[b].id} disputam ${hits.join(', ')}`);
      }
    }
    if (wave.length > 1 && wave.some((t) => t.dirs.includes('.'))) {
      problems.push(`onda ${i + 1}: quem declara o lote raiz ('.') precisa de onda sozinho`);
    }
  });
  if (problems.length) throw new PlanError(problems.join(' | '));
}

const CONCLUIDA = new Set(['gated', 'merged']);

export function nextWave(tasks, states) {
  const state = (id) => states.get(id) ?? 'planned';
  return tasks.filter((t) =>
    !CONCLUIDA.has(state(t.id)) && t.dependsOn.every((d) => CONCLUIDA.has(state(d))));
}
```

- [ ] **Step 4: Rodar para confirmar passagem**

Run: `node --test test/plan.test.js`
Expected: PASS (10 testes)

- [ ] **Step 5: Commit**

```bash
git add lib/plan.js test/plan.test.js
git commit -m "swarm: parse de plano, ondas e recusa de lote disputado"
```

---

### Task 3: `lib/ledger.js` — status.tsv single-writer

**Files:**
- Create: `lib/ledger.js`, `test/ledger.test.js`

**Interfaces:**
- Consumes: nada
- Produces: `STATES: string[]`, `COLS: string[]`, `createLedger(runDir): string`, `append(runDir, row): void`, `rows(runDir): Row[]`, `latest(runDir, taskId): Row | null`, `stateOf(runDir): Map<string,string>`, `crashedRuns(runDir, isAlive: (pid:number)=>boolean): Row[]`. `Row` tem uma chave por coluna em `COLS`.

- [ ] **Step 1: Escrever os testes que falham**

```js
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
```

- [ ] **Step 2: Rodar para confirmar falha**

Run: `node --test test/ledger.test.js`
Expected: FAIL — `Cannot find module '../lib/ledger.js'`

- [ ] **Step 3: Implementar**

```js
// lib/ledger.js
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COLS = ['task', 'state', 'rc', 'start', 'end', 'branch', 'log', 'tokens', 'pid'];
export const STATES = ['planned', 'running', 'reported', 'gated', 'merged', 'failed', 'timeout', 'crashed', 'discarded'];

const file = (runDir) => join(runDir, 'status.tsv');
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function createLedger(runDir) {
  mkdirSync(runDir, { recursive: true });
  const p = file(runDir);
  if (existsSync(p)) throw new Error(`ledger ja existe em ${p} — single-writer nao recria`);
  writeFileSync(p, COLS.join('\t') + '\n');
  return p;
}

export function append(runDir, row) {
  const missing = COLS.filter((c) => !(c in row));
  if (missing.length) throw new Error(`linha sem colunas ${missing.join(',')} — use null explicito`);
  if (!STATES.includes(row.state)) throw new Error(`estado invalido: ${row.state}`);
  if (!existsSync(file(runDir))) throw new Error(`sem ledger em ${file(runDir)}`);
  const line = COLS.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return '';
    return String(v).replaceAll('\t', ' ').replaceAll('\n', ' ');
  });
  appendFileSync(file(runDir), line.join('\t') + '\n');
}

export function rows(runDir) {
  if (!existsSync(file(runDir))) throw new Error(`sem ledger em ${file(runDir)}`);
  return readFileSync(file(runDir), 'utf8').trimEnd().split(/\r?\n/).slice(1)
    .map((l) => Object.fromEntries(COLS.map((c, i) => [c, l.split('\t')[i] ?? ''])));
}

export function latest(runDir, taskId) {
  return rows(runDir).filter((r) => r.task === taskId).at(-1) ?? null;
}

export function stateOf(runDir) {
  const m = new Map();
  for (const r of rows(runDir)) m.set(r.task, r.state);
  return m;
}

export function crashedRuns(runDir, isAlive) {
  const last = new Map();
  for (const r of rows(runDir)) last.set(r.task, r);
  return [...last.values()].filter((r) => r.state === 'running' && !isAlive(Number(r.pid)));
}
```

- [ ] **Step 4: Usar `now()` no CLI (Task 9 grava start/end)**

Expor `export const stamp = now;` ao final do arquivo para o `run.js` não reinventar formato de data.

- [ ] **Step 5: Rodar para confirmar passagem**

Run: `node --test test/ledger.test.js`
Expected: PASS (7 testes)

- [ ] **Step 6: Commit**

```bash
git add lib/ledger.js test/ledger.test.js
git commit -m "swarm: ledger append-only single-writer com deteccao de crash"
```

---

### Task 4: `lib/meta.js` + `lib/isolate.js` — worktrees e integração sem tocar o checkout do usuário

**Files:**
- Create: `lib/meta.js`, `lib/isolate.js`, `test/isolate.test.js`

**Interfaces:**
- Consumes: git CLI, `runDir` de Task 3
- Produces: `initRun({ workspaceRoot, repoDir }): RunMeta`, `readRun(runDir): RunMeta` com `RunMeta = { runId, repoDir, baseSha, createdAt }`; `branchName(runId, taskId)`, `worktreePath(runDir, taskId)`, `integrationPath(runDir)`, `prepare({ repoDir, runDir, runId, taskId, baseSha }): { dir, branch }`, `prepareIntegration({...}): { dir, branch }`, `touchedFiles({ workDir, baseSha }): { status: string, file: string }[]`, `mergeInOrder({ integrationDir, branches }): { merged: string[], conflicts: { branch, files: string[] }[] }`, `removeWorktree({ repoDir, dir }): void`

- [ ] **Step 1: Escrever os testes que falham**

```js
// test/isolate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun, readRun, prepare, touchedFiles, prepareIntegration, mergeInOrder, removeWorktree, branchName } from '../lib/isolate.js';

const G = ['-c', 'user.email=swarm@test', '-c', 'user.name=swarm'];
const git = (args, cwd) => execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), 'swarm-repo-'));
  git(['init', '-q', '-b', 'main'], repoDir);
  mkdirSync(join(repoDir, 'styles'), { recursive: true });
  writeFileSync(join(repoDir, 'styles', 'tokens.css'), ':root { --bg: oklch(0.98 0.01 250); }\n');
  writeFileSync(join(repoDir, 'index.html'), '<h1>base</h1>\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'base'], repoDir);
  return repoDir;
}

test('initRun grava run.json com o sha base', () => {
  const repoDir = makeRepo();
  const runDir = join(repoDir, '..', 'swarm-run');
  mkdirSync(runDir, { recursive: true });
  const meta = initRun({ workspaceRoot: runDir, repoDir });
  assert.equal(meta.baseSha, git(['rev-parse', 'HEAD'], repoDir));
  assert.equal(readRun(runDir).runId, meta.runId);
});

test('prepare cria worktree em branch propria e nao mexe no HEAD do usuario', () => {
  const repoDir = makeRepo();
  const headBefore = git(['rev-parse', 'HEAD'], repoDir);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
  const runDir = mkdtempSync(join(tmpdir(), 'swarm-run-'));
  const { dir } = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: headBefore });
  assert.ok(dir.endsWith(join('worktrees', 'T-01')));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), branchName('r1', 'T-01'));
  assert.equal(git(['rev-parse', 'HEAD'], repoDir), headBefore);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), branch);
});

test('touchedFiles ve commit e ve trabalho nao commitado', () => {
  const repoDir = makeRepo();
  const base = git(['rev-parse', 'HEAD'], repoDir);
  const runDir = mkdtempSync(join(tmpdir(), 'swarm-run-'));
  const { dir } = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: base });
  writeFileSync(join(dir, 'styles', 'header.css'), 'h { margin: 3px }\n');
  writeFileSync(join(dir, 'index.html'), '<h1>editado</h1>\n');
  git(['add', 'styles/header.css'], dir);
  git(['commit', '-q', '-m', 'worker'], dir);
  writeFileSync(join(dir, 'styles', 'novo.css'), '.x { padding: 8px }\n');
  const files = touchedFiles({ workDir: dir, baseSha: base }).map((f) => f.file).sort();
  assert.deepEqual(files, ['styles/header.css', 'styles/novo.css'].sort());
});

test('mergeInOrder integra duas branches disjuntas e detecta a colidida', () => {
  const repoDir = makeRepo();
  const base = git(['rev-parse', 'HEAD'], repoDir);
  const runDir = mkdtempSync(join(tmpdir(), 'swarm-run-'));
  const a = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: base });
  const b = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-02', baseSha: base });
  writeFileSync(join(a.dir, 'styles', 'tokens.css'), ':root { --bg: oklch(0.9 0.02 250); }\n');
  git(['add', '.'], a.dir); git(['commit', '-q', '-m', 'a'], a.dir);
  writeFileSync(join(b.dir, 'components', 'x.css'), '.x { padding: 8px }\n');
  mkdirSync(join(b.dir, 'components'), { recursive: true });
  writeFileSync(join(b.dir, 'components', 'x.css'), '.x { padding: 8px }\n');
  git(['add', '.'], b.dir); git(['commit', '-q', '-m', 'b'], b.dir);

  const integ = prepareIntegration({ repoDir, runDir, runId: 'r1', baseSha: base });
  const ok = mergeInOrder({ integrationDir: integ.dir, branches: [a.branch, b.branch] });
  assert.deepEqual(ok.conflicts, []);
  assert.equal(ok.merged.length, 2);

  const c = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-03', baseSha: base });
  writeFileSync(join(c.dir, 'index.html'), '<h1>de outro lado</h1>\n');
  git(['add', '.'], c.dir); git(['commit', '-q', '-m', 'c'], c.dir);
  writeFileSync(join(integ.dir, 'index.html'), '<h1>de um lado</h1>\n');
  git(['add', '.'], integ.dir); git(['commit', '-q', '-m', 'integ'], integ.dir);
  const colid = mergeInOrder({ integrationDir: integ.dir, branches: [c.branch] });
  assert.equal(colid.merged.length, 0);
  assert.deepEqual(colid.conflicts[0].files, ['index.html']);
});

test('removeWorktree apaga o diretorio e faz prune', () => {
  const repoDir = makeRepo();
  const base = git(['rev-parse', 'HEAD'], repoDir);
  const runDir = mkdtempSync(join(tmpdir(), 'swarm-run-'));
  const { dir } = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: base });
  removeWorktree({ repoDir, dir });
  assert.equal(existsSync(dir), false);
  assert.match(git(['worktree', 'list'], repoDir), /main/);
});
```

- [ ] **Step 2: Rodar para confirmar falha**

Run: `node --test test/isolate.test.js`
Expected: FAIL — `Cannot find module '../lib/isolate.js'`

- [ ] **Step 3: Implementar `lib/meta.js`**

```js
// lib/meta.js
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function initRun({ workspaceRoot, repoDir }) {
  const runId = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 4)}`;
  const runDir = join(workspaceRoot, 'runs', runId);
  const baseSha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const meta = { runId, repoDir: repoDir.replaceAll('\\', '/'), baseSha, createdAt: new Date().toISOString() };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(meta, null, 2) + '\n');
  return { ...meta, runDir };
}

export function readRun(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
}
```

- [ ] **Step 4: Implementar `lib/isolate.js`**

```js
// lib/isolate.js
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export const branchName = (runId, taskId) => `swarm/${runId}/${taskId}`;
export const worktreePath = (runDir, taskId) => join(runDir, 'worktrees', taskId);
export const integrationPath = (runDir) => join(runDir, 'worktrees', '_integration');

function add({ repoDir, dir, branch, baseSha }) {
  mkdirSync(join(dir, '..'), { recursive: true });
  git(['worktree', 'add', '-b', branch, dir, baseSha], repoDir);
}

export function prepare({ repoDir, runDir, runId, taskId, baseSha }) {
  const dir = worktreePath(runDir, taskId);
  const branch = branchName(runId, taskId);
  add({ repoDir, dir, branch, baseSha });
  return { dir, branch };
}

export function prepareIntegration({ repoDir, runDir, runId, baseSha }) {
  const dir = integrationPath(runDir);
  const branch = branchName(runId, 'integration');
  add({ repoDir, dir, branch, baseSha });
  return { dir, branch };
}

export function touchedFiles({ workDir, baseSha }) {
  const found = new Map();
  for (const line of git(['diff', '--name-status', baseSha, 'HEAD'], workDir).split(/\r?\n/).filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    found.set(rest[0], { status: status[0], file: rest[0] });
  }
  for (const line of git(['status', '--porcelain'], workDir).split(/\r?\n/).filter(Boolean)) {
    const code = line.slice(0, 2), file = line.slice(3).trim();
    if (found.has(file)) continue;
    found.set(file, { status: code.includes('A') || code === '??' ? 'A' : code.trim()[0], file });
  }
  return [...found.values()];
}

export function mergeInOrder({ integrationDir, branches }) {
  const merged = [], conflicts = [];
  for (const branch of branches) {
    try {
      git(['merge', '--no-edit', branch], integrationDir);
      merged.push(branch);
    } catch {
      const files = git(['diff', '--name-only', '--diff-filter=U'], integrationDir)
        .split(/\r?\n/).filter(Boolean);
      git(['merge', '--abort'], integrationDir);
      conflicts.push({ branch, files });
    }
  }
  return { merged, conflicts };
}

export function removeWorktree({ repoDir, dir }) {
  if (existsSync(dir)) git(['worktree', 'remove', '--force', dir], repoDir);
  git(['worktree', 'prune'], repoDir);
}
```

- [ ] **Step 5: Rodar para confirmar passagem**

Run: `node --test test/isolate.test.js`
Expected: PASS (5 testes)

- [ ] **Step 6: Commit**

```bash
git add lib/meta.js lib/isolate.js test/isolate.test.js
git commit -m "swarm: worktree por tarefa e integracao sem tocar o checkout do usuario"
```

---

### Task 5: `lib/report.js` — o que o worker diz vs o que ele fez

**Files:**
- Create: `lib/report.js`, `test/report.test.js`

**Interfaces:**
- Consumes: `ownsFile` de `lib/paths.js`
- Produces: `parseReport(md): { touched: string[], tokens: number | null, summary: string, blocked: string | null }`, `scopeCheck({ dirs, files }): { ok: boolean, violations: { file, status, reason }[] }`

- [ ] **Step 1: Escrever os testes que falham**

```js
// test/report.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, scopeCheck } from '../lib/report.js';

const MD = `## Summary
Header novo com nav acessivel.
- touched: styles/header.css, components/header.js
- tokens: 4200
## Notes
Faltou token de foco.
## Blocked
Preciso de --focus-ring em styles/tokens.css, que nao e meu lote.
`;

test('parseReport le touched, tokens, summary e blocked', () => {
  const r = parseReport(MD);
  assert.deepEqual(r.touched, ['styles/header.css', 'components/header.js']);
  assert.equal(r.tokens, 4200);
  assert.match(r.summary, /nav acessivel/);
  assert.match(r.blocked, /--focus-ring/);
});

test('parseReport tolera report sem blocked e sem tokens', () => {
  const r = parseReport('## Summary\nso isso\n- touched: a.css\n');
  assert.equal(r.blocked, null);
  assert.equal(r.tokens, null);
});

test('scopeCheck aprova arquivo dentro do lote, inclusive novo', () => {
  const r = scopeCheck({ dirs: ['styles'], files: [{ status: 'A', file: 'styles/novo.css' }] });
  assert.equal(r.ok, true);
});

test('scopeCheck reprova modificacione fora do lote', () => {
  const r = scopeCheck({ dirs: ['components'], files: [{ status: 'M', file: 'styles/tokens.css' }] });
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /fora do lote/);
});

test('scopeCheck reprova criacao fora do lote', () => {
  const r = scopeCheck({ dirs: ['components'], files: [{ status: 'A', file: 'app/page.tsx' }] });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].status, 'A');
});

test('scopeCheck junta violacoes de dois tipos', () => {
  const r = scopeCheck({ dirs: ['styles'], files: [
    { status: 'M', file: 'index.html' }, { status: 'A', file: 'x/y.css' },
  ] });
  assert.equal(r.violations.length, 2);
});
```

- [ ] **Step 2: Rodar para confirmar falha**

Run: `node --test test/report.test.js`
Expected: FAIL — `Cannot find module '../lib/report.js'`

- [ ] **Step 3: Implementar**

```js
// lib/report.js
import { ownsFile } from './paths.js';

const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

export function parseReport(md) {
  const touched = /^-\s+touched:\s*(.*)$/m.exec(md);
  const tokens = /^-\s+tokens:\s*(\d+)/m.exec(md);
  const summary = /^## Summary\s*\n([\s\S]*?)(?=\n##\s|$)/m.exec(md);
  const blocked = /^## Blocked\s*\n([\s\S]*?)(?=\n##\s|$)/m.exec(md);
  return {
    touched: touched ? list(touched[1]) : [],
    tokens: tokens ? Number(tokens[1]) : null,
    summary: summary ? summary[1].trim() : '',
    blocked: blocked ? blocked[1].trim() : null,
  };
}

export function scopeCheck({ dirs, files }) {
  const violations = files
    .filter((f) => !ownsFile(dirs, f.file))
    .map((f) => ({
      file: f.file,
      status: f.status,
      reason: f.status === 'A' ? 'criado fora do lote declarado' : 'modificado fora do lote declarado',
    }));
  return { ok: violations.length === 0, violations };
}
```

- [ ] **Step 4: Rodar para confirmar passagem**

Run: `node --test test/report.test.js`
Expected: PASS (6 testes)

- [ ] **Step 5: Commit**

```bash
git add lib/report.js test/report.test.js
git commit -m "swarm: report do worker e checagem de lote pelo diff real"
```

---

### Task 6: `lib/sloplint.js` — 4 regras determinísticas com id

**Files:**
- Create: `lib/sloplint.js`, `test/sloplint.test.js`

**Interfaces:**
- Consumes: nada
- Produces: `RULES: { id: string, why: string }[]`, `lintCss(css: string, { file, tokenValues }): Finding[]`, `lintFiles(entries: { path, text, tokenValues? }[]): Finding[]`. `Finding = { id, file, line, message }`

Regras (spec seção 6 degrau 2; rule-set próprio, informado por `hallmark/sloplint.mjs` MIT e pelo detector `impeccable` Apache-2.0 — atribuição em `seed/ATTRIBUTION.md`):

| id | Detecta |
|---|---|
| `SLOP-PURPLE-GRADIENT` | `linear-gradient` com stop roxo/violeta/índigo |
| `SLOP-EYEBROW-CAPS` | bloco com `text-transform: uppercase` + `letter-spacing` largo |
| `SLOP-SPACING-RHYTHM` | `margin`/`padding`/`gap` em px múltiplo de 4 (ignora 0 e `border`) |
| `SLOP-OFF-TOKEN-COLOR` | cor hexadecimal que não está nos tokens do tema |

- [ ] **Step 1: Escrever os testes que falham**

```js
// test/sloplint.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, lintCss, lintFiles } from '../lib/sloplint.js';

const ids = (f) => f.map((x) => x.id);

test('SLOP-PURPLE-GRADIENT pega gradiente roxo, nao pega cinza', () => {
  const bad = lintCss('.hero { background: linear-gradient(135deg, #6366f1, #a855f7); }', { file: 'a.css' });
  assert.deepEqual(ids(bad), ['SLOP-PURPLE-GRADIENT']);
  assert.equal(bad[0].line, 1);
  assert.deepEqual(lintCss('.x { background: linear-gradient(180deg, #101010, #202020); }'), []);
});

test('SLOP-EYEBROW-CAPS: caps + letter-spacing largo; caps sozinho passa', () => {
  assert.deepEqual(ids(lintCss('.k { text-transform: uppercase; letter-spacing: 0.12em; }')), ['SLOP-EYEBROW-CAPS']);
  assert.deepEqual(ids(lintCss('.k { text-transform: uppercase; letter-spacing: 0.01em; }')), []);
  assert.deepEqual(ids(lintCss('.k { text-transform: uppercase; }')), []);
  assert.deepEqual(ids(lintCss('.k { text-transform: uppercase; letter-spacing: 3px; }')), ['SLOP-EYEBROW-CAPS']);
});

test('SLOP-SPACING-RHYTHM: 3px e 13px fora; 0, 8px e 1.5rem passam; border passa', () => {
  assert.deepEqual(ids(lintCss('.a { margin-top: 3px; }')), ['SLOP-SPACING-RHYTHM']);
  assert.deepEqual(ids(lintCss('.a { padding: 8px 1.5rem 0; }')), []);
  assert.deepEqual(ids(lintCss('.a { gap: 13px; }')), ['SLOP-SPACING-RHYTHM']);
  assert.deepEqual(ids(lintCss('.a { border: 3px solid red; }')), []);
});

test('SLOP-OFF-TOKEN-COLOR: so roda com tokens; hex proprio da declaracao de token passa', () => {
  const toks = ['oklch(0.98 0.01 250)', '#101010'];
  assert.deepEqual(ids(lintCss('.a { color: #ff0055; }', { tokenValues: toks })), ['SLOP-OFF-TOKEN-COLOR']);
  assert.deepEqual(ids(lintCss('.a { color: #101010; }', { tokenValues: toks })), []);
  assert.deepEqual(ids(lintCss('.a { color: #101010; }')), []);
  assert.deepEqual(ids(lintCss(':root { --ink: #ff0055; }', { tokenValues: [] })), []);
});

test('lintFiles so olha css e carrega o path no achado', () => {
  const f = lintFiles([
    { path: 'styles/a.css', text: '.a { gap: 3px }' },
    { path: 'app.js', text: '.a { gap: 3px }' },
  ]);
  assert.equal(f.length, 1);
  assert.equal(f[0].file, 'styles/a.css');
});

test('toda regra tem id e motivo', () => {
  assert.equal(RULES.length, 4);
  for (const r of RULES) assert.ok(r.id.startsWith('SLOP-') && r.why.length > 10);
});
```

- [ ] **Step 2: Rodar para confirmar falha**

Run: `node --test test/sloplint.test.js`
Expected: FAIL — `Cannot find module '../lib/sloplint.js'`

- [ ] **Step 3: Implementar**

```js
// lib/sloplint.js
const PURPLE = /(purple|violet|indigo|#7c3aed|#8b5cf6|#a855f7|#6366f1|#9333ea)/i;

export const RULES = [
  { id: 'SLOP-PURPLE-GRADIENT', why: 'gradiente roxo/indigo e a assinatura visual de template gerado por IA' },
  { id: 'SLOP-EYEBROW-CAPS', why: 'rotulo em caps com letter-spacing largo e o tique do eyebrow de landing page' },
  { id: 'SLOP-SPACING-RHYTHM', why: 'espacamento fora da escala de 4 rompe o ritmo vertical' },
  { id: 'SLOP-OFF-TOKEN-COLOR', why: 'cor literal que nao esta nos tokens do tema divergiu porque ninguem olhou' },
];

const find = (out, id, file, line, message) => out.push({ id, file, line, message });

export function lintCss(css, { file = '(css)', tokenValues = null } = {}) {
  const out = [];
  const lines = css.split(/\r?\n/);

  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const line = css.slice(0, m.index).split('\n').length;
    const body = m[2];
    if (/linear-gradient/i.test(body) && PURPLE.test(body)) {
      find(out, 'SLOP-PURPLE-GRADIENT', file, line, 'gradiente com stop roxo/indigo');
    }
    const caps = /text-transform:\s*uppercase/i.test(body);
    const ls = /letter-spacing:\s*(-?[\d.]+)(em|rem|px)/i.exec(body);
    if (caps && ls) {
      const v = Number(ls[1]);
      const wide = ls[2] === 'px' ? v >= 1 : v >= 0.05;
      if (wide) find(out, 'SLOP-EYEBROW-CAPS', file, line, 'uppercase + letter-spacing largo');
    }
  }

  lines.forEach((raw, i) => {
    if (/border/.test(raw)) return;
    const d = /(?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|bottom|left|right|inline|block))?\s*:\s*([^;]+);/i.exec(raw);
    if (!d) return;
    const off = [...d[1].matchAll(/([\d.]+)px/g)].map((x) => Number(x[1])).filter((v) => v !== 0 && v % 4 !== 0);
    if (off.length) find(out, 'SLOP-SPACING-RHYTHM', file, i + 1, `fora da escala de 4: ${off.join(', ')}px`);
  });

  if (tokenValues) {
    const known = new Set(tokenValues.map((v) => String(v).toLowerCase()));
    lines.forEach((raw, i) => {
      if (/^\s*--/.test(raw)) return;
      for (const h of raw.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        if (!known.has(h[0].toLowerCase())) find(out, 'SLOP-OFF-TOKEN-COLOR', file, i + 1, `${h[0]} nao esta nos tokens`);
      }
    });
  }
  return out;
}

export function lintFiles(entries) {
  return entries
    .filter((e) => e.path.endsWith('.css'))
    .flatMap((e) => lintCss(e.text, { file: e.path, tokenValues: e.tokenValues ?? null }));
}
```

- [ ] **Step 4: Rodar para confirmar passagem**

Run: `node --test test/sloplint.test.js`
Expected: PASS (6 testes)

- [ ] **Step 5: Commit**

```bash
git add lib/sloplint.js test/sloplint.test.js
git commit -m "swarm: sloplint com quatro regras deterministicas"
```

---

### Task 7: `lib/gate.js` — gate de tarefa sem toolchain, gate de onda com toolchain uma vez

**Files:**
- Create: `lib/gate.js`, `test/gate.test.js`

**Interfaces:**
- Consumes: `lintFiles` (`lib/sloplint.js`), `scopeCheck` (`lib/report.js`)
- Produces: `gateTask({ scope, cssEntries }): { level: 'task', ok, findings }`, `gateWave({ dir, verify, cssEntries }): { level: 'wave', ok, findings, build: { rc, output } | null }`, `runVerify(cmd, cwd): { rc, output }`

**Decisão que corrige a spec §6 no M1:** a gate de tarefa **não** roda toolchain. Motivo medido em `libra`: worktree git não leva `node_modules`, e `bun install` por tarefa tornaria o custo do swarm dominado por instalar dependência. O build real roda uma vez por onda, na branch de integração.

- [ ] **Step 1: Escrever os testes que falham**

```js
// test/gate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateTask, gateWave, runVerify } from '../lib/gate.js';

const okScope = { ok: true, violations: [] };
const badScope = { ok: false, violations: [{ file: 'index.html', status: 'M', reason: 'modificado fora do lote declarado' }] };

test('gateTask nao roda nada: so scope e sloplint', () => {
  const g = gateTask({ scope: okScope, cssEntries: [{ path: 'a.css', text: '.a { gap: 3px; }' }] });
  assert.equal(g.level, 'task');
  assert.equal(g.ok, false);
  assert.equal(g.findings[0].id, 'SLOP-SPACING-RHYTHM');
});

test('gateTask marca SCOPE-OUTSIDE-LOT por violacao, uma por arquivo', () => {
  const g = gateTask({ scope: badScope, cssEntries: [] });
  assert.equal(g.findings[0].id, 'SCOPE-OUTSIDE-LOT');
  assert.equal(g.findings[0].file, 'index.html');
});

test('gateTask passa quando nada e violado', () => {
  assert.equal(gateTask({ scope: okScope, cssEntries: [{ path: 'a.css', text: '.a { gap: 8px; }' }] }).ok, true);
});

test('runVerify devolve rc 0 e rc nao-zero sem lancar', () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-gate-'));
  writeFileSync(join(d, 'build.mjs'), "console.log('ok');\n");
  assert.equal(runVerify('node build.mjs', d).rc, 0);
  writeFileSync(join(d, 'bad.mjs'), "process.exit(7);\n");
  assert.equal(runVerify('node bad.mjs', d).rc, 7);
});

test('runVerify corta saida longa para caber no ledger', () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-gate-'));
  writeFileSync(join(d, 'loud.mjs'), "console.log('x'.repeat(9000));\n");
  assert.ok(runVerify('node loud.mjs', d).output.length <= 4000);
});

test('gateWave: build reprovado derruba a onda mesmo com css limpo', () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-gate-'));
  writeFileSync(join(d, 'fail.mjs'), "process.exit(3);\n");
  const g = gateWave({ dir: d, verify: 'node fail.mjs', cssEntries: [] });
  assert.equal(g.ok, false);
  assert.equal(g.build.rc, 3);
});

test('gateWave sem verify so checa sloplint', () => {
  const g = gateWave({ dir: process.cwd(), verify: null, cssEntries: [{ path: 'a.css', text: '.a{color:#abcdef}', tokenValues: [] }] });
  assert.equal(g.build, null);
  assert.equal(g.findings[0].id, 'SLOP-OFF-TOKEN-COLOR');
});
```

- [ ] **Step 2: Rodar para confirmar falha**

Run: `node --test test/gate.test.js`
Expected: FAIL — `Cannot find module '../lib/gate.js'`

- [ ] **Step 3: Implementar**

```js
// lib/gate.js
import { execSync } from 'node:child_process';
import { lintFiles } from './sloplint.js';

const VERIFY_TIMEOUT_MS = 300_000;
const OUTPUT_CAP = 4000;

export function runVerify(cmd, cwd) {
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    return { rc: 0, output: String(out).slice(-OUTPUT_CAP) };
  } catch (e) {
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`;
    return { rc: typeof e.status === 'number' ? e.status : 1, output: text.slice(-OUTPUT_CAP) };
  }
}

export function gateTask({ scope, cssEntries }) {
  const findings = [];
  for (const v of scope.violations) {
    findings.push({ id: 'SCOPE-OUTSIDE-LOT', file: v.file, line: null, message: v.reason });
  }
  findings.push(...lintFiles(cssEntries));
  return { level: 'task', ok: findings.length === 0, findings };
}

export function gateWave({ dir, verify, cssEntries }) {
  const findings = lintFiles(cssEntries);
  const build = verify ? runVerify(verify, dir) : null;
  const buildOk = build ? build.rc === 0 : true;
  return { level: 'wave', ok: buildOk && findings.length === 0, findings, build };
}
```

- [ ] **Step 4: Rodar para confirmar passagem**

Run: `node --test test/gate.test.js`
Expected: PASS (7 testes)

- [ ] **Step 5: Commit**

```bash
git add lib/gate.js test/gate.test.js
git commit -m "swarm: gate de tarefa sem toolchain e gate de onda com build unico"
```

---

### Task 8: `lib/briefing.js` + `lib/prompt.js` + `seed/` — o piso, o tema e o prompt imutável

**Files:**
- Create: `lib/briefing.js`, `lib/prompt.js`, `seed/floor.md`, `seed/themes/verde-fluxo.md`, `seed/themes/neutro-editorial.md`, `seed/ATTRIBUTION.md`, `test/prompt.test.js`

**Interfaces:**
- Consumes: nada
- Produces: `loadFloor(seedDir): string`, `loadTheme(seedDir, name): string`, `repoConventions(repoDir): string`, `renderPrompt({ task, waveNumber, run, floor, theme, conventions }): string`, `writePrompt({ runDir, taskId, attempt, text }): string`

- [ ] **Step 1: Escrever `seed/floor.md`**

```markdown
# Piso visual — inalienavel

Nao e sugestao. Se a tarefa nao da para cumprir isto, reporte em `## Blocked` em vez de improvisar.

- Cor e tipografia saem dos tokens do tema. Nenhum hex literal fora de `tokens.css`.
- Escala de espacamento: multiplos de 4px. Sem 3px, 13px, 27px.
- Nenhum gradiente roxo/violeta/indigo. Nenhum glow padrao de template de IA.
- Rotulo pequeno em CAIXA ALTA com letter-spacing largo nao e hierarquia, e tique.
- Titulo de secao tem que sobrevir a 1280px de largura de leitura, nao so a 1920px.
- Contraste de texto: 4.5:1 no corpo, 3:1 em titulo >= 24px.
- Todo elemento interativo tem estado visivel de foco. Sem `outline: none` sem substituto.
- Imagem decorativa entra com `alt=""`; imagem com informacao entra com `alt` descrito.
- Layout em grid/flex com uma fonte de verdade para a largura do conteudo.
- Nenhum texto de placeholder tipo "Lorem ipsum" ou "Your awesome product" no resultado.
```

- [ ] **Step 2: Escrever os dois temas**

```markdown
<!-- seed/themes/verde-fluxo.md -->
# Tema Verde Fluxo

- `--bg: oklch(0.985 0.008 150)` · `--surface: oklch(0.96 0.015 150)`
- `--ink: oklch(0.24 0.02 155)` · `--muted: oklch(0.52 0.02 155)`
- `--accent: oklch(0.55 0.13 155)` · `--accent-ink: oklch(0.99 0.005 150)`
- Tipografia: display e corpo na mesma familia, com peso fazendo a hierarquia.
- Raio: 2px. Sombra: nenhuma em superficie de leitura.
- Ritmo: 4 / 8 / 16 / 24 / 48.
```

```markdown
<!-- seed/themes/neutro-editorial.md -->
# Tema Neutro Editorial

- `--bg: oklch(0.99 0.002 260)` · `--surface: oklch(0.965 0.004 260)`
- `--ink: oklch(0.2 0.01 260)` · `--muted: oklch(0.45 0.01 260)`
- `--accent: oklch(0.35 0.02 260)` · `--accent-ink: oklch(0.99 0.002 260)`
- Um unico acento de cor, usado em enlace e foco, nunca em fundo de secao.
- Raio: 0. Linha editorial como separador.
- Ritmo: 4 / 8 / 12 / 24 / 48.
```

- [ ] **Step 3: Escrever `seed/ATTRIBUTION.md`**

Registrar, no mínimo: `hallmark` (MIT) como referência das regras de ritmo/eyebrow; `impeccable` (Apache-2.0, `NOTICE.md` retido) como referência da disciplina de rule-id; `am-will/swarms` (sem licença) como origem de **mecânica** — prompt-por-arquivo, status TSV, ondas por `depends_on` — sem linha copiada; `swarm-cursors` (sem licença) como origem do conceito de blueprint, sem código reutilizado; `agent-browser` (Apache-2.0, notices do axe-core) reservado para M4.

- [ ] **Step 4: Escrever os testes que falham**

```js
// test/prompt.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPrompt, writePrompt } from '../lib/prompt.js';
import { loadFloor, loadTheme, repoConventions } from '../lib/briefing.js';
import { scopeDir } from '../lib/paths.js';

const SEED = join(import.meta.dirname, '..', 'seed');

const base = {
  task: { id: 'T-01', title: 'Cabecalho acessivel', dirs: ['components/header'].map(scopeDir), dependsOn: [], verify: null },
  waveNumber: 1,
  run: { workDir: 'C:/x/runs/r1/worktrees/T-01', branch: 'swarm/r1/T-01', reportPath: 'C:/x/runs/r1/tasks/T-01/attempt-1/report.md' },
  floor: loadFloor(SEED),
  theme: loadTheme(SEED, 'neutro-editorial'),
  conventions: '(sem AGENTS.md)',
};

test('floor e tema carregam e nao vem vazios', () => {
  assert.ok(loadFloor(SEED).includes('multiplos de 4'));
  assert.ok(loadTheme(SEED, 'verde-fluxo').includes('oklch'));
  assert.throws(() => loadTheme(SEED, 'inexistente'), /tema nao existe/);
});

test('repoConventions pega AGENTS.md e CLAUDE.md e corta em 6000 chars', () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-conv-'));
  const big = 'x'.repeat(9000);
  writeFileSync(join(d, 'AGENTS.md'), '# regras\n' + big);
  const out = repoConventions(d);
  assert.ok(out.length < 7000);
  assert.ok(out.includes('regras'));
});

test('repoConventions sem arquivos volta string vazia', () => {
  assert.equal(repoConventions(mkdtempSync(join(tmpdir(), 'swarm-conv-'))), '');
});

test('prompt carrega lote, caminho, branch e o contrato de report', () => {
  const p = renderPrompt(base);
  assert.match(p, /components\/header/);
  assert.match(p, /C:\/x\/runs\/r1\/worktrees\/T-01/);
  assert.match(p, /swarm\/r1\/T-01/);
  assert.match(p, /## Blocked/);
  assert.match(p, /- touched:/);
  assert.match(p, /multiplos de 4/);
  assert.match(p, /Nunca merge/);
});

test('writePrompt grava e recusa sobrescrever prompt existente', () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-prompt-'));
  const f = writePrompt({ runDir: d, taskId: 'T-01', attempt: 1, text: 'oi' });
  assert.ok(existsSync(f));
  assert.equal(readFileSync(f, 'utf8'), 'oi');
  assert.throws(() => writePrompt({ runDir: d, taskId: 'T-01', attempt: 1, text: 'de novo' }), /imutavel/);
  assert.ok(writePrompt({ runDir: d, taskId: 'T-01', attempt: 2, text: 'de novo' }).endsWith('prompt.md'));
});
```

- [ ] **Step 5: Implementar `lib/briefing.js`**

```js
// lib/briefing.js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'TECHNICAL_GUIDELINES.md'];
const CONVENTION_CAP = 6000;

export const loadFloor = (seedDir) => readFileSync(join(seedDir, 'floor.md'), 'utf8');

export function loadTheme(seedDir, name) {
  const p = join(seedDir, 'themes', `${name}.md`);
  if (!existsSync(p)) throw new Error(`tema nao existe: ${p}`);
  return readFileSync(p, 'utf8');
}

export function repoConventions(repoDir) {
  const out = [];
  for (const f of CONVENTION_FILES) {
    const p = join(repoDir, f);
    if (existsSync(p)) out.push(`### ${f}\n${readFileSync(p, 'utf8').slice(0, CONVENTION_CAP)}`);
  }
  return out.join('\n\n');
}
```

- [ ] **Step 6: Implementar `lib/prompt.js`**

```js
// lib/prompt.js
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function renderPrompt({ task, waveNumber, run, floor, theme, conventions }) {
  return `# Worker ${task.id} — onda ${waveNumber}

${task.title}

## Fronteira (inviolavel)
Voce possui apenas estes diretorios, dentro de ${run.workDir}:
${task.dirs.map((d) => `- ${d}`).join('\n')}

Leia qualquer arquivo do repositorio. Escreva **somente** dentro dos diretorios acima,
inclusive criando arquivos novos neles. Se precisar mudar algo fora, NAO mude:
escreva um bloco \`## Blocked\` no seu report dizendo o que falta e em que arquivo.

## Piso visual
${floor.trim()}

## Tema
${theme.trim()}

## Convenções do repositorio alvo
${conventions || '(nenhum AGENTS.md/CLAUDE.md encontrado)'}

## Como terminar
1. Commit no seu worktree, na branch \`${run.branch}\`. Nunca merge, nunca push, nunca crie branch.
2. Escreva \`${run.reportPath}\` com exatamente:
   - \`## Summary\` — o que voce fez, em ate 3 linhas
   - uma linha \`- touched: <csv dos arquivos que voce tocou>\`
   - uma linha \`- tokens: <numero aproximado>\`
   - \`## Notes\` — opcional
   - \`## Blocked\` — opcional, obrigatorio se algo ficou fora do seu lote
`;
}

export function writePrompt({ runDir, taskId, attempt, text }) {
  const dir = join(runDir, 'tasks', taskId, `attempt-${attempt}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'prompt.md');
  if (existsSync(file)) throw new Error(`prompt imutavel: ${file} ja existe — use attempt-${attempt + 1}`);
  writeFileSync(file, text);
  return file;
}
```

- [ ] **Step 7: Rodar para confirmar passagem**

Run: `node --test test/prompt.test.js`
Expected: PASS (5 testes)

- [ ] **Step 8: Commit**

```bash
git add lib/briefing.js lib/prompt.js seed/ test/prompt.test.js
git commit -m "swarm: piso visual, dois temas e prompt imutavel do worker"
```

---

### Task 9: `run.js` — o CLI que é o único dono do estado

**Files:**
- Create: `run.js`, `test/run.test.js`

**Interfaces:**
- Consumes: tudo de `lib/*`
- Produces: `COMMANDS: string[]` (`['init','plan','start','finish','integrate','status','abort']`), `main(argv): Promise<number>`, e o contrato de disco:

```
<workspace>/runs/<runId>/
  run.json  plan.md  waves.json  status.tsv
  worktrees/<T-xx>/            # um por tarefa
  worktrees/_integration/      # branch de integracao
  tasks/<T-xx>/attempt-N/{prompt.md, report.md, gate.json}
  gates/wave-<n>.json
```

`start` **não** faz spawn de processo: ele prepara worktree + prompt e imprime o JSON que o orquestrador entrega ao subagente. É a decisão de design do M1 — o dispatcher é o host, o dono do estado é o CLI.

- [ ] **Step 1: Escrever os testes que falham**

```js
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
- paths: styles
- depends_on: -
- verify: -

## T-02 cabecalho
- paths: components
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

  const b = JSON.parse(cli(['start', '--run', meta.runDir, '--task', 'T-02']));
  writeFileSync(join(b.workDir, 'components', 'x.css'), '.x { padding: 16px; }\n');
  git(['add', '.'], b.workDir); git(['commit', '-q', '-m', 'header'], b.workDir);
  writeFileSync(join(meta.runDir, 'tasks', 'T-02', 'attempt-1', 'report.md'),
    '## Summary\nok\n- touched: components/x.css\n- tokens: 100\n');
  assert.equal(JSON.parse(cli(['finish', '--run', meta.runDir, '--task', 'T-02', '--rc', '0'])).ok, true);

  const integ = JSON.parse(cli(['integrate', '--run', meta.runDir]));
  assert.equal(integ.merged.length, 2);
  assert.equal(integ.conflicts.length, 0);
  const head = git(['rev-parse', 'HEAD'], repoDir);
  assert.equal(head, git(['rev-parse', 'HEAD~0'], join(meta.runDir, 'worktrees', '_integration')) || head);
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
});
```

- [ ] **Step 2: Rodar para confirmar falha**

Run: `node --test test/run.test.js`
Expected: FAIL — `Cannot find module '../run.js'`

- [ ] **Step 3: Implementar o núcleo do CLI (opções, despacho e os comandos `init`/`plan`)**

```js
#!/usr/bin/env node
// run.js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePlan, computeWaves, validateWaves, nextWave, PlanError } from './lib/plan.js';
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
  const waves = wavesOf(runDir);
  const all = runDir ? JSON.parse(readFileSync(join(runDir, 'tasks.json'), 'utf8')) : [];
  return all;
}

function cmdInit(o) {
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
```

- [ ] **Step 4: Implementar `start`, `finish`, `integrate`, `status`, `abort` e o `main`**

```js
function attemptOf(runDir, taskId) {
  let n = 1;
  while (existsSync(join(runDir, 'tasks', taskId, `attempt-${n}`, 'prompt.md'))) n++;
  return existsSync(join(runDir, 'tasks', taskId, `attempt-${n - 1}`, 'report.md')) ? n : Math.max(1, n - 1);
}

function cmdStart(o) {
  const run = readRun(o.run);
  const task = tasksOf(o.run).find((t) => t.id === o.task);
  const attempt = Number(o.attempt ?? 1);
  const { dir, branch } = prepare({ repoDir: run.repoDir, runDir: o.run, runId: run.runId, taskId: task.id, baseSha: run.baseSha });
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

function cssEntries(o.run, task, files) {
  return files.filter((f) => f.file.endsWith('.css')).map((f) => ({
    path: f.file,
    text: (() => { try { return readFileSync(join(worktreePath(o.run, task.id), f.file), 'utf8'); } catch { return ''; } })(),
  }));
}

function cmdFinish(o) {
  const run = readRun(o.run);
  const task = tasksOf(o.run).find((t) => t.id === o.task);
  const attempt = Number(o.attempt ?? 1);
  const workDir = worktreePath(o.run, task.id);
  const reportFile = join(o.run, 'tasks', task.id, `attempt-${attempt}`, 'report.md');
  const report = parseReport(existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '');
  const rc = Number(o.rc ?? 0);
  if (rc !== 0) {
    append(o.run, { task: task.id, state: 'failed', rc, start: latest(o.run, task.id).start, end: stamp(),
      branch: task && latest(o.run, task.id).branch, log: reportFile.replaceAll('\\', '/'), tokens: report.tokens, pid: null });
    out({ ok: false, reason: 'worker reportou rc != 0', findings: [] });
    return 0;
  }
  const files = touchedFiles({ workDir, baseSha: run.baseSha });
  const scope = scopeCheck({ dirs: task.dirs, files });
  const gate = gateTask({ scope, cssEntries: cssEntries(o.run, task, files) });
  writeFileSync(join(o.run, 'tasks', task.id, `attempt-${attempt}`, 'gate.json'),
    JSON.stringify({ ...gate, files }, null, 2) + '\n');
  append(o.run, { task: task.id, state: gate.ok ? 'gated' : 'failed', rc: 0,
    start: latest(o.run, task.id).start, end: stamp(), branch: latest(o.run, task.id).branch,
    log: reportFile.replaceAll('\\', '/'), tokens: report.tokens, pid: null });
  out({ ...gate, blocked: report.blocked, touched: files.map((f) => f.file) });
  return gate.ok ? 0 : 1;
}

function cmdIntegrate(o) {
  const run = readRun(o.run);
  const states = stateOf(o.run);
  const waves = wavesOf(o.run);
  const integ = existsSync(integrationPath(o.run))
    ? { dir: integrationPath(o.run) }
    : prepareIntegration({ repoDir: run.repoDir, runDir: o.run, runId: run.runId, baseSha: run.baseSha });
  const branches = [];
  const conflicts = [];
  for (const wave of waves) {
    const ready = wave.filter((id) => ['gated', 'merged'].includes(states.get(id) ?? 'planned'));
    if (ready.length !== wave.length) break;
    for (const id of ready) branches.push(branchName(run.runId, id));
    const res = mergeInOrder({ integrationDir: integ.dir, branches: branches.slice(0, -0) });
    branches.length = 0;
    // merge incremental: reconstroi a pilha ate aqui
    const pile = [];
    for (const w of waves.slice(0, waves.indexOf(wave) + 1)) for (const id of w) pile.push(branchName(run.runId, id));
    const r = mergeInOrder({ integrationDir: integ.dir, branches: pile });
    conflicts.push(...r.conflicts);
    for (const c of r.conflicts) {
      for (const id of waves.flat()) if (branchName(run.runId, id) === c.branch) states.set(id, 'failed');
    }
    break;
  }
  out({ merged: [], conflicts });
  return 0;
}

function cmdStatus(o) {
  const lines = rows(o.run);
  const width = 8;
  const text = lines.map((r) => `${r.task.padEnd(width)} ${r.state.padEnd(10)} ${r.tokens || ''}`.trimEnd()).join('\n');
  process.stdout.write(text + '\n');
  const dead = crashedRuns(o.run, (pid) => pid !== 0 && existsSync(join(o.run, 'worktrees')));
  if (dead.length) out({ crashed: dead.map((r) => r.task) });
  return 0;
}

function cmdAbort(o) {
  const run = readRun(o.run);
  for (const t of tasksOf(o.run)) {
    const dir = worktreePath(o.run, t.id);
    if (existsSync(dir)) removeWorktree({ repoDir: run.repoDir, dir });
    append(o.run, { task: t.id, state: 'discarded', rc: null, start: latest(o.run, t.id)?.start ?? null,
      end: stamp(), branch: branchName(run.runId, t.id), log: null, tokens: null, pid: null });
  }
  const integ = integrationPath(o.run);
  if (existsSync(integ)) removeWorktree({ repoDir: run.repoDir, dir: integ });
  out({ aborted: true });
  return 0;
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.includes(cmd)) throw new PlanError(`comando desconhecido: ${cmd} (use ${COMMANDS.join('|')})`);
  const o = opts(rest);
  const table = { init: cmdInit, plan: cmdPlan, start: cmdStart, finish: cmdFinish,
    integrate: cmdIntegrate, status: cmdStatus, abort: cmdAbort };
  return table[o.run !== undefined || cmd === 'init' ? cmd : cmd](o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = e instanceof PlanError ? 2 : 1; }
}
```

**Nota de implementação:** `cmdIntegrate` acima está rascunhado de propósito em duas passadas — a versão final roda **uma** pilha de branches por onda, chamando `mergeInOrder` com `pile` e gravando `gates/wave-<n>.json` + linhas `merged`/`failed` no ledger, e a `gateWave` com `verify` declarado no plano. Implemente a versão final aqui, substituindo o rascunho, e teste no Step 1 de `test/e2e.test.js` (Task 11). Não deixe o rascunho no arquivo: o teste de integração abaixo é o que o remove.

- [ ] **Step 5: Rodar para confirmar passagem**

Run: `node --test test/run.test.js`
Expected: PASS (7 testes). `integrate` só passa depois da versão final do passo 4 — se falhar, é ali.

- [ ] **Step 6: Commit**

```bash
git add run.js test/run.test.js
git commit -m "swarm: cli dono do estado com start, finish, integrate, status e abort"
```

---

### Task 10: As três skills e o teste que impede a skill de citar comando que não existe

**Files:**
- Create: `skills/swarm-orchestrator/SKILL.md`, `skills/swarm-worker/SKILL.md`, `skills/swarm-integrator/SKILL.md`, `test/skills.test.js`

**Interfaces:**
- Consumes: `COMMANDS` de `run.js`
- Produzes: três skills no formato Anthropic Agent Skills (`SKILL.md` com frontmatter `name` + `description`), que são a interface entre o host e o CLI

- [ ] **Step 1: Escrever o teste que falha**

```js
// test/skills.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS } from '../run.js';

const ROOT = join(import.meta.dirname, '..', 'skills');
const names = readdirSync(ROOT);
const skillText = (n) => readFileSync(join(ROOT, n, 'SKILL.md'), 'utf8');

test('as tres skills existem com frontmatter valido', () => {
  assert.deepEqual(names.sort(), ['swarm-integrator', 'swarm-orchestrator', 'swarm-worker']);
  for (const n of names) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(skillText(n));
    assert.ok(fm, `${n}: sem frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${n}$`, 'm'));
    assert.match(fm[1], /^description: .{20,}/m);
  }
});

test('skill so cita comandos que existem no CLI', () => {
  for (const n of names) {
    for (const m of skillText(n).matchAll(/node run\.js (\w+)/g)) {
      assert.ok(COMMANDS.includes(m[1]), `${n}: cita "node run.js ${m[1]}", que nao existe (${COMMANDS.join(', ')})`);
    }
  }
});

test('orchestrator menciona as quatro regras estruturais', () => {
  const t = skillText('swarm-orchestrator');
  for (const key of ['lote', 'onda', 'single-writer', 'concorrencia']) {
    assert.ok(t.toLowerCase().includes(key), `orchestrator sem a regra "${key}"`);
  }
});

test('worker tem a fronteira e o contrato de report', () => {
  const t = skillText('swarm-worker');
  assert.match(t, /Nunca merge/);
  assert.match(t, /- touched:/);
  assert.match(t, /## Blocked/);
});

test('integrator nao resolve colisao sozinho: reporta', () => {
  assert.match(skillText('swarm-integrator'), /reporta/);
});
```

- [ ] **Step 2: Rodar para confirmar falha**

Run: `node --test test/skills.test.js`
Expected: FAIL — `ENOENT` no diretório de skills

- [ ] **Step 3: Escrever `skills/swarm-orchestrator/SKILL.md`**

```markdown
---
name: swarm-orchestrator
description: Planeja e conduz um swarm de ate 3 agentes editando um mesmo repositorio em worktrees isolados. Use quando a tarefa for dividir construcao de site/codigo entre agentes simultaneos com integracao controlada.
---

# Swarm orchestrator

Voce e o orquestrador. Voce NUNCA edita o produto: voce planeja, starta, le o ledger e integra.
Toda escrita de estado vai pelo `run.js`. Voce e o unico autor do `status.tsv` (single-writer).

## Ciclo
1. `node run.js init --repo <repo> --workspace <dir>` -> `runDir` no stdout.
2. Escreva `plan.md`. Cada tarefa declara o **lote** (diretorios que ela possui),
   `depends_on` e `verify`. Lote disputado na mesma onda faz o plano ser recusado.
3. `node run.js plan --run <runDir> --file plan.md` -> valida e grava as ondas.
4. Para cada onda, **no maximo 3 tarefas** em paralelo:
   `node run.js start --run <runDir> --task T-xx` e entregue o `prompt` impresso
   a um subagente cujo unico trabalho e trabalhar naquele `workDir`.
5. Quando o worker terminar: `node run.js finish --run <runDir> --task T-xx --rc <0|1>`.
   Um `SCOPE-OUTSIDE-LOT` ali significa que o agente atravessou a fronteira: a branch
   dele NAO entra na integracao. Relance com prompt revisado (`attempt-2`), nao edite
   o worktree voce mesmo.
6. Onda toda `gated` -> `node run.js integrate --run <runDir>`.
7. `node run.js status --run <runDir>` antes de decidir a proxima onda.

## Regras que nao se negociam
- Um lote por tarefa. Sem dois donos para o mesmo diretorio na mesma onda.
- Onda seguinte so abre quando a atual passou na gate.
- Voce nao integra, nao da push e nao corrigir o worker por fora: integra o CLI.
- Worker `blocked` vira tarefa nova na onda seguinte, nao favor agora.
```

- [ ] **Step 4: Escrever `skills/swarm-worker/SKILL.md`**

```markdown
---
name: swarm-worker
description: Executa uma unica tarefa de swarm dentro de um worktree git proprio, dentro de um lote de diretorios declarado, e devolve um report verificavel. Use quando voce for o agente worker de um swarm, nao o orquestrador.
---

# Swarm worker

Voce recebeu um `workDir`, uma `branch` e um `prompt.md`. O prompt diz o que fazer e
quais diretorios voce **possui**.

## Fronteira
- Leia qualquer arquivo do repositorio.
- Escreva **somente** dentro dos diretorios do seu lote, inclusive criando arquivos novos.
- Precisa mudar algo fora? NAO mude. Escreva `## Blocked` no report com arquivo e motivo.
- Outro agente esta trabalhando no mesmo repo agora. Cada linha sua que vaza para fora
  do lote e uma colisao que alguem tera de resolver.

## Git
- Commit no seu worktree, na sua branch. `git add` so dos seus arquivos.
- Nunca merge. Nunca push. Nunca crie branch. Nunca saia do seu worktree.

## Terminar
Escreva o `report.md` no caminho que o prompt deu:

    ## Summary
    (ate 3 linhas do que mudou)
    - touched: <csv dos arquivos>
    - tokens: <numero aproximado>
    ## Notes
    (opcional)
    ## Blocked
    (opcional; obrigatorio se algo ficou fora do lote)

O `finish` do orquestrador compara o diff real com o `touched` que voce declarou.
Divergir nao te salva: reprova e a branch fica de fora.
```

- [ ] **Step 5: Escrever `skills/swarm-integrator/SKILL.md`**

```markdown
---
name: swarm-integrator
description: Reconcilia o resultado de um swarm depois da integracao: resolve colisao declarada, confere coerencia entre lotes, roda a gate de onda e reporta regressao medida. Use quando o run.js tiver mergeado as branches de uma onda.
---

# Swarm integrator

O `integrate` já mergeou o que dava para mergear. Seu trabalho é o que sobra.

## Entrada
- `status.tsv` (estados por tarefa)
- `gates/wave-<n>.json` (build e achados de sloplint na integração)
- `tasks/*/attempt-*/report.md`, inclusive os blocos `## Blocked`

## O que fazer
1. Colisão reportada pelo `integrate` **não** é para você decidir em silêncio:
   mostre os dois lados, explique o conflito e **reporta** para o humano escolher.
2. Verifique coerência entre lotes: tokens definidos por uma tarefa e consumidos por outra,
   classes de componente criadas num lote e referenciadas noutro.
3. Todo `## Blocked` vira proposta de tarefa nova na onda seguinte, com lote próprio.
4. Rode `node run.js gate`/`integrate` de novo depois de corrigir, e só então declare a onda fechada.

## O que você não faz
- Não resolve colisão sem reportar.
- Não integra, não dá push, não publico. Publicação continua sendo gesto humano.
```

- [ ] **Step 6: Rodar para confirmar passagem**

Run: `node --test test/skills.test.js`
Expected: PASS (5 testes)

- [ ] **Step 7: Commit**

```bash
git add skills/ test/skills.test.js
git commit -m "swarm: tres skills de swarm e teste que checa comando citado"
```

---

### Task 11: Ponta a ponta na fixture — o caminho feliz e a sabotagem (spec §8 teste 2)

**Files:**
- Create: `test/e2e.test.js`, `test/fixtures/site/index.html`, `test/fixtures/site/styles/tokens.css`, `test/fixtures/site/styles/base.css`, `test/fixtures/site/components/.gitkeep`, `test/fixtures/site/build.mjs`

**Interfaces:**
- Consumes: `run.js` por processo filho
- Produces: nenhum produto — é a prova de que o M1 funciona

- [ ] **Step 1: Criar a fixture**

```html
<!-- test/fixtures/site/index.html -->
<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Base</title><link rel="stylesheet" href="styles/base.css"></head>
<body><header class="site-header"><h1>Base</h1></header><main><p>conteudo</p></main></body>
</html>
```

```css
/* test/fixtures/site/styles/tokens.css */
:root { --bg: oklch(0.99 0.002 260); --ink: oklch(0.2 0.01 260); }
```

```css
/* test/fixtures/site/styles/base.css */
body { margin: 0; padding: 8px; color: var(--ink); background: var(--bg); }
```

```js
// test/fixtures/site/build.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
const root = dirname(new URL(import.meta.url).pathname.slice(1));
const required = ['index.html', 'styles/base.css', 'styles/tokens.css'];
for (const f of required) {
  if (!existsSync(join(root, f))) { console.error(`faltando: ${f}`); process.exit(1); }
  if (join(root, f).endsWith('.css') && /#[0-9a-fA-F]{6}/.test(readFileSync(join(root, f), 'utf8')) && !f.includes('tokens')) {
    console.error(`cor literal fora de tokens em ${f}`); process.exit(1);
  }
}
console.log('build ok');
```

- [ ] **Step 2: Escrever o teste de 3 agentes, caminhos disjuntos, integração topológica, e o sabotador**

```js
// test/e2e.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS } from '../run.js';

const G = ['-c', 'user.email=swarm@test', '-c', 'user.name=swarm'];
const git = (a, cwd) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8' }).trim();
const RUN = join(import.meta.dirname, '..', 'run.js');
const cli = (a, cwd = import.meta.dirname) =>
  execFileSync(process.execPath, [RUN, ...a], { cwd, encoding: 'utf8' }).trim();

const PLAN = `# plano
## T-01 tokens
- paths: styles
- depends_on: -
- verify: node build.mjs

## T-02 cabecalho
- paths: components/header
- depends_on: T-01
- verify: node build.mjs

## T-03 rodape
- paths: components/footer
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
  const a = worker(s, 'T-01', { 'styles/tokens.css': ':root { --bg: oklch(0.99 0.002 260); --ink: oklch(0.2 0.01 260); }\n' });
  assert.equal(a.result.ok, true, JSON.stringify(a.result));

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
```

- [ ] **Step 3: Rodar**

Run: `node --test test/e2e.test.js`
Expected: PASS (3 testes). Este teste é o que valida a versão final de `cmdIntegrate` da Task 9 — falha aqui significa `integrate` incompleto ali, não aqui.

- [ ] **Step 4: Commit**

```bash
git add test/e2e.test.js test/fixtures/
git commit -m "swarm: ponta a ponta de tres agentes com lote violado barrado"
```

---

### Task 12: Injeção de falha — zumbi, crash e ausência de merge parcial (spec §7 e §8 teste 3)

**Files:**
- Create: `test/fault.test.js`

**Interfaces:**
- Consumes: `run.js`, `lib/ledger.js`, `lib/isolate.js`
- Produces: nenhum produto

- [ ] **Step 1: Escrever o teste**

```js
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
  git(['add', '.'], repoDir); git(['commit', '-q', '-m', 'base'], repoDir);
  const workspace = mkdtempSync(join(tmpdir(), 'swarm-fault-ws-'));
  const meta = JSON.parse(cli(['init', '--repo', repoDir, '--workspace', workspace]));
  const plan = join(workspace, 'plan.md');
  writeFileSync(plan, '## T-01 a\n- paths: styles\n- depends_on: -\n- verify: -\n\n## T-02 b\n- paths: components\n- depends_on: -\n- verify: -\n');
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
```

- [ ] **Step 2: Rodar**

Run: `node --test test/fault.test.js`
Expected: FAIL na primeira vez em `timeout` e `blockedOn` — `run.js` ainda não trata `--rc 124` nem devolve `blockedOn`. Implemente:
  - em `cmdFinish`: `rc === 124 → estado 'timeout'` (é o código que `execSync` com `timeout` produz via shell no Windows para kill), e qualquer outro `rc != 0 → 'failed'`;
  - em `cmdIntegrate`: se a onda tem tarefa não `gated`, retorne `{ merged: [], conflicts: [], blockedOn: <primeiro id nao gated> }` sem tocar na branch de integração.

- [ ] **Step 3: Rodar até passar**

Run: `node --test test/fault.test.js`
Expected: PASS (5 testes)

- [ ] **Step 4: Rodar a suíte inteira**

Run: `node --test test/`
Expected: PASS em todos os arquivos. Se `e2e` quebrar depois desta mudança, é sinal de que o `integrate` ficou mais rígido do que o teste da Task 11 esperava — ajustar o **teste da Task 11** para integrar uma onda completa, não relaxar o `integrate`.

- [ ] **Step 5: Commit**

```bash
git add test/fault.test.js run.js lib/gate.js
git commit -m "swarm: timeout, crash e ausencia de merge parcial viram estado no ledger"
```

---

### Task 13: Dry run em `libra` — marketing com 3 lotes disjuntos (spec §12 risco 1)

**Files:**
- Create: `docs/dry-run-libra.md`, `runs/` (ignorado pelo git)

**Interfaces:**
- Consumes: CLI + skills dos passos anteriores. Repo alvo: `O:/DEV/A JORNADA/PROJETOS/libra` (árvore limpa verificado em 2026-11-05; **sem `node_modules` instalado**, `bun 1.4.2` presente).

- [ ] **Step 1: Preflight (sem escrever nada)**

```bash
git -C "O:/DEV/A JORNADA/PROJETOS/libra" status --porcelain        # esperado: vazio
git -C "O:/DEV/A JORNADA/PROJETOS/libra" rev-parse --abbrev-ref HEAD  # esperado: main
```

Se sujo: **pare e pergunte**. Worktree ramifica do HEAD; árvore suja significa que o swarm trabalharia num estado que não é o que está commitado.

- [ ] **Step 2: Escrever `runs/<id>/plan.md` com os três lotes reais**

```markdown
# plano libra — secao de precificacao
## T-01 paginas de marketing
- paths: apps/web/app/(frontend)/(marketing)
- depends_on: T-02
- verify: -

## T-02 componentes de marketing
- paths: apps/web/components/marketing
- depends_on: -
- verify: -

## T-03 textos pt/en
- paths: apps/web/messages
- depends_on: T-02
- verify: -
```

T-02 é a onda 1 (componentes); T-01 e T-03 são a onda 2 (página e copy consomem os componentes). Os três lotes são disjuntos por diretório, e as rotas com parênteses testam o path no Windows de verdade.

- [ ] **Step 3: Rodar `plan` e confirmar que a validação aceita**

```bash
node run.js init --repo "O:/DEV/A JORNADA/PROJETOS/libra" --workspace .
node run.js plan --run runs/<id> --file runs/<id>/plan.md
```

Expected: `{ "tasks": 3, "waves": [["T-02"],["T-01","T-03"]] }`

- [ ] **Step 4: Onda 1 — um worker**

```bash
node run.js start --run runs/<id> --task T-02
```

Dispatche **um** subagente de background com o conteúdo exato de `tasks/T-02/attempt-1/prompt.md` como prompt, e a linha: *"sua área de trabalho é `<workDir>`; use caminhos absolutos em toda ferramenta"*. Depois: `node run.js finish --run runs/<id> --task T-02 --rc 0`.

- [ ] **Step 5: Onda 2 — dois workers em paralelo**

`start` em T-01 e T-03, dois subagentes de background simultâneos, `finish` nos dois.

- [ ] **Step 6: Integrar e medir**

```bash
node run.js integrate --run runs/<id>
node run.js status --run runs/<id>
```

Preencher `docs/dry-run-libra.md` com os **seis números**, sem yorum:

| Mede | Como |
|---|---|
| Violações de lote | contar `SCOPE-OUTSIDE-LOT` no ledger |
| Colisões de merge | `integrate.conflicts` |
| `## Blocked` por worker | ler os reportes |
| Tempo de parede por onda | `start`→`end` no `status.tsv` |
| Custo do worktree | `git -C <repo> worktree list` e bytes de `runs/<id>/worktrees`; tempo de `git worktree add` |
| Toolchain | `bun install` na integração: tempo e se o build passou |

- [ ] **Step 7: Fechar sem deixar resíduo**

```bash
git -C "O:/DEV/A JORNADA/PROJETOS/libra" worktree list       # conferir
node run.js abort --run runs/<id>                             # se quiser descartar
git -C "O:/DEV/A JORNADA/PROJETOS/libra" branch -D swarm/<id>/T-01 swarm/<id>/T-02 swarm/<id>/T-03
```

**Nenhum push. Nenhuma branch do `main` movida. Nada publicado.** Se você quiser o resultado, a branch de integração fica no repo e você revisa.

- [ ] **Step 8: Escrever o veredito do risco 1**

No fim de `docs/dry-run-libra.md`: com esses números, o swarm de 3 vale a pena para site, ou não? Se não, o M1 é um teste de uma agente só e a spec recebe uma ratchet.

- [ ] **Step 9: Commit**

```bash
git add docs/dry-run-libra.md
git commit -m "swarm: dry run no libra com metricas de lote, colisao e custo de worktree"
```

---

### Task 14: Dry run no Verde Fluxo — backend Python com gate de toolchain real

**Files:**
- Create: `docs/dry-run-verde-fluxo.md`

**Interfaces:**
- Consumes: CLI. Repo alvo: `O:/DEV/A JORNADA/PROJETOS/Trabalhos reais/dashboard` — Python 3.11, stdlib + SQLite, `python -m unittest discover -s backend/tests -v`, `ruff`. **Não é repositório git hoje.**

- [ ] **Step 1: Pedir OK explícito para `git init` na pasta do produto**

`git init` na pasta de um sistema que roda no andar 6 do ALETHE é ação em repositório de produto. **Não rode sem a resposta explícita do usuário.** Se aprovado:

```bash
cd "O:/DEV/A JORNADA/PROJETOS/Trabalhos reais/dashboard"
git init -q -b main
printf 'runtime/\n*.sqlite\n__pycache__/\n' > .gitignore
git add -A && git -c user.email=swarm@test -c user.name=swarm commit -q -m "linha de partida: monitor Verde Fluxo"
git log --oneline -1 && git status --porcelain | wc -l
```

Expected: `git status --porcelain` vazio. Se o `index (1).html` (494KB) e o `.zip` do mapa entrarem no commit inicial, confirme antes — são 1,4MB de binário/backup.

- [ ] **Step 2: Plano com lotes no backend (o monólito HTML fica de fora de propósito)**

```markdown
# plano verde fluxo — health das fontes
## T-01 adapters
- paths: backend/adapters
- depends_on: -
- verify: python -m unittest discover -s backend/tests -v

## T-02 teste de contrato
- paths: backend/tests
- depends_on: -
- verify: python -m unittest discover -s backend/tests -v

## T-03 config das fontes
- paths: config
- depends_on: -
- verify: -
```

Onde está o dente: T-01 e T-02 **não podem** ser na mesma onda se tocarem o mesmo contrato — é o teste honesto de que a declaração de lote obriga o planejador a pensar em posse. E o `verify` roda de verdade, sem `bun install`.

- [ ] **Step 3: Rodar as duas ondas, integrar, medir**

Sequência idêntica à Task 13 (steps 4-6), com os mesmos seis números, mais um:

| Mede | Por quê |
|---|---|
| `ruff check backend config` na integração | o gate de onda tem que pegar estilo também |
| `pytest`/`unittest` rc por onda | é a gate que `libra` não pôde rodar |

- [ ] **Step 4: Escrever o comparativo entre os dois alvos**

`docs/dry-run-verde-fluxo.md` termina com uma tabela `libra` vs `Verde Fluxo` nas seis métricas, e a frase de conclusão: **o gargalo do swarm é contenção ou toolchain?** Essa resposta decide se o M2 continua com gate de onda opcional ou passa a tratar install de dependência como parte do isolamento.

- [ ] **Step 5: Sem resíduo**

```bash
node run.js abort --run runs/<id>
git -C ".../dashboard" branch -D swarm/<id>/*
git -C ".../dashboard" status --porcelain    # esperado: vazio
```

- [ ] **Step 6: Commit**

```bash
git add docs/dry-run-verde-fluxo.md
git commit -m "swarm: dry run no Verde Fluxo com gate de toolchain real e comparativo"
```

---

## Self-Review (já executado por quem escreveu)

**Spec coverage.** D1→Tasks 9/10/13 (dispatcher host-nativo, com `start` devolvendo prompt e worktree); D2→CLI com 7 comandos em vez de 12 tools MCP (o conjunto de 12 da spec §4 se completa no M2, e este plano cobre init/plan/start/finish/integrate/status/abort); D3 e D4→Task 4 com teste explícito de que o HEAD do usuário não se move; D5→Task 3; D6 e D7→**não cobertas** (M3, por escopo do M1); D8→Task 7 (gate final é advisory fica em M4); D9→`MAX_WORKERS` em Task 9; D10 e D11→Global Constraints. Seções 8 teste 1→Tasks 2 e 3, teste 2→Task 11, teste 3→Task 12, teste 4 (golden do blueprint)→M4, não coberto aqui. Seção 12 risco 1→Task 13 e 14 com números obrigatórios; risco 2→Task 12 `blockedOn`; risco 3→M4; risco 4→M3.

**Placeholders.** Nenhum `TBD`/`TODO`. O rascunho de `cmdIntegrate` na Task 9 Step 4 está marcado como rascunho **e** tem o passo que o elimina (Task 11 Step 3) — isso é intencional e a instrução de fechamento está escrita.

**Type consistency.** `Task.dirs` (não `paths`) é usado em `plan.js`, `report.js` (`scopeCheck` recebe `dirs`), `isolate`/`run.js` e no prompt. `Finding = {id, file, line, message}` em todo lugar; `SCOPE-OUTSIDE-LOT` tem `line: null` porque não vem do CSS. `stamp()` exportado pelo ledger e usado em `start`/`finish`/`abort`. `worktreePath`/`integrationPath`/`branchName` sempre pelos nomes de Task 4. `lib/gate.js` exporta `runVerify` e é o único lugar que roda shell.
