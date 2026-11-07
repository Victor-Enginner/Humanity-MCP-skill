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
- Produces: `class PlanError`; `parsePlan(md: string): Task[]`; `computeWaves(tasks: Task[]): Task[][]`; `validateWaves(waves: Task[][]): void` (lança `PlanError`); `nextWave(tasks: Task[], states: Map<string,string>): Task[]`. `Task = { id: string, title: string, body: string, dirs: string[], dependsOn: string[], verify: string | null }`

**Emenda da Task 8 (ruling do controlador, 2026-11-05):** `Task.body` existia? Não — até aqui o plano tinha uma linha de título por tarefa e nada mais, e o worker recebia uma frase como especificação completa. A spec chama o pacote por tarefa de *context pack* (§ "Três contratos"); um título de cinco palavras não é um context pack, e o dry run da Task 13 mediria agentes adivinhando. `parsePlan` passa a acumular no corpo da tarefa **toda linha que não é heading, não é um dos três campos e vem depois do heading da tarefa até o próximo `## `**: `body` é `''` quando não há prosa (o `#` de nível 1 do cabeçalho do plano vem antes de qualquer tarefa, então cai no `if (!cur) continue` e não contamina ninguém). Linhas de campo continuam indo para os campos; um `## ` que não é tarefa continua lançando `PlanError` — a emenda não relaxa essa guarda, que é a barreira contra o lote fantasma da revisão da Task 2.

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
- paths: components/header/**, styles/header.css
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

// A emenda do body (ruling da Task 8): o worker precisa de especificacao, e ela mora no plano que o
// humano revisa — nao num arquivo paralelo. Sem prosa o corpo e '' (nem null, nem o titulo).
test('parsePlan guarda o corpo da tarefa e nao inventa um', () => {
  assert.equal(parsePlan(MD)[0].body, '');
  const t = parsePlan('## T-01 x\n- paths: styles/**\n- depends_on: -\n- verify: -\n\nFaca o cabecalho usar --accent.\nNao toque em tokens.css.\n\n## T-02 y\n- paths: components/**\n');
  assert.equal(t[0].body, 'Faca o cabecalho usar --accent.\nNao toque em tokens.css.');
  assert.equal(t[1].body, '');
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
// Um "## " que não é tarefa não pode herdar os campos da tarefa anterior (revisão da Task 2, I1)
// nem virar corpo de tarefa: a guarda vem antes do acúmulo de `body`, nos dois sentidos.
const SECAO = /^## /;
const FIELD = /^-\s+(paths|depends_on|verify):\s*(.*)$/;
const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

export function parsePlan(md) {
  const tasks = [];
  let cur = null;
  const corpo = [];
  const fechaCorpo = () => { if (cur) cur.body = corpo.join('\n').trim(); corpo.length = 0; };
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(HEADING);
    if (h) {
      fechaCorpo();
      cur = { id: h[1], title: h[2].trim(), body: '', dirs: [], dependsOn: [], verify: null };
      tasks.push(cur);
      continue;
    }
    if (SECAO.test(line)) {
      throw new PlanError(`secao "${line.trim()}" fora do formato "## T-NN <titulo>"`);
    }
    if (!cur) continue;
    const f = line.match(FIELD);
    if (!f) { corpo.push(line); continue; }
    const v = f[2].trim();
    if (f[1] === 'paths') cur.dirs = v === '-' ? [] : list(v).map(scopeDir);
    else if (f[1] === 'depends_on') cur.dependsOn = v === '-' ? [] : list(v);
    else cur.verify = v === '-' ? null : v;
  }
  fechaCorpo();
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
// lib/report.js — o que o worker diz (parseReport) contra o que ele fez (scopeCheck).
import { ownsFile } from './paths.js';

const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

// Fim de secao = proximo "^## " ou fim absoluto da entrada. `$` sozinho nao serve: com a flag m
// ele casa no fim de QUALQUER linha, e o trecho preguiçoso pararia na primeira linha.
const SUMMARY = /^## Summary\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const BLOCKED = /^## Blocked\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const TOUCHED = /^-\s+touched:\s*(.*)$/m;
const TOKENS = /^-\s+tokens:\s*(\d+)/m;

export function parseReport(md) {
  const touched = TOUCHED.exec(md);
  const tokens = TOKENS.exec(md);
  const summary = SUMMARY.exec(md);
  const blocked = BLOCKED.exec(md);
  const blockedText = blocked ? blocked[1].trim() : '';
  return {
    touched: touched ? list(touched[1]) : [],
    tokens: tokens ? Number(tokens[1]) : null,
    summary: summary ? summary[1].trim() : '',
    // Um "## Blocked" sem corpo nao e um bloqueio: '' seria lido como bloco existente e
    // viraria tarefa fantasma na onda seguinte.
    blocked: blockedText || null,
  };
}

// Status vem do git via lib/isolate.js: A criado, M modificado, D apagado, R renomeado (a
// origem e o destino chegam como dois itens). O reason e a mensagem do finding da Task 7.
const reasonFor = (status) =>
  status === 'A' ? 'criado fora do lote declarado'
    : status === 'D' ? 'apagado fora do lote declarado'
    : status === 'R' ? 'renomeado com um lado fora do lote declarado'
    : 'modificado fora do lote declarado';

export function scopeCheck({ dirs, files }) {
  const violations = files
    .filter((f) => !ownsFile(dirs, f.file))
    .map((f) => ({ file: f.file, status: f.status, reason: reasonFor(f.status) }));
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
| `SLOP-PURPLE-GRADIENT` | gradiente (`linear`/`radial`/`conic`) com stop roxo/violeta/índigo |
| `SLOP-EYEBROW-CAPS` | bloco com `text-transform: uppercase` + `letter-spacing` largo |
| `SLOP-SPACING-RHYTHM` | `margin`/`padding`/`gap` em px que **não** é múltiplo de 4 (ignora 0 e `border`) |
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
Expected: FAIL — o trecho acima é o ponto de partida, não a versão final: ele viola dois testes do próprio Step 1 (a isenção de token ancorada em linha não dispara em `:root { --ink: #ff0055; }` numa linha só, e a regra de espaçamento exige `;`, deixando a última declaração de cada bloco sem checar). Implemente o scanner por bloco/declaração com máscara de comentários e strings (índices preservando `\n`, para o `line` continuar certo) e só então espere PASS nos 6 testes do brief mais os que você acrescentar. Referências de comportamento, não de cópia: `lib/sloplint.js` commitado em `e8ae1db`.

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
- Produces: `gateTask({ scope, cssEntries }): { level: 'task', ok, findings }`, `gateWave({ dir, verify, cssEntries }): Promise<{ level: 'wave', ok, findings, build: { rc, output, timedOut } | null }>`, `runVerify(cmd, cwd, timeoutMs?): Promise<{ rc, output, timedOut }>`

**Duas coisas que a revisão da Task 7 obrigou a mudar aqui, e que valem para as Tasks 9-14:**

1. **`runVerify` é `async`.** O `execSync(..., { timeout })` mata o `cmd.exe` e **deixa o build vivo** — medido na máquina: filho que grava um arquivo 1,5 s depois, `timeout` de 300 ms, `rc 124` devolvido em 317 ms e o arquivo escrito *depois* de a gate já ter respondido. Um build zumbi na worktree de integração faz o `integrate` seguinte rodar dois builds no mesmo diretório. Só um temporizador de que nós somos donos consegue matar a árvore: `spawn(..., { shell: true })` + `taskkill /F /T /PID` no Windows, `kill('SIGKILL')` fora dele. Por isso `gateWave` e, em cascata, `cmdIntegrate` e `main` do `run.js` são `async` (top-level `await` no ESM). Custo da propagação: três `await`. Custo de não fazer: um estado de worktree que a gate não controla.
2. **`timedOut` é um campo, não o número 124.** Sem ele, um comando que ele próprio sai 124 é indistinguível de um timeout e o estado `timeout` do ledger mentiria. O `rc` continua 124 no timeout (é a convenção do `--rc` do worker, Task 12), mas o mapeamento da **onda** chaveia em `build.timedOut === true`.

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

test('runVerify devolve rc 0 e rc nao-zero sem lancar', async () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-gate-'));
  writeFileSync(join(d, 'build.mjs'), "console.log('ok');\n");
  assert.equal((await runVerify('node build.mjs', d)).rc, 0);
  writeFileSync(join(d, 'bad.mjs'), "process.exit(7);\n");
  assert.equal((await runVerify('node bad.mjs', d)).rc, 7);
});

test('runVerify corta saida longa para caber no ledger', async () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-gate-'));
  writeFileSync(join(d, 'loud.mjs'), "console.log('x'.repeat(9000));\n");
  assert.ok((await runVerify('node loud.mjs', d)).output.length <= 4000);
});

// O teste que segura a regra 1: depois de um timeout, NINGUEM pode escrever no diretorio.
// Medido nesta maquina: no lugar do taskkill da arvore, com `child.kill()` simples, o node filho
// sobrevive ao cmd.exe e o arquivo aparece — o teste falha, sempre. As margens (filho dorme 1,5 s,
// timeout de 300 ms, teste espera 2,5 s) existem para nenhuma flutuacao de maquina decidir isso.
// O filho e ESM de proposito (`require` nao existe em .mjs no Node 24 e o teste passaria vazio).
test('runVerify timeout mata a arvore de processos, nao so o shell', async () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-gate-'));
  writeFileSync(join(d, 'lento.mjs'), "import { writeFileSync } from 'node:fs';\nsetTimeout(() => writeFileSync('escrito.txt', 'zumbi'), 1500);\n");
  const r = await runVerify('node lento.mjs', d, 300);
  assert.equal(r.rc, 124);
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal(existsSync(join(d, 'escrito.txt')), false);
});

test('gateWave: build reprovado derruba a onda mesmo com css limpo', async () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-gate-'));
  writeFileSync(join(d, 'fail.mjs'), "process.exit(3);\n");
  const g = await gateWave({ dir: d, verify: 'node fail.mjs', cssEntries: [] });
  assert.equal(g.ok, false);
  assert.equal(g.build.rc, 3);
});

test('gateWave sem verify so checa sloplint', async () => {
  const g = await gateWave({ dir: process.cwd(), verify: null, cssEntries: [{ path: 'a.css', text: '.a{color:#abcdef}', tokenValues: [] }] });
  assert.equal(g.build, null);
  assert.equal(g.findings[0].id, 'SLOP-OFF-TOKEN-COLOR');
});

// A regra 2 tem que ter guarda executável: 124 vindo do comando mesmo nao e timeout.
test('runVerify de comando que sai 124 por conta propria nao e timeout', async () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-gate-'));
  writeFileSync(join(d, 'convite.mjs'), "console.log('eu escolhi sair 124');\nprocess.exit(124);\n");
  const r = await runVerify('node convite.mjs', d, 5_000);
  assert.equal(r.rc, 124);
  assert.equal(r.timedOut, false);
});
```

- [ ] **Step 2: Rodar para confirmar falha**

Run: `node --test test/gate.test.js`
Expected: FAIL — `Cannot find module '../lib/gate.js'`

- [ ] **Step 3: Implementar**

```js
// lib/gate.js
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { lintFiles } from './sloplint.js';

const VERIFY_TIMEOUT_MS = 300_000;
const OUTPUT_CAP = 4000;
const JANELA_MEMORIA = 4 * OUTPUT_CAP;
const GRACA_MS = 2_000;

const tail = (s) => String(s ?? '').slice(-OUTPUT_CAP);

// Decoder por stream: um caractere UTF-8 partido ao meio entre dois chunks não pode virar U+FFFD
// no registro do ledger. Acumula com teto: sem `maxBuffer`, é isto que impede um build de 18 MB de
// virar uma string de 18 MB — e um build barulhento que termina em 0 continua sendo 0.
function coleta() {
  const dec = new StringDecoder('utf8');
  let acum = '';
  return {
    add(chunk) {
      acum += dec.write(chunk);
      if (acum.length > 2 * JANELA_MEMORIA) acum = acum.slice(-JANELA_MEMORIA);
    },
    fim() {
      acum += dec.end();
      return acum.slice(-OUTPUT_CAP);
    },
  };
}

// Melhor esforço, e nunca lança: se o kill falhar, a gate ainda responde rc 124.
function mataArvore(child) {
  try {
    if (child.pid === undefined) return;
    if (process.platform !== 'win32') {
      child.kill('SIGKILL');
      return;
    }
    // `spawnSync` SEM `shell`: passando por shell, o Git Bash lê `/F` como caminho e o kill não
    // roda. E se o `taskkill` não estiver ao alcance (PATH quebrado), ainda vale matar o shell.
    const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    if (r.error) child.kill('SIGKILL');
  } catch {
    // nada a fazer: o rc 124 é a resposta, com ou sem kill confirmado.
  }
}

export function runVerify(cmd, cwd, timeoutMs = VERIFY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      // stdin 'ignore': gate automática não pode travar esperando resposta de um comando que
      // pergunta alguma coisa. `windowsHide`: sem isto o cmd.exe abre janela no desktop de quem
      // roda o swarm.
      child = spawn(cmd, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ rc: 1, output: tail((e && e.message) || e), timedOut: false });
      return;
    }
    const stdout = coleta();
    const stderr = coleta();
    let temporizador = null, graca = null, respondido = false, saidaDoFilho = null, timeout = false;

    // `timedOut` é campo, não o número: um comando que sai 124 por conta própria não é timeout, e
    // o estado `timeout` do ledger mentiria. O rc continua 124 porque é a convenção do ledger.
    const responde = (rc, motivo) => {
      if (respondido) return;
      respondido = true;
      clearTimeout(temporizador);
      clearTimeout(graca);
      const texto = [stdout.fim(), stderr.fim()].filter(Boolean).join('\n');
      resolve({ rc, output: tail(texto || motivo), timedOut: timeout });
    };
    const rcDoFilho = () => (saidaDoFilho === null ? 1 : (saidaDoFilho.code ?? 1));
    const motivoTimeout = () => `o build nao terminou em ${timeoutMs}ms e a arvore foi morta`;
    const armaGraca = (rc, motivo) => {
      if (graca === null) graca = setTimeout(() => responde(rc, motivo), GRACA_MS);
    };

    child.stdout.on('data', (b) => stdout.add(b));
    child.stderr.on('data', (b) => stderr.add(b));
    // O rc vem do filho, não do pipe: um EPIPE de um build que fecha o próprio stdout não pode
    // derrubar o processo do swarm nem deixar a promessa pendurada sem resposta.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    // ENOENT, cwd inexistente: o comando não rodou. rc 1 com o motivo, nunca uma exceção da gate.
    child.on('error', (e) => responde(1, (e && e.message) || String(e)));

    child.on('exit', (code, signal) => {
      saidaDoFilho = { code, signal };
      // Depois do kill resolve-se no `exit`, não no `close`: um neto que ficou com o stdio herdado
      // seguraria o `close` e a gate esperaria por um processo que ela já matou.
      if (timeout) responde(124, motivoTimeout());
      else armaGraca(rcDoFilho(), '');
    });

    child.on('close', () => {
      if (timeout) responde(124, motivoTimeout());
      else responde(rcDoFilho(), '');
    });

    temporizador = setTimeout(() => {
      if (saidaDoFilho !== null) {
        // O build terminou sozinho; o que ainda não fecharam foram os pipes. Matar a árvore aqui
        // reportaria timeout de um build que rodou até o fim.
        armaGraca(rcDoFilho(), '');
        return;
      }
      timeout = true;
      mataArvore(child);
      armaGraca(124, motivoTimeout());
    }, timeoutMs);
  });
}

export function gateTask({ scope, cssEntries }) {
  const findings = scope.violations.map((v) => ({
    id: 'SCOPE-OUTSIDE-LOT', file: v.file, line: null, message: v.reason,
  }));
  findings.push(...lintFiles(cssEntries));
  return { level: 'task', ok: findings.length === 0, findings };
}

// `async` porque espera o build que ela própria mata no timeout — e é a única função da suíte que
// precisa esperar: `gateTask` continua síncrona.
export async function gateWave({ dir, verify, cssEntries }) {
  const findings = lintFiles(cssEntries);
  // `build: null` é a terceira coisa possível, e precisa continuar visível: "a onda não declarou
  // build" não é "o build rodou e passou". Um verify em branco é tratado como não declarado.
  const cmd = typeof verify === 'string' ? verify.trim() : '';
  const build = cmd ? await runVerify(cmd, dir) : null;
  return { level: 'wave', ok: (build === null || build.rc === 0) && findings.length === 0, findings, build };
}
```

- [ ] **Step 4: Rodar para confirmar passagem**

Run: `node --test test/gate.test.js`
Expected: PASS (os 8 acima; o arquivo commitado termina com 17 testes — os extras são os que a revisão pediu)

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
- Consumes: `Task.body` (emenda da Task 2, logo abaixo)
- Produces: `loadFloor(seedDir): string`, `loadTheme(seedDir, name): string`, `repoConventions(repoDir): string`, `renderPrompt({ task, waveNumber, run, floor, theme, conventions }): string`, `writePrompt({ runDir, taskId, attempt, text }): string`

**Emenda do controlador (achados da própria Task 8, 2026-11-05), dois itens e os dois neste módulo:**

1. **O corpo da tarefa entra no prompt.** `${task.title}` sozinho é uma frase; a especificação é o `body` do plano. `renderPrompt` imprime `task.body` (já trimado pelo parser) logo abaixo do título, sem inventar seção nova quando ele está vazio, e corta o começo com `[corpo cortado]` acima de 6000 caracteres — mesmo teto e mesma direção do `repoConventions`, porque o que um plano escreve primeiro é o que importa. O teto fica no *prompt*, não no parser: o `plan.md` do humano continua sendo o texto inteiro.
2. **O parágrafo das dependências tem que dizer a verdade do run, e a verdade está mudando na Task 9.** A versão inicial deste módulo escreveu "o que as dependências prometem não está no seu worktree", que era honesto com o `cmdStart` rascunhado (todo worktree sai do `baseSha` do run). Isso é um defeito de design, não de texto — a spec (§ "Ledger como barragem") diz que *a onda seguinte só abre quando a atual passa na gate*, e com worktree saindo do base esse `depends_on` não entrega nada além do nome da tarefa. A Task 9 passa a cortar worktree de onda > 1 do head da branch de integração e a recusar `start` de tarefa com dependência não integrada. Feito isso, o prompt afirma o invariant como fato — "as dependências declaradas já estão no seu worktree; leia-as antes de escrever, e não recrie o que elas entregam" — e continua proibindo escrever fora do lote. Se a Task 9 chegar aqui e ainda não fizer o corte pelo head, é a Task 9 que muda, não este texto de volta.

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
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPrompt, writePrompt } from '../lib/prompt.js';
import { loadFloor, loadTheme, repoConventions } from '../lib/briefing.js';
import { scopeDir } from '../lib/paths.js';

const SEED = join(import.meta.dirname, '..', 'seed');

const base = {
  // O lote vai `components/header/**` e nao `components/header`: `scopeDir` corta caminho literal
  // no pai, e o teste de abaixo afirma o diretorio inteiro dentro do prompt (regra da Task 2).
  task: { id: 'T-01', title: 'Cabecalho acessivel', dirs: ['components/header/**'].map(scopeDir), dependsOn: [], verify: null },
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
  // Os 9000 x do arquivo viraram no maximo 6000 no prompt, e sobreviveu a frente (o comeco da
  // regra, nao o fim do arquivo): contar os x e mais honesto que afirmar um comprimento exato,
  // que mudaria se o cabecalho `### AGENTS.md` mudasse de tamanho.
  const xs = (out.match(/x/g) || []).length;
  assert.ok(xs > 5000 && xs <= 6000, `x cortado para o teto por arquivo, veio ${xs}`);
});

// O nome do teste acima promete AGENTS.md E CLAUDE.md, entao os tres arquivos convencionados
// precisam ter cobertura: o worker so ve o que repoConventions juntou, e a ordem dos cabecalhos
// e o que o prompt da Task 8 mostra como "Convenções do repositorio alvo".
test('repoConventions junta os tres arquivos de convencao, cada um com seu teto', () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-conv-'));
  writeFileSync(join(d, 'AGENTS.md'), 'regra-agents\n' + 'a'.repeat(9000));
  writeFileSync(join(d, 'CLAUDE.md'), 'regra-claude');
  writeFileSync(join(d, 'TECHNICAL_GUIDELINES.md'), 'regra-tech');
  const out = repoConventions(d);
  assert.ok(out.includes('regra-agents') && out.includes('regra-claude') && out.includes('regra-tech'));
  assert.deepEqual([...out.matchAll(/^### (\S+)$/gm)].map((m) => m[1]),
    ['AGENTS.md', 'CLAUDE.md', 'TECHNICAL_GUIDELINES.md']);
  assert.ok(out.length < 3 * 6100, 'o teto e por arquivo, e a soma tem que caber no prompt');
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
  assert.equal(git(['branch', '--list', 'swarm/*'], repoDir).trim(), '');
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
import { execFileSync } from 'node:child_process';
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

**Quatro requisitos que a Task 8 trouxe para cá, e que este passo é dono de cumprir** (não são refinamento, são correção de design):

1. `cmdStart` recusa tarefa com dependência não `merged` e corta worktree de onda > 1 do head da branch de integração — a barragem da spec vira código, e `depends_on` passa a entregar arquivos reais ao worker.
2. `cmdFinish` diffa contra `baseOf(...)` (merge-base da branch da tarefa com a de integração), nunca contra `run.baseSha` cru — sem isto, o item 1 faria a gate reprovar todo worker de onda 2 pelos arquivos da onda 1.
3. `cssEntries` supplying `tokenValues` desde o arquivo de tokens do worktree (`--tokens`, default `styles/tokens.css`) e `null` quando ele não existe; `tokenSource` vai no `gate.json` para o dry run poder dizer quanta gate estava armada.
4. `gitIn(repoDir, args)` (helper que o `cmdAbort` já usa sem nunca ter sido definido no plano) retorna **stdout em utf8 já trimado**, via `execFileSync` sem shell — os itens 1 e 2 leem sha por ele, e um helper que engole a saída quebra as duas coisas.

```js
function attemptOf(runDir, taskId) {
  let n = 1;
  while (existsSync(join(runDir, 'tasks', taskId, `attempt-${n}`, 'prompt.md'))) n++;
  return existsSync(join(runDir, 'tasks', taskId, `attempt-${n - 1}`, 'report.md')) ? n : Math.max(1, n - 1);
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
  // O mesmo padrão vale para `dropTask` e `cmdAbort`: chamar removeWorktree sem guard próprio.
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
  const report = parseReport(existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '');
  const rc = Number(o.rc ?? 0);
  if (rc !== 0) {
    append(o.run, { task: task.id, state: 'failed', rc, start: latest(o.run, task.id).start, end: stamp(),
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
  const gate = gateTask({ scope, cssEntries: entries });
  writeFileSync(join(o.run, 'tasks', task.id, `attempt-${attempt}`, 'gate.json'),
    JSON.stringify({ ...gate, tokenSource, files }, null, 2) + '\n');
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
    // Sem guard existsSync aqui (round 2 Task 9): removeWorktree prunea a inscrição stale mesmo
    // com o diretório apagado por fora, e o `branch -D` de baixo deixa de falhar em silencio.
    removeWorktree({ repoDir: run.repoDir, dir });
    // `git worktree remove` NAO apaga a ref: sem isto, o `git branch` do humano acumula
    // uma linha swarm/<runId>/... por tarefa, por run. A refstore e compartilhada por
    // construcao do git, e limpar ela e obrigacao deste CLI, nao do worktree.
    // `branch -D` guardado (fix round 1 Task 9, D8 aprovado): abort logo depois de init/plan nao
    // tem ref nenhuma, e sem o catch o comando do operador morria no meio do loop de limpeza.
    try { gitIn(run.repoDir, ['branch', '-D', branchName(run.runId, t.id)]); } catch { /* nunca existiu */ }
    append(o.run, { task: t.id, state: 'discarded', rc: null, start: latest(o.run, t.id)?.start ?? null,
      end: stamp(), branch: branchName(run.runId, t.id), log: null, tokens: null, pid: null });
  }
  const integ = integrationPath(o.run);
  // Round 2 Task 9, mesmo raciocinio do retry: sem o prune incondicional aqui, uma integracao
  // apagada por fora deixa inscricao stale e o `branch -D` de baixo falha em silencio.
  removeWorktree({ repoDir: run.repoDir, dir: integ });
  try { gitIn(run.repoDir, ['branch', '-D', `swarm/${run.runId}/integration`]); } catch { /* nunca existiu */ }
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

**Nota de implementação:** `cmdIntegrate` acima está rascunhado de propósito em duas passadas — a versão final roda **uma** pilha de branches por onda, chamando `mergeInOrder` com `pile` e gravando `gates/wave-<n>.json` + linhas `merged`/`failed` no ledger, e a `gateWave` com `verify` declarado no plano. A versão final também **apaga as refs `swarm/<runId>/<task>` das branches que entraram na pilha** (e a `swarm/<runId>/integration` quando a última onda fecha): `git worktree remove` não apaga ref, e sem isto o `git branch` do humano acumuma uma linha por tarefa a cada run — achado da revisão da Task 4. Implemente a versão final aqui, substituindo o rascunho, e teste no Step 1 de `test/e2e.test.js` (Task 11). Não deixe o rascunho no arquivo: o teste de integração abaixo é o que o remove.

**Cascata do `async` da Task 7 (achado da revisão dela):** `gateWave` devolve Promise, então `cmdIntegrate` é `async`, `main` é `async` e a entrada vira `process.exitCode = await main(process.argv.slice(2))` (top-level `await` do ESM). `cmdStart`, `cmdFinish`, `cmdStatus` e `cmdAbort` continuam síncronos — em todo o M1 só a gate de onda roda shell, e ela é o único lugar que precisa esperar. Quem chamar `main` diretamente em teste precisa do `await`; os testes das Tasks 11 e 12 chamam o CLI por processo filho e não mudam.

**O estado `timeout` tem consumidor aqui:** se `build.timedOut === true` na gate da onda, as linhas daquela onda no ledger saem com estado `timeout` (não `failed`) e a onda **não** avança para `merged`; o JSON do `integrate` devolve o `build` com o `output` cortado. É assim que o operador distingue "o build quebrou" de "o build não terminou dentro dos 5 min" — na Task 12 isso é a diferença entre re-rodar e investigar o toolchain.

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

**Emenda do controlador (revisão da Task 10, 2026-11-05) — a skill é contrato documental; três frases do texto abaixo ensinam o que o código NÃO faz e foram corrigidas na fix round, com o código correspondente adiada para a Task 12 (registrada no ledger):**

1. **`crashed[]` do `status` dispara SIM — e errado.** O texto abaixo diz "M1 não grava pid, então essa linha não dispara". Verificado: `pid: null` → campo vazio → `Number('') === 0` → `isAlive(0)` é `false` → `crashedRuns` marca TODO task cujo último estado é `running`; o `status` no meio de uma onda imprime um `{crashed:[...]}` falso. A skill passa a descrever o ruído como ruído ("em M1, tarefa `running` aparece em `crashed` porque não há pid; é limitação conhecida, não incidente") e a correção do predicado (pid ausente ⇒ *estado desconhecido*, não morto) é da Task 12.
2. **`finish` não compara o `touched` declarado com o diff.** Só `scopeCheck` (diff vs LOTE) reprova; `out.touched` é recomposto do git e o `touched` do report não tem consumidor. A frase da skill-worker vira a verdade, e a frase homóloga em `lib/prompt.js` ("divergir dos dois jeitos reprova a tarefa") — que mente ao worker desde a Task 8 — é ajustada na mesma fix round; *implementar* a coerção declarada-×-real é carrego para a Task 12, com teste.
3. **Rodar `plan` de novo num runDir vivo entope o run.** `cmdPlan` anexa linha `planned` para toda tarefa, inclusive as já `merged` — o próximo `integrate` vê essa tarefa como não-pronta (`blockedOn`) e o `start` dela morre na imutabilidade do prompt. O remédio do integrator ("Blocked vira tarefa nova") passa a valer **no próximo run**; num run vivo, tarefa nova se declara quando o run fecha, não se re-planifica no meio.
4. Menores de precisão: rc 2 por tarefa desconhecida é do `start` (no `finish` é TypeError rc 1 — dizer `start`); o corpo da tarefa vai ao prompt **até 6000 chars** com `[corpo cortado]`; `gates/wave-<n>.json` é escrito em toda onda que chega à gate (sem `verify`: `build: null`, `ok: true` — o que exige `verify` é o `build`).

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
Toda escrita de estado vai pelo `run.js` — só o CLI escreve `plan.md`/`waves.json`/`status.tsv`/`run.json`
(single-writer, Global Constraints; você planeja e dispara comandos, a mão que grava é o CLI, nunca um
editor seu no ledger). 

## Ciclo
1. `node run.js init --repo <repo> --workspace <dir>` -> `runDir` no stdout.
2. Escreva `plan.md`. Cada tarefa declara o **lote** (diretorios que ela possui),
   `depends_on` e `verify`. Lote disputado na mesma onda faz o plano ser recusado.
   Sintaxe do lote: um diretorio **sempre** com `/**` no fim (`backend/adapters/**`).
   Sem o wildcard, `scopeDir` corta o caminho literal no pai e a tarefa passa a
   possuir um nivel acima do que voce declarou; um nome solto (`config`) vira a raiz.
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
4. Rode `node run.js integrate` de novo depois de corrigir — a gate de onda roda dentro dele, não
   existe comando `gate` — e só então declare a onda fechada.

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
  // Identidade repo-local (ruling I1 da Task 4): o `-c` do helper git() do teste NAO chega ao
  // subprocesso run.js, e o `integrate` faz merge de verdade. Sem estas duas linhas o e2e
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
  const a = worker(s, 'T-01', { 'styles/tokens.css': ':root { --bg: oklch(0.99 0.002 260); --ink: oklch(0.2 0.01 260); }\n' });
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
- Modify (emenda do controlador, item 3): `run.js`, `lib/ledger.js`, `lib/report.js`, `lib/prompt.js`, `skills/swarm-worker/SKILL.md`, `skills/swarm-orchestrator/SKILL.md`, `test/prompt.test.js`/`test/skills.test.js` (literais aprisionados)

**Interfaces:**
- Consumes: `run.js`, `lib/ledger.js`, `lib/isolate.js`
- Produces: nenhum produto

**Emenda do controlador (carrego das Tasks 10 e 11, 2026-11-05) — esta Task é também a última correção de código do M1; o Step 1 sozinho não a completa:**

1. **Setup hermético (mesma régua da emenda edfad4a da Task 11).** O bloco `setup()` do Step 1 ganha as duas linhas de identidade repo-local logo após o `git init` (antes do commit `base` e antes do `cli(['init'])`, cujo pre-check lê `git config user.email`). O `-c` do helper `git()` NÃO chega ao subprocesso `run.js`.

2. **Quatro testes NOVOS no `test/fault.test.js` (código abaixo, após os 5 do Step 1; o quarto prende o caso positivo da lista vazia — achado M-2 da review):**

```js
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
```

3. **Implementações exigidas (a ordem é teste primeiro, código depois):**
   - `crashedRuns` (lib/ledger.js): célula de `pid` vazia/não-numérica ⇒ **estado desconhecido, não morto** — a linha não entra em `crashed[]`; só entra pid numérico com `!isAlive(pid)`. É isto que derruba o falso positivo que a Task 10 documentou como ruído (run do meio de onda com `pid: null`).
   - `cmdFinish` (run.js), só no caminho `rc == 0` com report presente: compara o conjunto declarado em `- touched:` com o diff REAL já recomposto do git contra `attempt-N/base.txt`. Dois conjuntos de findings: arquivo declarado sem mudança ⇒ `TOUCHED-DECLARED-NOT-DONE` (um finding por arquivo, com `file`); arquivo mudado sem declaração ⇒ `TOUCHED-DONE-NOT-DECLARED`. Os findings entram o veredito da gate: divergência em qualquer sentido ⇒ `ok:false`, estado `failed` (D1 continua: exit 0, o JSON é o veredito). `- touched: -` significa lista VAZIA (compare com o parse de `depends_on: -`); se `lib/report.js` hoje nao trata o tracinho, tratar.
   - `lib/prompt.js`: reescrever o paragrafo do `touched` para o contrato FINAL (a coercão dos dois sentidos existe e reprova) e corrigir a frase de `prompt.js:78-80` ("Blocked vira tarefa nova na onda seguinte") — o que acontece de verdade: o `## Blocked` chega ao operador no JSON do `finish`, a tarefa fica `failed`/`gated` conforme o veredito, e quem abre tarefa nova e o humano no plano seguinte. Nada de prometer automato que o CLI nao roda.
   - Sincronizar a documentação com o código novo (mesma derivada da Task 10, agora ao contrario): a frase do `touched` em `skills/swarm-worker/SKILL.md` passa a AFIRMAR a coercão, e a frase do `crashed[]` em `skills/swarm-orchestrator/SKILL.md` para de descrever o ruído (pid ausente não aparece mais). A lista NÃO é exaustiva: varredura `grep -rn` por touched/crashed/timeout/rc em `skills/` + `lib/prompt.js` inteira — inclui `skills/swarm-integrator/SKILL.md` (frase wave-only do `timeout` e máscara `--rc <0|1>`, que deve virar 0/124/outro-não-zero) e o passo 6 do orquestrador (`timeout` de TAREFA via `--rc 124` ≠ `timeout` de build de ONDA; as duas origens existem). Rodar `node --test test/skills.test.js test/prompt.test.js` e atualizar os literais aprisionados na MESMA mudança — nenhum commit pode deixar skill e código divergidos.

4. **Correção do Step 2 (contra-emenda 2026-11-06, prova do revisor da Task 12):** a emenda anterior MENTIU ao dizer que `rc 124 → timeout` já estava embarcado na Task 9 — `git log -S "rc === 124" -- run.js` mostra só `c333325`; o que a Task 9 embarcou foi o curto-circuito `blockedOn` e o `build.timedOut` da ONDA. O mapping do WORKER (`cmdFinish`) é trabalho DESTA Task — o Step 2 original e a regra 2 da Task 7 sempre disseram isso. Medição real: dos 5 testes do Step 1, **4 nascem PASS** (crash, abort, blockedOn, failed-rc2) e **`timeout` nasce FAIL**; os 3 novos do item 2 também nascem FAIL. TDD desta Task: 4 verdes / 4 vermelhos antes das implementações do item 3.

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
```

- [ ] **Step 2: Rodar**

Run: `node --test test/fault.test.js`
Expected: 4 dos testes do Step 1 nascem PASS (crash, abort, blockedOn, failed-rc2); `timeout` nasce FAIL junto com os 4 NOVOS da emenda (item 4 contra-emendado). Implemente o item 3 da emenda:
  - em `cmdFinish`: `rc === 124 → estado 'timeout'`. Aqui o 124 é **convenção com quem despacha o worker** (o host devolve 124 quando mata o agente no tempo dele), não saída de `execSync` — a gate da onda não passa por aqui e usa o campo `timedOut`, porque lá o número sozinho não é confiável (ver Task 7, regra 2). Qualquer outro `rc != 0 → 'failed'`;
  - em `cmdIntegrate`: se a onda tem tarefa não `gated`, retorne `{ merged: [], conflicts: [], blockedOn: <primeiro id nao gated> }` sem tocar na branch de integração; se `build.timedOut`, registre a onda como `timeout` (já especificado na Task 9).

- [ ] **Step 3: Rodar até passar**

Run: `node --test test/fault.test.js`
Expected: PASS (9 testes)

- [ ] **Step 4: Rodar a suíte inteira**

Run: `node --test "test/"*.test.js`
Expected: PASS em todos os arquivos (132 = 123 + os 9 de fault). Se `e2e` quebrar depois desta mudança, é sinal de que a coercão do `touched` pegou uma declaração divergente no teste da Task 11 — corrigir a DECLARAÇÃO do report no fixture do teste (ela é que estava mentindo), não relaxar a coercão. Vale a regra de sempre: relaxar o `integrate` para fazer verde esta PROIBIDO.

- [ ] **Step 5: Commit**

```bash
git add test/fault.test.js run.js lib/gate.js lib/ledger.js lib/report.js lib/prompt.js test/prompt.test.js skills/
git commit -m "swarm: timeout, crash e ausencia de merge parcial viram estado no ledger"
```

---

### Task 13: Dry run em `libra` — marketing com 3 lotes disjuntos (spec §12 risco 1)

**Files:**
- Create: `docs/dry-run-libra.md`, `runs/` (ignorado pelo git)

**Interfaces:**
- Consumes: CLI + skills dos passos anteriores. Repo alvo: `O:/DEV/A JORNADA/PROJETOS/libra` (árvore limpa verificado em 2026-11-05; **sem `node_modules` instalado**, `bun 1.4.2` presente).

**Emenda B-1 (2026-11-06, medida na tentativa 1).** O run `20261106-fb0f` falhou na onda 1: o worker de T-02 reportou `## Blocked` porque o worktree prometido não existia no workspace — `git worktree add` recebe o caminho relativo de `--run` com cwd no repo alvo (`lib/isolate.js`, `add()`), então o worktree nasceu DENTRO do libra. O orquestrador abortou (libra intacto: HEAD 454e5c4, zero branches/worktrees); o humano mandou parar o agente de background e o controlador assumiu em primeiro plano. Reproduzido em repo temporário. Os 132 testes não pegaram porque todo setup usa workspace absoluto (`mkdtempSync`). Correção obrigatória ANTES de re-rodar os steps abaixo: (a) `main()` normaliza `--run` para absoluto na fronteira do CLI; (b) teste e2e novo dirige o CLI com `--run` relativo a partir do cwd do workspace e afirma que o worktree nasce no workspace (não no repo) e que `workDir` devolvido é absoluto — nasce FAIL, passa com o fix. A tentativa 1 entra no `docs/dry-run-libra.md` como linha de falha medida, não como nota de rodapé.

- [ ] **Step 1: Preflight (sem escrever nada)**

```bash
git -C "O:/DEV/A JORNADA/PROJETOS/libra" status --porcelain        # esperado: vazio
git -C "O:/DEV/A JORNADA/PROJETOS/libra" rev-parse --abbrev-ref HEAD  # esperado: main
git -C "O:/DEV/A JORNADA/PROJETOS/libra" config core.longpaths                    # esperado: true
tasklist //FI "IMAGENAME eq bun.exe" 2>/dev/null | head -5        # builds de runs anteriores
```

Se sujo: **pare e pergunte**. Worktree ramifica do HEAD; árvore suja significa que o swarm trabalharia num estado que não é o que está commitado.

Os outros dois são checks aprendidos nas revisões, não burocracia:

- **`core.longpaths`.** Os lotes reais deste repo têm `(frontend)/(marketing)` e o `runDir` acrescenta `runs/<id>/worktrees/<task>/` na frente. No Windows sem longpaths, `git worktree add` falha no meio do run com erro de caminho, não com erro do swarm. Se vier vazio, `git -C <repo> config core.longpaths true` antes de `init` — é config do repo, não código.
- **Build órfão.** A gate de onda mata a árvore do processo no timeout (Task 7), mas um run *anterior* pode ter deixado um build vivo nesta worktree de integração, e `integrate` sobre ele faria dois builds no mesmo diretório ao mesmo tempo. Se o `tasklist` mostrar `bun.exe`/`node.exe` que você não reconheceu, termine antes de integrar e anote no `docs/dry-run-libra.md` o que estava vivo. Nunca re-rodar `integrate` com um build do `integrate` passado ainda escrevendo.

- [ ] **Step 2: Escrever `runs/<id>/plan.md` com os três lotes reais**

```markdown
# plano libra — secao de precificacao
## T-01 paginas de marketing
- paths: apps/web/app/(frontend)/(marketing)/**
- depends_on: T-02
- verify: -

Rota de precificacao existente: reescrever a pagina usando os componentes de T-02, sem criar
componente novo dentro desta pasta. Titulo e subtitulo em PT; a variant EN fica em T-03.
Nao tocar em tokens nem em componentes compartilhados — se faltar um componente, e ## Blocked.

## T-02 componentes de marketing
- paths: apps/web/components/marketing/**
- depends_on: -
- verify: -

Extrair/corrigir os blocos da secao de precificacao: card de plano, tabela comparativa e CTA.
Props tipadas, sem hex literal — cores so via tokens do tema. Este lote e o contrato que a
onda 2 consome: nomes de componente estaveis importam mais que beleza aqui.

## T-03 textos pt/en
- paths: apps/web/messages/**
- depends_on: T-02

Copy PT/EN da secao de precificacao nos arquivos de messages ja existentes, seguindo a estrutura
de chave do repo. Sem placeholder tipo Lorem ipsum; preco e o que esta em production.json hoje.
```

**Sintaxe de lote (regra, não opção):** um lote de diretório **sempre** termina em `/**`. `scopeDir` corta um caminho literal sem wildcard no diretório pai — `apps/web/messages` viraria posse de `apps/web` inteiro, e o swarm perderia o isolamento que é a tese do M1. Um arquivo literal declarado sozinho (`styles/tokens.css`) herda o diretório dele de propósito (é o que a spec afirma no Task 1).

**O corpo de cada tarefa não é comentário** (emenda C3, ruling da Task 8): `parsePlan` acumula as linhas de prosa depois dos campos em `Task.body`, `renderPrompt` as imprime abaixo do título e o teto de 6000 caracteres corta com `[corpo cortado]`. Um plano de dry run escrito só com título mediria agentes adivinhando — o que a spec chama *context pack* é o body, e é ele que a fixture declara. Se ao rodar o `plan` o JSON dos tasks vier com `body: ''`, o parser está sem a emenda da Task 2 e o dry run para ali.

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

- [ ] **Step 5: Fechar a onda 1 antes de abrir a onda 2**

```bash
node run.js integrate --run runs/<id>
```

Expected: `{ "merged": ["T-02"], ... }` e as linhas `merged` no ledger. Este passo não é burocracia de medição: é ele que põe os componentes de T-02 dentro do worktree de T-01 e T-03 (emenda da Task 8 / item 1 da Task 9). **Sem ele, `start` em T-01 recusa com `PlanError`** — e se você chegar aqui e ele não recusar, o item 1 da Task 9 não foi implementado: pare e volte lá, porque o resto da medição sairia mentindo.

- [ ] **Step 6: Onda 2 — dois workers em paralelo**

`start` em T-01 e T-03 (dois, agora liberados), dois subagentes de background simultâneos, `finish` nos dois. Eles leem os componentes que já estão no worktree e escrevem a página e o copy em cima do que existe — é essa a diferença entre um swarm com ondas e três agentes no mesmo repo.

- [ ] **Step 7: Integrar e medir**

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

- [ ] **Step 8: Fechar sem deixar resíduo**

```bash
git -C "O:/DEV/A JORNADA/PROJETOS/libra" worktree list       # conferir
node run.js abort --run runs/<id>                             # se quiser descartar
git -C "O:/DEV/A JORNADA/PROJETOS/libra" branch -D swarm/<id>/T-01 swarm/<id>/T-02 swarm/<id>/T-03
```

**Nenhum push. Nenhuma branch do `main` movida. Nada publicado.** Se você quiser o resultado, a branch de integração fica no repo e você revisa.

- [ ] **Step 9: Escrever o veredito do risco 1**

No fim de `docs/dry-run-libra.md`: com esses números, o swarm de 3 vale a pena para site, ou não? Se não, o M1 é um teste de uma agente só e a spec recebe uma ratchet.

- [ ] **Step 10: Commit**

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

`git init` na pasta de um sistema que roda no andar 6 do ALETHE é ação em repositório de produto. **Não rode sem a resposta explícita do usuário.** OK CONCEDIDO em 2026-11-06 (AskUserQuestion): "Aprovo, sem os binários" — o `.gitignore` abaixo já reflete o escopo aprovado (exclui também `index (1).html` e `*.zip`, os 1,4MB de binário/backup que o brief original mandava confirmar):

```bash
cd "O:/DEV/A JORNADA/PROJETOS/Trabalhos reais/dashboard"
git init -q -b main
printf 'runtime/\n*.sqlite\n__pycache__/\nindex (1).html\n*.zip\n' > .gitignore
git add -A && git -c user.email=swarm@test -c user.name=swarm commit -q -m "linha de partida: monitor Verde Fluxo"
git log --oneline -1 && git status --porcelain | wc -l
```

Expected: `git status --porcelain` vazio e NENHUM binário grande no commit inicial (`git show --stat`confere). O OK cobre só este init+commit local; nada de push, nada de publicar.

- [ ] **Step 2: Plano com lotes no backend (o monólito HTML fica de fora de propósito)**

```markdown
# plano verde fluxo — health das fontes
## T-01 adapters
- paths: backend/adapters/**
- depends_on: -
- verify: python -m unittest discover -s backend/tests -v

Adaptadores de fonte (RSS, API, scraping): cada um expoe fetch() e health() no contrato que
os testes de T-02 cobram. Sem mudanca de contrato — se o contrato atual nao fecha, ## Blocked
dizendo qual metodo falta, porque o lote de testes e de outra tarefa.

## T-02 teste de contrato
- paths: backend/tests/**
- depends_on: -
- verify: python -m unittest discover -s backend/tests -v

Teste de contrato unico rodando sobre todos os adapters: mesmo nome de metodo, mesma assinatura,
mesma saida de health(). E este teste que a gate de onda roda — se ele quebrar, a onda nao fecha.

## T-03 config das fontes
- paths: config/**
- depends_on: -
- verify: -

Registrador das fontes vivas com URL, tipo e intervalo. Nenhuma chave nova sem par no adapter —
config e espelho do que existe, nao wishlist.
```

Mesma regra da Task 13: lote de diretório termina em `/**`. Sem isso, `config` viraria `.` — a raiz do repositório inteiro, que `validateWaves` só aceita como lote solo. E mesma emenda C3: os três corpos acima são a especificação que o worker recebe (`Task.body` → prompt); um plano sem corpo aqui mediria adivinhação, não swarm.

Onde está o dente: T-01 e T-02 **não podem** ser na mesma onda se tocarem o mesmo contrato — é o teste honesto de que a declaração de lote obriga o planejador a pensar em posse. E o `verify` roda de verdade, sem `bun install`.

- [ ] **Step 3: Rodar as duas ondas, integrar, medir**

Sequência idêntica à Task 13 (steps 4→7, com o `integrate` da step 5 entre as ondas mesmo sem `depends_on` aqui — é a mesma máquina, não uma burocracia), com os mesmos seis números, mais um:

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
