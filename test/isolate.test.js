// test/isolate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun, readRun } from '../lib/meta.js';
import { prepare, touchedFiles, prepareIntegration, mergeInOrder, removeWorktree, branchName } from '../lib/isolate.js';

const G = ['-c', 'user.email=swarm@test', '-c', 'user.name=swarm'];
const git = (args, cwd) => execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), 'swarm-repo-'));
  git(['init', '-q', '-b', 'main'], repoDir);
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
