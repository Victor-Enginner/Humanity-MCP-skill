// lib/gate.js — o único módulo da suíte que roda comando de shell, e o único controle de
// qualidade de M1 que não depende de modelo.
//
// Custo decidido sobre o alvo real (`libra`), corrigindo a spec §6 para o M1: a gate de TAREFA não
// roda toolchain nenhuma — só scope + sloplint, que são leitura de memória. Worktree git não leva
// `node_modules`, então build por tarefa sairia em erro falso ou obrigaria três `bun install`
// paralelos, e o custo do swarm passaria a ser instalar dependência. O build roda UMA vez por
// ONDA, na worktree de integração, dentro de `gateWave`.
import { execSync } from 'node:child_process';
import { lintFiles } from './sloplint.js';

const VERIFY_TIMEOUT_MS = 300_000;
const OUTPUT_CAP = 4000;
const MAX_BUFFER = 16 * 1024 * 1024;

// Recorta pela CAUDA: num build, o que importa é o fim (o erro e a última linha antes dele), e é
// o pedaço que cabe no ledger. Recortar cada stream antes de juntar é o que impede uma saída de
// 16 MB de virar uma string de 48 MB só para ser jogada fora.
const tail = (s) => String(s ?? '').slice(-OUTPUT_CAP);

// O terceiro argumento existe só para o teste afirmar o caminho de timeout sem esperar 5 minutos;
// `gateWave` (e o CLI da Task 9) passam dois argumentos e ficam com VERIFY_TIMEOUT_MS.
export function runVerify(cmd, cwd, timeoutMs = VERIFY_TIMEOUT_MS) {
  try {
    // stdin 'ignore': gate automática não pode travar esperando resposta de um comando que pergunta
    // alguma coisa — `execSync` congela o processo inteiro até o timeout, e o timeout é de 5 min.
    // encoding 'utf8' é o da saída do toolchain (node/bun/python escrevem utf8 no pipe); só as
    // mensagens próprias do cmd.exe ("não é reconhecido") chegam no codepage OEM e saem tortas.
    const out = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    });
    return { rc: 0, output: tail(out) };
  } catch (e) {
    // rc nunca vem de suposição: saída capturada é a do comando, e só se recorre à mensagem do
    // Node quando o comando não escreveu nada (cwd inexistente, timeout, saída estourada).
    const saida = [tail(e.stdout), tail(e.stderr)].filter(Boolean).join('\n');
    return { rc: rcDe(e), output: tail(saida || e.message) };
  }
}

// No Windows o `execSync` com `timeout` NÃO devolve 124: ele mata o cmd.exe e o erro chega com
// `status: null` e `code: 'ETIMEDOUT'` (medido nesta máquina). Sem este mapeamento, timeout
// chegaria como rc 1 → estado `failed`, e o operador não distinguiria "o build falhou" de "o
// build não terminou" — e é 124 que o ledger da Task 9/12 chama de `timeout`.
function rcDe(e) {
  if (e.code === 'ETIMEDOUT') return 124;
  return typeof e.status === 'number' ? e.status : 1;
}

export function gateTask({ scope, cssEntries }) {
  // `line: null` porque o achado não vem de CSS: aponta para um arquivo do diff, não para uma
  // declaração. Um número de linha inventado ali seria lido como localização pelo critic.
  const findings = scope.violations.map((v) => ({
    id: 'SCOPE-OUTSIDE-LOT',
    file: v.file,
    line: null,
    message: v.reason,
  }));
  findings.push(...lintFiles(cssEntries));
  return { level: 'task', ok: findings.length === 0, findings };
}

export function gateWave({ dir, verify, cssEntries }) {
  const findings = lintFiles(cssEntries);
  // `build: null` é a terceira coisa possível, e precisa continuar visível: "a onda não declarou
  // build" não é "o build rodou e passou". Um verify em branco é tratado como não declarado.
  const cmd = typeof verify === 'string' ? verify.trim() : '';
  const build = cmd ? runVerify(cmd, dir) : null;
  return { level: 'wave', ok: (build === null || build.rc === 0) && findings.length === 0, findings, build };
}
