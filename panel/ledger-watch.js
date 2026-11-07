// panel/ledger-watch.js — leitor do ledger M1: append no status.tsv → state; gates/wave-N.json → gate.
// Poll, não fs.watch: o ledger é append-only e o poll de 250ms cumpre o ≤1s da spec com folga.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rows } from '../lib/ledger.js';

export function watchLedger({ runDir, onEvent, pollMs = 250 }) {
  let lineCount = 0;
  try { lineCount = rows(runDir).length; } catch { /* sem ledger ainda */ }
  const gatesSeen = new Map(); // wave → mtimeMs já emitido
  const gdir = join(runDir, 'gates');

  function poll() {
    try {
      const rs = rows(runDir);
      if (rs.length > lineCount) {
        const fresh = rs.slice(lineCount);
        lineCount = rs.length;
        for (const r of fresh) {
          onEvent({ type: 'state', task: r.task, state: r.state, rc: r.rc === '' ? null : Number(r.rc) });
        }
      }
    } catch { /* ledger ainda não existe */ }
    if (!existsSync(gdir)) return;
    for (const name of readdirSync(gdir)) {
      const m = /^wave-(\d+)\.json$/.exec(name);
      if (!m) continue;
      const p = join(gdir, name);
      let mt;
      try { mt = statSync(p).mtimeMs; } catch { continue; }
      if (gatesSeen.get(m[1]) === mt) continue;
      let g;
      try { g = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; } // escrita parcial: próximo poll
      gatesSeen.set(m[1], mt);
      onEvent({ type: 'gate', wave: g.wave, ok: g.ok === true, rc: g.build ? g.build.rc : null, timedOut: g.build?.timedOut === true });
    }
  }

  poll(); // gates já existentes viram evento (cliente novo recebe via replay do ring buffer)
  const timer = setInterval(poll, pollMs);
  return { poll, close() { clearInterval(timer); } };
}