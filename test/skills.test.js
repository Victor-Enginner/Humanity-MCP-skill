// test/skills.test.js — a guarda de consistencia entre as skills e o CLI real.
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
