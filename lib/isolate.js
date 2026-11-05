// lib/isolate.js — worktree por tarefa e integração em ordem: nada aqui toca o checkout do usuário.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Sem trim() no stdout: touchedFiles fatia `git status --porcelain` por posição (colunas XY),
// e aparar a saída inteira comeria o espaço à esquerda da primeira linha ('M index.html' virando
// caminho 'ndex.html'). Linhas vazias são descartadas já no split.
// stderr vai para pipe e só reaparece no erro do execFileSync: `worktree add` e `merge` escrevem
// progresso em stderr, e biblioteca nenhuma do swarm deve falar por cima do JSON do CLI (Task 9).
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export const branchName = (runId, taskId) => `swarm/${runId}/${taskId}`;
export const worktreePath = (runDir, taskId) => join(runDir, 'worktrees', taskId);
export const integrationPath = (runDir) => join(runDir, 'worktrees', '_integration');

// worktree add recusa pai inexistente, mas exige destino vazio: criamos só o diretório-mãe.
function add({ repoDir, dir, branch, baseSha }) {
  mkdirSync(join(dir, '..'), { recursive: true });
  git(['worktree', 'add', '-b', branch, dir, baseSha], repoDir);
}

export function prepare({ repoDir, runDir, runId, taskId, baseSha }) {
  const dir = worktreePath(runDir, taskId);
  const branch = branchName(runId, taskId);
  add({ repoDir, dir, branch, baseSha });
  return { dir, branch };
}

export function prepareIntegration({ repoDir, runDir, runId, baseSha }) {
  const dir = integrationPath(runDir);
  const branch = branchName(runId, 'integration');
  add({ repoDir, dir, branch, baseSha });
  return { dir, branch };
}

export function touchedFiles({ workDir, baseSha }) {
  const found = new Map();
  const lines = (args, cwd) => git(args, cwd).split(/\r?\n/).filter(Boolean);
  // -c core.quotePath=false nos dois comandos de caminho: com o valor padrão o git cita e escapa
  // em octal todo nome não-ASCII ('"styles/rodap\303\251.css"'), e o gate (Task 7) compararia esse
  // texto escapado contra o lote declarado no plano — nunca casaria, e um arquivo em português
  // dentro do próprio lote viraria SCOPE-OUTSIDE-LOT falso.
  for (const line of lines(['-c', 'core.quotePath=false', 'diff', '--name-status', baseSha, 'HEAD'], workDir)) {
    const [code, ...paths] = line.split('\t');
    // Em rename o git devolve origem E destino; os dois contam como tocados, senão um worker
    // poderia mover um arquivo para fora do lote e o gate (Task 7) só veria a origem.
    for (const file of paths) found.set(file, { status: code[0], file });
  }
  for (const line of lines(['-c', 'core.quotePath=false', 'status', '--porcelain'], workDir)) {
    const code = line.slice(0, 2);
    const status = code.includes('A') || code === '??' ? 'A' : code.trim()[0];
    // Em porcelain o caminho começa sempre no índice 3 (sem aparar: nome com espaço à esquerda
    // é caminho válido). 'R  old -> new' é uma linha só: os dois lados contam, mesma razão acima.
    for (const file of line.slice(3).split(' -> ')) {
      if (!found.has(file)) found.set(file, { status, file });
    }
  }
  return [...found.values()];
}

export function mergeInOrder({ integrationDir, branches }) {
  const merged = [], conflicts = [];
  for (const branch of branches) {
    try {
      git(['merge', '--no-edit', branch], integrationDir);
      merged.push(branch);
    } catch (err) {
      // Só há colisão de verdade se sobrou arquivo unmerged. `merge --abort` é melhor esforço:
      // quando o git falha antes de abrir MERGE_HEAD (identidade ausente no host, branch
      // inexistente), não existe o que abortar, e um conflito fantasma com `files: []`
      // mentiria ao operador que o lote foi disputado.
      const files = git(['diff', '--name-only', '--diff-filter=U'], integrationDir)
        .split(/\r?\n/).filter(Boolean);
      try {
        git(['merge', '--abort'], integrationDir);
      } catch {}
      if (!files.length) {
        throw new Error(`merge de ${branch} falhou sem colisao: ${String(err.stderr ?? err.message).trim()}`);
      }
      conflicts.push({ branch, files });
    }
  }
  return { merged, conflicts };
}

export function removeWorktree({ repoDir, dir }) {
  if (existsSync(dir)) git(['worktree', 'remove', '--force', dir], repoDir);
  git(['worktree', 'prune'], repoDir);
}
