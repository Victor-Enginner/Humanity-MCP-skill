---
name: swarm-orchestrator
description: Planeja e conduz um swarm de ate 3 agentes editando um mesmo repositorio em worktrees isolados. Use quando a tarefa for dividir a construcao de um site ou de um codigo entre agentes simultaneos com integracao controlada por ondas, e voce for o host que dispatcha os subagentes.
---

# Swarm orchestrator

Voce e o orquestrador. Voce NUNCA edita o produto: voce planeja, starta, le o ledger e integra. O dispatcher e voce; o dono do estado e o `run.js`.

## single-writer — a regra de concorrencia numero um

O unico escritor do estado do run e o CLI: `run.js` escreve `tasks.json`/`waves.json` (no `plan`), o ledger `status.tsv`, `run.json`, os prompts, os `gate.json` e os `gates/wave-<n>.json`. Voce nao edita nenhum desses arquivos por fora, e nunca pede ao host que os edite: se o estado esta errado, a correcao passa por um comando ou por um `plan.md` novo rodado de novo. O `plan.md` que voce escreve e entrada do `plan`, nao estado do run.

## Ciclo

1. `node run.js init --repo <repo> --workspace <dir>` — imprime o JSON do run (`runId`, `runDir`, `baseSha`, `repoDir`). Guarde o `runDir`: e ele que passa em `--run` em todo comando seguinte. Recusa com rc 2 se o git do humano nao tem `user.email` — o merge de producao exige a identidade dele.
2. Escreva o `plan.md`. Cada tarefa e uma secao `## T-NN <titulo>` com os campos `- paths:` (o lote), `- depends_on:` e `- verify:`; a prosa depois dos campos e a especificacao da tarefa e vai inteira para o prompt do worker. Sintaxe do lote: um diretorio SEMPRE com `/**` no fim (`backend/adapters/**`). Sem o wildcard, `scopeDir` corta o caminho literal no pai e a tarefa passa a possuir um nivel acima do que voce declarou; um nome solto (`config`) vira a raiz. Uma secao `## ` que nao seja tarefa faz o plano ser recusado com rc 2.
3. `node run.js plan --run <runDir> --file plan.md` — valida, grava `tasks.json`/`waves.json`, lanca `planned` no ledger e imprime `{tasks, waves}`. Lote disputado na mesma onda recusa o plano (rc 2).
4. Para cada onda, no maximo 3 tarefas em paralelo: `node run.js start --run <runDir> --task T-xx` — prepara o worktree, grava o prompt em `tasks/<id>/attempt-N/prompt.md` e imprime `{task, workDir, branch, prompt, attempt}`. Entregue esse prompt a um subagente cujo unico trabalho e operar naquele `workDir`. Flag opcional: `--theme <nome>` (default `neutro-editorial`).
5. Quando o worker terminar: `node run.js finish --run <runDir> --task T-xx --attempt N --rc <0|1>`. O `--attempt` e o que o `start` devolveu — omite-lo faz o CLI ler o report do attempt 1 e julgar o lote errado. Flag opcional `--tokens <caminho>`: onde fica o `tokens.css` no worktree da tarefa (default `styles/tokens.css`); e dele que a gate de cor puxa os valores. Saem JSON na stdout (`ok`, `findings`, `blocked`, `touched`) com exit code 0: veredito de gate e dados, nao erro; quem lanca excecao e erro de CLI (`PlanError` sai rc 2, outro erro rc 1). Um achado `SCOPE-OUTSIDE-LOT` ai significa que o agente atravessou a fronteira do lote: a branch dele NAO entra na integracao. Relance com prompt revisado (`start --attempt 2`), nao edite o worktree voce mesmo.
6. Onda toda `gated` (ou `merged`) -> `node run.js integrate --run <runDir>` — mergeia as branches em ordem de onda, roda a gate da onda quando o plano declarou `verify`, grava `gates/wave-<n>.json` e imprime `{merged, conflicts, blockedOn?, build?}` (mesma flag `--tokens` da gate de tarefa, agora lida na worktree de integracao). `conflicts` tem duas formas de entrada (por branch, com `files`, e a forma de onda inteira com `error`): conheca as duas. Estado `timeout` numa linha do ledger significa build de onda que nao terminou no prazo — onda nao fechada, nao "quebrou".
7. So depois do `integrate` da onda N e voce abre a onda N+1: `start` recusa com rc 2 qualquer tarefa cuja dependencia ainda nao esta `merged` ("rode integrate primeiro"). O codigo das dependencias ja esta no worktree da onda seguinte — o CLI corta worktree de onda > 1 do head da integracao. Voce nao carrega dependencia em nada: o corte e do CLI.
8. `node run.js status --run <runDir>` antes de decidir a proxima onda (uma linha legivel por tarefa, com estado e tokens; pode sair tambem JSON `{crashed: [...]}` para tarefa `running` cujo processo nao vive mais — o M1 nao grava pid no ledger, entao hoje essa linha nao dispara: leia as linhas). Para descartar o run: `node run.js abort --run <runDir>` (remove worktrees e apaga as refs `swarm/*` que o CLI criou).

## Regras que nao se negociam

- Um lote por tarefa. Sem dois donos para o mesmo diretorio na mesma onda — o plano e recusado antes de qualquer worktree nascer.
- Onda seguinte so abre depois de fechar a atual: termine TODAS as tarefas da onda N, rode `integrate`, e somente entao `start` as da onda N+1.
- Retry e `start --attempt N` (re-corta worktree e ref da tarefa `failed`/`timeout` e escreve prompt novo ao lado do velho). Prompt e imutavel por attempt: repetir o `start` do mesmo attempt da rc 2 por proposito.
- Tarefa desconhecida no plano: rc 2. Worker `blocked` vira tarefa nova na onda seguinte, com lote proprio — nao e favor agora.
- Voce nao integra a mao, nao da push, nao move o `main` do humano e nao corrige o worker por fora: quem integra e o CLI, e a publicacao continua sendo gesto humano.
