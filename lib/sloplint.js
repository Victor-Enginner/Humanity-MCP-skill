// lib/sloplint.js — quatro regras determinísticas de slop visual, nenhuma delas chama LLM.
// O que torna um achado de layout checável é o id citável da regra que o produziu: o critic (e o
// worker, na Task 7) pode discordar da fronteira, nunca do fato de que a regra SLOP-* pegou.
// Rule-set próprio, informado por hallmark/sloplint.mjs (MIT) e pelo detector impeccable
// (Apache-2.0) — atribuição em seed/ATTRIBUTION.md.
/** @typedef {{ id: string, file: string, line: number, message: string }} Finding */

const PURPLE = /(purple|violet|indigo|#7c3aed|#8b5cf6|#a855f7|#6366f1|#9333ea)/i;

export const RULES = [
  { id: 'SLOP-PURPLE-GRADIENT', why: 'gradiente roxo/indigo e a assinatura visual de template gerado por IA' },
  { id: 'SLOP-EYEBROW-CAPS', why: 'rotulo em caps com letter-spacing largo e o tique do eyebrow de landing page' },
  { id: 'SLOP-SPACING-RHYTHM', why: 'espacamento fora da escala de 4 rompe o ritmo vertical' },
  { id: 'SLOP-OFF-TOKEN-COLOR', why: 'cor literal que nao esta nos tokens do tema divergiu porque ninguem olhou' },
];

const find = (out, id, file, line, message) => out.push({ id, file, line, message });

// Linha de um índice: contar '\n' até o ponto dá a linha certa com LF e com CRLF, e é o único jeito
// de o achado apontar para a declaração que falha num bloco escrito em várias linhas.
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// Um bloco "interno" (corpo sem chaves) é onde vivem as declarações. Num @media aninhado o corpo do
// wrapper tem '{', então só o bloco de regra é varrido — e o prelude, que traz "(min-width: 768px)",
// nunca vira declaração falsa nem linha de achado.
const BLOCK = /[^{}]*\{[^{}]*\}/g;
// O valor é sempre o rabo do match, então (match - valor) devolve onde o valor começa.
const DECL = /(--[-\w]+|[-A-Za-z][-\w]*)\s*:\s*([^;{}]*)/g;
const GRADIENT = /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/gi;
const SPACING = /^(?:margin|padding|gap|row-gap|column-gap|grid-gap|grid-row-gap|grid-column-gap)(?:-(?:top|bottom|left|right|inline|block|start|end))?$/i;
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const HEX_SHORT = /^#([0-9a-f]{3,4})$/;

// Do '(' até o ')' que fecha, contando profundidade: a cor precisa ser procurada dentro do
// gradiente, não no valor inteiro — `url(indigo.png)` ao lado de um gradiente cinza não é stop roxo.
function gradientArgs(value, open) {
  let depth = 0;
  for (let i = open; i < value.length; i++) {
    if (value[i] === '(') depth += 1;
    else if (value[i] === ')') {
      depth -= 1;
      if (depth === 0) return value.slice(open + 1, i);
    }
  }
  return value.slice(open + 1);
}

const spacingOff = (value, base) =>
  [...value.matchAll(/(-?[\d.]+)px\b/gi)]
    .map((x) => ({ v: Number(x[1]), at: base + x.index }))
    .filter((o) => Number.isFinite(o.v) && o.v !== 0 && o.v % 4 !== 0);

const isWideTracking = (value) => {
  const m = /(-?[\d.]+)\s*(em|rem|px)/i.exec(value);
  if (!m) return false;
  const v = Number(m[1]);
  return Number.isFinite(v) && (m[2].toLowerCase() === 'px' ? v >= 1 : v >= 0.05);
};

// Caixa, espaço sobrando e forma curta (#f05 === #ff0055) são o mesmo token: comparar o literal
// cru faria o gate barrar cor que o tema define, e finding falso bloqueia output correto do worker.
const normColor = (v) => {
  const s = String(v).trim().toLowerCase();
  const short = HEX_SHORT.exec(s);
  return short ? `#${[...short[1]].map((c) => c + c).join('')}` : s;
};

// Comentários e strings viram espaços do mesmo comprimento, preservando as quebras de linha: o
// texto mascarado continua com índices idênticos aos do original, e um "padding: 3px" dentro de
// comentário deixa de ser declaração sem que nenhuma linha desloque.
function mask(css) {
  const chars = css.split('');
  const hide = (from, to) => {
    for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  let i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      hide(i, stop);
      i = stop;
    } else if (css[i] === '"' || css[i] === "'") {
      const closed = closeQuote(css, i);
      if (closed === -1) {
        i += 1;
        continue;
      }
      hide(i + 1, closed);
      i = closed + 1;
    } else {
      i += 1;
    }
  }
  return chars.join('');
}

// String CSS não cruza linha crua: aspas que só fecha depois do \n é apóstrofo de palavra
// (`font-family: O'Brien Sans`), e tratá-la como string escondia o resto do arquivo.
function closeQuote(css, open) {
  for (let j = open + 1; j < css.length; j++) {
    if (css[j] === '\n') return -1;
    if (css[j] === '\\') {
      j += 1;
      continue;
    }
    if (css[j] === css[open]) return j;
  }
  return -1;
}

export function lintCss(css, { file = '(css)', tokenValues = null } = {}) {
  if (typeof css !== 'string' || css.length === 0) return [];
  const src = mask(css);
  // tokenValues vem do tema (Task 8); o lint não lê arquivo nenhum. Set vazio é "tema sem cores":
  // a regra continua rodando, porque aí toda cor literal está fora dos tokens.
  const known = Array.isArray(tokenValues) ? new Set(tokenValues.map(normColor)) : null;
  const out = [];

  for (const block of src.matchAll(BLOCK)) {
    const open = block[0].indexOf('{');
    const body = block[0].slice(open + 1, -1);
    const bodyAt = block.index + open + 1;
    const decls = [];
    for (const d of body.matchAll(DECL)) {
      decls.push({ prop: d[1], value: d[2], at: bodyAt + d.index, valueAt: bodyAt + d.index + d[0].length - d[2].length });
    }

    for (const { prop, value, valueAt } of decls) {
      for (const g of value.matchAll(GRADIENT)) {
        const fnOpen = g.index + g[0].length - 1;
        if (PURPLE.test(gradientArgs(value, fnOpen))) {
          find(out, 'SLOP-PURPLE-GRADIENT', file, lineAt(src, valueAt + fnOpen), 'gradiente com stop roxo/indigo');
        }
      }
      if (SPACING.test(prop)) {
        const off = spacingOff(value, valueAt);
        if (off.length) {
          find(out, 'SLOP-SPACING-RHYTHM', file, lineAt(src, off[0].at), `fora da escala de 4: ${off.map((o) => o.v).join(', ')}px`);
        }
      }
      if (known && !prop.startsWith('--')) {
        for (const h of value.matchAll(HEX)) {
          if (!known.has(normColor(h[0]))) {
            find(out, 'SLOP-OFF-TOKEN-COLOR', file, lineAt(src, valueAt + h.index), `${h[0]} nao esta nos tokens`);
          }
        }
      }
    }

    // O eyebrow é o par dentro do MESMO bloco: uppercase num bloco e tracking largo noutro não é
    // rótulo de landing page, e denunciar o par separado derrubaria botão e tabela legítimos.
    // Nome de propriedade é case-insensitive em CSS, então comparar cru perderia `.K { TEXT-TRANSFORM:
    // uppercase; letter-spacing: 0.2em }` — falso negativo do jeito que o gate não vê.
    const caps = decls.find((d) => /^text-transform$/i.test(d.prop) && /uppercase/i.test(d.value));
    const wide = decls.find((d) => /^letter-spacing$/i.test(d.prop) && isWideTracking(d.value));
    if (caps && wide) {
      find(out, 'SLOP-EYEBROW-CAPS', file, lineAt(src, Math.min(caps.at, wide.at)), `uppercase + letter-spacing largo (${wide.value.trim()})`);
    }
  }

  return out.sort((a, b) => a.line - b.line || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function lintFiles(entries) {
  return entries
    .filter((e) => typeof e.text === 'string' && e.path.endsWith('.css'))
    .flatMap((e) => lintCss(e.text, { file: e.path, tokenValues: e.tokenValues ?? null }));
}
