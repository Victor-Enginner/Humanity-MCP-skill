// lib/report.js — o que o worker diz (parseReport) contra o que ele fez (scopeCheck).
import { ownsFile } from './paths.js';

const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

// Fim de secao = proximo "^## " ou fim absoluto da entrada. `$` sozinho nao serve: com a flag m
// ele casa no fim de QUALQUER linha, e o trecho preguiçoso pararia na primeira linha — o
// "## Summary em ate 3 linhas" que o prompt da Task 8 pede viraria 1 linha, e um "## Blocked"
// de duas linhas perderia a metade que costuma dizer em que arquivo falta. (?![\s\S]) e o unico
// "fim de string" do JS que nao e afetado pela flag m.
const SUMMARY = /^## Summary\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const BLOCKED = /^## Blocked\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const TOUCHED = /^-\s+touched:\s*(.*)$/m;
const TOKENS = /^-\s+tokens:\s*(\d+)/m;

export function parseReport(md) {
  const touched = TOUCHED.exec(md);
  const tokens = TOKENS.exec(md);
  const summary = SUMMARY.exec(md);
  const blocked = BLOCKED.exec(md);
  const blockedText = blocked ? blocked[1].trim() : '';
  return {
    touched: touched ? list(touched[1]) : [],
    tokens: tokens ? Number(tokens[1]) : null,
    summary: summary ? summary[1].trim() : '',
    // Um "## Blocked" sem corpo nao e um bloqueio: '' no JSON do finish (Task 9) seria lido
    // pelo orquestrador como bloco existente e viraria tarefa fantasma na onda seguinte.
    blocked: blockedText || null,
  };
}

// Status vem do git via lib/isolate.js: A criado, M modificado, D apagado, R renomeado (a
// origem e o destino chegam como dois itens da lista). O reason e a mensagem que a gate da
// Task 7 poe no finding e o operador le no finish: chamar "modificado" de um arquivo que o
// worker apagou ou renomeou la fora e justamente o dano que importa esconder.
const reasonFor = (status) =>
  status === 'A' ? 'criado fora do lote declarado'
    : status === 'D' ? 'apagado fora do lote declarado'
    : status === 'R' ? 'renomeado com um lado fora do lote declarado'
    : 'modificado fora do lote declarado';

export function scopeCheck({ dirs, files }) {
  const violations = files
    .filter((f) => !ownsFile(dirs, f.file))
    .map((f) => ({ file: f.file, status: f.status, reason: reasonFor(f.status) }));
  return { ok: violations.length === 0, violations };
}
