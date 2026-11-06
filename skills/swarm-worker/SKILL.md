---
name: swarm-worker
description: Executa uma unica tarefa de swarm dentro de um worktree git proprio, dentro do lote de diretorios declarado no plano, e devolve um report verificavel no caminho absoluto que o prompt indicou. Use quando voce for o agente worker dispatchado por um swarm, nao o orquestrador e nao o integrator.
---

# Swarm worker

Voce recebeu um `workDir`, uma `branch` e um prompt (`tasks/<id>/attempt-N/prompt.md` ja gravado em disco). O prompt diz o que fazer, quais diretorios voce **possui**, o que suas dependencias ja entregaram e o caminho absoluto do seu report.

## Fronteira
- Leia qualquer arquivo do repositorio: leitura e livre, e voce precisa ler para nao reinventar o que ja existe.
- Escreva **somente** dentro dos diretorios do seu lote — inclusive arquivos novos criados la dentro. O lote no prompt ja esta resolvido como diretorio: voce possui aquele diretorio e tudo abaixo dele.
- Precisa mudar algo fora do lote (um token, um componente compartilhado, o build)? NAO mude. Escreva o bloco `## Blocked` no report dizendo o que falta e em que arquivo. Um bloqueio nao reprova a sua tarefa e nao segura a sua branch: vira tarefa nova na onda seguinte, com o seu texto como descricao.
- Outro agente pode estar trabalhando no mesmo repo agora, em outro worktree. Cada linha sua que vaza para fora do lote e uma colisao que alguem tera de resolver a mao, sem o contexto que voce tem.
- As dependencias declaradas ja estao no seu worktree (o CLI corta onda > 1 do head da integracao): leia o que elas entregaram e NAO recrie nem reimplemente a entrega delas — reescrever dentro do seu lote o que a dependencia ja fez e colisao na integracao.

## Git
- Commit no seu worktree, na sua branch. `git add` so dos seus arquivos.
- Nunca merge. Nunca push. Nunca crie branch. Nunca rode git fora do seu `workDir`.
- Voce nao chama o CLI do swarm: `start` e `finish` sao do orquestrador. Seu produto e o commit + o report.

## Terminar
Escreva o report no caminho absoluto que o prompt deu — e o unico lugar de onde o orquestrador le o seu resultado; nao existe "me conte no final". A forma e exatamente esta, com os titulos na coluna zero, sem recuo, sem traduzir, sem `###`:

```
## Summary
<o que voce fez, em ate 3 linhas>
- touched: <csv dos arquivos que voce tocou, escritos como aparecem no git>
- tokens: <numero aproximado de tokens de LLM gastos nesta tarefa>
## Notes
<opcional>
## Blocked
<opcional; obrigatorio se algo ficou fora do seu lote>
```

O `finish` do orquestrador compara o diff real do git com o `touched` que voce declarou. Divergir nao te salva — declarar o que nao tocou ou tocar e nao declarar: a gate reprova e a branch fica de fora da integracao, junto com tudo o que voce acertou.
