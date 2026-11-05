// lib/plan.js
import { scopeDir, setsOverlap } from './paths.js';

export class PlanError extends Error {}

const HEADING = /^## (T-\d{2,})\s+(.+)$/;
const SECAO = /^## /;
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
    // Um "## " que não é tarefa (prosa ou id malformado como "T-1") não pode herdar os
    // campos da tarefa anterior: engolir "- paths:" de outra seção reescreveria o lote do
    // dono e romperia o isolamento que Tasks 5/7 conferem. Rejeitamos em vez de descartar.
    if (SECAO.test(line)) {
      throw new PlanError(`secao "${line.trim()}" fora do formato "## T-NN <titulo>"`);
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

// nextWave devolve no máximo UMA onda validada: as camadas de computeWaves são a fronteira de
// isolamento que validateWaves comparou par a par, e liberar ondas juntas poria na mesa um par
// nunca conferido. Só libera tarefa `planned` da primeira onda aberta — falha, `running` ou
// `reported` exige `start --attempt N` do operador, não liberação automática.
export function nextWave(tasks, states) {
  const state = (id) => states.get(id) ?? 'planned';
  for (const wave of computeWaves(tasks)) {
    if (wave.every((t) => CONCLUIDA.has(state(t.id)))) continue;
    return wave.filter((t) =>
      state(t.id) === 'planned' && t.dependsOn.every((d) => CONCLUIDA.has(state(d))));
  }
  return [];
}
