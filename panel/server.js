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

async function main(argv) {
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