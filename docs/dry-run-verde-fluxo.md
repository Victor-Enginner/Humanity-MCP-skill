# Dry run — Verde Fluxo (Task 14, spec §12 risco 1)

Run: `20261107-8079` · alvo: `O:/DEV/A JORNADA/PROJETOS/Trabalhos reais/dashboard` · base `eda56e2` (main) · 2026-11-07
Orquestração: controlador em primeiro plano (sem background). Workers: `codex exec` 0.163.0,
modelo gpt-6.1-sol, sandbox workspace-write, prompt exato de `tasks/<id>/attempt-N/prompt.md` + linha do workDir.
Toolchain do alvo: Python 3.12.10 (>= 3.11 do CLAUDE.md), stdlib + SQLite, `python -m unittest discover -s backend/tests -v`, ruff 0.17.4.

## Prep — emendas V-1/V-2 (OK do humano antes do dispatch)

O brief original mandava `git init` na pasta do produto. V-1: o repo **já existe** (6 commits, identidade
do humano, binários `index (1).html`/`*.zip` tracked) — AskUserQuestion respondeu "usar como está":
sem init, sem rewrite, binários ficam, ruff instalado com OK. V-2: o plano do brief dizia "duas ondas"
mas declarava `depends_on: -` em tudo — ruling: `T-02 depends_on: T-01`, ondas
`[["T-01","T-03"],["T-02"]]`, corpos intactos. Plano emendado e commitado (546045e) ANTES do brief
regerado. Baseline medido: 35/35 unittest OK, ruff 58 erros pre-existentes.

## Plano e ondas

Lotes: T-01 `backend/adapters/**`, T-02 `backend/tests/**`, T-03 `config/**` — disjuntos, verify de
T-01/T-02 = unittest. Barragem C1 medida: `start T-02` antes do integrate recusou com rc 2
(dependência não integrada). Worktree de T-02 nasceu do head da integração (42e18c8), e o worker
leu a entrega real de T-01 antes de escrever.

**Onda 1** — T-01 devolveu **diff zero honesto**: o protocolo `SourceAdapter` declara só `scan()`;
`fetch()`/`health()` não existem no contrato, e inventá-los violaria a instrução de preservar contrato
(`- touched: -`, gate ok:true — o caminho positivo da lista vazia). T-03 entregou config real
(README + sources.json: 4 fontes habilitadas, intervalos alinhados a 86400s). Ambos tiveram o commit
negado pelo sandbox (B-2 de novo); operador commitou T-03 (42e18c8). `integrate`: merged [T-01, T-03],
0 colisões, **gate de onda rodou unittest de verdade: rc 0, 35 testes, 2.784s** — a gate que o libra
não pôde rodar.

**Onda 2** — T-02 escreveu `test_adapter_contract.py` sobre as seis fontes configuradas, sem fabricar
adapter dentro dos testes, sem skip/expectedFailure: **36 testes, 9 falhas** (fetch ausente nas 6
fontes, health ausente nos 3 feeds). Operador commitou (686fbf9), finish ok:true. `integrate`: merge
limpo, **gate rc 1 → a onda NÃO fechou**: integração resetada ao head da onda 1 (42e18c8), T-02 saiu
`failed` rc 1, refs preservadas para forense/retry. Exatamente o dente do plano: "se ele quebrar, a
onda nao fecha".

## Os seis números (+ os dois extras do brief)

| Mede | Resultado |
|---|---|
| Violações de lote (`SCOPE-OUTSIDE-LOT`) | **0** em 5 gates (3 de tarefa + 2 de onda, findings sempre `[]`) |
| Colisões de merge (`integrate.conflicts`) | **0** nas duas ondas |
| `## Blocked` por worker | **3 de 3**: contrato sem fetch()/health() (T-01/T-02), commit negado pelo sandbox (T-03/T-02; T-01 não tinha diff), itens fora do lote documentados sem tocar (T-03: URL/tipo fixos no adapter, daily ignora intervalo) |
| Tempo de parede por onda | Onda 1: **8m21s** (21:13:03→21:21:24; workers sequenciais em primeiro plano: 2m10s + 2m33s, mais commits/gates do operador). Onda 2: **3m58s** (21:21:39→21:25:37; worker 3m10s, integrate 5s) |
| Custo do worktree | **7 MB** pós-run (3.6M `_integration` + 3.4M T-02; T-01/T-03 já removidos pelo integrate). Durante o run: 4 worktrees. `git worktree add` ~1s |
| Toolchain | **Zero install** (stdlib). Testes rodaram nos worktrees de tarefa E na gate de onda — o oposto do libra, onde typecheck/build não rodaram nos lotes |
| Extra: `unittest` rc por onda | Onda 1: **rc 0** (35 testes). Onda 2: **rc 1** (36 testes, 9 falhas de contrato) — gate vermelha honesta, integração resetada |
| Extra: `ruff check backend config` na integração | **rc 1, 58 erros — diff normalizado idêntico ao baseline eda56e2: 0 erros novos** introduzidos pelo swarm (39 auto-fixáveis, todos pré-existentes) |

Tokens: worker jurou 5200/6200/6500 (T-01/T-03/T-02); dispatcher mediu **45.528/36.459/42.336**.
Sub-report confirmado no segundo alvo — a métrica de custo do M1 vem do dispatcher, não do worker.

## Achados

1. **B-2 é ambiental, não do libra:** os 3 workers do segundo repo também tiveram `index.lock:
   Permission denied` no `.git` real, mesmo com `--add-dir`. Workaround do operador usado 2×
   (commits marcados "commit pelo operador"); a gate validou o diff real contra o `- touched:` nos dois.
2. **A gate vermelha tem dente:** rc 1 da verify ⇒ onda não fecha, integração volta ao head anterior,
   refs ficam para forense. O gap de contrato do Verde Fluxo virou evidência acionável (9 lacunas
   fetch()/health() nomeadas por fonte) sem um arquivo tocado no checkout do produto.
3. **Posse de contrato funcionou como desenho:** T-01 e T-02 em ondas diferentes obrigou o planejador
   a pensar em posse; T-01 não inventou a interface, T-02 não maquiou o teste — o sistema preferiu o
   Blocked honesto dos dois lados ao verde falso.
4. `finish --attempt` usado certo em todos (lição M-4 do libra aplicada); nenhum finding fantasma.

## Comparativo — libra vs Verde Fluxo

| Métrica | libra (8699) | Verde Fluxo (8079) |
|---|---|---|
| `SCOPE-OUTSIDE-LOT` | 0 em 4 gates | 0 em 5 gates |
| Colisões de merge | 0 | 0 |
| `## Blocked` | 3/3 workers | 3/3 workers |
| Tempo de parede | 8m39s + 4m20s | 8m21s + 3m58s |
| Worktree | 21 MB pós-integrate; 4 durante | 7 MB pós-run; 4 durante |
| Toolchain | install 550s/1799 pacotes; build 641s rc 1; sem typecheck nos lotes | zero install; testes nos lotes e na gate; ruff 58=58 baseline |
| Gate de onda | não rodou até o fim (build estourou 600s, falhou por env fora dos lotes) | rodou nos dois sentidos: verde (35 OK) e vermelho (9 falhas ⇒ onda barrada) |

## Veredito — o gargalo do swarm é contenção ou toolchain?

**Toolchain, confirmado no segundo alvo.** Contenção: zero violações, zero colisões, dependência
consumida de verdade — nos dois repos. Com toolchain stdlib a máquina inteira (2 ondas, 3 workers,
gates verdes e vermelhas, commits de operador) fechou em ~12min de parede; no libra só o install+build
custaram ~20min e mesmo assim a gate não pôde validar. Para o M2: **install de dependência entra como
parte do isolamento** (cache compartilhado/herdado, não detalhe), o dispatcher precisa commitar na
branch do worker sem operador (B-2), e a gate de onda **não vira opcional quando declarada** — o
vermelho honesto deste run foi a validação mais barata que o sistema produziu.

## Limpeza verificada (step 5)

`abort` rc 0: worktrees e branches `swarm/20261107-8079/*` apagados sem resíduo (sem node_modules,
`__pycache__`/`.ruff_cache` saíram limpos — M-5 não recorreu). Dashboard: `worktree list` só o checkout,
`status --porcelain` vazio, HEAD `eda56e2` intacto, zero branches `swarm/*`. Resíduo `runs/baseline-vf`
(worktree do próprio SWARM usada na prep, já desregistrada) removido manualmente. `runs/` (ignorado
pelo git) mantém os artefatos forenses dos três runs. Nada foi publicado: nenhum push, main do produto
intacto, branches só locais — e agora apagadas.