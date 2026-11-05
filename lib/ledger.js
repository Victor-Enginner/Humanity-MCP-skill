// lib/ledger.js — status.tsv append-only, single-writer: o registro durável de tudo que o swarm fez.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COLS = ['task', 'state', 'rc', 'start', 'end', 'branch', 'log', 'tokens', 'pid'];
// O vocabulário de estado é contrato com lib/plan.js: nextWave só libera 'planned' e
// CONCLUIDA = {gated, merged}. Se qualquer dessas três grafias divergir, o CLI (Task 9)
// nunca avança de onda — e em silêncio.
export const STATES = ['planned', 'running', 'reported', 'gated', 'merged', 'failed', 'timeout', 'crashed', 'discarded'];

const file = (runDir) => join(runDir, 'status.tsv');
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function createLedger(runDir) {
  mkdirSync(runDir, { recursive: true });
  const p = file(runDir);
  // A recusa de recriar é a regra single-writer, não um detalhe: recriar apagaria o histórico
  // e abriria espaço para um segundo escritor corromper a corrida em andamento.
  if (existsSync(p)) throw new Error(`ledger ja existe em ${p} — single-writer nao recria`);
  writeFileSync(p, COLS.join('\t') + '\n');
  return p;
}

export function append(runDir, row) {
  // Exigimos toda coluna (mesmo vazia) para impedir linha truncada: 'sem colunas' força null explícito.
  const missing = COLS.filter((c) => !(c in row));
  if (missing.length) throw new Error(`linha sem colunas ${missing.join(',')} — use null explicito`);
  if (!STATES.includes(row.state)) throw new Error(`estado invalido: ${row.state}`);
  if (!existsSync(file(runDir))) throw new Error(`sem ledger em ${file(runDir)}`);
  const line = COLS.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return '';
    // TSV não pode carregar tab nem newline dentro de um campo: colapsamos para espaço.
    return String(v).replaceAll('\t', ' ').replaceAll('\n', ' ');
  });
  appendFileSync(file(runDir), line.join('\t') + '\n');
}

export function rows(runDir) {
  if (!existsSync(file(runDir))) throw new Error(`sem ledger em ${file(runDir)}`);
  return readFileSync(file(runDir), 'utf8').trimEnd().split(/\r?\n/).slice(1)
    .map((l) => Object.fromEntries(COLS.map((c, i) => [c, l.split('\t')[i] ?? ''])));
}

export function latest(runDir, taskId) {
  return rows(runDir).filter((r) => r.task === taskId).at(-1) ?? null;
}

export function stateOf(runDir) {
  const m = new Map();
  for (const r of rows(runDir)) m.set(r.task, r.state);
  return m;
}

export function crashedRuns(runDir, isAlive) {
  // Crash só se mede pela última linha de cada tarefa: uma tarefa pode ter 'running' no histórico
  // e já ter sido reportada depois; só o estado atual (a última linha) conta.
  const last = new Map();
  for (const r of rows(runDir)) last.set(r.task, r);
  return [...last.values()].filter((r) => r.state === 'running' && !isAlive(Number(r.pid)));
}

// Exposto para o CLI (Task 9) gravar start/end: um único formato de data no swarm, sem reinventar.
export const stamp = now;
