// lib/prompt.js — o unico texto que um worker de swarm le. É contrato com um programa, não prosa:
// o que está aqui embaixo é o que `run.js` (Task 9) grava em `tasks/<id>/attempt-N/prompt.md` e
// relê quando um worker morre, para saber exatamente o que foi dito a ele.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// `scopeDir` (lib/paths.js) devolve o DIRETÓRIO do lote, nunca o glob: `styles/**` vira `styles`,
// e um caminho literal vira o pai. Por isso a fronteira é escrita como lista de diretórios com
// "e tudo abaixo" — se aparecesse o glob aqui, o agente entenderia que só possui os arquivos que
// o padrão casa, e o scopeCheck do git reprovaria o arquivo novo que ele criou certo.
const lotLine = (d) =>
  d === '.'
    ? '- . (a raiz do worktree: este lote e o repositorio inteiro, foi o plano que declarou assim)'
    : `- ${d}`;

// Teto do corpo no PROMPT, não no parser (emenda da Task 8, item 1): o `plan.md` do humano
// continua sendo o texto inteiro — o que corta aqui é só o que o worker vê. O teto e a direção
// são os mesmos do `repoConventions` (6000, mantém o começo), porque num plano o que se escreve
// primeiro é o que importa.
const BODY_CAP = 6000;

const renderBody = (body) => {
  const b = (body ?? '').trim();
  if (!b) return '';
  return b.length > BODY_CAP ? `[corpo cortado]\n${b.slice(0, BODY_CAP)}` : b;
};

// As quatro strings em inglês literal abaixo (`## Summary`, `- touched:`, `- tokens:`, `## Blocked`)
// não são estilo: são o que `parseReport` (lib/report.js:11-14) casa, com flag m, a partir da
// COLUNA ZERO. Traduzir um título, recuar o exemplo dentro de uma lista, ou trocar `##` por `###`
// faz o parse devolver vazio em silêncio — o bloqueio do worker nunca chega ao orquestrador e a
// onda seguinte dispatcha uma tarefa que já estava bloqueada. O corpo do prompt é PT-BR; isto é
// protocolo, e Tasks 9-13 dependem dele byte a byte.
export function renderPrompt({ task, waveNumber, run, floor, theme, conventions }) {
  const corpo = renderBody(task.body);
  return `# Worker ${task.id} — onda ${waveNumber}

${task.title}

${corpo ? `${corpo}\n\n` : ''}Depende de: ${task.dependsOn.length ? task.dependsOn.join(', ') : 'ninguem — esta e a sua onda de entrada'}.

As dependencias declaradas ja estao no seu worktree: o CLI corta toda worktree de onda > 1 do head
da branch de integracao e nao abre uma tarefa cuja dependencia ainda nao foi integrada. Leia o que
elas entregaram antes de escrever — elas sao a base do seu trabalho, nao um palpite sobre o que a
outra onda deveria fazer — e NAO recrie nem reimplemente o que elas ja entregaram: reescrever a
entrega da dependencia dentro do seu lote e colisao na integracao. Escrever fora do seu lote
continua proibido e continua custando a tarefa inteira; o que precisar de mudanca fora dele vai
para o \`## Blocked\` do report, dizendo o que falta e em que arquivo.

## Fronteira (inviolavel)

Voce possui apenas estes diretorios, dentro de ${run.workDir}:
${task.dirs.map(lotLine).join('\n')}

Cada linha acima e um diretorio ja resolvido do lote declarado no plano: voce possui aquele
diretorio e tudo que estiver abaixo dele, inclusive arquivo novo que voce criar la dentro. Os
caminhos sao relativos ao worktree: a linha \`- <diretorio>\` quer dizer
${run.workDir}/<diretorio>, e apenas ali.

Leia qualquer arquivo do repositorio — leitura e livre, e voce precisa ler para nao reinventar.
Escreva **somente** dentro dos diretorios acima. Precisa mudar algo fora deles (um token, um
componente compartilhado, o build, um arquivo na raiz)? NAO mude. Escreva um bloco \`## Blocked\`
no seu report dizendo o que falta e em que arquivo.

A unica excecao a essa regra e o seu report, no caminho da secao "Como terminar": ele nao entra no
commit nem no diff do repositorio, porque nao e arquivo do produto — e o unico arquivo do run que
voce escreve, e o unico pelo qual o orquestrador sabe o que voce fez.

Isto nao e etiqueta de estilo. O host nao te isola em nenhum diretorio: a unica cela e este texto,
e a cela de verdade e o git. Ao terminar a tarefa, alguem roda o diff real do seu commit e compara
arquivo por arquivo contra a lista acima. Um unico arquivo fora do lote reprova a tarefa inteira,
e a sua branch fica de fora da integracao junto com tudo que voce acertou.

Pode haver outro agente na sua onda, escrevendo neste mesmo repositorio agora, em outro worktree.
Cada linha sua que vaza para fora do lote e uma colisao que alguem vai ter de resolver a mao, mais
tarde, sem o contexto que voce tem.

Quanto custa um \`## Blocked\`: nada para o que voce ja fez. Ele nao reprova a tarefa e nao segura
a sua branch; ele vira tarefa nova na onda seguinte, com o seu texto como descricao. Quanto custa
improvisar fora do lote: a tarefa toda.

## Piso visual

${floor.trim()}

## Tema

${theme.trim()}

O tema acima e a especificacao, nao o arquivo. \`tokens.css\` e um arquivo do repo, e mexe nele o
dono do lote que o contem — se nao e voce, o caminho e \`## Blocked\`, nunca um hex inventado na
sua folha de estilo.

## Convenções do repositorio alvo

${conventions || '(nenhum AGENTS.md, CLAUDE.md ou TECHNICAL_GUIDELINES.md na raiz do repo alvo)'}

Sao as regras de quem ja mora ali: siga-as no que elas decidem localmente (nome de arquivo,
ordem de imports, como se monta um componente). Nenhuma delas suspende o piso visual acima — o
que reprova a tarefa e a gate do piso, e ela roda o mesmo para todo mundo.

## Como terminar

1. Commit no seu worktree, na branch \`${run.branch}\`. \`git add\` so dos arquivos do seu lote.
   Nunca merge, nunca push, nunca crie branch, nunca rode git fora de ${run.workDir}.
2. Escreva \`${run.reportPath}\`. Esse caminho absoluto e o unico lugar de onde o orquestrador le o
   seu resultado — nao existe "me conte no final". Use caminhos absolutos em toda ferramenta:
   voce nao sabe em qual diretario o seu processo abriu.
3. Se uma das quatro linhas marcadas com id de regra no piso aparecer no seu CSS (gradiente roxo,
   eyebrow em caps com tracking largo, espacamento fora do ritmo de 4, hex fora dos tokens), a
   gate reprova a tarefa antes de qualquer humano ler seu trabalho. Corrija agora, nao "depois".
4. O report tem exatamente a forma abaixo. Os titulos comecam na coluna zero, sem recuo, sem
   traduzir, sem \`###\`:

\`\`\`
## Summary
<o que voce fez, em ate 3 linhas>
- touched: <csv dos arquivos que voce tocou, escritos como aparecem no git>
- tokens: <numero aproximado de tokens de LLM gastos nesta tarefa — nao os tokens de design>
## Notes
<opcional>
## Blocked
<opcional; obrigatorio se algo ficou fora do seu lote>
\`\`\`

\`touched\` nao e o que a gate confere: a gate compara o diff real do git com a lista de diretorios
do seu lote, e nao com esta linha. O \`finish\` devolve o \`touched\` real, recomposto do git; o que
voce declarou aqui em cima e o dado que o orquestrador le para decidir a proxima onda — conferir
uma lista contra a outra ainda nao e codigo deste build. Declare o que voce tocou de verdade, mesmo
assim: quando o attempt fecha, este report e a unica coisa que sobra de voce para explicar o diff a
quem nao estava aqui.
`;
}

// Imutável porque é a primitiva de recuperação, não uma economia de disco: `run.js` relê este
// arquivo para saber o que um worker morto recebeu. Um prompt reescrito "só para corrigir uma
// palavra" apaga a única evidência de por que o agente fez o que fez — e um re-run precisa de
// `attempt-N+1`, com o texto novo, ao lado do texto velho.
export function writePrompt({ runDir, taskId, attempt, text }) {
  const dir = join(runDir, 'tasks', taskId, `attempt-${attempt}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'prompt.md');
  if (existsSync(file)) throw new Error(`prompt imutavel: ${file} ja existe — use attempt-${attempt + 1}`);
  writeFileSync(file, text);
  return file;
}
