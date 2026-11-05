# SWARM — suíte portátil de swarm multi-agente para construir sites

**Data:** 2026-11-05
**Status:** design aprovado em sessão, aguardando revisão escrita
**Local do projeto:** `O:\DEV\A JORNADA\tools\SWARM` (repo git próprio, ignorado pelo monorepo do A JORNADA)

---

## 1. O que é

Um pacote autocontido que vive num pendrive e conduz um **swarm de agentes de código editando o mesmo site ao mesmo tempo**, com isolamento por worktree git, integração determinística e gates de qualidade mensuráveis.

Chego numa máquina que não é minha, plugo o stick, rodo `iniciar.ps1`, digito uma senha, e tenho meu ambiente de engenharia trabalhando local naquela máquina. O modelo vem de API. O que não é: um serviço remoto, uma ponte para minha estação, ou um produto publicado.

### Tese central

Orquestração de swarm é problema resolvido. **Isolamento e integração são o produto.** Os dois swarms open-source mais usados hoje — `claude-flow`/ruflo (MIT) e `am-will/swarms` — não resolvem o conflito de escrita entre agentes: o primeiro trata claims no nível de *issue* com gravação last-write-wins e mantém isolamento por worktree apenas no adapter Codex; o segundo roda todos os workers no mesmo checkout e delega a segurança a uma instrução em prosa. É esse buraco que a suíte fecha.

### Por que "conectar em qualquer lugar" ficou de fora

A decisão de escopo tomada foi *levar meu ambiente comigo*, não *alcançar minha estação de qualquer lugar*. A segunda opção reaproveitaria o túnel/Tailscale/9router que já existe em `O:\DEV\A JORNADA\tools\gateways` e é um projeto separado, sem relação com o swarm. Ela não foi abandonada — foi excluída deste escopo.

---

## 2. Decisões tomadas (e por quê)

| # | Decisão | Motivo |
|---|---|---|
| D1 | Harness **híbrido**: usa subagentes nativos do host quando existe; senão, CLI/processos destacados | Máquina emprestada pode não ter nenhum agente instalado |
| D2 | **Supervisor MCP próprio e fino** (~12 tools), não adoção do ruflo | O ruflo tem 305 tools, escrita em `~/.claude-flow`, checagem de update no npm **ligada por padrão** e nenhum lock de arquivo no caminho principal — os três são hostis a um stick |
| D3 | **Um worktree git por tarefa**, nunca checkout compartilhado | Única defesa real contra N agentes escrevendo no mesmo repo |
| D4 | **Worker nunca integra.** Só o supervisor faz merge, em ordem topológica | Mantém o ponto de falha único e auditável |
| D5 | **Single-writer no ledger** (`status.tsv`, `plan.md`) | Elimina a classe de bug last-write-wins vista no ruflo |
| D6 | **Pendrive imutável durante o trabalho**; execução e worktrees em `%LOCALAPPDATA%` | USB falha em escrita concorrente, monta read-only em máquina emprestada, e AppLocker bloqueia `.exe` de mídia removível |
| D7 | **Chaves cifradas no stick** (scrypt + AES-256-GCM embutidos do Node) com senha digitada no boot | DPAPI amarra o segredo à máquina hospedeira, o que quebra o caso de uso |
| D8 | **Gate final de design é advisory**, gates de tarefa e onda bloqueiam | Crítica estética que trava o swarm vira negociação com o gosto do modelo |
| D9 | **Teto de 3 workers** concorrentes | Com worktree-por-tarefa, concorrência alta é limite de IO e disco antes de ser qualquer outra coisa |
| D10 | **Sem modelo local** | Stick não carrega pesos; máquina emprestada não tem GPU garantida |
| D11 | Node em JS puro, **sem step de build** no supervisor | Menos superfície para quebrar numa máquina que não é sua |

---

## 3. Arquitetura

```
                        ┌──────────────────────────────────────┐
   você ──iniciar.ps1──▶│  SUPERVISOR (MCP stdio, Node)        │
                        │  possui: plano, ondas, worktrees,    │
                        │  ledger, merge, gates, orçamento     │
                        └───────┬──────────────────┬───────────┘
                    dispatch    │                  │  ingestão
              ┌─────────────────┴───┐         ┌────▼─────────┐
              │ WORKER 1..3         │         │ INTEGRADOR   │
              │ worktree próprio    │         │ (agente c/   │
              │ host-nativo OU CLI  │         │  contexto    │
              │ escreve só em si    │         │  completo)   │
              └─────────────────┬───┘         └────┬─────────┘
                                │ report.md        │
                                └──────────────────┘
                                        │
                              ┌─────────▼──────────┐
                              │ GATES              │
                              │ build → sloplint → │
                              │ browser → blueprint│
                              └────────────────────┘
```

O host (Qoder, Claude Code, Codex, Cursor) ou o CLI fallback são **músculo**: executam um prompt dentro de um diretório que o supervisor escolheu e devolvem um relatório. Toda decisão — o que roda, quando, em que cópia, se passa — é do supervisor.

---

## 4. Contrato de ferramentas

Doze tools. O teto é o design: o orçamento de contexto da máquina emprestada é o produto, e o contraste deliberado é com as 305 do ruflo.

| Tool | Faz | Chama |
|---|---|---|
| `swarm_plan` | recebe objetivo + tarefas com `depends_on` e **conjunto de caminhos declarado**; recusa sobreposição entre tarefas; calcula ondas; grava plano | orquestrador |
| `swarm_wave` | devolve a próxima onda desbloqueada, cada tarefa com seu *context pack* | orquestrador |
| `swarm_task_prepare` | cria worktree + branch, escreve `prompt.md`, devolve `{dir, branch, prompt}` | orquestrador |
| `swarm_dispatch` | liga o worker (subagente nativo se houver host; processo destacado no Windows senão); devolve handle com PID/correlação | orquestrador |
| `swarm_poll` | estado dos rodando, com **deadline e watchdog reais** | orquestrador |
| `swarm_report` | worker declara fim: tocou, rodou, aprendeu, consumiu | worker |
| `swarm_integrate` | aplica branches em ordem topológica na branch de integração; colisão é *reportada*, não resolvida às cegas | orquestrador |
| `swarm_gate_run` | roda a cascata de gates (seção 6), por tarefa ou por onda | supervisor no `swarm_report`; integrador na onda |
| `swarm_retry` | relança tarefa com prompt revisado, como nova tentativa numerada | orquestrador |
| `swarm_status` | leitura humana do ledger; não altera nada | você |
| `swarm_abort` | mata workers, remove worktrees, preserva ledger | você |
| `swarm_export` | sync de saída do ledger para o stick (temp + rename) | você |

Nenhuma tool publica, força push ou deleta fora do diretório de execução. Publicação continua sendo gesto humano.

### Layout de execução (disco local da máquina hospedeira)

```
%LOCALAPPDATA%\Swarm\
  bin\  suite\                     # copiados do stick no boot
  runs\<run-id>\
    plan.md                        # tarefas, depends_on, caminhos declarados
    status.tsv                     # append-only, single-writer:
                                   # task|state|rc|start|end|branch|log|tokens
    worktrees\<task-id>\           # um por tarefa
    tasks\<task-id>\
      prompt.md                    # imutável
      attempt-N\report.md
      attempt-N\log
      attempt-N\diffstat
    integration\                   # branch de integração
```

### Três contratos que sustentam o resto

**Prompt imutável por tentativa.** Um arquivo de prompt por tarefa, entregue por stdin. Falha não reescreve prompt: cria `attempt-2`. O histórico vira evidência reproduzível, não rascunho. *(Mecânica do `parallel-task-tmux`, reimplementada.)*

**Caminhos declarados, verificados depois.** `swarm_plan` recusa duas tarefas cujos conjuntos se sobreponham — o isolamento é checado **antes** do spawn. Na volta, a gate compara o diff real com o conjunto declarado: worker que tocou fora do próprio lote reprova e a branch não entra.

A regra de fronteira, explícita para não virar discussão no meio de um run: **o worker pode criar arquivos novos dentro dos diretórios declarados, mas não pode tocar em arquivo existente fora deles.** Declarar o lote é trabalho do planejador e é revisável entre ondas — uma onda que descobre que precisa de `styles/tokens.css` abre uma tarefa nova na onda seguinte, em vez de invadir a do vizinho.

**Refinamento (2026-11-05, decidido ao escrever o plano do M1):** a declaração é feita por **diretório**, não por arquivo. `scopeDir(pattern)` é o diretório mais profundo antes do primeiro wildcard (ou `dirname` se não houver), e duas tarefas da mesma onda colidem se um `scopeDir` for igual ou ancestral do outro. Interseção de glob não é determinável sem tocar no sistema de arquivos, e a recusa conservadora é a direção segura — ela força o planejador a pensar em posse de diretório, que é exatamente a unidade que o worktree protege.

**Ledger como barragem.** O orquestrador nunca lê transcrição de worker — só `status.tsv` e o `tail` do log. A onda seguinte só abre quando a atual passa na gate. Concorrência máxima: 3.

### Backends de dispatch

| | Host presente | Máquina limpa |
|---|---|---|
| Mecanismo | subagente nativo com isolamento por worktree (Qoder expõe `isolation: "worktree"`) | `Start-Process -PassThru -NoNewWindow -RedirectStandardOutput` alimentado por stdin |
| Vida do worker | gerido pelo host; o supervisor correlaciona por arquivo de relatório | PID no ledger; `Wait-Process` + deadline; `Stop-Process` no timeout |
| Deteção de capacidade | no `swarm_plan`, não no `swarm_dispatch` | idem |

A escolha acontece no planejamento e é gravada no plano, para que um run seja reproduzível com o backend registrado.

Concorrência é constante no código — 3 workers, sem flag — até um dado real pedir o contrário (D9).

---

## 5. Runtime do pendrive

```
SWARM\                          # no stick — imutável durante o trabalho
  iniciar.ps1                   # único ponto de entrada
  eject.ps1                     # sync de saída + limpeza
  bin\
    node\                       # node.exe portável win-x64
    agent-browser\              # binário Rust por plataforma, pré-baixado
    chrome\                     # Chrome for Testing, pré-baixado
  suite\
    skills\                     # SKILL.md curados
    supervisor\                 # MCP server Node, sem build
  seed\
    config\                     # base, sem segredo
    keys.json.enc               # envelope cifrado (scrypt + AES-256-GCM)
    ATTRIBUTION.md
    licenses\
```

**Sequência do `iniciar.ps1`:**

1. Sondar permissão de execução de mídia removível. Bloqueado → falha com uma linha legível, sem swarm meio ligado.
2. Pedir senha; destrancar `keys.json.enc` **em memória**, nunca em disco.
3. Copiar `bin\` e `suite\` para `%LOCALAPPDATA%\Swarm`. Custo: ~250MB, 30-90s em USB 2.0. Aceitável porque a cópia é onde todo o trabalho acontece de qualquer forma.
4. Exportar exatamente três redirecionamentos de estado — `SWARM_HOME` (ledger, worktrees, relatórios), `AGENT_BROWSER_SOCKET_DIR` (socket do daemon do browser) e `TMP` escopado ao diretório do run — todos apontando para `%LOCALAPPDATA%\Swarm`. Nenhum outro caminho de escrita é aceito; componente que não aceite redirecionamento fica de fora da suíte. Regra dura: **nada escreve no stick, nada escreve no home da máquina hospedeira.**
5. Preflight de API: uma chamada barata + teto de tokens do run gravado no ledger.
6. Subir o supervisor MCP em stdio e registrar as 12 tools.

**Sequência do `eject.ps1`:** sync do ledger para o stick em temp + rename, depois apagar `%LOCALAPPDATA%\Swarm`. Rastro zero em máquina de terceiro é requisito.

Sem rede, sem túnel, sem daemon além do próprio MCP stdio.

---

## 6. Gates de qualidade

Ordem determinística; cada degrau só roda se o anterior passou.

1. **Build + typecheck.**
2. **Slop lint — sem LLM.** Regras em CSSOM/regex: gradiente roxo default, caps de eyebrow, ritmo de espaçamento quebrado, cor fora da paleta de tokens. Rule-set nosso, informado pelos ~60 do `hallmark/sloplint.mjs` (MIT) e as 62 do detector do `impeccable` (Apache-2.0).
3. **Medição no browser real.** `agent-browser` abre a página, devolve a árvore de acessibilidade com refs `@eN` em vez de despejar o DOM, roda o axe-core embutido. Contraste e label saem como número.
4. **Crítica por blueprint.** Varredura do DOM incluindo shadow roots, destilada em camadas tipadas — rects, textos, linhas, media, **master + duplicatas**, guias de baseline compartilhada — convertida em grandeza: contagem de masters, quebras de alinhamento, dispersão de tamanhos de fonte, razão de duplicação. É daqui que o swarm consegue dizer *"a onda 3 piorou a página"* com número.
5. **Crítico LLM.** Só sobre os fatos medidos, e **cada finding cita um id de regra** (disciplina do `<!-- rule:id -->` do impeccable). Nunca "acho que".

| Gate | Roda | Severidade |
|---|---|---|
| Por tarefa | 1 + 2 | **bloqueia** o `swarm_report` de dizer "pronto" |
| Por onda | 1 + 2 + 3, na página integrada | **bloqueia** a onda seguinte |
| Final | 4 + 5 | **advisory** (D8) |

Os degraus 3 e 4 existem porque N agentes escrevendo CSS simultaneamente é o regime exato em que tokens divergem e ritmos se multiplicam sem ninguém ter olhado a página inteira.

---

## 7. Tratamento de falha

Princípio: **toda falha vira um estado no ledger, nunca um sucesso fingido.**

| Falha | Resposta |
|---|---|
| Worker zumbi | deadline por tarefa; watchdog; `Stop-Process`; estado `timeout`; relança como `attempt-2` |
| Tocou fora do lote | reprova na gate; branch **não é integrada**; worktree descartado |
| Colisão de merge | reportada com os dois lados ao integrador; se ele não resolve, o supervisor **divide a tarefa em duas sequenciais** e revisa o plano |
| Máquina desliga no meio | no restart, `running` sem PID vivo = `crashed`; limpeza por comando; **recuperação não passa por LLM** |
| Stick arrancado | sem janela de falha: nada escreve no stick durante o trabalho |
| Execução bloqueada | sonda antes de copiar; falha legível |
| Sem rede / chave inválida / quota | preflight antes de qualquer spawn; teto de tokens por run; workers reportam consumo |
| Host sem subagente nem worktree | detecção de capacidade no `swarm_plan`, o run cai no backend CLI e isso fica registrado no plano |

---

## 8. Testes

1. **Unitário** da função de ondas: `depends_on` topológico + rejeição de sobreposição de caminhos. Função pura, sem modelo, milissegundos. É onde a correção toda mora.
2. **Integração** com repositório fixture de site: 3 tarefas de caminhos disjuntos → 3 worktrees → integração em ordem topológica; uma tarefa sabotada tocando fora do lote → gate reprova e aquela branch não entra.
3. **Injeção de falha:** matar worker no meio do run → `crashed` no ledger, worktree removido, nenhum merge parcial.
4. **Golden do blueprint:** página fixture com métricas esperadas + uma versão degradada de propósito (ritmo de espaçamento quebrado, contraste ruim) → o gate tem de detectar a regressão com número. Se este teste não passar, os degraus 4 e 5 da seção 6 são enfeite e a seção 6 é reduzida.
5. O crítico LLM **não** é testado por determinismo de saída; é testado por *cada* finding citar um id de regra.

Os testes 1-3 servem igualmente aos dois backends de dispatch, porque ambos entram pela porta única do ledger. É isso que faz o primeiro marco em forma de A ser banco de prova do B, e não rascunho descartável.

---

## 9. Milestones

**M1 — suíte fina sobre o host (forma A).** Skills + contratos de arquivo + dispatcher de subagentes nativos com worktree + gates 1-2. Sem binário, sem CLI, sem cifragem. Roda hoje, na sua máquina, dentro do Qoder. Entrega: um site construído por 3 agentes em paralelo sem colisão.

**M2 — supervisor MCP.** As 12 tools como processo real, ledger single-writer, watchdog, integração topológica. Os testes 1-3 de M1 viram o harness do M2.

**M3 — pendrive.** `iniciar.ps1`/`eject.ps1`, envelope de chaves, binários pré-baixados, redirecionamento de estado, teste em máquina limpa de verdade.

**M4 — gates de percepção.** Degraus 3 e 4 (`agent-browser` + blueprint) e o teste golden. É o milestone que valida a única ideia original; se ele falhar, a suíte continua útil e a seção 6 é cortada.

**M5 — backend CLI.** Dispatcher para máquina sem host, `Start-Process` + TSV + timeout.

A ordem M1→M2 é deliberada: M1 prova a semântica do swarm com o mínimo de código possível antes de qualquer coisa virar servidor.

**Escopo do plano de implementação:** o próximo plano cobre **somente o M1**. M2 a M5 recebem planos próprios, cada um depois de o anterior ter rodado — M4 em particular pode ser cortado pelo risco 3 da seção 12, e seria desperdício planejá-lo agora.

---

## 10. Fora de escopo

- Acesso remoto à minha estação, túnel, Tailscale, 9router (D — excluído na decisão de cenário).
- Publicação/deploy automatizado. Gate no browser é de *medição*, não de publicação.
- Modelo local (vLLM, bitnet).
- Embarcar o ruflo/claude-flow. Roubamos convenções: filtro de tools por namespace, claims/leases em JSON, `CLAUDE_FLOW_DB_PATH`-estilo, teto de budget por run.
- Redistribuir os 2.831 skills do `agentic-awesome-skills`. Curam-se poucos, com atribuição.
- O overlay visual de cursores do swarm-cursors — decoração sem licença, e o próprio autor pede para não reusar sem falar com Joel Califa.
- `logocreator` (sem licença + fontes que proíbem redistribuição + geração paga) e `awesome-frontend-skills` (3 arquivos, zero conteúdo, sem licença).

---

## 11. Licenças e atribuição

`seed/ATTRIBUTION.md` e `seed/licenses/` são obrigatórios, não opcionais.

| Fonte | Licença | Uso |
|---|---|---|
| `hallmark` | MIT | adaptar regras do sloplint |
| `impeccable` | Apache-2.0 + `NOTICE.md` | adaptar playbooks e disciplina de rule-id; reter NOTICE |
| `agent-browser` | Apache-2.0 | binário redistribuído; **reter os notices do axe-core** que já vêm no repo |
| `agentic-awesome-skills` | MIT código / **CC-BY-4.0 prosa** | skills curados exigem atribuição visível |
| `ruflo`/`claude-flow` | MIT (raiz), Apache-2.0 em `src/ruvocal` (vendido da HF) | convenções apenas; se algo for copiado, reter os dois textos |
| `am-will/swarms` | **sem licença** | mecânica apenas, zero linha copiada |
| `swarm-cursors` | **sem licença**, autor pede contato | conceito do blueprint apenas |
| `open-flow` | Apache modificada (proíbe revender como serviço hospedado) | modelo de grafo-como-estado apenas |

**Risco registrado:** as duas fontes sem licença estão dentro do mesmo espaço de ideias que estamos construindo. A barreira é a reimplementação a partir da mecânica descrita, não o texto. Se um dia o produto for publicado, isso merece revisão de licença por um advogado, não por mim.

---

## 12. Riscos abertos

1. **Custo do worktree.** Três cópias de um repo de site + IO de git em disco de máquina emprestada pode ser mais lento que um agente só, e aí o swarm não paga o próprio preço. Mitigação: medir no M1 antes de construir o M3.
2. **Gate por onda bloqueando no browser.** Máquina emprestada sem Chrome embarcado funcionando = run parado. Mitigação: degrau 3 pode degradar para advisory com aviso explícito no ledger, nunca silenciosamente.
3. **Blueprint é a aposta.** Ninguém no conjunto lido faz isso. Se as métricas não correlacionarem com qualidade real, a seção 6 perde dois degraus.
4. **Fuso de credencial.** A senha destrava chaves em memória; malware da máquina hospedeira pode lê-las. Mitigação honesta: chave de teto baixo para viagem é a resposta real, e ela foi adiada por D7 — revisitar se a suíte sair de uso pessoal.
