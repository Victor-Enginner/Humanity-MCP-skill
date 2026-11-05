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

// --- Fix round da emenda da Task 8 (2026-11-05): o corpo da tarefa entra no prompt (item 1,
// consumindo o `Task.body` da emenda da Task 2) e o paragrafo de dependencia passa a dizer a
// verdade do protocolo novo da Task 9 (item 2: worktree de onda > 1 sai do head de integracao).

test('o corpo da tarefa entra no prompt logo abaixo do titulo', () => {
  const corpo = 'Faca o cabecalho usar --accent.\nNao toque em tokens.css.';
  const p = renderPrompt({ ...base, task: { ...base.task, body: corpo } });
  const iTitulo = p.indexOf(base.task.title);
  const iCorpo = p.indexOf(corpo);
  const iDep = p.indexOf('Depende de:');
  assert.ok(iTitulo >= 0, 'titulo presente');
  assert.ok(iCorpo > iTitulo, 'corpo precisa aparecer abaixo do titulo');
  assert.ok(iCorpo < iDep, 'o corpo e a especificacao da tarefa: vem antes do paragrafo de dependencia');
});

test('corpo vazio ou ausente nao inventa secao nem muda um byte do prompt', () => {
  const semCampo = renderPrompt(base); // fixture antigo, sem `body` nenhum
  const comVazio = renderPrompt({ ...base, task: { ...base.task, body: '' } });
  const comEspacos = renderPrompt({ ...base, task: { ...base.task, body: '  \n  ' } });
  assert.equal(comVazio, semCampo, 'body vazio nao pode mudar nada');
  assert.equal(comEspacos, semCampo, 'body so whitespace tambem nao');
  assert.match(comVazio, /Cabecalho acessivel\n\nDepende de:/, 'sem corpo: o titulo segue direto a linha Depende de');
  assert.ok(!comVazio.includes('[corpo cortado]'));
});

test('corpo acima de 6000 chars e cortado com a marca literal no comeco', () => {
  const corpo = 'x'.repeat(6000) + 'ECAUDA-CORTADA';
  const p = renderPrompt({ ...base, task: { ...base.task, body: corpo } });
  assert.match(p, /\[corpo cortado\]/);
  assert.ok(p.includes('x'.repeat(6000)), 'o teto mantem o comeco — num plano, o que vem primeiro importa');
  assert.ok(!p.includes('ECAUDA-CORTADA'), 'o fim acima do teto nao entra no prompt');
});

test('o prompt afirma a verdade nova da dependencia e a mentira antiga saiu', () => {
  const p = renderPrompt(base);
  // Fragmento fixo do paragrafo novo (emenda item 2): a dependencia ja esta no worktree.
  assert.match(p, /ja estao no seu worktree/i);
  // A claim antiga do `cmdStart` rascunhado nao pode sobreviver em lugar nenhum.
  assert.doesNotMatch(p, /NAO esta no seu worktree/);
});
