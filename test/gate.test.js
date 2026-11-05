// test/gate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateTask, gateWave, runVerify } from '../lib/gate.js';

const okScope = { ok: true, violations: [] };
const badScope = { ok: false, violations: [{ file: 'index.html', status: 'M', reason: 'modificado fora do lote declarado' }] };

const tmpDir = () => mkdtempSync(join(tmpdir(), 'swarm-gate-'));

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
  const d = tmpDir();
  writeFileSync(join(d, 'build.mjs'), "console.log('ok');\n");
  assert.equal((await runVerify('node build.mjs', d)).rc, 0);
  writeFileSync(join(d, 'bad.mjs'), "process.exit(7);\n");
  assert.equal((await runVerify('node bad.mjs', d)).rc, 7);
});

test('runVerify corta saida longa para caber no ledger', async () => {
  const d = tmpDir();
  writeFileSync(join(d, 'loud.mjs'), "console.log('x'.repeat(9000));\n");
  assert.ok((await runVerify('node loud.mjs', d)).output.length <= 4000);
});

// O teste que segura a regra 1: depois de um timeout, NINGUEM pode escrever no diretorio.
// Medido nesta maquina: no lugar do taskkill da arvore, com `child.kill()` simples, o node filho
// sobrevive ao cmd.exe e o arquivo aparece — o teste falha, sempre. As margens (filho dorme 1,5 s,
// timeout de 300 ms, teste espera 2,5 s) existem para nenhuma flutuacao de maquina decidir isso.
// O filho e ESM de proposito (`require` nao existe em .mjs no Node 24 e o teste passaria vazio).
test('runVerify timeout mata a arvore de processos, nao so o shell', async () => {
  const d = tmpDir();
  writeFileSync(join(d, 'lento.mjs'), "import { writeFileSync } from 'node:fs';\nsetTimeout(() => writeFileSync('escrito.txt', 'zumbi'), 1500);\n");
  const r = await runVerify('node lento.mjs', d, 300);
  assert.equal(r.rc, 124);
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal(existsSync(join(d, 'escrito.txt')), false);
});

test('gateWave: build reprovado derruba a onda mesmo com css limpo', async () => {
  const d = tmpDir();
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

// --- além do bloco do brief: campos que o `finish` (Task 9) e o `integrate` (Task 11) gravam e o
// operador lê — a conjunção do `ok` da onda e as três formas distintas de "o build não rodou".

test('gateTask junta achado de scope e de sloplint no mesmo resultado', () => {
  const g = gateTask({ scope: badScope, cssEntries: [{ path: 'a.css', text: '.a { padding: 3px; }' }] });
  assert.equal(g.ok, false);
  assert.deepEqual(g.findings.map((f) => f.id), ['SCOPE-OUTSIDE-LOT', 'SLOP-SPACING-RHYTHM']);
  assert.equal(g.findings[0].line, null);
  assert.equal(g.findings[0].message, 'modificado fora do lote declarado');
});

test('gateWave ok exige build rc 0 E ausencia de achado', async () => {
  const d = tmpDir();
  writeFileSync(join(d, 'build.mjs'), "console.log('build ok');\n");
  const sujo = await gateWave({ dir: d, verify: 'node build.mjs', cssEntries: [{ path: 'a.css', text: '.a { gap: 3px; }' }] });
  assert.equal(sujo.level, 'wave');
  assert.equal(sujo.build.rc, 0);
  assert.equal(sujo.build.timedOut, false);
  assert.equal(sujo.ok, false);
  const limpo = await gateWave({ dir: d, verify: 'node build.mjs', cssEntries: [{ path: 'a.css', text: '.a { gap: 8px; }' }] });
  assert.equal(limpo.ok, true);
});

test('gateWave sem verify declarado nao finge build: build e null', async () => {
  for (const verify of ['', '   ', undefined]) {
    const g = await gateWave({ dir: process.cwd(), verify, cssEntries: [] });
    assert.equal(g.build, null);
    assert.equal(g.ok, true);
  }
});

test('runVerify timeout vira rc 124 e timedOut true, nunca rc 0 nem rc 1', async () => {
  const d = tmpDir();
  // 5s e so o que o filho dorme: quem encerra e o temporizador da gate, que aos 300 ms mata a
  // arvore inteira (cmd.exe E o node filho) — o filho nao morre sozinho, medido no teste acima.
  writeFileSync(join(d, 'lento.mjs'), "setTimeout(() => {}, 5000);\n");
  const r = await runVerify('node lento.mjs', d, 300);
  assert.equal(r.rc, 124);
  assert.equal(r.timedOut, true);
});

test('runVerify de comando que sai 124 por conta propria nao e timeout', async () => {
  const d = tmpDir();
  writeFileSync(join(d, 'convite.mjs'), "console.log('eu escolhi sair 124');\nprocess.exit(124);\n");
  const r = await runVerify('node convite.mjs', d, 5_000);
  assert.equal(r.rc, 124);
  assert.equal(r.timedOut, false);
  assert.match(r.output, /eu escolhi sair 124/);
});

test('runVerify com diretorio inexistente devolve rc nao-zero e nao lanca', async () => {
  const r = await runVerify('node build.mjs', join(tmpDir(), 'nao-existe'));
  assert.equal(r.rc, 1);
  assert.equal(r.timedOut, false);
  assert.ok(r.output.length > 0);
});

test('runVerify de build barulhento que termina em 0 continua sendo rc 0', async () => {
  const d = tmpDir();
  writeFileSync(join(d, 'guincho.mjs'), "for (let i = 0; i < 600; i++) console.log('x'.repeat(30000));\n");
  const r = await runVerify('node guincho.mjs', d);
  assert.equal(r.rc, 0);
  assert.ok(r.output.length <= 4000);
});

test('runVerify guarda o fim da saida, nao o comeco: e la que o build explica o erro', async () => {
  const d = tmpDir();
  writeFileSync(join(d, 'log.mjs'), "console.log('COMECO' + 'x'.repeat(9000) + 'FIM');\n");
  const r = await runVerify('node log.mjs', d);
  assert.equal(r.rc, 0);
  assert.ok(r.output.endsWith('FIM\n'));
  assert.ok(!r.output.includes('COMECO'));
});

test('runVerify na falha preserva o que o comando disse, nao so a mensagem do Node', async () => {
  const d = tmpDir();
  writeFileSync(join(d, 'quebra.mjs'), "console.log('ultima linha util do build');\nconsole.error('erro: faltou arquivo');\nprocess.exit(5);\n");
  const r = await runVerify('node quebra.mjs', d);
  assert.equal(r.rc, 5);
  assert.match(r.output, /ultima linha util do build/);
  assert.match(r.output, /erro: faltou arquivo/);
});
