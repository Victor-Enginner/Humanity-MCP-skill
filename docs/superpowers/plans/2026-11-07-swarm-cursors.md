# SWARM cursors (M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Painel espectador local onde o usuário vê o run real do M1 construir código ao vivo — árvore, viewer read-only com cursores nomeados/coloridos por lote, faixa de ondas/gates — via SSE, zero deps.

**Architecture:** `panel/` é adição pura: `watch.js` (fs.watch + debounce + diff line-based nos worktrees) e `ledger-watch.js` (poll do status.tsv + gates) emitem eventos; `server.js` (http stdlib, GET-only, 127.0.0.1) serve estáticos + `/snapshot` + `/file` + `/events` (SSE, ring buffer 500, replay por Last-Event-ID); `public/` renderiza. O M1 não muda uma linha — o painel só lê o run.

**Tech Stack:** Node 24 stdlib ESM (fs, http, child_process), `node --test`, Playwright headed via lib global já instalada (`C:/Users/User/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright`, Chromium 155 verificado nesta máquina).

**Spec:** `docs/superpowers/specs/2026-11-07-swarm-cursors-design.md` (commit eefc2a7) — o plano argumenta a partir dela; o contrato de eventos §4 é congelado.

## Global Constraints

Copiado verbatim da spec §2 (C1–C10) e §7:

- C1: Abordagem A: espectador do run real, não editor-runtime nem replay.
- C2: **SSE**, não WebSocket.
- C3: Visualizador de código próprio, read-only (`<pre>` + overlays); zero-deps do M1 preservado.
- C4: Bind só em `127.0.0.1`, porta default 4180 (`--port` opcional).
- C5: Um painel por run.
- C6: Cursor por arquivo, dono = lote da tarefa (lotes disjuntos por onda).
- C7: Árvore vem de `git ls-tree -r <baseSha>` ∪ arquivos novos dos worktrees.
- C8: Servidor só aceita GET; qualquer outro método → 405.
- C9: Zero dependências novas (Node 24 stdlib, ESM). Playwright é ferramenta de verificação já presente na máquina — NÃO entra no `package.json`.
- C10: Usuário inicia o servidor (`node panel/server.js --run runs/<id>`); nada de daemon, nada roda em background sem pedido explícito.
- Testes: `node --test "test/"*.test.js` (NUNCA `node --test test/`), hermético (mkdtemp), comportamento real. A suíte do M1 (135) continua verde; nenhum arquivo do M1 é modificado.
- Cores fixas por ordem de task: T-01 `#4f9cf9`, T-02 `#3fb56b`, T-03 `#e8a33d`.
- Contrato §4 congelado: 5 tipos de evento (`edit`, `delete`, `state`, `gate`, `reset`), `/snapshot`, `/file` com validação de path (relativo, sem `..`, na tree → senão 400), texto cap 64KB, binário = null byte nos primeiros 8KB.
- Verificação visual Playwright headed do golden path e dos edges é OBRIGATÓRIA antes de declarar pronto (spec §7/§9.5).
- Nada de push: commits ficam locais até o usuário autorizar explicitamente.

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `panel/public/core.js` | Matemática de linhas compartilhada servidor/cliente: `toLines`, `applyEdit` (uma definição só, roundtrip prendado por teste) |
| `panel/watch.js` | `diffLines`, `readCapped`, `capBuffer`, `watchWorktrees` — fs.watch + debounce 150ms + rescan → `edit`/`delete` |
| `panel/ledger-watch.js` | `watchLedger` — poll 250ms do `status.tsv` e `gates/wave-N.json` → `state`/`gate` |
| `panel/server.js` | `createPanelServer` + CLI — estáticos, `/snapshot`, `/file`, `/events` SSE ring 500, rescan 2s, 405, boot rc 2 |
| `panel/public/index.html`, `app.js`, `style.css` | Árvore com badge do dono, viewer com cursor nomeado + reveal ~30 chars/frame, faixa de ondas/gates |
| `test/panel-fixtures.js` | Fixture compartilhada (repo git real + run M1 real via lib) + `waitFor` + `sseClient` — não é `.test.js`, não roda na suíte |
| `test/panel-watch.test.js`, `test/panel-ledger-watch.test.js`, `test/panel-server.test.js`, `test/panel-static.test.js` | Testes das 4 unidades + contrato §4 prendado |
| `test/visual/check.mjs` | Verificação visual headed (fake run + Playwright), screenshots em `.superpowers/` (ignorado) |
| `docs/panel-visual-check.md` | Registro da verificação visual (exigido pela spec §9.5) |

Decisões de fronteira que o plano trava (a spec não fixa, mas o contrato permite):

- Cliente SSE **novo** (sem `Last-Event-ID`) recebe o replay completo do ring buffer (≤500 eventos) — é assim que gates anteriores ao boot do cliente chegam à faixa. `ledger-watch` emite eventos `gate` para arquivos já existentes no boot; estados iniciais vêm do `/snapshot`, não de eventos.
- `reset` de reconnect é escrito só para o cliente com gap, com id do contador, sem entrar no ring (os outros clientes não precisam redesenhar).
- `/file` de arquivo com dono `deleted` cai no conteúdo do base com `task` do dono — o viewer mostra "[arquivo removido]" a partir do `edits`/evento `delete`, não do conteúdo.
- Race conhecida e aceita (espectador, não editor): `skipUntil` do buffer é o `lastId` **depois** do fetch de `/file`; um write que cai dentro da janela do fetch (~ms em localhost) pode ser pulado e cura no próximo write/rescan ou num `reset`. O caminho dourado (write → debounce 150ms → evento → fetch) não tem a race.
- Binário: `watch` emite `edit` com `lines: []` na transição para binário (cursor vai ao arquivo, sem reveal); writes binários subsequentes não geram evento (não há diff de texto possível).

---

### Task 1: Matemática de linhas + watcher de worktrees

**Files:**
- Create: `panel/public/core.js`
- Create: `panel/watch.js`
- Create: `test/panel-fixtures.js`
- Test: `test/panel-watch.test.js`

**Interfaces:**
- Consumes: `lib/ledger.js` (`createLedger`, `append` — só na fixture), formato do run M1 (`run.json`, `worktrees/<task>/`).
- Produces:
  - `core.js`: `toLines(text) → string[]` (CRLF→LF, newline final não vira linha vazia, `''`→`[]`); `applyEdit(lines, {startLine, endLine, lines}) → string[]` (splice 1-based inclusivo; `endLine < startLine` = inserção pura).
  - `watch.js`: `diffLines(oldLines, newLines) → {startLine, endLine, lines} | null` (null = iguais); `capBuffer(buf) → {binary, text, truncated}`; `readCapped(path) → {binary, text, truncated}`; `CAP_BYTES = 65536`; `DEBOUNCE_MS = 150`; `watchWorktrees({runDir, repoDir, baseSha, baseTree, onEvent, debounceMs?, useWatch?}) → {owners: Map<file,{task,deleted?}>, rescan(), poke(task,file), close()}`. Eventos: `{type:'edit', task, file, startLine, endLine, lines}` e `{type:'delete', task, file}` (sem `id` — o servidor numera).

- [ ] **Step 1: Escrever os testes que falham**

`test/panel-fixtures.js` (compartilhado pelas Tasks 1–3; repo e ledger REAIS do M1):

```js
// test/panel-fixtures.js — fixture real: repo git + run no formato M1. Não é .test.js.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, append } from '../lib/ledger.js';

export function makeRun() {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-panel-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'um\ndois\n');
  writeFileSync(join(repo, 'base.css'), 'body { color: red; }\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD').trim();
  const runDir = join(dir, 'run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    runId: '20261107-test', repoDir: repo.replaceAll('\\', '/'), baseSha, createdAt: '2026-11-07T00:00:00Z',
  }));
  writeFileSync(join(runDir, 'tasks.json'), JSON.stringify([
    { id: 'T-01', title: 'um', body: '', dirs: ['lote1'], dependsOn: [], verify: null },
    { id: 'T-02', title: 'dois', body: '', dirs: ['lote2'], dependsOn: [], verify: null },
  ]));
  writeFileSync(join(runDir, 'waves.json'), JSON.stringify([['T-01'], ['T-02']]));
  createLedger(runDir);
  for (const id of ['T-01', 'T-02']) {
    append(runDir, { task: id, state: 'planned', rc: null, start: null, end: null, branch: null, log: null, tokens: null, pid: null });
  }
  for (const id of ['T-01', 'T-02']) {
    mkdirSync(join(runDir, 'worktrees', id), { recursive: true });
    // worktree real é checkout COMPLETO: os dois arquivos do base, senão o boot marca deleted falso
    writeFileSync(join(runDir, 'worktrees', id, 'a.txt'), 'um\ndois\n');
    writeFileSync(join(runDir, 'worktrees', id, 'base.css'), 'body { color: red; }\n');
  }
  return {
    dir, repo, runDir, baseSha, git,
    baseTree: new Set(['a.txt', 'base.css']),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timeout esperando condicao');
}

export function sseClient(port, lastId) {
  const ctrl = new AbortController();
  const events = [];
  let buf = '';
  const done = (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: lastId === undefined ? {} : { 'last-event-id': String(lastId) },
      signal: ctrl.signal,
    });
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
      }
    }
  })().catch(() => {});
  return { events, done, stop: () => ctrl.abort() };
}
```

`test/panel-watch.test.js`:

```js
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test "test/panel-watch.test.js"`
Expected: FAIL — `Cannot find module '.../panel/watch.js'` (e core.js).

- [ ] **Step 3: Implementar `panel/public/core.js`**

```js
// panel/public/core.js — matemática de linhas compartilhada: servidor diffa e cliente aplica
// com a MESMA definição (CRLF normalizado, newline final não vira linha vazia).
export function toLines(text) {
  if (text === '') return [];
  const t = text.replaceAll('\r\n', '\n');
  return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
}

export function applyEdit(lines, { startLine, endLine, lines: replacement }) {
  const out = lines.slice();
  out.splice(startLine - 1, Math.max(0, endLine - startLine + 1), ...replacement);
  return out;
}
```

- [ ] **Step 4: Implementar `panel/watch.js`**

```js
// panel/watch.js — espectador dos worktrees: fs.watch + debounce + diff line-based → edit/delete.
// Só lê: nunca escreve no run nem no produto. `_integration` fica fora (spec §8: só estado).
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { toLines } from './public/core.js';

export const DEBOUNCE_MS = 150;
export const CAP_BYTES = 64 * 1024;

export function capBuffer(buf) {
  if (buf.subarray(0, 8192).includes(0)) return { binary: true, text: '', truncated: false };
  return { binary: false, text: buf.subarray(0, CAP_BYTES).toString('utf8'), truncated: buf.length > CAP_BYTES };
}

export function readCapped(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(CAP_BYTES + 1);
    const n = readSync(fd, buf, 0, CAP_BYTES + 1, 0);
    return capBuffer(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

// Prefixo/sufixo comum de linhas fica fora do evento. endLine < startLine = inserção pura
// (arquivo novo: startLine 1, endLine 0 — contrato §4).
export function diffLines(oldLines, newLines) {
  let p = 0;
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
  let s = 0;
  while (s < oldLines.length - p && s < newLines.length - p
    && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++;
  if (p === oldLines.length && p === newLines.length) return null;
  return { startLine: p + 1, endLine: oldLines.length - s, lines: newLines.slice(p, newLines.length - s) };
}

export function watchWorktrees({ runDir, repoDir, baseSha, baseTree, onEvent, debounceMs = DEBOUNCE_MS, useWatch = true }) {
  const root = join(runDir, 'worktrees');
  const seen = new Map();   // "task/file" → { task, file, text, binary }; text null = ausente
  const owners = new Map(); // file → { task, deleted? }
  const knownTasks = new Set();
  const timers = new Map();
  let watcher = null;

  const baseContent = (file) => {
    if (!baseTree.has(file)) return null;
    try {
      const buf = execFileSync('git', ['-C', repoDir, 'show', `${baseSha}:${file}`],
        { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      return capBuffer(buf);
    } catch { return null; }
  };

  function processFile(task, file, emit) {
    const key = `${task}/${file}`;
    let cur = null;
    const abs = join(root, task, file);
    try {
      if (statSync(abs).isFile()) cur = readCapped(abs);
    } catch { /* ausente */ }
    const prev = seen.get(key);
    if (cur === null) {
      const eraPresente = prev ? prev.text !== null : baseTree.has(file);
      if (eraPresente) {
        seen.set(key, { task, file, text: null, binary: false });
        owners.set(file, { task, deleted: true });
        if (emit) onEvent({ type: 'delete', task, file });
      }
      return;
    }
    if (cur.binary) {
      if (!prev || !prev.binary) {
        seen.set(key, { task, file, text: '', binary: true });
        owners.set(file, { task });
        if (emit) onEvent({ type: 'edit', task, file, startLine: 1, endLine: 0, lines: [] });
      }
      return;
    }
    const old = prev ? (prev.text ?? '') : (baseContent(file)?.text ?? '');
    const d = diffLines(toLines(old), toLines(cur.text));
    seen.set(key, { task, file, text: cur.text, binary: false });
    if (d === null) return;
    owners.set(file, { task });
    if (emit) onEvent({ type: 'edit', task, file, ...d });
  }

  function poke(task, file) {
    const key = `${task}/${file}`;
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); processFile(task, file, true); }, debounceMs));
  }

  // fs.watch no runDir (existe sempre), não no worktrees/ (pode não existir no boot).
  // Recursivo no Windows; eventos de status.tsv/gates caem no filtro e quem cuida é o ledger-watch.
  if (useWatch) {
    watcher = watch(runDir, { recursive: true }, (type, filename) => {
      if (!filename) return;
      const parts = String(filename).split(/[\\/]/);
      if (parts[0] !== 'worktrees' || parts.length < 3) return;
      const task = parts[1];
      if (task === '_integration' || task.startsWith('.')) return;
      const file = parts.slice(2).join('/');
      if (!file || file === '.git' || file.startsWith('.git/')) return;
      poke(task, file);
    });
    watcher.on('error', () => {}); // fs.watch perde evento no Windows: o rescan reconcilia
  }

  function walk(dir, prefix, out) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel, out);
      else if (e.isFile()) out.push(rel);
    }
  }

  function rescan(emit = true) {
    if (!existsSync(root)) return;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === '_integration' || e.name.startsWith('.')) continue;
      const task = e.name;
      const files = [];
      walk(join(root, task), '', files);
      const present = new Set(files);
      if (!knownTasks.has(task)) {
        knownTasks.add(task);
        for (const f of baseTree) if (!present.has(f)) processFile(task, f, emit);
      }
      for (const f of files) processFile(task, f, emit);
      for (const v of seen.values()) {
        if (v.task === task && v.text !== null && !present.has(v.file)) processFile(task, v.file, emit);
      }
    }
  }

  rescan(false); // boot silencioso: o /snapshot carrega o estado inicial; mudanças depois emitem

  return {
    owners,
    rescan: () => rescan(true),
    poke,
    close() {
      if (watcher) watcher.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test "test/panel-watch.test.js"`
Expected: PASS (15 testes). Se o teste de fs.watch real falhar por timing no Windows, aumentar o debounce do teste — NÃO desligar o `useWatch: true` (é o critério ≤1s da spec §9.1).

- [ ] **Step 6: Suíte completa + commit**

Run: `node --test "test/"*.test.js` → Expected: 135 + 15 verdes.
Run: `git status --porcelain` → só arquivos novos de panel/ e test/.

```bash
git add panel/public/core.js panel/watch.js test/panel-fixtures.js test/panel-watch.test.js
git commit -m "swarm: M3 watcher de worktrees -- diff line-based, debounce, rescan, cap 64KB, binario"
```

---

### Task 2: Watcher do ledger (state/gate)

**Files:**
- Create: `panel/ledger-watch.js`
- Test: `test/panel-ledger-watch.test.js`

**Interfaces:**
- Consumes: `lib/ledger.js` `rows(runDir)` (formato TSV do M1, só leitura); `gates/wave-N.json` gravado por `run.js integrate` (`{wave, verify, level, ok, findings, build, tokenSource}`, `build` pode ser null).
- Produces: `watchLedger({runDir, onEvent, pollMs = 250}) → {poll(), close()}`. Eventos: `{type:'state', task, state, rc}` (rc null quando vazio no TSV) e `{type:'gate', wave, ok, rc, timedOut}` (rc/timedOut vêm de `build`; build null → rc null, timedOut false). Boot: estados existentes NÃO viram evento (vêm do snapshot); gates existentes VIRAM evento (cliente novo recebe via replay do ring).

- [ ] **Step 1: Escrever os testes que falham**

`test/panel-ledger-watch.test.js`:

```js
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test "test/panel-ledger-watch.test.js"`
Expected: FAIL — `Cannot find module '.../panel/ledger-watch.js'`.

- [ ] **Step 3: Implementar `panel/ledger-watch.js`**

```js
// panel/ledger-watch.js — leitor do ledger M1: append no status.tsv → state; gates/wave-N.json → gate.
// Poll, não fs.watch: o ledger é append-only e o poll de 250ms cumpre o ≤1s da spec com folga.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rows } from '../lib/ledger.js';

export function watchLedger({ runDir, onEvent, pollMs = 250 }) {
  let lineCount = 0;
  try { lineCount = rows(runDir).length; } catch { /* sem ledger ainda */ }
  const gatesSeen = new Map(); // wave → mtimeMs já emitido
  const gdir = join(runDir, 'gates');

  function poll() {
    try {
      const rs = rows(runDir);
      if (rs.length > lineCount) {
        const fresh = rs.slice(lineCount);
        lineCount = rs.length;
        for (const r of fresh) {
          onEvent({ type: 'state', task: r.task, state: r.state, rc: r.rc === '' ? null : Number(r.rc) });
        }
      }
    } catch { /* ledger ainda não existe */ }
    if (!existsSync(gdir)) return;
    for (const name of readdirSync(gdir)) {
      const m = /^wave-(\d+)\.json$/.exec(name);
      if (!m) continue;
      const p = join(gdir, name);
      let mt;
      try { mt = statSync(p).mtimeMs; } catch { continue; }
      if (gatesSeen.get(m[1]) === mt) continue;
      let g;
      try { g = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; } // escrita parcial: próximo poll
      gatesSeen.set(m[1], mt);
      onEvent({ type: 'gate', wave: g.wave, ok: g.ok === true, rc: g.build ? g.build.rc : null, timedOut: g.build?.timedOut === true });
    }
  }

  poll(); // gates já existentes viram evento (cliente novo recebe via replay do ring buffer)
  const timer = setInterval(poll, pollMs);
  return { poll, close() { clearInterval(timer); } };
}
```

- [ ] **Step 4: Rodar e ver passar + suíte + commit**

Run: `node --test "test/panel-ledger-watch.test.js"` → PASS (5).
Run: `node --test "test/"*.test.js` → 135 + 15 + 5 verdes.

```bash
git add panel/ledger-watch.js test/panel-ledger-watch.test.js
git commit -m "swarm: M3 watcher do ledger -- state por append, gate por wave-N.json, parcial espera"
```

---

### Task 3: Servidor HTTP + SSE + contrato prendado

**Files:**
- Create: `panel/server.js`
- Test: `test/panel-server.test.js`

**Interfaces:**
- Consumes: `watchWorktrees` (Task 1), `watchLedger` (Task 2), `readRun`/`stateOf`/`latest` do M1 (só leitura), `git ls-tree -r --name-only <baseSha>` com `-c core.quotePath=false`.
- Produces:
  - `createPanelServer({runDir, port = 4180, host = '127.0.0.1', debounceMs?, pollMs?, useWatch?, rescanMs = 2000}) → Promise<{server, port, close(), emit(ev)}>`. `emit` é seam de teste (numera, põe no ring, escreve nos clientes) — o CLI não usa.
  - `COLORS = ['#4f9cf9', '#3fb56b', '#e8a33d']`; `PanelBootError`.
  - CLI: `node panel/server.js --run <dir> [--port N]` → JSON `{url, runDir}` no stdout; erro → mensagem no stderr, rc 2. `--run` relativo é resolvido para absoluto na fronteira (lição B-1 do M1).
  - Endpoints (contrato §4): `GET /snapshot`, `GET /file?path=`, `GET /events` (SSE), estáticos (Task 4 cria os arquivos; o handler já os serve por whitelist). Não-GET → 405. Path desconhecido → 404.

- [ ] **Step 1: Escrever os testes que falham**

`test/panel-server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { append } from '../lib/ledger.js';
import { createPanelServer, PanelBootError, COLORS } from '../panel/server.js';
import { makeRun, sseClient, waitFor } from './panel-fixtures.js';

const SERVER_JS = fileURLToPath(new URL('../panel/server.js', import.meta.url));

async function withPanel(fn, opts = {}) {
  const f = makeRun();
  const panel = await createPanelServer({
    runDir: f.runDir, port: 0, debounceMs: 30, pollMs: 30, useWatch: false, rescanMs: 50, ...opts,
  });
  try { await fn(f, panel); } finally { await panel.close(); f.cleanup(); }
}

const get = (panel, path) => fetch(`http://127.0.0.1:${panel.port}${path}`).then(async (r) => ({ status: r.status, body: await r.json() }));

test('snapshot: schema do contrato, cores por ordem, tree do base', async () => {
  await withPanel(async (f, panel) => {
    const { status, body } = await get(panel, '/snapshot');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['baseSha', 'edits', 'runId', 'tasks', 'tree', 'waves']);
    assert.equal(body.runId, '20261107-test');
    assert.equal(body.baseSha, f.baseSha);
    assert.deepEqual(body.waves, [['T-01'], ['T-02']]);
    assert.deepEqual(body.tree, ['a.txt', 'base.css']);
    assert.deepEqual(body.tasks.map((t) => t.color), COLORS.slice(0, 2));
    assert.deepEqual(Object.keys(body.tasks[0]).sort(), ['color', 'id', 'rc', 'state']);
    assert.equal(body.tasks[0].state, 'planned');
    assert.equal(body.tasks[0].rc, null);
  });
});

test('/file le do base sem dono e do worktree do dono depois do edit', async () => {
  await withPanel(async (f, panel) => {
    let r = await get(panel, '/file?path=a.txt');
    assert.deepEqual(r.body, { task: null, content: 'um\ndois\n', truncated: false, binary: false });
    writeFileSync(join(f.runDir, 'worktrees', 'T-02', 'a.txt'), 'um\nNOVO\n');
    // rescanMs 50 + debounce 30: 150ms cobre o dono aparecer
    await new Promise((r2) => setTimeout(r2, 150));
    r = await get(panel, '/file?path=a.txt');
    assert.equal(r.body.task, 'T-02');
    assert.equal(r.body.content, 'um\nNOVO\n');
  });
});

test('/file valida path: traversal, absoluto, backslash, fora da tree → 400', async () => {
  await withPanel(async (f, panel) => {
    for (const p of ['../run.json', '..\\run.json', '/etc/passwd', 'C:/windows', 'a.txt/../../x', 'nao-existe.txt', '']) {
      const r = await get(panel, `/file?path=${encodeURIComponent(p)}`);
      assert.equal(r.status, 400, `path=${p}`);
    }
  });
});

test('nao-GET → 405 em qualquer rota', async () => {
  await withPanel(async (f, panel) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`http://127.0.0.1:${panel.port}/`, { method });
      assert.equal(r.status, 405, method);
    }
  });
});

test('bind so em 127.0.0.1', async () => {
  await withPanel(async (f, panel) => {
    assert.equal(panel.server.address().address, '127.0.0.1');
  });
});

test('SSE: edit chega com schema do contrato; delete idem', async () => {
  await withPanel(async (f, panel) => {
    const c = sseClient(panel.port);
    writeFileSync(join(f.runDir, 'worktrees', 'T-01', 'a.txt'), 'um\nX\n');
    await waitFor(() => c.events.some((e) => e.type === 'edit'));
    const ev = c.events.find((e) => e.type === 'edit');
    assert.deepEqual(Object.keys(ev).sort(), ['endLine', 'file', 'id', 'lines', 'startLine', 'task', 'type']);
    assert.equal(ev.task, 'T-01');
    assert.deepEqual(ev.lines, ['X']);
    unlinkSync(join(f.runDir, 'worktrees', 'T-01', 'a.txt'));
    await waitFor(() => c.events.some((e) => e.type === 'delete'));
    const del = c.events.find((e) => e.type === 'delete');
    assert.deepEqual(Object.keys(del).sort(), ['file', 'id', 'task', 'type']);
    c.stop();
  });
});

test('reconnect com Last-Event-ID recebe o gap na ordem', async () => {
  await withPanel(async (f, panel) => {
    const c1 = sseClient(panel.port);
    writeFileSync(join(f.runDir, 'worktrees', 'T-01', 'a.txt'), 'um\nA\n');
    await waitFor(() => c1.events.some((e) => e.type === 'edit'));
    const ultimo = c1.events.at(-1).id;
    c1.stop();
    writeFileSync(join(f.runDir, 'worktrees', 'T-01', 'a.txt'), 'um\nB\n');
    await new Promise((r) => setTimeout(r, 150));
    const c2 = sseClient(panel.port, ultimo);
    await waitFor(() => c2.events.length > 0);
    assert.ok(c2.events.every((e) => e.id > ultimo));
    assert.ok(c2.events.some((e) => e.type === 'edit' && e.lines[0] === 'B'));
    c2.stop();
  });
});

test('Last-Event-ID fora do buffer → reset', async () => {
  await withPanel(async (f, panel) => {
    for (let i = 0; i < 501; i++) panel.emit({ type: 'state', task: 'T-01', state: 'running', rc: null });
    const c = sseClient(panel.port, 1); // id 1 saiu do ring (500)
    await waitFor(() => c.events.some((e) => e.type === 'reset'));
    const reset = c.events.find((e) => e.type === 'reset');
    assert.deepEqual(Object.keys(reset).sort(), ['id', 'type']);
    c.stop();
    const c2 = sseClient(panel.port, 999999); // id futuro (servidor reiniciado)
    await waitFor(() => c2.events.some((e) => e.type === 'reset'));
    c2.stop();
  });
});

test('cliente novo recebe replay completo do ring (gates do boot)', async () => {
  await withPanel(async (f, panel) => {
    mkdirSync(join(f.runDir, 'gates'));
    writeFileSync(join(f.runDir, 'gates', 'wave-1.json'), JSON.stringify({ wave: 1, ok: true, build: { rc: 0, timedOut: false } }));
    await new Promise((r) => setTimeout(r, 100)); // poll do ledger-watch pega
    const c = sseClient(panel.port);
    await waitFor(() => c.events.some((e) => e.type === 'gate'));
    const g = c.events.find((e) => e.type === 'gate');
    assert.deepEqual({ type: g.type, wave: g.wave, ok: g.ok, rc: g.rc, timedOut: g.timedOut },
      { type: 'gate', wave: 1, ok: true, rc: 0, timedOut: false });
    assert.ok(Number.isInteger(g.id));
    c.stop();
  });
});

test('state e gate: schema do contrato, rc fiel', async () => {
  await withPanel(async (f, panel) => {
    const c = sseClient(panel.port);
    append(f.runDir, { task: 'T-01', state: 'running', rc: null, start: null, end: null, branch: null, log: null, tokens: null, pid: null });
    await waitFor(() => c.events.some((e) => e.type === 'state'));
    const st = c.events.find((e) => e.type === 'state');
    assert.deepEqual(Object.keys(st).sort(), ['id', 'rc', 'state', 'task', 'type']);
    assert.equal(st.state, 'running');
    assert.equal(st.rc, null);
    mkdirSync(join(f.runDir, 'gates'));
    writeFileSync(join(f.runDir, 'gates', 'wave-1.json'), JSON.stringify({ wave: 1, ok: false, build: { rc: 1, timedOut: false } }));
    await waitFor(() => c.events.some((e) => e.type === 'gate'));
    const g = c.events.find((e) => e.type === 'gate');
    assert.deepEqual(Object.keys(g).sort(), ['id', 'ok', 'rc', 'timedOut', 'type', 'wave']);
    assert.equal(g.ok, false);
    assert.equal(g.rc, 1);
    c.stop();
  });
});

test('run invalido recusa com PanelBootError; CLI rc 2', async () => {
  const f = makeRun();
  try {
    await assert.rejects(() => createPanelServer({ runDir: join(f.dir, 'nao-existe'), port: 0 }), PanelBootError);
    const r = execFileSync('node', [SERVER_JS, '--run', join(f.dir, 'nao-existe')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.fail(`CLI devia ter saido 2, saiu 0: ${r}`);
  } catch (e) {
    if (e.code === 'ERR_ASSERTION') throw e;
    assert.equal(e.status, 2);
    assert.match(e.stderr, /run inválido/);
  } finally { f.cleanup(); }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test "test/panel-server.test.js"`
Expected: FAIL — `Cannot find module '.../panel/server.js'`.

- [ ] **Step 3: Implementar `panel/server.js`**

```js
// panel/server.js — painel espectador: GET-only, SSE com replay, bind 127.0.0.1. Só lê o run.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latest, stateOf } from '../lib/ledger.js';
import { readRun } from '../lib/meta.js';
import { capBuffer, readCapped, watchWorktrees } from './watch.js';
import { watchLedger } from './ledger-watch.js';

export const COLORS = ['#4f9cf9', '#3fb56b', '#e8a33d'];
const RING_SIZE = 500;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/core.js': ['core.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

export class PanelBootError extends Error {}

export async function createPanelServer({ runDir, port = 4180, host = '127.0.0.1', debounceMs, pollMs, useWatch, rescanMs = 2000 }) {
  runDir = resolve(runDir);
  if (!existsSync(join(runDir, 'run.json'))) throw new PanelBootError(`run inválido: ${runDir} não tem run.json`);
  if (!existsSync(join(runDir, 'tasks.json')) || !existsSync(join(runDir, 'waves.json'))) {
    throw new PanelBootError('run sem plano: rode "node run.js plan" antes do painel');
  }
  const meta = readRun(runDir);
  const tasks = JSON.parse(readFileSync(join(runDir, 'tasks.json'), 'utf8'));
  const waves = JSON.parse(readFileSync(join(runDir, 'waves.json'), 'utf8'));
  const baseTree = new Set(execFileSync('git',
    ['-C', meta.repoDir, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', meta.baseSha],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean));

  const ring = [];
  let nextId = 1;
  const clients = new Set();
  const sse = (ev) => `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  function emit(ev) {
    const full = { id: nextId++, ...ev };
    ring.push(full);
    if (ring.length > RING_SIZE) ring.shift();
    for (const c of clients) c.write(sse(full));
    return full;
  }

  const wt = watchWorktrees({ runDir, repoDir: meta.repoDir, baseSha: meta.baseSha, baseTree, onEvent: emit, debounceMs, useWatch });
  const lw = watchLedger({ runDir, onEvent: emit, pollMs });
  const rescanTimer = setInterval(() => wt.rescan(), rescanMs);
  const pingTimer = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000);

  function snapshot() {
    const states = stateOf(runDir);
    return {
      runId: meta.runId,
      baseSha: meta.baseSha,
      tasks: tasks.map((t, i) => {
        const row = latest(runDir, t.id);
        return { id: t.id, state: states.get(t.id) ?? 'planned', rc: row && row.rc !== '' ? Number(row.rc) : null, color: COLORS[i % COLORS.length] };
      }),
      waves,
      tree: [...new Set([...baseTree, ...wt.owners.keys()])].sort(),
      edits: Object.fromEntries(wt.owners),
    };
  }

  function validPath(p) {
    if (typeof p !== 'string' || p === '') return false;
    if (p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
    if (p.split('/').some((s) => s === '..' || s === '.' || s === '')) return false;
    return baseTree.has(p) || wt.owners.has(p);
  }

  function fileContent(path) {
    const owner = wt.owners.get(path);
    if (owner && !owner.deleted) {
      try {
        const r = readCapped(join(runDir, 'worktrees', owner.task, path));
        return { task: owner.task, content: r.text, truncated: r.truncated, binary: r.binary };
      } catch { /* worktree sumsriu no meio: cai no base */ }
    }
    try {
      const buf = execFileSync('git', ['-C', meta.repoDir, 'show', `${meta.baseSha}:${path}`],
        { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const r = capBuffer(buf);
      return { task: owner?.task ?? null, content: r.text, truncated: r.truncated, binary: r.binary };
    } catch {
      return { task: owner?.task ?? null, content: '', truncated: false, binary: false };
    }
  }

  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'painel é read-only: só GET' }));
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (url.pathname === '/file') {
      const p = url.searchParams.get('path');
      if (!validPath(p)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'path inválido' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fileContent(p)));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': ok\n\n');
      const last = req.headers['last-event-id'];
      if (last === undefined) {
        for (const e of ring) res.write(sse(e)); // cliente novo: replay completo do buffer
      } else {
        const idx = ring.findIndex((e) => e.id === Number(last));
        if (idx >= 0) for (const e of ring.slice(idx + 1)) res.write(sse(e));
        else res.write(sse({ id: nextId++, type: 'reset' })); // gap fora do ring: cliente rebusca snapshot
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const st = STATIC[url.pathname];
    if (st) {
      try {
        const body = readFileSync(join(PUBLIC_DIR, st[0]));
        res.writeHead(200, { 'content-type': st[1] });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  return {
    server,
    port: server.address().port,
    emit,
    close() {
      clearInterval(rescanTimer);
      clearInterval(pingTimer);
      wt.close();
      lw.close();
      for (const c of clients) c.destroy();
      clients.clear();
      return new Promise((ok) => server.close(ok));
    },
  };
}

function main(argv) {
  const o = { run: null, port: 4180 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run') o.run = argv[++i];
    else if (argv[i] === '--port') o.port = Number(argv[++i]);
    else throw new PanelBootError(`argumento desconhecido: ${argv[i]}`);
  }
  if (!o.run) throw new PanelBootError('uso: node panel/server.js --run <runDir> [--port N]');
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new PanelBootError(`porta inválida: ${o.port}`);
  return createPanelServer({ runDir: o.run, port: o.port }).then((s) => {
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${s.port}`, runDir: resolve(o.run) }) + '\n');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write((e.message || String(e)) + '\n');
    process.exit(2);
  });
}
```

- [ ] **Step 4: Rodar e ver passar + suíte + commit**

Run: `node --test "test/panel-server.test.js"` → PASS (11).
Run: `node --test "test/"*.test.js` → 135 + 15 + 5 + 11 verdes.

```bash
git add panel/server.js test/panel-server.test.js
git commit -m "swarm: M3 servidor GET-only 127.0.0.1 -- snapshot, file validado, SSE ring 500 com replay/reset"
```

---

### Task 4: Frontend — árvore, viewer com cursor, faixa de ondas

**Files:**
- Create: `panel/public/index.html`
- Create: `panel/public/app.js`
- Create: `panel/public/style.css`
- Test: `test/panel-static.test.js`

**Interfaces:**
- Consumes: contrato §4 (servidor da Task 3), `core.js` `toLines`/`applyEdit` (Task 1).
- Produces: os 3 estáticos servidos por whitelist; `window.__swarm = { state }` como seam de inspeção do Playwright (Task 5). Nenhuma outra superfície global.

Comportamento (spec §5): um arquivo aberto por vez; default follow (abre o arquivo do último edit), clicar pina e desliga follow; cursor nomeado/colorido do dono na linha do edit, reveal ~30 chars/frame (tick 33ms, budget 30); "pensando…" após >3s sem edit com tarefa `running`; merged/failed/timeout escondem o cursor (chip da faixa mostra `merged ✓`); binário/truncado/removido viram marcador; `reset` rebusca snapshot e reabre o arquivo; EventSource reconecta sozinho com Last-Event-ID. Todo texto dinâmico entra por `textContent`/`createElement` — conteúdo de arquivo é não- confiável, nunca `innerHTML` com dado.

- [ ] **Step 1: Escrever o teste que falha**

`test/panel-static.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from '../panel/server.js';
import { makeRun } from './panel-fixtures.js';

const pub = (n) => fileURLToPath(new URL(`../panel/public/${n}`, import.meta.url));

test('estaticos servidos por whitelist com content-type certo', async () => {
  const f = makeRun();
  const panel = await createPanelServer({ runDir: f.runDir, port: 0, useWatch: false });
  try {
    for (const [path, type, trecho] of [
      ['/', 'text/html', 'SWARM cursors'],
      ['/app.js', 'text/javascript', 'EventSource'],
      ['/core.js', 'text/javascript', 'applyEdit'],
      ['/style.css', 'text/css', 'cursor'],
    ]) {
      const r = await fetch(`http://127.0.0.1:${panel.port}${path}`);
      assert.equal(r.status, 200, path);
      assert.ok(r.headers.get('content-type').startsWith(type), path);
      assert.ok((await r.text()).includes(trecho), path);
    }
    const r = await fetch(`http://127.0.0.1:${panel.port}/nao-existe`);
    assert.equal(r.status, 404);
  } finally { await panel.close(); f.cleanup(); }
});

test('app.js e core.js parseiam como ESM (node --check)', () => {
  for (const n of ['app.js', 'core.js']) {
    execFileSync('node', ['--check', pub(n)], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test "test/panel-static.test.js"`
Expected: FAIL — 404 nos estáticos (arquivos não existem) e `node --check` falha.

- [ ] **Step 3: Implementar `panel/public/index.html`**

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SWARM cursors</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header id="topo">
  <strong>SWARM cursors</strong>
  <span id="run-id"></span>
  <span id="base-sha"></span>
  <span id="conexao" class="badge">conectando…</span>
</header>
<div id="layout">
  <aside id="lateral">
    <h2>arquivos</h2>
    <ul id="arvore"></ul>
  </aside>
  <main id="editor">
    <div id="arquivo-barra">
      <span id="arquivo-path">nenhum arquivo aberto</span>
      <span id="dono"></span>
      <span id="pensando" class="badge oculto">pensando…</span>
    </div>
    <div id="viewer-wrap">
      <pre id="viewer"></pre>
      <div id="cursor" class="oculto"><span id="cursor-nome"></span></div>
    </div>
    <div id="marcador" class="oculto"></div>
  </main>
</div>
<footer id="faixa"></footer>
<script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Implementar `panel/public/app.js`**

```js
// panel/public/app.js — espectador: SSE → buffers por arquivo, cursor nomeado, faixa de ondas.
import { applyEdit, toLines } from './core.js';

const $ = (id) => document.getElementById(id);
const state = {
  tasks: new Map(), owners: {}, waves: [], gates: new Map(), tree: [],
  buffers: new Map(), open: null, follow: true, lastId: 0,
  lastEditAt: new Map(), revealJobs: [], display: [], cursorLine: 1,
};
window.__swarm = { state }; // seam de inspeção do Playwright (Task 5)
let openTicket = 0;

function buf(file) {
  if (!state.buffers.has(file)) {
    state.buffers.set(file, { lines: [], loaded: false, skipUntil: 0, binary: false, truncated: false });
  }
  return state.buffers.get(file);
}

async function openFile(file, pin = false) {
  if (pin) state.follow = false;
  state.open = file;
  state.revealJobs = [];
  const ticket = ++openTicket;
  const b = buf(file);
  const data = await (await fetch(`/file?path=${encodeURIComponent(file)}`)).json();
  if (ticket !== openTicket) return; // clique mais novo venceu
  b.lines = toLines(data.content);
  b.binary = data.binary;
  b.truncated = data.truncated;
  b.loaded = true;
  b.skipUntil = state.lastId; // eventos até aqui já estão no conteúdo lido
  state.display = b.lines.slice();
  state.cursorLine = 1;
  $('arquivo-path').textContent = file;
  renderTree(); renderViewer(); renderCursor(); renderMarcador();
}

function flushReveal() {
  for (const j of state.revealJobs) j.lines.forEach((t, k) => { state.display[j.at + k] = t; });
  state.revealJobs = [];
}

function enqueueReveal(ev) {
  flushReveal(); // display não pode ficar para trás de um novo edit
  const count = Math.max(0, ev.endLine - ev.startLine + 1);
  state.display.splice(ev.startLine - 1, count, ...ev.lines.map(() => ''));
  state.revealJobs.push({ at: ev.startLine - 1, lines: ev.lines, li: 0, ci: 0 });
  state.cursorLine = ev.startLine;
  renderViewer();
}

// ~30 chars/frame: tick de 33ms com budget de 30 chars (spec §5).
setInterval(() => {
  const j = state.revealJobs[0];
  if (!j) return;
  let budget = 30;
  while (budget > 0 && j.li < j.lines.length) {
    const line = j.lines[j.li];
    if (line.length === 0) { j.li++; continue; }
    const take = Math.min(budget, line.length - j.ci);
    j.ci += take;
    budget -= take;
    state.display[j.at + j.li] = line.slice(0, j.ci);
    state.cursorLine = j.at + j.li + 1;
    if (j.ci >= line.length) { j.li++; j.ci = 0; }
  }
  if (j.li >= j.lines.length) state.revealJobs.shift();
  renderViewer(); renderCursor();
}, 33);

function onEdit(ev) {
  state.lastEditAt.set(ev.task, Date.now());
  state.owners[ev.file] = { task: ev.task };
  if (!state.tree.includes(ev.file)) { state.tree.push(ev.file); state.tree.sort(); }
  const b = buf(ev.file);
  if (b.loaded && ev.id > b.skipUntil) b.lines = applyEdit(b.lines, ev);
  if (state.open === ev.file) {
    if (b.binary) renderMarcador();
    else enqueueReveal(ev);
    $('pensando').classList.add('oculto');
  } else if (state.follow) {
    openFile(ev.file);
    return;
  }
  renderTree(); renderCursor();
}

function renderViewer() {
  const pre = $('viewer');
  pre.innerHTML = '';
  state.display.forEach((text) => {
    const div = document.createElement('div');
    div.className = 'linha';
    div.textContent = text === '' ? ' ' : text;
    pre.appendChild(div);
  });
}

function renderCursor() {
  const el = $('cursor');
  const owner = state.open && state.owners[state.open]?.task;
  const task = owner && state.tasks.get(owner);
  $('dono').textContent = task ? `${task.id} · ${task.state}` : '';
  $('dono').style.color = task?.color || '';
  const ativo = task && ['running', 'reported', 'gated'].includes(task.state);
  if (!state.open || !owner || !ativo || buf(state.open).binary) {
    el.classList.add('oculto');
    return;
  }
  el.classList.remove('oculto');
  el.style.background = task.color;
  $('cursor-nome').textContent = task.id;
  $('cursor-nome').style.background = task.color;
  const lineEl = $('viewer').children[state.cursorLine - 1];
  el.style.top = `${lineEl ? lineEl.offsetTop : 0}px`;
}

function renderMarcador() {
  const el = $('marcador');
  const b = state.open && buf(state.open);
  const o = state.open && state.owners[state.open];
  let msg = '';
  if (o?.deleted) msg = '[arquivo removido]';
  else if (b?.binary) msg = '[binário — sem reveal]';
  else if (b?.truncated) msg = '[arquivo truncado em 64KB]';
  el.textContent = msg;
  el.classList.toggle('oculto', !msg);
}

function renderTree() {
  const ul = $('arvore');
  ul.innerHTML = '';
  for (const f of state.tree) {
    const li = document.createElement('li');
    li.className = 'arquivo' + (f === state.open ? ' aberto' : '');
    li.appendChild(document.createTextNode(f));
    const o = state.owners[f];
    if (o) {
      const badge = document.createElement('span');
      badge.className = 'dono-badge';
      badge.style.background = state.tasks.get(o.task)?.color || '#888';
      badge.textContent = o.deleted ? `${o.task} ✗` : o.task;
      li.appendChild(badge);
    }
    li.addEventListener('click', () => openFile(f, true));
    ul.appendChild(li);
  }
}

function renderFaixa() {
  const el = $('faixa');
  el.innerHTML = '';
  state.waves.forEach((w, i) => {
    const chip = document.createElement('span');
    chip.className = 'onda';
    chip.appendChild(document.createTextNode(`onda ${i + 1}: `));
    for (const id of w) {
      const t = state.tasks.get(id);
      const s = document.createElement('span');
      const est = t?.state || 'planned';
      s.className = `task-chip estado-${est}`;
      s.style.borderColor = t?.color || '#888';
      s.textContent = `${id} ${est === 'merged' ? 'merged ✓' : est}${t?.rc != null ? ` rc ${t.rc}` : ''}`;
      chip.appendChild(s);
    }
    const g = state.gates.get(i + 1);
    if (g) {
      const b = document.createElement('span');
      b.className = `gate-badge ${g.ok ? 'ok' : 'falhou'}`;
      b.textContent = g.timedOut ? `gate timeout rc ${g.rc}` : `gate ${g.ok ? '✓' : '✗'} rc ${g.rc ?? '—'}`;
      chip.appendChild(b);
    }
    el.appendChild(chip);
  });
}

// "pensando": >3s sem edit com a tarefa running (spec §5).
setInterval(() => {
  const owner = state.open && state.owners[state.open]?.task;
  const t = owner && state.tasks.get(owner);
  const pensando = t?.state === 'running' && Date.now() - (state.lastEditAt.get(owner) || 0) > 3000;
  $('pensando').classList.toggle('oculto', !pensando);
}, 500);

async function loadSnapshot() {
  const snap = await (await fetch('/snapshot')).json();
  state.tasks = new Map(snap.tasks.map((t) => [t.id, t]));
  state.owners = snap.edits;
  state.waves = snap.waves;
  state.tree = snap.tree;
  $('run-id').textContent = snap.runId;
  $('base-sha').textContent = snap.baseSha.slice(0, 7);
  renderTree(); renderFaixa();
}

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { $('conexao').textContent = 'ao vivo'; $('conexao').className = 'badge ok'; };
  es.onerror = () => { $('conexao').textContent = 'reconectando…'; $('conexao').className = 'badge falhou'; };
  const handle = (e) => {
    const ev = JSON.parse(e.data);
    state.lastId = Math.max(state.lastId, ev.id);
    return ev;
  };
  es.addEventListener('edit', (e) => onEdit(handle(e)));
  es.addEventListener('delete', (e) => {
    const ev = handle(e);
    state.owners[ev.file] = { task: ev.task, deleted: true };
    const b = buf(ev.file);
    b.lines = [];
    if (state.open === ev.file) { state.display = []; state.revealJobs = []; renderViewer(); renderMarcador(); }
    renderTree();
  });
  es.addEventListener('state', (e) => {
    const ev = handle(e);
    const t = state.tasks.get(ev.task) || { id: ev.task, color: '#888' };
    t.state = ev.state;
    t.rc = ev.rc;
    state.tasks.set(ev.task, t);
    renderFaixa(); renderCursor(); renderTree();
  });
  es.addEventListener('gate', (e) => { const ev = handle(e); state.gates.set(ev.wave, ev); renderFaixa(); });
  es.addEventListener('reset', async () => {
    state.buffers.clear();
    state.revealJobs = [];
    await loadSnapshot();
    if (state.open) await openFile(state.open);
  });
}

loadSnapshot().then(() => {
  connect();
  const dono = Object.keys(state.owners)[0];
  if (dono) openFile(dono);
  else if (state.tree[0]) openFile(state.tree[0]);
});
```

- [ ] **Step 5: Implementar `panel/public/style.css`**

```css
/* painel espectador — tema escuro de editor, cursores coloridos por lote */
* { box-sizing: border-box; }
body {
  margin: 0; background: #14161a; color: #d7dae0;
  font: 14px/1.45 "Segoe UI", system-ui, sans-serif;
  display: flex; flex-direction: column; height: 100vh;
}
#topo {
  display: flex; gap: 12px; align-items: center; padding: 8px 14px;
  background: #1c1f26; border-bottom: 1px solid #2a2e37;
}
#run-id { color: #9aa9ff; }
#base-sha { color: #7a828f; font-family: Consolas, monospace; }
.badge { padding: 1px 8px; border-radius: 8px; background: #333; font-size: 12px; }
.badge.ok { background: #1d4d2e; color: #7fe0a0; }
.badge.falhou { background: #5a2222; color: #ff9c9c; }
.oculto { display: none !important; }
#layout { display: flex; flex: 1; min-height: 0; }
#lateral { width: 280px; overflow-y: auto; border-right: 1px solid #2a2e37; padding: 8px; }
#lateral h2 { font-size: 12px; text-transform: uppercase; color: #7a828f; margin: 4px 0 8px; }
#arvore { list-style: none; margin: 0; padding: 0; }
.arquivo {
  padding: 3px 6px; border-radius: 4px; cursor: pointer;
  font: 12px/1.5 Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.arquivo:hover { background: #232730; }
.arquivo.aberto { background: #2a3040; }
.dono-badge {
  margin-left: 6px; padding: 0 5px; border-radius: 6px;
  color: #10131a; font-size: 10px; font-weight: 700;
}
#editor { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#arquivo-barra {
  display: flex; gap: 10px; align-items: center; padding: 6px 12px;
  background: #1c1f26; border-bottom: 1px solid #2a2e37; font-family: Consolas, monospace; font-size: 12px;
}
#viewer-wrap { position: relative; flex: 1; overflow: auto; }
#viewer {
  margin: 0; padding: 10px 12px 10px 52px; counter-reset: linha;
  font: 13px/1.5 Consolas, "Cascadia Mono", monospace; min-height: 100%;
}
.linha { position: relative; white-space: pre; min-height: 1.5em; }
.linha::before {
  counter-increment: linha; content: counter(linha);
  position: absolute; left: -40px; width: 28px; text-align: right; color: #4a505c;
}
#cursor {
  position: absolute; left: 48px; width: 2px; height: 1.5em;
  animation: pisca 1s steps(1) infinite;
}
#cursor-nome {
  position: absolute; top: -16px; left: -2px; padding: 0 5px;
  color: #10131a; font: 700 10px/1.5 "Segoe UI", sans-serif; border-radius: 3px 3px 3px 0;
  animation: none;
}
@keyframes pisca { 50% { opacity: 0.35; } }
#marcador { padding: 6px 12px; color: #e8a33d; font: 12px Consolas, monospace; }
#faixa {
  display: flex; gap: 16px; padding: 8px 14px; overflow-x: auto;
  background: #1c1f26; border-top: 1px solid #2a2e37; font-size: 12px;
}
.onda { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
.task-chip { padding: 1px 7px; border: 1px solid; border-radius: 8px; font-family: Consolas, monospace; }
.estado-running { background: #233048; }
.estado-merged { background: #1d3a28; }
.estado-failed, .estado-timeout { background: #4a2424; }
.gate-badge { padding: 1px 7px; border-radius: 8px; font-weight: 700; }
.gate-badge.ok { background: #1d4d2e; color: #7fe0a0; }
.gate-badge.falhou { background: #5a2222; color: #ff9c9c; }
```

- [ ] **Step 6: Rodar e ver passar + suíte + commit**

Run: `node --test "test/panel-static.test.js"` → PASS (2).
Run: `node --test "test/"*.test.js` → 135 + 15 + 5 + 11 + 2 verdes.

```bash
git add panel/public/index.html panel/public/app.js panel/public/style.css test/panel-static.test.js
git commit -m "swarm: M3 frontend -- arvore com dono, viewer com cursor nomeado e reveal, faixa de ondas/gates"
```

---

### Task 5: Verificação visual Playwright headed (golden path + edges)

**Files:**
- Create: `test/visual/check.mjs`
- Create: `docs/panel-visual-check.md` (registro exigido pela spec §9.5)

**Interfaces:**
- Consumes: `createPanelServer` (Task 3), frontend (Task 4), `makeRun` (Task 1), Playwright da lib global: `require('C:/Users/User/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright')` via `createRequire` (verificado: Chromium 155 lança nesta máquina). Nada entra no `package.json` (C9).
- Produces: relatório `docs/panel-visual-check.md` com o que foi visto + paths dos screenshots (`.superpowers/visual-2026-11-07/`, git-ignorado). Este task NÃO tem teste de unidade — a verificação É o teste, headed, na frente do usuário.

Cenário (fake run = fixture real do M1 + writes roteirizados; spec §7/§9):
1. Golden path: 2 tasks escrevendo → 2 cursores nomeados/coloridos revelando texto na posição certa, ≤1s após o write.
2. Gate vermelha → badge vermelho com rc; worktree integrado (rm + linha `merged` no ledger) → cursor some, chip `merged ✓`.
3. Reconnect: `context.setOffline(true/false)` → badge "reconectando…" → "ao vivo" sem perder estado.
4. Binário → marcador "[binário — sem reveal]"; arquivo removido → "[arquivo removido]".

- [ ] **Step 1: Escrever `test/visual/check.mjs`**

```js
// test/visual/check.mjs — verificação visual headed do painel (spec §7/§9.5).
// Roda na frente do usuário: node test/visual/check.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createPanelServer } from '../../panel/server.js';
import { append } from '../../lib/ledger.js';
import { makeRun } from '../panel-fixtures.js';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/User/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright');
const SHOTS = join(process.cwd(), '.superpowers', 'visual-2026-11-07');
mkdirSync(SHOTS, { recursive: true });

const f = makeRun();
const panel = await createPanelServer({ runDir: f.runDir, port: 4180 });
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const resultados = [];
const ok = (nome) => { resultados.push(`PASS ${nome}`); console.log(`PASS ${nome}`); };
const shot = (nome) => page.screenshot({ path: join(SHOTS, `${nome}.png`) });
const row = (task, state, rc = null) => ({ task, state, rc, start: null, end: null, branch: null, log: null, tokens: null, pid: null });

try {
  await page.goto('http://127.0.0.1:4180/');
  await page.waitForFunction(() => document.getElementById('conexao').textContent === 'ao vivo');
  ok('conexao SSE ao vivo');

  // golden path: duas tasks running escrevendo em arquivos distintos
  append(f.runDir, row('T-01', 'running'));
  append(f.runDir, row('T-02', 'running'));
  const py = join(f.runDir, 'worktrees', 'T-01', 'app.py');
  const js = join(f.runDir, 'worktrees', 'T-02', 'ui.js');
  const chunksPy = ['def ola():\n', '    return "oi"\n', '\n', 'def tchau():\n', '    return "tchau"\n'];
  const chunksJs = ['export function oi() {\n', '  return "oi";\n', '}\n'];
  const t0 = Date.now();
  writeFileSync(py, chunksPy[0]);
  writeFileSync(js, chunksJs[0]);
  // follow abre o arquivo do último edit; o cursor nomeado aparece na tree/badge
  await page.waitForFunction(() => window.__swarm.state.open !== null, { timeout: 2000 });
  assert.ok(Date.now() - t0 <= 1000 + 500, 'edit chegou em ≤1s (+folga de render)'); // fs.watch+debounce+rescan
  for (const c of chunksPy.slice(1)) { writeFileSync(py, readFileSync(py, 'utf8') + c); await new Promise((r) => setTimeout(r, 350)); }
  for (const c of chunksJs.slice(1)) { writeFileSync(js, readFileSync(js, 'utf8') + c); await new Promise((r) => setTimeout(r, 350)); }
  await page.waitForFunction(() => window.__swarm.state.tree.includes('app.py') && window.__swarm.state.tree.includes('ui.js'));
  // pina app.py e confere cursor T-01 revelando
  await page.click('li.arquivo:has-text("app.py")');
  await page.waitForFunction(() => {
    const c = document.getElementById('cursor');
    return !c.classList.contains('oculto') && document.getElementById('cursor-nome').textContent === 'T-01';
  });
  writeFileSync(py, readFileSync(py, 'utf8') + '\n# fim\n');
  await page.waitForFunction(() => document.getElementById('viewer').textContent.includes('# fim'));
  await shot('01-golden-t01');
  ok('golden path: cursor T-01 nomeado revelando texto na posicao certa');
  await page.click('li.arquivo:has-text("ui.js")');
  await page.waitForFunction(() => document.getElementById('cursor-nome').textContent === 'T-02' && !document.getElementById('cursor').classList.contains('oculto'));
  await shot('02-golden-t02');
  ok('golden path: cursor T-02 verde no segundo arquivo');

  // pensando: >3s sem edit com running
  await page.waitForFunction(() => !document.getElementById('pensando').classList.contains('oculto'), { timeout: 5000 });
  await shot('03-pensando');
  ok('badge pensando apos 3s idle');

  // gate vermelha
  mkdirSync(join(f.runDir, 'gates'));
  writeFileSync(join(f.runDir, 'gates', 'wave-1.json'), JSON.stringify({ wave: 1, ok: false, build: { rc: 1, timedOut: false }, findings: [] }));
  await page.waitForFunction(() => document.querySelector('.gate-badge.falhou')?.textContent.includes('rc 1'));
  await shot('04-gate-vermelha');
  ok('gate vermelha com rc 1');

  // reconnect real: offline → online, EventSource volta com Last-Event-ID
  await context.setOffline(true);
  await page.waitForFunction(() => document.getElementById('conexao').textContent === 'reconectando…');
  await context.setOffline(false);
  await page.waitForFunction(() => document.getElementById('conexao').textContent === 'ao vivo');
  writeFileSync(js, readFileSync(js, 'utf8') + '\n// pos-reconnect\n');
  await page.click('li.arquivo:has-text("ui.js")');
  await page.waitForFunction(() => document.getElementById('viewer').textContent.includes('pos-reconnect'));
  await shot('05-reconnect');
  ok('reconnect sem perder estado');

  // binario
  writeFileSync(join(f.runDir, 'worktrees', 'T-02', 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x4e]));
  await page.waitForFunction(() => window.__swarm.state.tree.includes('logo.png'), { timeout: 4000 });
  await page.click('li.arquivo:has-text("logo.png")');
  await page.waitForFunction(() => document.getElementById('marcador').textContent.includes('binário'));
  await shot('06-binario');
  ok('binario: marcador sem reveal');

  // integrado: worktree removido + merged no ledger → cursor some, chip merged ✓
  append(f.runDir, row('T-01', 'merged'));
  rmSync(join(f.runDir, 'worktrees', 'T-01'), { recursive: true, force: true });
  await page.waitForFunction(() => document.querySelector('.task-chip.estado-merged')?.textContent.includes('merged ✓'));
  await page.click('li.arquivo:has-text("app.py")');
  await page.waitForFunction(() => document.getElementById('cursor').classList.contains('oculto'));
  await shot('07-merged');
  ok('merged: cursor some, chip merged ✓');

  // arquivo removido
  unlinkSync(js);
  await page.waitForFunction(() => window.__swarm.state.owners['ui.js']?.deleted === true, { timeout: 4000 });
  await page.click('li.arquivo:has-text("ui.js")');
  await page.waitForFunction(() => document.getElementById('marcador').textContent.includes('removido'));
  await shot('08-removido');
  ok('delete: marcador arquivo removido');
} finally {
  await browser.close();
  await panel.close();
  f.cleanup();
}

console.log('\n' + resultados.join('\n'));
console.log(`screenshots: ${SHOTS}`);
```

- [ ] **Step 2: Rodar headed na frente do usuário**

Run: `node test/visual/check.mjs` (a partir de `O:\DEV\A JORNADA\tools\SWARM`)
Expected: janela Chromium abre, os 9 PASS aparecem no stdout, screenshots em `.superpowers/visual-2026-11-07/`. O usuário VÊ os cursores trabalhando — este é o primeiro ensaio visual (fake run); o run real com workers codex é a Task 6.
Se um assert falhar: investigar com a skill systematic-debugging, corrigir o painel (não o assert), re-rodar.

- [ ] **Step 3: Registrar em `docs/panel-visual-check.md`**

Escrever o registro com: data, comando, resultado de cada um dos 8 checks (o que foi visto na tela, não só o PASS), paths dos screenshots, versão do Chromium, e a frase de fechamento da spec §9.5. Modelo:

```markdown
# Verificação visual — swarm cursors (spec §9.5)

Data: 2026-11-07 · comando: `node test/visual/check.mjs` · Chromium 155 headed, 1280×800.

| Check | Resultado | Screenshot |
|---|---|---|
| Conexão SSE ao vivo | PASS — badge verde no boot | — |
| Golden path T-01 | PASS — cursor azul nomeado revelando app.py linha a linha | `.superpowers/visual-2026-11-07/01-golden-t01.png` |
| ... (preencher com o observado) | | |

Screenshots são locais (`.superpowers/` é git-ignorado); este registro é o artefato commitado.
```

- [ ] **Step 4: Suíte completa + commit**

Run: `node --test "test/"*.test.js` → 168 verdes, nenhum arquivo do M1 modificado (`git diff --stat eefc2a7..HEAD -- run.js lib/ skills/` vazio).

```bash
git add test/visual/check.mjs docs/panel-visual-check.md
git commit -m "swarm: M3 verificacao visual headed -- golden path, gate, reconnect, binario, merged, delete"
```

---

### Task 6: Primeiro run REAL com o painel no navegador do usuário

**Files:** nenhum arquivo novo da suíte — este task é a cerimônia do primeiro teste real que o usuário pediu ("já vamos fazer o nosso primeiro teste real no navegador"). Alvo: repo demo descartável em `runs/demo-alvo` (git-ignorado), para não tocar produto nenhum. Workers: `codex exec` em primeiro plano, prompt exato de `tasks/<id>/attempt-N/prompt.md` (protocolo M1, workaround B-2 do operador commitando).

**Interfaces:**
- Consumes: M1 completo (`run.js init/plan/start/finish/integrate/abort`), painel (Tasks 1–5), skill `swarm-orchestrator`.
- Produces: a experiência ao vivo + veredito honesto do que funcionou (registrado no ledger do run e reportado ao usuário). Nada de push.

- [ ] **Step 1: Criar o repo demo e o run**

```bash
mkdir -p runs/demo-alvo && cd runs/demo-alvo && git init -q
# seed mínimo: README.md descrevendo o alvo (CLI todo em Python, backend/ + frontend/ estático)
git add . && git commit -qm "seed do demo"
cd ../..
node run.js init --repo runs/demo-alvo --workspace runs/demo-ws
```

Expected: JSON com `runId`, `runDir`, `baseSha`. Guardar `runDir`.

- [ ] **Step 2: Plano de 2 tarefas com lotes disjuntos**

Escrever `runs/demo-ws/plan.md` (fora do git):

```markdown
## T-01 Backend da CLI todo
- paths: backend/**
- depends_on: -
- verify: python -m unittest discover -s backend -v

Criar backend/todo.py (add/list/done em JSON local) e backend/test_todo.py com 4 testes
unittest reais. Sem deps externas. O verify acima é a gate da onda.

## T-02 Página estática
- paths: frontend/**
- depends_on: -
- verify: -

Criar frontend/index.html + frontend/app.js + frontend/style.css: página que lista todos
de um JSON fixo de exemplo, tema escuro, sem libs. Arquivos pequenos.
```

```bash
node run.js plan --run <runDir> --file runs/demo-ws/plan.md
node run.js start --run <runDir> --task T-01
node run.js start --run <runDir> --task T-02
```

Expected: `{"tasks":2,"waves":[["T-01","T-02"]]}`; dois worktrees + prompts.

- [ ] **Step 3: Usuário inicia o painel (C10) e abre o navegador**

Entregar ao usuário o comando exato (ele roda no terminal dele):

```bash
cd "O:\DEV\A JORNADA\tools\SWARM"
node panel/server.js --run <runDir>
```

Expected: `{"url":"http://127.0.0.1:4180",...}` — usuário abre a URL e vê a árvore do demo.

- [ ] **Step 4: Workers em primeiro plano, usuário assistindo**

Para cada tarefa, entregar o prompt de `tasks/<id>/attempt-1/prompt.md` + linha do workDir a um worker `codex exec` (sandbox workspace-write, modelo do dry run). B-2 conhecido: se o sandbox negar o commit, o operador commita no worktree (marcar "commit pelo operador") e a gate valida o diff real. Depois:

```bash
node run.js finish --run <runDir> --task T-01 --attempt 1
node run.js finish --run <runDir> --task T-02 --attempt 1
node run.js integrate --run <runDir>
```

Expected no navegador DO USUÁRIO enquanto isso roda: cursores T-01/T-02 revelando código real nos arquivos certos, badge "pensando" durante o raciocínio, faixa virando `gated`/`merged ✓`, gate da onda 1 verde (unittest rc 0). Playwright headed pode anexar na mesma URL para registrar (opcional — a spec §9.5 já foi cumprida pela Task 5).

- [ ] **Step 5: Veredito + limpeza**

Reportar ao usuário o que foi visto vs. o esperado (critérios §9). Limpar com `node run.js abort --run <runDir>` se o demo não for ficar, ou deixar o run intacto para ele inspecionar — perguntar. Nada de push, nada publicado. Registrar no ledger do run e no progresso `.superpowers/` (ignorado).

---

## Self-Review (feito na escrita)

**1. Cobertura da spec:** §3 componentes → Tasks 1–4 (watch/ledger-watch/server/public). §4 contrato → prendado nos testes da Task 3 (schema dos 5 tipos + snapshot + /file). §5 fluxo (follow, reveal 30 chars, pensando 3s, merged ✓) → Task 4 + verificado na Task 5. §6 error handling → rescan 2s (Task 1/3), Last-Event-ID/reset (Task 3), boot rc 2 (Task 3), 64KB/binário (Tasks 1/3/4), worktree removido (Tasks 1/4/5), 405 (Task 3), servidor cai (Task 5 reconnect). §7 testes → 4 arquivos de teste + visual obrigatório (Task 5). §9 critérios → 1 (Task 5 golden), 2 (Task 5 gate/merged), 3 (Task 3 replay/reset + Task 5 reconnect), 4 (suíte em cada task), 5 (Task 5 registro), 6 (Task 3 405/bind). C10 → Task 6 Step 3 (usuário inicia).

**2. Placeholders:** nenhum TBD/TODO/"implement later" — todo código de teste e implementação está escrito por inteiro (os rascunhos com import dinâmico/linhas mortas foram corrigidos inline antes de fechar o plano). `<runDir>` na Task 6 é o valor que o Step 1 imprime (cerimônia, não código); a tabela de `docs/panel-visual-check.md` é preenchida com o observado na execução, como o Step 3 instrui.

**3. Consistência de tipos:** `toLines`/`applyEdit` definidos na Task 1 e consumidos nas Tasks 4/5 com a mesma assinatura; `watchWorktrees` retorna `{owners, rescan, poke, close}` — servidor usa `owners`/`rescan`/`close`, testes usam `poke`; eventos sem `id` nos watchers, `id` posto pelo `emit` do servidor (Task 3) — os testes de watcher não esperam `id`, os de servidor esperam; `gate.rc`/`timedOut` de `build` (null → null/false) igual em ledger-watch, server e frontend; cores `COLORS` na mesma ordem da spec.