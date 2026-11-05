// lib/gate.js — o único módulo da suíte que roda comando de shell, e o único controle de
// qualidade de M1 que não depende de modelo.
//
// Custo decidido sobre o alvo real (`libra`), corrigindo a spec §6 para o M1: a gate de TAREFA não
// roda toolchain nenhuma — só scope + sloplint, que são leitura de memória. Worktree git não leva
// `node_modules`, então build por tarefa sairia em erro falso ou obrigaria três `bun install`
// paralelos, e o custo do swarm passaria a ser instalar dependência. O build roda UMA vez por
// ONDA, na worktree de integração, dentro de `gateWave`.
//
// A gate é DONA do temporizador do build: `spawn` + `setTimeout` nosso, nunca `execSync`. Com
// `execSync(..., { timeout })` o timeout mata o `cmd.exe` e deixa o build vivo — medido nesta
// máquina, um filho que escreve um arquivo 1,5 s depois do início foi escrito DEPOIS de a gate já
// ter devolvido rc 124 em 317 ms. Um build zumbi na worktree de integração faz o `integrate`
// seguinte rodar dois builds no mesmo diretório.
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { lintFiles } from './sloplint.js';

const VERIFY_TIMEOUT_MS = 300_000;
const OUTPUT_CAP = 4000;
// Janela que se mantém em memória enquanto o build fala. Sem `maxBuffer` (a saída agora é
// streaming, não um buffer único), é isto que impede um build de 18 MB de virar uma string de
// 18 MB só para ser jogada fora — e um build barulhento que termina em 0 continua sendo 0.
const JANELA_MEMORIA = 4 * OUTPUT_CAP;
// Depois de matar a árvore, ou de o filho sair, é o tempo máximo que a gate ainda espera os pipes
// fecharem. Um neto zumbi segurando o stdio atrasaria o `close` para sempre, e nenhuma rota da
// gate pode passar do timeout além desta graça.
const GRACA_MS = 2_000;

const tail = (s) => String(s ?? '').slice(-OUTPUT_CAP);

// Decoder por stream: um caractere UTF-8 partido ao meio entre dois chunks não pode virar U+FFFD
// no registro do ledger. Só as mensagens do próprio cmd.exe chegam no codepage OEM (e saem com
// "n?o") — decodifica-se como o toolchain escreve, e não há aqui o que "otimizar".
function coleta() {
  const dec = new StringDecoder('utf8');
  let acum = '';
  return {
    add(chunk) {
      acum += dec.write(chunk);
      if (acum.length > 2 * JANELA_MEMORIA) acum = acum.slice(-JANELA_MEMORIA);
    },
    fim() {
      acum += dec.end();
      return acum.slice(-OUTPUT_CAP);
    },
  };
}

// Melhor esforço, e nunca lança: se o kill falhar, a gate ainda responde rc 124 — o que não pode
// acontecer é o timeout virar exceção dentro de `integrate`.
function mataArvore(child) {
  try {
    if (child.pid === undefined) return;
    if (process.platform !== 'win32') {
      child.kill('SIGKILL');
      return;
    }
    // `spawnSync` SEM `shell`: passando por shell, o Git Bash lê `/F` como caminho e o kill não
    // roda. E se o `taskkill` não estiver ao alcance (PATH quebrado), ainda vale matar o shell.
    const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    if (r.error) child.kill('SIGKILL');
  } catch {
    // nada a fazer: o rc 124 é a resposta, com ou sem kill confirmado.
  }
}

// O terceiro argumento existe só para o teste afirmar o caminho de timeout sem esperar 5 minutos;
// `gateWave` (e o CLI da Task 9) passam dois argumentos e ficam com VERIFY_TIMEOUT_MS.
export function runVerify(cmd, cwd, timeoutMs = VERIFY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      // stdin 'ignore': gate automática não pode travar esperando resposta de um comando que
      // pergunta alguma coisa. `windowsHide`: sem isto o cmd.exe abre janela no desktop de quem
      // roda o swarm.
      child = spawn(cmd, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ rc: 1, output: tail((e && e.message) || e), timedOut: false });
      return;
    }
    const stdout = coleta();
    const stderr = coleta();
    let temporizador = null;
    let graca = null;
    let respondido = false;
    let saidaDoFilho = null;
    let timeout = false;

    // `timedOut` é campo, não o número: um comando que sai 124 por conta própria não é timeout, e
    // o estado `timeout` do ledger mentiria. O rc continua 124 porque é a convenção do ledger.
    const responde = (rc, motivo) => {
      if (respondido) return;
      respondido = true;
      clearTimeout(temporizador);
      clearTimeout(graca);
      const texto = [stdout.fim(), stderr.fim()].filter(Boolean).join('\n');
      resolve({ rc, output: tail(texto || motivo), timedOut: timeout });
    };
    const rcDoFilho = () => (saidaDoFilho === null ? 1 : (saidaDoFilho.code ?? 1));
    const motivoTimeout = () => `o build nao terminou em ${timeoutMs}ms e a arvore foi morta`;
    // Uma única graça por execução: arma no `exit`, e se o temporizador cair depois disso ele não
    // marca um segundo prazo por cima do primeiro (o mais cedo é o que resolve).
    const armaGraca = (rc, motivo) => {
      if (graca === null) graca = setTimeout(() => responde(rc, motivo), GRACA_MS);
    };

    child.stdout.on('data', (b) => stdout.add(b));
    child.stderr.on('data', (b) => stderr.add(b));
    // O rc vem do filho, não do pipe: um EPIPE de um build que fecha o próprio stdout não pode
    // derrubar o processo do swarm nem deixar a promessa pendurada sem resposta.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    // ENOENT, cwd inexistente: o comando não rodou. rc 1 com o motivo na saída, exatamente como
    // era com `execSync` — e nunca uma exceção saindo da gate.
    child.on('error', (e) => responde(1, (e && e.message) || String(e)));

    child.on('exit', (code, signal) => {
      saidaDoFilho = { code, signal };
      // Depois do kill resolve-se no `exit`, não no `close`: um neto que ficou com o stdio herdado
      // seguraria o `close` e a gate esperaria por um processo que ela já matou.
      if (timeout) {
        responde(124, motivoTimeout());
        return;
      }
      // E no caminho normal a mesma razão: o `close` é o que traz a saída inteira, mas quem segura
      // o pipe pode ser um neto — então o `exit` também arma a sua própria graça.
      armaGraca(rcDoFilho(), '');
    });

    child.on('close', () => {
      if (timeout) responde(124, motivoTimeout());
      else responde(rcDoFilho(), '');
    });

    temporizador = setTimeout(() => {
      if (saidaDoFilho !== null) {
        // O build terminou sozinho; o que ainda não fecharam foram os pipes. Matar a árvore aqui
        // reportaria timeout de um build que rodou até o fim.
        armaGraca(rcDoFilho(), '');
        return;
      }
      timeout = true;
      mataArvore(child);
      armaGraca(124, motivoTimeout());
    }, timeoutMs);
  });
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

// `async` porque espera o build que ela própria mata no timeout — e é a única função da suíte que
// precisa esperar: `gateTask` continua síncrona.
export async function gateWave({ dir, verify, cssEntries }) {
  const findings = lintFiles(cssEntries);
  // `build: null` é a terceira coisa possível, e precisa continuar visível: "a onda não declarou
  // build" não é "o build rodou e passou". Um verify em branco é tratado como não declarado.
  const cmd = typeof verify === 'string' ? verify.trim() : '';
  const build = cmd ? await runVerify(cmd, dir) : null;
  return { level: 'wave', ok: (build === null || build.rc === 0) && findings.length === 0, findings, build };
}
