// panel/public/core.js — matemática de linhas compartilhada: servidor diffa e cliente aplica
// com a MESMA definição (CRLF normalizado, newline final não vira linha vazia).
export function toLines(text) {
  if (text === '') return [];
  const t = text.replaceAll('\r\n', '\n');
  return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
}

export function applyEdit(lines, { startLine, endLine, lines: replacement }) {
  const out = lines.slice();
  out.splice(startLine - 1, Math.max(0, endLine - startLine + 1), ...replacement);
  return out;
}