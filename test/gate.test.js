// test/gate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

test('runVerify devolve rc 0 e rc nao-zero sem lancar', () => {
  const d = tmpDir();
  writeFileSync(join(d, 'build.mjs'), "console.log('ok');\n");
  assert.equal(runVerify('node build.mjs', d).rc, 0);
  writeFileSync(join(d, 'bad.mjs'), "process.exit(7);\n");
  assert.equal(runVerify('node bad.mjs', d).rc, 7);
});

test('runVerify corta saida longa para caber no ledger', () => {
  const d = tmpDir();
  writeFileSync(join(d, 'loud.mjs'), "console.log('x'.repeat(9000));\n");
  assert.ok(runVerify('node loud.mjs', d).output.length <= 4000);
});

test('gateWave: build reprovado derruba a onda mesmo com css limpo', () => {
  const d = tmpDir();
  writeFileSync(join(d, 'fail.mjs'), "process.exit(3);\n");
  const g = gateWave({ dir: d, verify: 'node fail.mjs', cssEntries: [] });
  assert.equal(g.ok, false);
  assert.equal(g.build.rc, 3);
});

test('gateWave sem verify so checa sloplint', () => {
  const g = gateWave({ dir: process.cwd(), verify: null, cssEntries: [{ path: 'a.css', text: '.a{color:#abcdef}', tokenValues: [] }] });
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

test('gateWave ok exige build rc 0 E ausencia de achado', () => {
  const d = tmpDir();
  writeFileSync(join(d, 'build.mjs'), "console.log('build ok');\n");
  const sujo = gateWave({ dir: d, verify: 'node build.mjs', cssEntries: [{ path: 'a.css', text: '.a { gap: 3px; }' }] });
  assert.equal(sujo.level, 'wave');
  assert.equal(sujo.build.rc, 0);
  assert.equal(sujo.ok, false);
  const limpo = gateWave({ dir: d, verify: 'node build.mjs', cssEntries: [{ path: 'a.css', text: '.a { gap: 8px; }' }] });
  assert.equal(limpo.ok, true);
});

test('gateWave sem verify declarado nao finge build: build e null', () => {
  for (const verify of ['', '   ', undefined]) {
    const g = gateWave({ dir: process.cwd(), verify, cssEntries: [] });
    assert.equal(g.build, null);
    assert.equal(g.ok, true);
  }
});

test('runVerify timeout do execSync no Windows vira rc 124, nunca rc 0 nem rc 1', () => {
  const d = tmpDir();
  // 5s e o que sobra vivo no host: o timeout do execSync no Windows mata o cmd.exe, nao a arvore
  // de processos, e o Node filho morre sozinho — por isso o comando nao espera os 300s reais.
  writeFileSync(join(d, 'lento.mjs'), "setTimeout(() => {}, 5000);\n");
  assert.equal(runVerify('node lento.mjs', d, 300).rc, 124);
});

test('runVerify com diretorio inexistente devolve rc nao-zero e nao lanca', () => {
  const r = runVerify('node build.mjs', join(tmpDir(), 'nao-existe'));
  assert.equal(r.rc, 1);
  assert.ok(r.output.length > 0);
});

test('runVerify com saida maior que o maxBuffer nao estoura a execucao', () => {
  const d = tmpDir();
  writeFileSync(join(d, 'guincho.mjs'), "for (let i = 0; i < 600; i++) console.log('x'.repeat(30000));\n");
  const r = runVerify('node guincho.mjs', d);
  assert.notEqual(r.rc, 0);
  assert.ok(r.output.length <= 4000);
});

test('runVerify guarda o fim da saida, nao o comeco: e la que o build explica o erro', () => {
  const d = tmpDir();
  writeFileSync(join(d, 'log.mjs'), "console.log('COMECO' + 'x'.repeat(9000) + 'FIM');\n");
  const r = runVerify('node log.mjs', d);
  assert.equal(r.rc, 0);
  assert.ok(r.output.endsWith('FIM\n'));
  assert.ok(!r.output.includes('COMECO'));
});

test('runVerify na falha preserva o que o comando disse, nao so a mensagem do Node', () => {
  const d = tmpDir();
  writeFileSync(join(d, 'quebra.mjs'), "console.log('ultima linha util do build');\nconsole.error('erro: faltou arquivo');\nprocess.exit(5);\n");
  const r = runVerify('node quebra.mjs', d);
  assert.equal(r.rc, 5);
  assert.match(r.output, /ultima linha util do build/);
  assert.match(r.output, /erro: faltou arquivo/);
});
