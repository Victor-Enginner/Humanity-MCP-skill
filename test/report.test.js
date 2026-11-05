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

// O prompt da Task 8 pede o resumo "em ate 3 linhas": resumo de varias linhas e o formato
// normal do report, nao uma excecao.
test('parseReport guarda todas as linhas do summary', () => {
  const r = parseReport('## Summary\nlinha 1.\nlinha 2.\nlinha 3.\n## Notes\nx\n');
  assert.equal(r.summary, 'linha 1.\nlinha 2.\nlinha 3.');
});

test('parseReport guarda todas as linhas do blocked', () => {
  const r = parseReport('## Summary\nok\n## Blocked\nfalta --focus-ring\nem styles/tokens.css\n');
  assert.equal(r.blocked, 'falta --focus-ring\nem styles/tokens.css');
});

test('parseReport devolve nulls e summary vazio quando o report omite as secoes', () => {
  const r = parseReport('- touched: a.css\n- tokens: 90\n');
  assert.equal(r.summary, '');
  assert.equal(r.blocked, null);
  assert.deepEqual(r.touched, ['a.css']);
  assert.equal(r.tokens, 90);
});

// O report pode nem existir: o finish da Task 9 le um arquivo ausente como string vazia.
test('parseReport nao estoura com report vazio', () => {
  assert.deepEqual(parseReport(''), { touched: [], tokens: null, summary: '', blocked: null });
});

// Um "## Blocked" sem corpo nao e um bloqueio: '' dentro do JSON do finish seria lido pelo
// orquestrador como um bloco com conteudo, e viraria tarefa fantasma na onda seguinte.
test('parseReport trata blocked sem corpo como nao bloqueado', () => {
  assert.equal(parseReport('## Summary\nok\n## Blocked\n').blocked, null);
});

test('parseReport le report escrito com CRLF', () => {
  const r = parseReport('## Summary\r\nlinha 1.\r\nlinha 2.\r\n- tokens: 4200\r\n## Blocked\r\nfalta x\r\n');
  assert.match(r.summary, /linha 1\./);
  assert.match(r.summary, /linha 2\./);
  assert.equal(r.tokens, 4200);
  assert.equal(r.blocked, 'falta x');
});

// Worker que mente sobre o custo nao pode arrastar o parse: sem digitos ali, tokens e null,
// e o ledger da Task 9 registra null em vez de um numero inventado pelo regex.
test('parseReport nao inventa tokens que nao sao numero', () => {
  assert.equal(parseReport('## Summary\nok\n- tokens: mais ou menos\n').tokens, null);
  assert.equal(parseReport('## Summary\nok\n- tokens: ~4200\n').tokens, null);
  assert.equal(parseReport('## Summary\nok\n- tokens:\n').tokens, null);
});

test('scopeCheck diz que o worker apagou o que nao era dele', () => {
  const r = scopeCheck({ dirs: ['styles'], files: [{ status: 'D', file: 'components/header.js' }] });
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /apagado fora do lote/);
});

// lib/isolate.js devolve origem E destino do renomeado, ambas com status 'R': git mv para
// fora do lote e a forma mais facil de atravessar a fronteira sem parecer que escreveu la.
test('scopeCheck reprova o destino de um renomeado para fora do lote', () => {
  const r = scopeCheck({ dirs: ['styles'], files: [
    { status: 'R', file: 'styles/rodape.css' },
    { status: 'R', file: 'components/rodape.css' },
  ] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [
    { file: 'components/rodape.css', status: 'R', reason: 'renomeado com um lado fora do lote declarado' },
  ]);
});

test('scopeCheck reprova a origem de um renomeado que veio de fora', () => {
  const r = scopeCheck({ dirs: ['components'], files: [
    { status: 'R', file: 'styles/tokens.css' },
    { status: 'R', file: 'components/tokens.css' },
  ] });
  assert.deepEqual(r.violations.map((v) => v.file), ['styles/tokens.css']);
});

test('scopeCheck aprova quando nada foi tocado', () => {
  assert.deepEqual(scopeCheck({ dirs: ['styles'], files: [] }), { ok: true, violations: [] });
});

// Um nome solto no plano ("paths: config") vira lote raiz pelo scopeDir da Task 2, e o dono
// do raiz possui todo o repositorio: sem isso, o gate barraria o proprio dono do lote.
test('scopeCheck do lote raiz nao inventa violacao', () => {
  assert.equal(scopeCheck({ dirs: ['.'], files: [{ status: 'M', file: 'index.html' }] }).ok, true);
});
