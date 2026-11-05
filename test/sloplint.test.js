// test/sloplint.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, lintCss, lintFiles } from '../lib/sloplint.js';

const ids = (f) => f.map((x) => x.id);

test('SLOP-PURPLE-GRADIENT pega gradiente roxo, nao pega cinza', () => {
  const bad = lintCss('.hero { background: linear-gradient(135deg, #6366f1, #a855f7); }', { file: 'a.css' });
  assert.deepEqual(ids(bad), ['SLOP-PURPLE-GRADIENT']);
  assert.equal(bad[0].line, 1);
  assert.deepEqual(lintCss('.x { background: linear-gradient(180deg, #101010, #202020); }'), []);
});

test('SLOP-EYEBROW-CAPS: caps + letter-spacing largo; caps sozinho passa', () => {
  assert.deepEqual(ids(lintCss('.k { text-transform: uppercase; letter-spacing: 0.12em; }')), ['SLOP-EYEBROW-CAPS']);
  assert.deepEqual(ids(lintCss('.k { text-transform: uppercase; letter-spacing: 0.01em; }')), []);
  assert.deepEqual(ids(lintCss('.k { text-transform: uppercase; }')), []);
  assert.deepEqual(ids(lintCss('.k { text-transform: uppercase; letter-spacing: 3px; }')), ['SLOP-EYEBROW-CAPS']);
});

test('SLOP-SPACING-RHYTHM: 3px e 13px fora; 0, 8px e 1.5rem passam; border passa', () => {
  assert.deepEqual(ids(lintCss('.a { margin-top: 3px; }')), ['SLOP-SPACING-RHYTHM']);
  assert.deepEqual(ids(lintCss('.a { padding: 8px 1.5rem 0; }')), []);
  assert.deepEqual(ids(lintCss('.a { gap: 13px; }')), ['SLOP-SPACING-RHYTHM']);
  assert.deepEqual(ids(lintCss('.a { border: 3px solid red; }')), []);
});

test('SLOP-OFF-TOKEN-COLOR: so roda com tokens; hex proprio da declaracao de token passa', () => {
  const toks = ['oklch(0.98 0.01 250)', '#101010'];
  assert.deepEqual(ids(lintCss('.a { color: #ff0055; }', { tokenValues: toks })), ['SLOP-OFF-TOKEN-COLOR']);
  assert.deepEqual(ids(lintCss('.a { color: #101010; }', { tokenValues: toks })), []);
  assert.deepEqual(ids(lintCss('.a { color: #101010; }')), []);
  assert.deepEqual(ids(lintCss(':root { --ink: #ff0055; }', { tokenValues: [] })), []);
});

test('lintFiles so olha css e carrega o path no achado', () => {
  const f = lintFiles([
    { path: 'styles/a.css', text: '.a { gap: 3px }' },
    { path: 'app.js', text: '.a { gap: 3px }' },
  ]);
  assert.equal(f.length, 1);
  assert.equal(f[0].file, 'styles/a.css');
});

test('toda regra tem id e motivo', () => {
  assert.equal(RULES.length, 4);
  for (const r of RULES) assert.ok(r.id.startsWith('SLOP-') && r.why.length > 10);
});

// --- além dos casos do brief: as classes de falso positivo que bloqueariam output correto ---

test('comentario e string nao viram achado', () => {
  const css = [
    '/* padding: 3px; color: #ff0055; linear-gradient(purple) */',
    '.a { content: "linear-gradient(90deg, purple, violet)"; gap: 8px; }',
  ].join('\n');
  assert.deepEqual(lintCss(css, { tokenValues: ['#101010'] }), []);
});

test('aspas de palavra nao engolem o resto do arquivo', () => {
  const css = ".nav { font-family: O'Brien Sans; margin: 3px; }";
  assert.deepEqual(ids(lintCss(css)), ['SLOP-SPACING-RHYTHM']);
});

test('border nao cega a regra de ritmo na mesma linha', () => {
  assert.deepEqual(ids(lintCss('.a { border: 1px solid #ccc; margin: 3px; }')), ['SLOP-SPACING-RHYTHM']);
});

test('linha aponta a declaracao que falha, nao o bloco', () => {
  const f = lintCss('.a {\n  color: red;\n  margin: 3px;\n}');
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 3);
  const g = lintCss('.hero {\n  background:\n    linear-gradient(135deg, #a855f7, #6366f1);\n}');
  assert.deepEqual(ids(g), ['SLOP-PURPLE-GRADIENT']);
  assert.equal(g[0].line, 3);
});

test('declaracao dentro de @media conta; a condicao nao', () => {
  const f = lintCss('@media (min-width: 768px) {\n  .a { padding: 3px 6px 13px }\n}', { file: 'a.css' });
  assert.deepEqual(ids(f), ['SLOP-SPACING-RHYTHM']);
  assert.equal(f[0].line, 2);
  assert.equal(f[0].message, 'fora da escala de 4: 3, 6, 13px');
});

test('uppercase e letter-spacing em blocos separados nao formam eyebrow', () => {
  assert.deepEqual(lintCss('.a { text-transform: uppercase } .b { letter-spacing: 0.3em }'), []);
});

test('gradiente cinza com arquivo de nome roxo nao e gradiente roxo', () => {
  assert.deepEqual(lintCss('.a { background: linear-gradient(#fff, #eee) url(indigo.png); }'), []);
});

test('token reconhecido com outra caixa, espaco sobrando ou forma curta', () => {
  assert.deepEqual(lintCss('.a { color: #ff0055; }', { tokenValues: ['  #FF0055 '] }), []);
  assert.deepEqual(lintCss('.a { color: #F05; }', { tokenValues: ['#ff0055'] }), []);
  assert.deepEqual(ids(lintCss('.a { color: #0f0; }', { tokenValues: ['#ff0055'] })), ['SLOP-OFF-TOKEN-COLOR']);
});

test('seletor de id que parece hexadecimal nao e cor', () => {
  assert.deepEqual(lintCss('#fade { color: #101010; }', { tokenValues: ['#101010'] }), []);
});

test('propriedade e unidade escritas em caixa alta nao escapam das regras', () => {
  assert.deepEqual(ids(lintCss('.K { TEXT-TRANSFORM: UPPERCASE; letter-spacing: 0.2em }')), ['SLOP-EYEBROW-CAPS']);
  assert.deepEqual(ids(lintCss('.A { MARGIN: 6PX }')), ['SLOP-SPACING-RHYTHM']);
});

test('lintFiles ignora entrada sem texto', () => {
  assert.deepEqual(lintFiles([{ path: 'a.css' }, { path: 'b.css', text: '' }]), []);
});
