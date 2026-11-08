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