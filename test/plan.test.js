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
