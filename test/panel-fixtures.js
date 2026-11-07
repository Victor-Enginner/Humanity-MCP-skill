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