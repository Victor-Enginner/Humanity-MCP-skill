// panel/watch.js — espectador dos worktrees: fs.watch + debounce + diff line-based → edit/delete.
// Só lê: nunca escreve no run nem no produto. `_integration` fica fora (spec §8: só estado).
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { toLines } from './public/core.js';

export const DEBOUNCE_MS = 150;
export const CAP_BYTES = 64 * 1024;

export function capBuffer(buf) {
  if (buf.subarray(0, 8192).includes(0)) return { binary: true, text: '', truncated: false };
  return { binary: false, text: buf.subarray(0, CAP_BYTES).toString('utf8'), truncated: buf.length > CAP_BYTES };
}

export function readCapped(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(CAP_BYTES + 1);
    const n = readSync(fd, buf, 0, CAP_BYTES + 1, 0);
    return capBuffer(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

// Prefixo/sufixo comum de linhas fica fora do evento. endLine < startLine = inserção pura
// (arquivo novo: startLine 1, endLine 0 — contrato §4).
export function diffLines(oldLines, newLines) {
  let p = 0;
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
  let s = 0;
  while (s < oldLines.length - p && s < newLines.length - p
    && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++;
  if (p === oldLines.length && p === newLines.length) return null;
  return { startLine: p + 1, endLine: oldLines.length - s, lines: newLines.slice(p, newLines.length - s) };
}

export function watchWorktrees({ runDir, repoDir, baseSha, baseTree, onEvent, debounceMs = DEBOUNCE_MS, useWatch = true }) {
  const root = join(runDir, 'worktrees');
  const seen = new Map();   // "task/file" → { task, file, text, binary }; text null = ausente
  const owners = new Map(); // file → { task, deleted? }
  const knownTasks = new Set();
  const timers = new Map();
  let watcher = null;

  const baseContent = (file) => {
    if (!baseTree.has(file)) return null;
    try {
      const buf = execFileSync('git', ['-C', repoDir, 'show', `${baseSha}:${file}`],
        { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      return capBuffer(buf);
    } catch { return null; }
  };

  function processFile(task, file, emit) {
    const key = `${task}/${file}`;
    let cur = null;
    const abs = join(root, task, file);
    try {
      if (statSync(abs).isFile()) cur = readCapped(abs);
    } catch { /* ausente */ }
    const prev = seen.get(key);
    if (cur === null) {
      const eraPresente = prev ? prev.text !== null : baseTree.has(file);
      if (eraPresente) {
        seen.set(key, { task, file, text: null, binary: false });
        owners.set(file, { task, deleted: true });
        if (emit) onEvent({ type: 'delete', task, file });
      }
      return;
    }
    if (cur.binary) {
      if (!prev || !prev.binary) {
        seen.set(key, { task, file, text: '', binary: true });
        owners.set(file, { task });
        if (emit) onEvent({ type: 'edit', task, file, startLine: 1, endLine: 0, lines: [] });
      }
      return;
    }
    const old = prev ? (prev.text ?? '') : (baseContent(file)?.text ?? '');
    const d = diffLines(toLines(old), toLines(cur.text));
    seen.set(key, { task, file, text: cur.text, binary: false });
    if (d === null) return;
    owners.set(file, { task });
    if (emit) onEvent({ type: 'edit', task, file, ...d });
  }

  function poke(task, file) {
    const key = `${task}/${file}`;
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); processFile(task, file, true); }, debounceMs));
  }

  // fs.watch no runDir (existe sempre), não no worktrees/ (pode não existir no boot).
  // Recursivo no Windows; eventos de status.tsv/gates caem no filtro e quem cuida é o ledger-watch.
  if (useWatch) {
    watcher = watch(runDir, { recursive: true }, (type, filename) => {
      if (!filename) return;
      const parts = String(filename).split(/[\\/]/);
      if (parts[0] !== 'worktrees' || parts.length < 3) return;
      const task = parts[1];
      if (task === '_integration' || task.startsWith('.')) return;
      const file = parts.slice(2).join('/');
      if (!file || file === '.git' || file.startsWith('.git/')) return;
      poke(task, file);
    });
    watcher.on('error', () => {}); // fs.watch perde evento no Windows: o rescan reconcilia
  }

  function walk(dir, prefix, out) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel, out);
      else if (e.isFile()) out.push(rel);
    }
  }

  function rescan(emit = true) {
    if (!existsSync(root)) return;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === '_integration' || e.name.startsWith('.')) continue;
      const task = e.name;
      const files = [];
      walk(join(root, task), '', files);
      const present = new Set(files);
      if (!knownTasks.has(task)) {
        knownTasks.add(task);
        for (const f of baseTree) if (!present.has(f)) processFile(task, f, emit);
      }
      for (const f of files) processFile(task, f, emit);
      for (const v of seen.values()) {
        if (v.task === task && v.text !== null && !present.has(v.file)) processFile(task, v.file, emit);
      }
    }
  }

  rescan(false); // boot silencioso: o /snapshot carrega o estado inicial; mudanças depois emitem

  return {
    owners,
    rescan: () => rescan(true),
    poke,
    close() {
      if (watcher) watcher.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}