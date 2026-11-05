// lib/plan.js
import { scopeDir, setsOverlap } from './paths.js';

export class PlanError extends Error {}

const HEADING = /^## (T-\d{2,})\s+(.+)$/;
const FIELD = /^-\s+(paths|depends_on|verify):\s*(.*)$/;
const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

export function parsePlan(md) {
  const tasks = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(HEADING);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), dirs: [], dependsOn: [], verify: null };
      tasks.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = line.match(FIELD);
    if (!f) continue;
    const v = f[2].trim();
    if (f[1] === 'paths') cur.dirs = v === '-' ? [] : list(v).map(scopeDir);
    else if (f[1] === 'depends_on') cur.dependsOn = v === '-' ? [] : list(v);
    else cur.verify = v === '-' ? null : v;
  }
  if (!tasks.length) throw new PlanError('plano sem tarefas: use "## T-01 <titulo>"');
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) throw new PlanError('id de tarefa duplicado');
  for (const t of tasks) {
    if (!t.dirs.length) throw new PlanError(`${t.id}: campo paths vazio — declare o lote`);
    for (const d of t.dependsOn) if (!ids.has(d)) throw new PlanError(`${t.id}: depende de ${d}, que nao existe`);
  }
  return tasks;
}

export function computeWaves(tasks) {
  const placed = new Set();
  const waves = [];
  while (placed.size < tasks.length) {
    const ready = tasks.filter((t) => !placed.has(t.id) && t.dependsOn.every((d) => placed.has(d)));
    if (!ready.length) {
      throw new PlanError(`ciclo de dependencia: ${tasks.filter((t) => !placed.has(t.id)).map((t) => t.id).join(', ')}`);
    }
    waves.push(ready);
    for (const t of ready) placed.add(t.id);
  }
  return waves;
}

export function validateWaves(waves) {
  const problems = [];
  waves.forEach((wave, i) => {
    for (let a = 0; a < wave.length; a++) {
      for (let b = a + 1; b < wave.length; b++) {
        const hits = setsOverlap(wave[a].dirs, wave[b].dirs);
        if (hits) problems.push(`onda ${i + 1}: ${wave[a].id} e ${wave[b].id} disputam ${hits.join(', ')}`);
      }
    }
    if (wave.length > 1 && wave.some((t) => t.dirs.includes('.'))) {
      problems.push(`onda ${i + 1}: quem declara o lote raiz ('.') precisa de onda sozinho`);
    }
  });
  if (problems.length) throw new PlanError(problems.join(' | '));
}

const CONCLUIDA = new Set(['gated', 'merged']);

// Só libera tarefa ainda `planned`: tarefa falha ou em curso precisa de tentativa
// nova aberta pelo operador (`start --attempt N`), não de liberação automática.
export function nextWave(tasks, states) {
  const state = (id) => states.get(id) ?? 'planned';
  return tasks.filter((t) =>
    state(t.id) === 'planned' && t.dependsOn.every((d) => CONCLUIDA.has(state(d))));
}
