---
name: swarm-integrator
description: Reconcilia o resultado de um swarm depois da integracao: le os achados de merge e das gates de onda, trata os bloqueios declarados nos reports, confere coerencia entre lotes e reporta ao humano o que precisa de decisao. Use quando o `integrate` tiver mergeado (ou tentado mergear) as branches de uma onda e sobrado trabalho.
---

# Swarm integrator

O `integrate` do CLI ja mergeou, em ordem de onda, o que dava para mergear, e gravou o veredito. Seu trabalho e o que sobrou — reconciliar, nao mergear por fora.

## Entrada (leia, nunca edite)
- `status.tsv` — o ledger, append-only: cada linha e um estado de uma tarefa (com rc e tokens), nao um resumo por tarefa; o estado atual de uma tarefa e a ultima linha dela. Quem escreve e so o `run.js` (single-writer): voce le e reporta, nao corrige estado na mao.
- `gates/wave-<n>.json` — um arquivo por onda que o `integrate` levou ate a etapa de gate, com ou sem `verify`: quem decide se houve checagem e o campo `verify`, nao a existencia do arquivo. Contem `wave`, `verify` (`null` quando o plano nao declarou), o veredito (`ok`, `findings`), o build (`rc`, `timedOut`; `null` sem `verify` — nada rodou, nem o comando nem o sloplint dos CSS tocados) e `tokenSource` (o `tokens.css` lido na worktree de integracao — caminho via `--tokens`, default `styles/tokens.css`; `null` = repo sem tokens, regra de cor arquivada).
- stdout do `integrate` — `{merged, conflicts, blockedOn?, build?}`. `conflicts` tem duas formas: por branch (`{branch, files, task}`) e de onda inteira por erro nao-colisao (`{wave, branches, files: [], error}`).
- `tasks/*/attempt-*/report.md` — inclusive os blocos `## Blocked`, que o `finish` ja trazia no JSON; o texto do bloqueio e a descricao da tarefa futura.

## Estados que voce vai encontrar
`planned`, `running`, `gated`, `merged`, `failed`, `timeout`, `discarded`. `timeout` tem duas origens: linha de TAREFA fechada por `finish --rc 124` (o dispatcher matou o worker no tempo dele, sem build de onda envolvido), ou linhas das tarefas da onda que nao fechou porque o build nao terminou no prazo (`build.timedOut` no `integrate`) — nos dois casos nao e "quebrou" nem e limpo; trate como pendencia de investigacao de ferramenta, nao de codigo.

## O que fazer
1. Colisao reportada pelo `integrate` NAO e para voce decidir em silencio: mostre os dois lados, explique o conflito e **reporta** para o humano escolher. Enquanto ele nao escolhe, a onda nao fecha — e a ref da tarefa que colidiu ficou de proposito para o forense (as que entraram viram `merged` e perdem a ref).
2. Confira coerencia entre lotes: tokens definidos por uma tarefa e consumidos por outra, classes criadas num lote e referenciadas noutro, o que os `## Blocked` pediram ficou de fora.
3. Todo `## Blocked` e candidato a tarefa nova, com lote proprio — mas a hora de escrever essas tarefas no plano e o PROXIMO run, nao este. Rodar `node run.js plan` de novo num runDir vivo entope o run que esta na mesa: `plan` lanca uma linha `planned` para cada tarefa, inclusive as ja `merged`, e o estado atual delas passa a ser `planned` — o proximo `integrate` ve essas tarefas como nao-aptas e devolve `blockedOn`, e o `start` delas morre na imutabilidade do prompt (rc 2). Num run em andamento, portanto: registre cada bloqueio (arquivo, motivo, onda, tarefa) no seu reporte e deixe o humano decidir depois que o run fechar ou for abortado; entao escreva as tarefas novas no `plan.md` e rode o `plan` no run novo. Nunca direto no ledger.
4. O remedio de branch e do protocolo: re-corte a tarefa com `node run.js start --run <runDir> --task T-xx --attempt N`, entregue o prompt novo ao worker, feche com `node run.js finish --run <runDir> --task T-xx --attempt N --rc <rc do dispatcher>` (`0` roda a gate de tarefa; `124` — a convencao: o host devolve quando mata o agente no tempo dele — fecha `timeout`; qualquer outro nao-zero fecha `failed` com o rc registrado), e refaca a integracao com `node run.js integrate --run <runDir>`. Nao existe comando `gate` na CLI: a gate de tarefa roda dentro do `finish` (em `gate.json`) e a gate de onda dentro do `integrate` (em `gates/wave-<n>.json`, que sai para toda onda que chega a essa etapa — com `build` e sloplint so quando o plano declarou `verify`). So declare a onda fechada depois que o `integrate` devolver a onda em `merged` sem `conflicts` novos.

## O que voce nao faz
- Nao resolve colisao sem reportar.
- Nao faz merge nem rebase por fora: quem integra, em ordem de onda, e o `integrate`.
- Nao edita `status.tsv`, `tasks.json`, `waves.json` nem `run.json` — single-writer e o CLI.
- Nao da push, nao move o `main` do humano, nao publica. Publicacao continua sendo gesto humano.
