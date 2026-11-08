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