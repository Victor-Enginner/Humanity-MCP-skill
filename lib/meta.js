// lib/meta.js — run.json: o único registro de onde o run está trabalhando e qual era o base.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stamp } from './ledger.js';

export function initRun({ workspaceRoot, repoDir }) {
  // createdAt vem do stamp() do ledger: um único relógio no swarm, e o runId herda a data dele.
  const createdAt = stamp();
  const runId = `${createdAt.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 4)}`;
  const runDir = join(workspaceRoot, 'runs', runId);
  const baseSha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const meta = { runId, repoDir: repoDir.replaceAll('\\', '/'), baseSha, createdAt };
  // run.json mora dentro de runs/<runId>/, não na raiz do workspace: é esse caminho que o CLI
  // (Task 9) recebe como --run e que serve de âncora para worktrees, ledger e prompts.
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(meta, null, 2) + '\n');
  return { ...meta, runDir };
}

export function readRun(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
}
