// test/prompt.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPrompt, writePrompt } from '../lib/prompt.js';
import { loadFloor, loadTheme, repoConventions } from '../lib/briefing.js';
import { scopeDir } from '../lib/paths.js';

const SEED = join(import.meta.dirname, '..', 'seed');

const base = {
  // O lote vai `components/header/**` e nao `components/header`: `scopeDir` corta caminho literal
  // no pai, e o teste de abaixo afirma o diretorio inteiro dentro do prompt (regra da Task 2).
  task: { id: 'T-01', title: 'Cabecalho acessivel', dirs: ['components/header/**'].map(scopeDir), dependsOn: [], verify: null },
  waveNumber: 1,
  run: { workDir: 'C:/x/runs/r1/worktrees/T-01', branch: 'swarm/r1/T-01', reportPath: 'C:/x/runs/r1/tasks/T-01/attempt-1/report.md' },
  floor: loadFloor(SEED),
  theme: loadTheme(SEED, 'neutro-editorial'),
  conventions: '(sem AGENTS.md)',
};

test('floor e tema carregam e nao vem vazios', () => {
  assert.ok(loadFloor(SEED).includes('multiplos de 4'));
  assert.ok(loadTheme(SEED, 'verde-fluxo').includes('oklch'));
  assert.throws(() => loadTheme(SEED, 'inexistente'), /tema nao existe/);
});

test('repoConventions pega AGENTS.md e CLAUDE.md e corta em 6000 chars', () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-conv-'));
  const big = 'x'.repeat(9000);
  writeFileSync(join(d, 'AGENTS.md'), '# regras\n' + big);
  const out = repoConventions(d);
  assert.ok(out.length < 7000);
  assert.ok(out.includes('regras'));
  // Os 9000 x do arquivo viraram no maximo 6000 no prompt, e sobreviveu a frente (o comeco da
  // regra, nao o fim do arquivo): contar os x e mais honesto que afirmar um comprimento exato,
  // que mudaria se o cabecalho `### AGENTS.md` mudasse de tamanho.
  const xs = (out.match(/x/g) || []).length;
  assert.ok(xs > 5000 && xs <= 6000, `x cortado para o teto por arquivo, veio ${xs}`);
});

// O nome do teste acima promete AGENTS.md E CLAUDE.md, entao os tres arquivos convencionados
// precisam ter cobertura: o worker so ve o que repoConventions juntou, e a ordem dos cabecalhos
// e o que o prompt da Task 8 mostra como "Convenções do repositorio alvo".
test('repoConventions junta os tres arquivos de convencao, cada um com seu teto', () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-conv-'));
  writeFileSync(join(d, 'AGENTS.md'), 'regra-agents\n' + 'a'.repeat(9000));
  writeFileSync(join(d, 'CLAUDE.md'), 'regra-claude');
  writeFileSync(join(d, 'TECHNICAL_GUIDELINES.md'), 'regra-tech');
  const out = repoConventions(d);
  assert.ok(out.includes('regra-agents') && out.includes('regra-claude') && out.includes('regra-tech'));
  assert.deepEqual([...out.matchAll(/^### (\S+)$/gm)].map((m) => m[1]),
    ['AGENTS.md', 'CLAUDE.md', 'TECHNICAL_GUIDELINES.md']);
  assert.ok(out.length < 3 * 6100, 'o teto e por arquivo, e a soma tem que caber no prompt');
});

test('repoConventions sem arquivos volta string vazia', () => {
  assert.equal(repoConventions(mkdtempSync(join(tmpdir(), 'swarm-conv-'))), '');
});

test('prompt carrega lote, caminho, branch e o contrato de report', () => {
  const p = renderPrompt(base);
  assert.match(p, /components\/header/);
  assert.match(p, /C:\/x\/runs\/r1\/worktrees\/T-01/);
  assert.match(p, /swarm\/r1\/T-01/);
  assert.match(p, /## Blocked/);
  assert.match(p, /- touched:/);
  assert.match(p, /multiplos de 4/);
  assert.match(p, /Nunca merge/);
});

test('writePrompt grava e recusa sobrescrever prompt existente', () => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-prompt-'));
  const f = writePrompt({ runDir: d, taskId: 'T-01', attempt: 1, text: 'oi' });
  assert.ok(existsSync(f));
  assert.equal(readFileSync(f, 'utf8'), 'oi');
  assert.throws(() => writePrompt({ runDir: d, taskId: 'T-01', attempt: 1, text: 'de novo' }), /imutavel/);
  assert.ok(writePrompt({ runDir: d, taskId: 'T-01', attempt: 2, text: 'de novo' }).endsWith('prompt.md'));
});

// Os seis acima sao do brief. Os dois abaixo existem porque o prompt e a unica coisa que um
// worker morto le: `run.js` (Task 9) reabre `tasks/<id>/attempt-N/prompt.md` para saber exatamente
// o que foi dito. Isso so vale se o texto for funcao pura das entradas e se o contrato em INGLES
// continuar literal — `parseReport` (lib/report.js:11-14) casa essas quatro strings NO TOPO DA
// LINHA (flag m, sem recuo); traduzir uma, trocar o hifen por dois pontos, ou recuar o exemplo
// dentro de um bloco faz o bloqueio do worker sumir em silencio no finish.
test('o contrato do parseReport inteiro esta no prompt, literal e comecando a linha', () => {
  const p = renderPrompt(base);
  for (const contrato of ['## Summary', '- touched:', '- tokens:', '## Blocked']) {
    assert.ok(p.includes(contrato), `prompt sem o contrato literal "${contrato}"`);
    assert.match(p, new RegExp(`^${contrato.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'm'),
      `"${contrato}" precisa comecar linha, como o parseReport casa`);
  }
});

test('renderPrompt e deterministico: mesmas entradas, mesmos bytes', () => {
  const a = renderPrompt(base);
  const b = renderPrompt({ ...base, task: { ...base.task } });
  assert.equal(a, b);
  // Nada do repositorio SWARM vaza no prompt do worker: o caminho absoluto de quem renderiza nao
  // e contrato nenhum, e tornaria o prompt instavel de maquina para maquina.
  const aqui = import.meta.dirname.replaceAll('\\', '/');
  assert.ok(!a.includes(aqui), 'caminho do repositorio swarm vazou no prompt');
});
