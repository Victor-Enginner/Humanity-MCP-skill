# SWARM cursors — painel espectador do run em tempo real (M3)

**Data:** 2026-11-07
**Status:** design aprovado em sessão (abordagem A + seções 1 e 2), spec escrita para review
**Local do projeto:** `O:\DEV\A JORNADA\tools\SWARM` — adição pura em `panel/`; o M1 não muda uma linha

---

## 1. O que é

Um site local onde o usuário VÊ o swarm construir código em tempo real: árvore de arquivos do
run, editor com cursores coloridos e nomeados (T-01, T-02, T-03) revelando o texto conforme os
workers escrevem, e a faixa de estado das ondas/gates do M1. Os cursores são renderizados no
painel (estilo multiplayer IDE), não o mouse do Windows — é o que os demos tipo swarm.build
fazem de verdade.

O trabalho por baixo é 100% o M1 real: workers codex em worktrees, lotes, gates, ledger,
integração. O painel é **espectador**: só lê, nunca escreve no run nem no produto. O cursor é a
visualização fiel do stream de writes — quando o agente pensa, o cursor mostra "pensando";
quando escreve, o texto aparece no arquivo dele. Não é encenação de keystroke nem replay.

### Tese

O M1 provou que o isolamento funciona (0 violações, 0 colisões nos dois dry runs) mas é
invisível: o usuário acompanha por ledger e reports. O painel fecha o buraco entre "o swarm
trabalha" e "eu vejo o swarm trabalhando" — sem tocar no que já foi provado.

## 2. Decisões tomadas (e por quê)

| # | Decisão | Motivo |
|---|---|---|
| C1 | Abordagem A: espectador do run real, não editor-runtime nem replay | Workers/gates do M1 intactos; cursor live sem refazer tool use, sandbox e commits |
| C2 | **SSE**, não WebSocket | Painel read-only ⇒ fluxo só servidor→cliente; SSE é HTTP puro na stdlib, reconexão com `Last-Event-ID` grátis no browser |
| C3 | Visualizador de código próprio, read-only (`<pre>` + overlays) | Monaco/CodeMirror são deps pesadas para quem não edita; zero-deps do M1 preservado |
| C4 | Bind só em `127.0.0.1`, porta default 4180 (`--port` opcional) | O stream carrega código do produto; nada sai da máquina, sem auth para localhost |
| C5 | Um painel por run | Multi-run é complexidade sem caso de uso hoje |
| C6 | Cursor por arquivo, dono = lote da tarefa | Lotes são disjuntos por onda: dois cursores no mesmo arquivo é impossível por construção; o modelo honesto é um cursor por arquivo, não N cursores no mesmo texto |
| C7 | Árvore vem de `git ls-tree -r <baseSha>` | Só tracked files — node_modules/binários ignorados ficam fora de graça, sem depender do estado do checkout |
| C8 | Servidor só aceita GET; qualquer outro método → 405 | Espectador por construção, não por convenção |
| C9 | Zero dependências novas (Node 24 stdlib, ESM) | Mesma constraint do M1; máquina emprestada não instala nada |
| C10 |Usuário inicia o servidor (`node panel/server.js --run runs/<id>`); nada de daemon | Regra da casa: nada roda em background sem pedido explícito |

## 3. Componentes

| Unidade | Responsabilidade | Depende de |
|---|---|---|
| `panel/watch.js` | `fs.watch` recursivo em `worktrees/` → debounce 150ms por arquivo → diff line-based contra snapshot → evento `edit` | fs, paths do run |
| `panel/ledger-watch.js` | observa `status.tsv` (append) e `gates/*.json` → eventos `state` e `gate` | formato do ledger M1 (só leitura) |
| `panel/server.js` | estáticos + `GET /snapshot` + `GET /file` + `GET /events` (SSE, ring buffer 500) + orquestra watchers + rescan 2s | watch, ledger-watch, http |
| `panel/public/index.html`, `app.js`, `style.css` | árvore com badge do dono, viewer com cursor nomeado, faixa das ondas/gates | contrato de eventos (§4) |

Cada unidade é testável sozinha; o contrato de eventos é o único ponto de congelamento entre
servidor e frontend.

## 4. Contrato de eventos (congelado)

**`GET /snapshot`** → estado inicial completo:
```json
{
  "runId": "20261107-8079", "baseSha": "eda56e2…",
  "tasks": [{"id": "T-01", "state": "running", "rc": null, "color": "#4f9cf9"}],
  "waves": [["T-01", "T-03"], ["T-02"]],
  "tree": ["backend/adapters/base.py", "config/sources.json"],
  "edits": {"config/sources.json": {"task": "T-03"}}
}
```
`tree` = `git ls-tree -r --name-only <baseSha>` ∪ arquivos novos criados nos worktrees.
`edits` = quem tocou o quê (dono atual de cada arquivo; `deleted: true` quando removido).
Cores: paleta fixa por ordem de task — T-01 azul `#4f9cf9`, T-02 verde `#3fb56b`, T-03 laranja
`#e8a33d` (o M1 tem teto de 3 workers, D9 da spec original).

**`GET /file?path=<rel>`** → `{task, content, truncated, binary}` — conteúdo lido do worktree
do dono atual; sem dono, do base (`git show <baseSha>:<path>`). Texto corta em 64KB com
`truncated: true`; binário (null byte nos primeiros 8KB) vem `binary: true, content: ""`.
`path` é validado: relativo, sem `..`, e presente na tree do snapshot — fora disso → 400
(nada de path traversal para fora do run).

**`GET /events`** (SSE) — cada evento tem `id` inteiro crescente (por processo do servidor):
- `edit`: `{id, type, task, file, startLine, endLine, lines}` — substitui as linhas
  `startLine..endLine` (1-based, inclusivo) por `lines` (array de strings). Diff line-based:
  prefixo/sufixo comum de linhas fica fora do evento; write sem contexto comum vira evento de
  arquivo inteiro (cap 64KB). Arquivo novo: `startLine: 1, endLine: 0` (inserção pura).
  Cursor vai para `startLine` e revela `lines` progressivamente.
- `delete`: `{id, type, task, file}` — arquivo removido no worktree; viewer mostra "arquivo
  removido", árvore mantém o caminho com badge de deletado.
- `state`: `{id, type, task, state, rc}` — última linha da tarefa no `status.tsv`.
- `gate`: `{id, type, wave, ok, rc, timedOut}` — `gates/wave-N.json` escrito.
- `reset`: `{id, type}` — cliente rebusca `/snapshot` e redenha (gap fora do ring buffer).

Reconnect: browser reenvia `Last-Event-ID`; servidor reenvia do ring buffer (500 eventos);
id pedido fora do buffer → `reset`.

## 5. Fluxo de dados

1. Worker escreve arquivo no worktree (write de ferramenta, como no M1).
2. `fs.watch` → debounce 150ms → lê + diffa contra snapshot → evento `edit`.
3. Cliente move o cursor da tarefa até `startLine` e revela `lines` a ~30 chars/frame; sem
   edit por >3s com a tarefa `running`, o cursor ganha badge "pensando".
4. `status.tsv` append → `state` → faixa das ondas; `gates/wave-N.json` → `gate` → badge
   verde/vermelho com rc.
5. `integrate` remove o worktree → watcher detecta → estado `merged` vem do ledger → cursor
   da tarefa vira "merged ✓" e some do editor; árvore mantém os arquivos com badge do dono.

**Editor:** um arquivo aberto por vez. Default = follow (abre o arquivo do último edit);
clicar num arquivo pina e desliga o follow. Cursores de tarefas em outros arquivos aparecem
como badge na árvore, não no texto fechado.

## 6. Error handling

| Falha | Resposta |
|---|---|
| `fs.watch` perde evento (Windows) | rescan de reconciliação a cada 2s: stat walk, mismatch → relê + diffa + emite. Stream nunca fica silenciosamente errado |
| Cliente cai e volta | `Last-Event-ID` + ring buffer 500; gap fora do buffer → `reset` → `/snapshot` |
| Run inexistente/inválido | servidor recusa no boot com mensagem clara, rc 2 (padrão do CLI) |
| Arquivo >64KB | `truncated: true`, marcador `[arquivo truncado]` no viewer |
| Binário | `binary: true` — cursor vai ao arquivo mas não revela texto |
| Worktree removido mid-run | evento de estado (merged/failed) vem do ledger; watcher para de observar o dir sem erro |
| Método não-GET | 405 — painel não tem superfície de escrita |
| Servidor cai | run não sente nada (watchers são só leitura); cliente tenta reconnect e cai em `reset` |

## 7. Testes

Mesmo padrão do M1: `node --test "test/"*.test.js`, hermético (mkdtemp), comportamento real.

- `test/panel-watch.test.js`: writes reais → evento com linhas corretas; rajada vira um evento
  (debounce); rescan pega evento perdido (watch suprimido no teste); truncamento; binário;
  remoção de arquivo → `delete`; worktree removido não quebra.
- `test/panel-ledger-watch.test.js`: append real no `status.tsv` + escrita de `wave-N.json` →
  eventos `state`/`gate` na ordem, rc fiel.
- `test/panel-server.test.js`: servidor real em porta efêmera + cliente SSE via fetch → edit
  chega na ordem; reconnect com `Last-Event-ID` recebe o gap; id velho → `reset`; POST → 405;
  `/file` lê do dono e do base; run inválido → rc 2.
- Contrato §4 é prendado por teste (schema dos 5 tipos de evento + snapshot).
- **Verificação visual obrigatória antes de declarar pronto:** Playwright headed no golden
  path (run fake com 2 tasks escrevendo → 2 cursores nomeados visíveis revelando texto) e nos
  edges (reconnect, binário, worktree removido, gate vermelha). Sem isso, não está pronto.

Suíte do M1 (135) continua verde — `panel/` é adição, nenhum arquivo do M1 muda.

## 8. Escopo

**Dentro:** espectador de um run; árvore + viewer + cursores + faixa de ondas/gates; SSE com
replay; rescan; testes acima; verificação visual.

**Fora (YAGNI):** editar pelo painel; disparar/abortar run pelo painel; multi-run; auth;
syntax highlighting; cursor de SO/desktop; modo replay; daemon/service; visualizar o
`_integration` como texto (só estado); qualquer mudança no M1.

## 9. Critérios de sucesso (mensuráveis)

1. Run fake com 2 tasks escrevendo → painel mostra 2 cursores nomeados/coloridos revelando o
   texto na posição certa, ≤1s após o write.
2. Gate de onda vermelha → badge vermelho com rc; worktree integrado → cursor vira "merged ✓".
3. Reconnect do cliente não perde evento (gap replay) ou reconstrói via `reset`.
4. 135 testes do M1 + testes novos do painel verdes; nenhum arquivo do M1 modificado.
5. Verificação visual Playwright headed do golden path e dos edges registrada antes do pronto.
6. Servidor recusa não-GET (405) e binda só 127.0.0.1 — verificado por teste.