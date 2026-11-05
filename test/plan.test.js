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

// --- Round de revisão (Findings 1 e 2) ---

test('parsePlan: secao de prosa depois de tarefa lanca PlanError e nao reescreve o lote', () => {
  const soTarefa = '## T-01 a\n- paths: styles/**\n- verify: node build.mjs\n';
  const comProsa = soTarefa + '\n## Criterios de aceite\n- paths: app/**\n- verify: -\n';

  // sem a secao de prosa, T-01 e dona de "styles" (contrato correto do lote)
  assert.deepEqual(parsePlan(soTarefa).map((t) => [t.id, t.dirs, t.verify]), [['T-01', ['styles'], 'node build.mjs']]);

  // com a secao, o parser nao pode absorver "- paths: app/**" em T-01: lanca e nomeia a secao
  assert.throws(() => parsePlan(comProsa), (err) =>
    err instanceof PlanError && /## Criterios de aceite/.test(err.message));
});

test('parsePlan: id de tarefa malformado (T-1) e rejeitado, nao descartado em silencio', () => {
  const md = '## T-01 a\n- paths: styles/**\n\n## T-1 b\n- paths: app/**\n';
  assert.throws(() => parsePlan(md), PlanError);
});

test('nextWave libera apenas uma onda validada, nunca camadas topologicas misturadas', () => {
  const md = '## T-01 a\n- paths: styles/**\n- depends_on: -\n\n'
    + '## T-02 b\n- paths: components/header/**\n- depends_on: -\n\n'
    + '## T-03 c\n- paths: components/footer/**\n- depends_on: T-02\n';
  const tasks = parsePlan(md);
  assert.deepEqual(computeWaves(tasks).map((w) => w.map((t) => t.id)), [['T-01', 'T-02'], ['T-03']]);
  // T-02 merged abriria T-03 (onda 2); nextWave nao pode devolver T-01 (onda 1) junto com T-03
  assert.deepEqual(nextWave(tasks, new Map([['T-02', 'merged']])).map((t) => t.id), ['T-01']);
});

test('nextWave nao relibera tarefas running nem reported', () => {
  const tasks = parsePlan(MD);
  assert.deepEqual(nextWave(tasks, new Map([['T-01', 'running']])).map((t) => t.id), []);
  assert.deepEqual(nextWave(tasks, new Map([['T-01', 'reported']])).map((t) => t.id), []);
});
