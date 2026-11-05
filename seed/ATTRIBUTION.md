# Atribuição e licenças das fontes

Registro de licença da suíte inteira (spec §11). Vale para `seed/`, `lib/`, `run.js` e `skills/`.

**Fato central:** nenhuma linha de código-fonte externo foi copiada para este repositório. Nada é
vendido, nada é linkado em tempo de build, não há `node_modules`. O que entrou das fontes abaixo é
**regras, ids, mecânica e vocabulário** — descritos, reimplementados, e verificáveis por teste aqui
dentro. É isso que torna utilizáveis as duas fontes sem licença: a barreira é a reimplementação a
partir da mecânica descrita, nunca o texto.

| Fonte | Licença | O que foi usado aqui | O que NÃO foi usado |
|---|---|---|---|
| `hallmark` (inclui `sloplint.mjs`) | MIT | As **categorias** de regra do piso: gradiente roxo de template, rótulo em CAIXA ALTA com tracking largo, ritmo de espaçamento, cor fora de token. Nossas regras `SLOP-*` em `lib/sloplint.js` são um rule-set próprio, com frontes e limiares próprios (`% 4`, 0.05em/1px, a lista de hex da familia roxa). | Nenhum regex, nenhuma linha de código, nenhum id copiado. |
| `impeccable` | Apache-2.0 | A **disciplina de rule-id**: todo achado sai com um `id` citável (`Finding = {id, file, line, message}`), para o crítico e o worker discordarem do número e não da impressão. | Playbooks, texto de regra, e o `NOTICE.md` — ver "Obrigação de NOTICE" abaixo. |
| `am-will/swarms` | **sem licença** | **Mecânica apenas**, descrita: prompt por tarefa, ledger de status tabulado, ondas derivadas de dependência. | Zero linha copiada. Nenhum arquivo, nenhum nome de função, nenhum formato de arquivo reproduzido byte a byte — `status.tsv` e `plan.md` foram desenhados aqui. |
| `swarm-cursors` | **sem licença** (o autor pede contato antes de reusar) | **Conceito** de blueprint: declarar a estrutura antes de dispatchar. Reservado para M4. | Nenhum código reutilizado, nenhum asset visual, nenhum overlay de cursores. O autor pede para não reusar sem falar com ele; não reusamos. |
| `agent-browser` | Apache-2.0 | Nada ainda. **Reservado para M4** (gate de percepção no browser real). | Binário, notices do axe-core, qualquer execução. Quando for embarcado, ver "Obrigação de NOTICE" abaixo. |
| `agentic-awesome-skills` | MIT (código) / **CC-BY-4.0** (prosa) | Nada. As skills de `skills/` foram escritas aqui. Se um dia um skill curado deles entrar, a atribuição tem que ser **visível** no próprio arquivo (CC-BY exige isso). | Prosa, templates, nomes. |
| `ruflo` / `claude-flow` | MIT (raiz), Apache-2.0 em `src/ruvocal` | **Convenções apenas**: filtro de tools por namespace, claims em JSON, teto de budget por run — ideias lidas e reimplementadas no nosso formato. A decisão D2 foi não adotá-los; nada deles roda aqui. | Código, dependência, o caminho de escrita em `~/.claude-flow`. |
| `open-flow` | Apache **modificada** (proíbe revender como serviço hospedado) | **Modelo** de grafo-como-estado apenas, na formulação de `waves.json`. | Código. A cláusula de não-revenda não é acionada: a suíte é ferramenta pessoal, não serviço hospedado — e se isso mudar, esta linha vira revisão de advogado. |

## Obrigação de NOTICE (registrada, ainda não acionada)

- `impeccable` é Apache-2.0: se um dia **qualquer** arquivo deles for distribuído junto, o
  `NOTICE.md` deles tem que ir junto, no mesmo diretório, sem edição. Em M1 nada é distribuído,
  então não há `NOTICE` a reter — a obrigação fica registrada aqui para não virar surpresa.
- `agent-browser` é Apache-2.0 e embarca notices do **axe-core**: ao pré-baixar o binário (M4), os
  notices vão para `seed/licenses/` antes de qualquer gate rodar com ele.
- MIT não impõe aviso derivado, mas `hallmark` exige que o aviso de copyright dele apareça se
  algum arquivo deles for redistribuído aqui. Também registrado em `seed/licenses/` nesse cenário.

`seed/licenses/` ainda não existe porque não há nada para colocar dentro: zero arquivo externo foi
copiado. O diretório é obrigatório no momento em que o primeiro texto de licença externo entrar
(spec §11), e esta tabela é o registro que diz qual foi o primeiro.

## Risco declarado (spec §12, item à parte)

`am-will/swarms` e `swarm-cursors` estão no mesmo espaço de ideias que esta suíte. A proteção é a
reimplementação a partir da mecânica descrita, sem linha copiada — que é o que esta página afirma e
o que o histórico do repositório tem que continuar permitindo verificar. Se o produto for publicado,
isto merece revisão de licença por advogado, não por quem escreveu esta linha.
