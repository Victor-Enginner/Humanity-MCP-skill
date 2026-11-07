// test/isolate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun, readRun } from '../lib/meta.js';
import { PlanError } from '../lib/plan.js';
import { prepare, touchedFiles, prepareIntegration, mergeInOrder, removeWorktree, branchName } from '../lib/isolate.js';
import { ownsFile } from '../lib/paths.js';

const G = ['-c', 'user.email=swarm@test', '-c', 'user.name=swarm'];
const git = (args, cwd) => execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), 'swarm-repo-'));
  git(['init', '-q', '-b', 'main'], repoDir);
  // Identidade LOCAL ao repositório (nada global): os worktrees herdam o .git/config, então os
  // merges que lib/isolate.js faz sem injetar autor deixam de depender da config do host. A
  // produção continua sem identidade injetada — o merge de integração é histórico do humano.
  git(['config', 'user.email', 'swarm@test'], repoDir);
  git(['config', 'user.name', 'swarm'], repoDir);
  mkdirSync(join(repoDir, 'styles'), { recursive: true });
  writeFileSync(join(repoDir, 'styles', 'tokens.css'), ':root { --bg: oklch(0.98 0.01 250); }\n');
  writeFileSync(join(repoDir, 'index.html'), '<h1>base</h1>\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'base'], repoDir);
  return repoDir;
}

const newRun = () => mkdtempSync(join(tmpdir(), 'swarm-run-'));

test('initRun grava run.json com o sha base', () => {
  const repoDir = makeRepo();
  const workspaceRoot = join(repoDir, '..', 'swarm-run');
  mkdirSync(workspaceRoot, { recursive: true });
  const meta = initRun({ workspaceRoot, repoDir });
  assert.equal(meta.baseSha, git(['rev-parse', 'HEAD'], repoDir));
  assert.ok(existsSync(join(meta.runDir, 'run.json')));
  assert.equal(readRun(meta.runDir).runId, meta.runId);
});

// Colisao de runId (review final do branch): date + 4 hex colide no mesmo dia, e o initRun gravava
// run.json ANTES do refuse-recreate do createLedger (run.js) — o run vivo perdia o baseSha dele em
// silencio e a guarda so reclamava do ledger. `uuid` e seam de TESTE (campo opcional, default
// randomUUID): sem ele a colisao seria 1/65536 e nenhum teste a esperaria acontecer.
test('initRun recusa runId colidido sem sobrescrever o run.json do run vivo', () => {
  const repoDir = makeRepo();
  const workspaceRoot = newRun();
  const uuid = () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const primeiro = initRun({ workspaceRoot, repoDir, uuid });
  const runJson = join(primeiro.runDir, 'run.json');
  const antes = readFileSync(runJson, 'utf8');
  // O repo ANDOU entre as duas chamadas: e o dano real da colisao, nao um byte qualquer — quem
  // reescreve troca o baseSha do run vivo pelo head novo. Sem isto a compara de bytes seria vacua
  // quando as duas chamadas caem no mesmo segundo (o stamp() so tem resolucao de segundo).
  writeFileSync(join(repoDir, 'index.html'), '<h1>o repo andou</h1>\n');
  git(['add', '.'], repoDir); git(['commit', '-q', '-m', 'depois do run'], repoDir);
  // Ordem deliberada: primeiro o DANO, depois a recusa — com o bug a segunda chamada sobrescreve
  // e o que falha aqui e a compara de bytes, nao o throws.
  let recusou = null;
  try { initRun({ workspaceRoot, repoDir, uuid }); } catch (e) { recusou = e; }
  assert.equal(readFileSync(runJson, 'utf8'), antes, 'initRun colidiu e sobrescreveu o run.json do run vivo');
  assert.equal(readRun(primeiro.runDir).baseSha, primeiro.baseSha);
  assert.ok(recusou instanceof PlanError, `colisao de runId tem de recusar com PlanError; veio: ${recusou}`);
  assert.match(recusou.message, /colidiu/);
  assert.match(recusou.message, /tente de novo/);
});

test('prepare cria worktree em branch propria e nao mexe no HEAD do usuario', () => {
  const repoDir = makeRepo();
  const headBefore = git(['rev-parse', 'HEAD'], repoDir);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
  const runDir = newRun();
  const { dir } = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: headBefore });
  assert.ok(dir.endsWith(join('worktrees', 'T-01')));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), branchName('r1', 'T-01'));
  assert.equal(git(['rev-parse', 'HEAD'], repoDir), headBefore);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), branch);
});

test('touchedFiles ve commit e ve trabalho nao commitado', () => {
  const repoDir = makeRepo();
  const base = git(['rev-parse', 'HEAD'], repoDir);
  const runDir = newRun();
  const { dir } = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: base });
  writeFileSync(join(dir, 'styles', 'header.css'), 'h { margin: 3px }\n');
  writeFileSync(join(dir, 'index.html'), '<h1>editado</h1>\n');
  git(['add', 'styles/header.css'], dir);
  git(['commit', '-q', '-m', 'worker'], dir);
  writeFileSync(join(dir, 'styles', 'novo.css'), '.x { padding: 8px }\n');
  const files = touchedFiles({ workDir: dir, baseSha: base }).map((f) => f.file).sort();
  assert.deepEqual(files, ['index.html', 'styles/header.css', 'styles/novo.css']);
});

test('touchedFiles ve os dois lados de um rename commitado', () => {
  const repoDir = makeRepo();
  const base = git(['rev-parse', 'HEAD'], repoDir);
  const runDir = newRun();
  const { dir } = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: base });
  git(['mv', 'styles/tokens.css', 'styles/design.css'], dir);
  git(['commit', '-q', '-m', 'rename'], dir);
  const files = touchedFiles({ workDir: dir, baseSha: base }).map((f) => f.file).sort();
  assert.deepEqual(files, ['styles/design.css', 'styles/tokens.css']);
});

// Um dos arquivos é commitado (o caminho vem de `diff --name-status`), o outro fica só na área de
// trabalho (vem de `status --porcelain`): as duas leituras que o git costuma citar com quotePath.
test('touchedFiles devolve caminho acentuado limpo e o lote declarado continua reconhecendo ele', () => {
  const repoDir = makeRepo();
  const base = git(['rev-parse', 'HEAD'], repoDir);
  const runDir = newRun();
  const { dir } = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: base });
  writeFileSync(join(dir, 'styles', 'página inicial.css'), '.p { margin: 0 }\n');
  git(['add', '.'], dir); git(['commit', '-q', '-m', 'worker'], dir);
  writeFileSync(join(dir, 'styles', 'rodapé.css'), '.r { padding: 0 }\n');
  const files = touchedFiles({ workDir: dir, baseSha: base }).map((f) => f.file).sort();
  assert.deepEqual(files, ['styles/página inicial.css', 'styles/rodapé.css']);
  assert.ok(files.every((f) => ownsFile(['styles'], f)), `lote 'styles' nao reconheceu ${files.join(', ')}`);
});

test('mergeInOrder integra duas branches disjuntas e detecta a colidida', () => {
  const repoDir = makeRepo();
  const base = git(['rev-parse', 'HEAD'], repoDir);
  const runDir = newRun();
  const a = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: base });
  const b = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-02', baseSha: base });
  writeFileSync(join(a.dir, 'styles', 'tokens.css'), ':root { --bg: oklch(0.9 0.02 250); }\n');
  git(['add', '.'], a.dir); git(['commit', '-q', '-m', 'a'], a.dir);
  mkdirSync(join(b.dir, 'components'), { recursive: true });
  writeFileSync(join(b.dir, 'components', 'x.css'), '.x { padding: 8px }\n');
  git(['add', '.'], b.dir); git(['commit', '-q', '-m', 'b'], b.dir);

  const integ = prepareIntegration({ repoDir, runDir, runId: 'r1', baseSha: base });
  const ok = mergeInOrder({ integrationDir: integ.dir, branches: [a.branch, b.branch] });
  assert.deepEqual(ok.conflicts, []);
  assert.equal(ok.merged.length, 2);

  const c = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-03', baseSha: base });
  writeFileSync(join(c.dir, 'index.html'), '<h1>de outro lado</h1>\n');
  git(['add', '.'], c.dir); git(['commit', '-q', '-m', 'c'], c.dir);
  writeFileSync(join(integ.dir, 'index.html'), '<h1>de um lado</h1>\n');
  git(['add', '.'], integ.dir); git(['commit', '-q', '-m', 'integ'], integ.dir);
  const colid = mergeInOrder({ integrationDir: integ.dir, branches: [c.branch] });
  assert.equal(colid.merged.length, 0);
  assert.deepEqual(colid.conflicts[0].files, ['index.html']);
  assert.equal(git(['status', '--porcelain'], integ.dir), '');
});

test('mergeInOrder nao inventa conflito quando o merge falha por outro motivo', () => {
  const repoDir = makeRepo();
  const base = git(['rev-parse', 'HEAD'], repoDir);
  const runDir = newRun();
  const integ = prepareIntegration({ repoDir, runDir, runId: 'r1', baseSha: base });
  assert.throws(
    () => mergeInOrder({ integrationDir: integ.dir, branches: ['swarm/r1/T-99'] }),
    /falhou sem colisao/);
  assert.equal(git(['status', '--porcelain'], integ.dir), '');
});

test('removeWorktree apaga o diretorio e faz prune', () => {
  const repoDir = makeRepo();
  const base = git(['rev-parse', 'HEAD'], repoDir);
  const runDir = newRun();
  const { dir } = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: base });
  removeWorktree({ repoDir, dir });
  assert.equal(existsSync(dir), false);
  assert.match(git(['worktree', 'list'], repoDir), /main/);
});

test('swarm inteiro trabalha sem mover HEAD nem sujar a arvore do usuario', () => {
  const repoDir = makeRepo();
  const headBefore = git(['rev-parse', 'HEAD'], repoDir);
  const branchBefore = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
  const runDir = newRun();
  const a = prepare({ repoDir, runDir, runId: 'r1', taskId: 'T-01', baseSha: headBefore });
  const integ = prepareIntegration({ repoDir, runDir, runId: 'r1', baseSha: headBefore });
  writeFileSync(join(a.dir, 'styles', 'tokens.css'), ':root { --bg: oklch(0.5 0.1 250); }\n');
  git(['add', '.'], a.dir); git(['commit', '-q', '-m', 'worker'], a.dir);
  mergeInOrder({ integrationDir: integ.dir, branches: [a.branch] });
  writeFileSync(join(integ.dir, 'index.html'), '<h1>na arvore de integracao</h1>\n');

  assert.equal(git(['rev-parse', 'HEAD'], repoDir), headBefore);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), branchBefore);
  assert.equal(git(['status', '--porcelain'], repoDir), '');
  assert.equal(readFileSync(join(repoDir, 'index.html'), 'utf8'), '<h1>base</h1>\n');
  assert.equal(existsSync(join(repoDir, 'worktrees')), false);
});
