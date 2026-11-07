# Dry run — libra (Task 13, spec §12 risco 1)

Run: `20261107-8699` · alvo: `O:/DEV/A JORNADA/PROJETOS/libra` · base `454e5c4` (main) · 2026-11-07
Orquestração: controlador em primeiro plano (sem background). Workers: `codex exec` 0.163.0,
modelo gpt-6.1-sol, sandbox workspace-write, prompt exato de `tasks/<id>/attempt-N/prompt.md` + linha do workDir.

## Tentativa 1 (20261106-fb0f) — falha medida, não nota de rodapé

O primeiro run falhou na onda 1: o worker T-02 reportou `## Blocked` honesto — o worktree prometido
não existia no workspace. Causa (bug B-1, reproduzido em repo temporário): `--run runs/<id>` relativo +
`git worktree add` com cwd no repo alvo (`lib/isolate.js`, `add()`) ⇒ worktree nascia DENTRO do libra.
Os 132 testes não pegaram porque todo setup usa workspace absoluto (`mkdtempSync`). O orquestrador
(de background, parado pelo humano por não ter sido pedido) abortou o run; libra ficou intacto.
Fix: `main()` normaliza `run/repo/workspace` na fronteira (commit c68ea51), teste e2e novo nasceu FAIL
e passa com o fix — 133/133. Esta tentativa entra na conta: 1 run abortado, 0 commits de worker,
1 bug de produto encontrado e corrigido antes da tentativa 2.

## Plano e ondas (tentativa 2)

`{"tasks":3,"waves":[["T-02"],["T-01","T-03"]]}` — lotes disjuntos por diretório, rotas com parênteses
`(frontend)/(marketing)` no Windows. Barragem C1 medida: `start T-01` antes do `integrate` recusou
com rc 2 (`depende de T-02 e nao esta liberada`). Depois do integrate da onda 1, os worktrees de
T-01/T-03 nasceram do head da integração e os workers LERAM o commit d5aaa1d de T-02 e usaram os
exports reais (T-01 inclusive notou que os nomes do report divergiam do commit e seguiu o commit).

## Os seis números

| Mede | Resultado |
|---|---|
| Violações de lote (`SCOPE-OUTSIDE-LOT`) | **0** em 4 gate.json (T-01 a1, T-02 a1/a2, T-03 a1) |
| Colisões de merge (`integrate.conflicts`) | **0** nas duas ondas (`merged: [T-02]` e `[T-01, T-03]`) |
| `## Blocked` por worker | **3 de 3** workers (todos os attempts finais): commit negado pelo sandbox (todos), tema/tokens fora do lote (T-02/T-01), sem node_modules p/ typecheck (todos), production.json ausente + inlang só en/zh (T-03) |
| Tempo de parede por onda | Onda 1: **8m39s** (19:59:49→20:08:28; inclui attempt 1 falho de 3m38s + retry de 4m25s + commit/gate do operador). Onda 2: **4m20s** (20:08:39→20:12:59, dois workers em paralelo) |
| Custo do worktree | **21 MB** medidos pós-integrate (3 worktrees de tarefa já removidos pelo integrate; `_integration` restante). Durante o run: 4 worktrees. `git worktree add` na ordem de segundos (starts T-01/T-03 com 4s de diferença, incluindo overhead do CLI) |
| Toolchain | `bun install` na integração: **550s, 1799 pacotes, rc 0**. Build: **641s, rc 1** (abaixo). Workers sem node_modules nos worktrees de tarefa: typecheck/build NÃO rodaram lá (sintaxe via Bun.Transpiler apenas) |

Build na integração: `bun run build` em apps/web levou **641s e falhou** — `Failed to collect page
data for /api/auth/[...all]`, rota que nenhum lote tocou; a worktree não tem `.env` real (só
`.env.example`), causa-raiz compatível com env ausente, não com o código do swarm (baseline sem os
lotes não rodado — seriam mais ~10 min de build). O `rc=0` impresso no log era o rc do `tail` no
pipe; o script saiu com exit code 1, registrado aqui para não mentir. O build estourou o teto de
600s do operador e o harness o moveu a background automaticamente — única execução fora do
primeiro plano, por escalonamento do harness, não por escolha.

## Achados de toolchain (o dente deste dry run)

1. **B-1 (produto, corrigido em c68ea51):** `--run` relativo criava worktree dentro do repo alvo.
2. **B-2 (sandbox do dispatcher, não do swarm):** o sandbox workspace-write do codex no Windows nega
   escrita no `.git` real mesmo com `--add-dir "libra/.git"` na lista de raízes graváveis:
   `Unable to create .../.git/worktrees/T-02/index.lock: Permission denied`. Sonda de controle:
   processo fora do sandbox cria arquivo no mesmo diretório sem erro ⇒ é o sandbox, não o filesystem.
   Workaround do operador: worker escreve os arquivos do lote e reporta; o operador commita por ele
   (commits marcados "commit pelo operador"); a gate valida o diff real contra o `- touched:` declarado.
   O protocolo de retry (1 por tarefa) foi gasto à toa no T-02 antes de a sonda provar que era ambiental.
3. **Operador, não produto:** `finish` sem `--attempt` lê o report do attempt 1 (default documentado).
   Um finish errado gerou findings contra o report velho; corrigido com `--attempt 2`. Candidato a
   menor na revisão final: `finish` poderia inferir o attempt running mais recente.
4. **Tokens sub-reportados:** ledger guarda o `- tokens:` que o worker jura (10500/6200/6200); o
   codex reporta uso real de 42.5k + 50.3k (T-02 a1/a2), 33.0k (T-01), 39.6k (T-03). A métrica de
   custo do M1 precisa vir do dispatcher, não do worker.

## Veredito do risco 1 — contenção ou toolchain?

**Toolchain.** A contenção que o M1 foi desenhado para evitar não apareceu: zero violações de lote,
zero colisões, onda 2 consumiu a onda 1 de verdade (exports reais, não adivinhação). O que custou foi
o ferramental: 550s de install por worktree fresca, workers sem typecheck/build no próprio lote,
sandbox do dispatcher bloqueando o commit (workaround do operador), e um build de integração que
estoura 10 minutos. Para site com 3 lotes disjuntos o swarm VALE como isolamento — mas o M2 precisa
tratar toolchain (install/cache compartilhado ou herdado) como parte do isolamento, não como detalhe,
e o dispatcher precisa conseguir commitar na branch do worker sem intervenção do operador.

Nada foi publicado: nenhum push, main do libra intacto em 454e5c4, branches `swarm/*` só locais.

## Limpeza (step 8) — mais um dente de Windows

`abort` derrubou as 3 tarefas e deletou as branches, mas `git worktree remove --force` da
`_integration` falhou com `Permission denied` ao apagar o diretório: nenhum processo órfão
(sonda Win32_Process), resíduo de atributo read-only em arquivos do `node_modules` instalado pelo
bun. O git desregistrou a worktree mas deixou o diretório; a remoção manual do resíduo fechou a
limpeza. Estado final verificado: `worktree list` só o checkout, `status --porcelain` vazio,
HEAD 454e5c4, zero branches `swarm/*`. Candidato a menor na revisão final: `removeWorktree` no
Windows precisa lidar com read-only de `node_modules` (ou o operador documenta o passo manual).