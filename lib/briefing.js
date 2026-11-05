// lib/briefing.js — o que o worker sabe antes de escrever a primeira linha: o piso, o tema e as
// convenções do repo alvo. Nada aqui decide nada: é leitura de arquivo, na ordem fixa de baixo para
// cima, e o resultado entra literal no prompt (lib/prompt.js).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Ordem deliberada: AGENTS.md (o contrato de agente para agente) antes de CLAUDE.md, que antes do
// guia técnico. É a ordem em que o worker lê, e é a ordem que test/prompt.test.js afirma.
const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'TECHNICAL_GUIDELINES.md'];

// O teto é POR ARQUIVO, não da soma: os três competem o mesmo espaço do prompt, e um AGENTS.md de
// 40 KB não pode engolir inteiro o CLAUDE.md — que é onde um repo costuma guardar as regras de CSS
// que a gate da Task 7 cobra. O corte mantém o começo do arquivo, que é onde a regra mora; o fim
// de um doc de convenção é quase sempre exemplo repetido.
const CONVENTION_CAP = 6000;

export const loadFloor = (seedDir) => readFileSync(join(seedDir, 'floor.md'), 'utf8');

export function loadTheme(seedDir, name) {
  const p = join(seedDir, 'themes', `${name}.md`);
  if (!existsSync(p)) throw new Error(`tema nao existe: ${p}`);
  return readFileSync(p, 'utf8');
}

export function repoConventions(repoDir) {
  const out = [];
  for (const f of CONVENTION_FILES) {
    const p = join(repoDir, f);
    if (existsSync(p)) out.push(`### ${f}\n${readFileSync(p, 'utf8').slice(0, CONVENTION_CAP)}`);
  }
  return out.join('\n\n');
}
