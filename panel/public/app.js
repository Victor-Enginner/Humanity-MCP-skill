// panel/public/app.js — espectador: SSE → buffers por arquivo, cursor nomeado, faixa de ondas.
import { applyEdit, toLines } from './core.js';

const $ = (id) => document.getElementById(id);
const state = {
  tasks: new Map(), owners: {}, waves: [], gates: new Map(), tree: [],
  buffers: new Map(), open: null, follow: true, lastId: 0,
  lastEditAt: new Map(), revealJobs: [], display: [], cursorLine: 1,
};
window.__swarm = { state }; // seam de inspeção do Playwright (Task 5)
let openTicket = 0;

function buf(file) {
  if (!state.buffers.has(file)) {
    state.buffers.set(file, { lines: [], loaded: false, skipUntil: 0, binary: false, truncated: false });
  }
  return state.buffers.get(file);
}

async function openFile(file, pin = false) {
  if (pin) state.follow = false;
  state.open = file;
  state.revealJobs = [];
  const ticket = ++openTicket;
  const b = buf(file);
  const data = await (await fetch(`/file?path=${encodeURIComponent(file)}`)).json();
  if (ticket !== openTicket) return; // clique mais novo venceu
  b.lines = toLines(data.content);
  b.binary = data.binary;
  b.truncated = data.truncated;
  b.loaded = true;
  b.skipUntil = state.lastId; // eventos até aqui já estão no conteúdo lido
  state.display = b.lines.slice();
  state.cursorLine = 1;
  $('arquivo-path').textContent = file;
  renderTree(); renderViewer(); renderCursor(); renderMarcador();
}

function flushReveal() {
  for (const j of state.revealJobs) j.lines.forEach((t, k) => { state.display[j.at + k] = t; });
  state.revealJobs = [];
}

function enqueueReveal(ev) {
  flushReveal(); // display não pode ficar para trás de um novo edit
  const count = Math.max(0, ev.endLine - ev.startLine + 1);
  state.display.splice(ev.startLine - 1, count, ...ev.lines.map(() => ''));
  state.revealJobs.push({ at: ev.startLine - 1, lines: ev.lines, li: 0, ci: 0 });
  state.cursorLine = ev.startLine;
  renderViewer();
}

// ~30 chars/frame: tick de 33ms com budget de 30 chars (spec §5).
setInterval(() => {
  const j = state.revealJobs[0];
  if (!j) return;
  let budget = 30;
  while (budget > 0 && j.li < j.lines.length) {
    const line = j.lines[j.li];
    if (line.length === 0) { j.li++; continue; }
    const take = Math.min(budget, line.length - j.ci);
    j.ci += take;
    budget -= take;
    state.display[j.at + j.li] = line.slice(0, j.ci);
    state.cursorLine = j.at + j.li + 1;
    if (j.ci >= line.length) { j.li++; j.ci = 0; }
  }
  if (j.li >= j.lines.length) state.revealJobs.shift();
  renderViewer(); renderCursor();
}, 33);

function onEdit(ev) {
  state.lastEditAt.set(ev.task, Date.now());
  state.owners[ev.file] = { task: ev.task };
  if (!state.tree.includes(ev.file)) { state.tree.push(ev.file); state.tree.sort(); }
  const b = buf(ev.file);
  if (b.loaded && ev.id > b.skipUntil) b.lines = applyEdit(b.lines, ev);
  if (state.open === ev.file) {
    if (b.binary) renderMarcador();
    else enqueueReveal(ev);
    $('pensando').classList.add('oculto');
  } else if (state.follow) {
    openFile(ev.file);
    return;
  }
  renderTree(); renderCursor();
}

function renderViewer() {
  const pre = $('viewer');
  pre.innerHTML = '';
  state.display.forEach((text) => {
    const div = document.createElement('div');
    div.className = 'linha';
    div.textContent = text === '' ? ' ' : text;
    pre.appendChild(div);
  });
}

function renderCursor() {
  const el = $('cursor');
  const owner = state.open && state.owners[state.open]?.task;
  const task = owner && state.tasks.get(owner);
  $('dono').textContent = task ? `${task.id} · ${task.state}` : '';
  $('dono').style.color = task?.color || '';
  const ativo = task && ['running', 'reported', 'gated'].includes(task.state);
  if (!state.open || !owner || !ativo || buf(state.open).binary) {
    el.classList.add('oculto');
    return;
  }
  el.classList.remove('oculto');
  el.style.background = task.color;
  $('cursor-nome').textContent = task.id;
  $('cursor-nome').style.background = task.color;
  const lineEl = $('viewer').children[state.cursorLine - 1];
  el.style.top = `${lineEl ? lineEl.offsetTop : 0}px`;
}

function renderMarcador() {
  const el = $('marcador');
  const b = state.open && buf(state.open);
  const o = state.open && state.owners[state.open];
  let msg = '';
  if (o?.deleted) msg = '[arquivo removido]';
  else if (b?.binary) msg = '[binário — sem reveal]';
  else if (b?.truncated) msg = '[arquivo truncado em 64KB]';
  el.textContent = msg;
  el.classList.toggle('oculto', !msg);
}

function renderTree() {
  const ul = $('arvore');
  ul.innerHTML = '';
  for (const f of state.tree) {
    const li = document.createElement('li');
    li.className = 'arquivo' + (f === state.open ? ' aberto' : '');
    li.appendChild(document.createTextNode(f));
    const o = state.owners[f];
    if (o) {
      const badge = document.createElement('span');
      badge.className = 'dono-badge';
      badge.style.background = state.tasks.get(o.task)?.color || '#888';
      badge.textContent = o.deleted ? `${o.task} ✗` : o.task;
      li.appendChild(badge);
    }
    li.addEventListener('click', () => openFile(f, true));
    ul.appendChild(li);
  }
}

function renderFaixa() {
  const el = $('faixa');
  el.innerHTML = '';
  state.waves.forEach((w, i) => {
    const chip = document.createElement('span');
    chip.className = 'onda';
    chip.appendChild(document.createTextNode(`onda ${i + 1}: `));
    for (const id of w) {
      const t = state.tasks.get(id);
      const s = document.createElement('span');
      const est = t?.state || 'planned';
      s.className = `task-chip estado-${est}`;
      s.style.borderColor = t?.color || '#888';
      s.textContent = `${id} ${est === 'merged' ? 'merged ✓' : est}${t?.rc != null ? ` rc ${t.rc}` : ''}`;
      chip.appendChild(s);
    }
    const g = state.gates.get(i + 1);
    if (g) {
      const b = document.createElement('span');
      b.className = `gate-badge ${g.ok ? 'ok' : 'falhou'}`;
      b.textContent = g.timedOut ? `gate timeout rc ${g.rc}` : `gate ${g.ok ? '✓' : '✗'} rc ${g.rc ?? '—'}`;
      chip.appendChild(b);
    }
    el.appendChild(chip);
  });
}

// "pensando": >3s sem edit com a tarefa running (spec §5).
setInterval(() => {
  const owner = state.open && state.owners[state.open]?.task;
  const t = owner && state.tasks.get(owner);
  const pensando = t?.state === 'running' && Date.now() - (state.lastEditAt.get(owner) || 0) > 3000;
  $('pensando').classList.toggle('oculto', !pensando);
}, 500);

async function loadSnapshot() {
  const snap = await (await fetch('/snapshot')).json();
  state.tasks = new Map(snap.tasks.map((t) => [t.id, t]));
  state.owners = snap.edits;
  state.waves = snap.waves;
  state.tree = snap.tree;
  $('run-id').textContent = snap.runId;
  $('base-sha').textContent = snap.baseSha.slice(0, 7);
  renderTree(); renderFaixa();
}

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { $('conexao').textContent = 'ao vivo'; $('conexao').className = 'badge ok'; };
  es.onerror = () => { $('conexao').textContent = 'reconectando…'; $('conexao').className = 'badge falhou'; };
  const handle = (e) => {
    const ev = JSON.parse(e.data);
    state.lastId = Math.max(state.lastId, ev.id);
    return ev;
  };
  es.addEventListener('edit', (e) => onEdit(handle(e)));
  es.addEventListener('delete', (e) => {
    const ev = handle(e);
    state.owners[ev.file] = { task: ev.task, deleted: true };
    const b = buf(ev.file);
    b.lines = [];
    if (state.open === ev.file) { state.display = []; state.revealJobs = []; renderViewer(); renderMarcador(); }
    renderTree();
  });
  es.addEventListener('state', (e) => {
    const ev = handle(e);
    const t = state.tasks.get(ev.task) || { id: ev.task, color: '#888' };
    t.state = ev.state;
    t.rc = ev.rc;
    state.tasks.set(ev.task, t);
    renderFaixa(); renderCursor(); renderTree();
  });
  es.addEventListener('gate', (e) => { const ev = handle(e); state.gates.set(ev.wave, ev); renderFaixa(); });
  es.addEventListener('reset', async () => {
    state.buffers.clear();
    state.revealJobs = [];
    await loadSnapshot();
    if (state.open) await openFile(state.open);
  });
}

loadSnapshot().then(() => {
  connect();
  const dono = Object.keys(state.owners)[0];
  if (dono) openFile(dono);
  else if (state.tree[0]) openFile(state.tree[0]);
});