import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, scopeDir, isAncestor, setsOverlap, ownsFile } from '../lib/paths.js';

test('normalize: barra invertida, ./ e barra final', () => {
  assert.equal(normalize('.\\apps/web/'), 'apps/web');
  assert.equal(normalize('apps\\web'), 'apps/web');
});

test('scopeDir: arquivo literal vira o diretorio dele', () => {
  assert.equal(scopeDir('styles/tokens.css'), 'styles');
  assert.equal(scopeDir('index.html'), '.');
});

test('scopeDir: para de cortar no primeiro segmento com wildcard', () => {
  assert.equal(scopeDir('apps/web/app/(frontend)/(marketing)/**'), 'apps/web/app/(frontend)/(marketing)');
  assert.equal(scopeDir('components/header.*'), 'components');
});

test('isAncestor: diretorio e ancestral do arquivo dentro dele, e de si mesmo', () => {
  assert.equal(isAncestor('styles', 'styles/base.css'), true);
  assert.equal(isAncestor('styles', 'styles'), true);
  assert.equal(isAncestor('styles', 'stylesheets/base.css'), false);
  assert.equal(isAncestor('.', 'index.html'), true);
});

test('setsOverlap: par que disputa o mesmo lote volta com os nomes', () => {
  assert.deepEqual(setsOverlap(['apps/web/components'], ['apps/web/components/marketing']),
    ['apps/web/components <-> apps/web/components/marketing']);
  assert.equal(setsOverlap(['apps/web/components'], ['apps/web/messages']), null);
});

test('ownsFile: lote possui tudo dentro, nada fora', () => {
  assert.equal(ownsFile(['apps/web/app/(frontend)/(marketing)'], 'apps/web/app/(frontend)/(marketing)/page.tsx'), true);
  assert.equal(ownsFile(['apps/web/components'], 'apps/web/lib/auth.ts'), false);
});
