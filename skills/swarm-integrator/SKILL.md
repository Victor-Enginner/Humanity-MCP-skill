---
name: swarm-integrator
description: Reconcilia o resultado de um swarm depois da integracao: le os achados de merge e das gates de onda, trata os bloqueios declarados nos reports, confere coerencia entre lotes e reporta ao humano o que precisa de decisao. Use quando o `integrate` tiver mergeado (ou tentado mergear) as branches de uma onda e sobrado trabalho.
---

# Swarm integrator

O `integrate` do CLI ja mergeou, em ordem de onda, o que dava para mergear, e gravou o veredito. Seu trabalho e o que sobrou — reconciliar, nao mergear por fora.

## Entrada (leia, nunca edite)
- `status.tsv` — o ledger; cada linha diz estado e rc por tarefa. Quem escreve e so o `run.js` (single-writer): voce le e reporta, nao corrige estado na mao.
- `gates/wave-<n>.json` — gerados pelo `integrate` por onda declarada no plano com `verify`: build (`rc`, `timedOut`), achados de sloplint na integracao e `tokenSource`.
- stdout do `integrate` — `{merged, conflicts, blockedOn?, build?}`. `conflicts` tem duas formas: por branch (`{branch, files, task}`) e de onda inteira por erro nao-colisao (`{wave, branches, files: [], error}`).
- `tasks/*/attempt-*/report.md` — inclusive os blocos `## Blocked`, que o `finish` ja trazia no JSON; o texto do bloqueio e a descricao da tarefa futura.

## Estados que voce vai encontrar
`planned`, `running`, `gated`, `merged`, `failed`, `timeout`, `discarded`. `timeout` e onda que nao fechou porque o build nao terminou no prazo — nao e "quebrou" nem e limpo; trate como onda pendente de investigacao de ferramenta, nao de codigo.

## O que fazer
1. Colisao reportada pelo `integrate` NAO e para voce decidir em silencio: mostre os dois lados, explique o conflito e **reporta** para o humano escolher. Enquanto ele nao escolhe, a onda nao fecha — e a ref da tarefa que colidiu ficou de proposito para o forense (as que entraram viram `merged` e perdem a ref).
2. Confira coerencia entre lotes: tokens definidos por uma tarefa e consumidos por outra, classes criadas num lote e referenciadas noutro, o que os `## Blocked` pediram ficou de fora.
3. Todo `## Blocked` vira proposta de tarefa nova na onda seguinte, com lote proprio — escrita no `plan.md` e rodade de novo pelo `plan`, nunca direto no ledger.
4. O remedio de branch e do protocolo: re-corte a tarefa com `node run.js start --run <runDir> --task T-xx --attempt N`, entregue o prompt novo ao worker, feche com `node run.js finish --run <runDir> --task T-xx --attempt N --rc <0|1>`, e refaca a integracao com `node run.js integrate --run <runDir>`. Nao existe comando `gate` na CLI: a gate de tarefa roda dentro do `finish` (em `gate.json`) e a gate de onda dentro do `integrate` (em `gates/wave-<n>.json`). So declare a onda fechada depois que o `integrate` devolver a onda em `merged` sem `conflicts` novos.

## O que voce nao faz
- Nao resolve colisao sem reportar.
- Nao faz merge nem rebase por fora: quem integra, em ordem de onda, e o `integrate`.
- Nao edita `status.tsv`, `tasks.json`, `waves.json` nem `run.json` — single-writer e o CLI.
- Nao da push, nao move o `main` do humano, nao publica. Publicacao continua sendo gesto humano.
