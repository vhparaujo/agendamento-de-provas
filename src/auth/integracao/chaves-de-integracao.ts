import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * ============================================================================
 * AS CHAVES DOS SISTEMAS QUE CONSULTAM A API
 * ============================================================================
 * Modulo puro — sem Nest, sem `process.env` — para que a regra da chave seja
 * testavel sem subir aplicacao, e para que a validacao do `.env` e o guard leiam
 * o MESMO formato (`FORMATO_DAS_CHAVES`).
 *
 * POR QUE API KEY, e nao os JWTs que ja existem: o JWT do aluno nasce de um
 * launch LTI (ha uma pessoa logada no AVA) e so enxerga a propria matricula; o
 * do admin dura 15 minutos, exige login com senha e da acesso total. Quem chama
 * aqui e um servidor de outro sistema, sem ninguem logado, consultando qualquer
 * RA — precisa de uma credencial que abra SO as rotas de integracao.
 *
 * O formato e `sistema:chave[,sistema:chave]`:
 *
 * - o NOME identifica quem chamou na auditoria, sem nunca escrever a chave;
 * - MAIS DE UMA entrada com o mesmo nome e a ROTACAO: a chave nova entra, o
 *   outro lado troca, a antiga sai — sem janela em que nenhuma das duas vale.
 */

/** Minusculo: e assim que o Express entrega os headers. */
export const CABECALHO_DA_CHAVE = 'x-api-key';

/**
 * 32 caracteres. `openssl rand -hex 32` produz 64, e e o que o `.env.example`
 * sugere; o piso existe para recusar no boot uma chave "teste123" que alguem
 * esqueceu no servidor.
 */
export const TAMANHO_MINIMO_DA_CHAVE = 32;

/**
 * Sem espaco, virgula ou dois-pontos na chave: sao os separadores do proprio
 * formato, e um deles dentro da chave a partiria em silencio.
 */
const ENTRADA = `[A-Za-z0-9_-]{1,40}:[^\\s,:]{${TAMANHO_MINIMO_DA_CHAVE},}`;

/** Vazio e valido: significa integracao desligada (fail-closed no guard). */
export const FORMATO_DAS_CHAVES = new RegExp(
  `^(|\\s*${ENTRADA}\\s*(,\\s*${ENTRADA}\\s*)*)$`,
);

export interface ChaveDeIntegracao {
  sistema: string;
  /**
   * O SHA-256 da chave, e nao a chave. Comparar hashes de tamanho fixo e o que
   * permite `timingSafeEqual` — que recusa buffers de tamanhos diferentes, e
   * comparar a chave crua vazaria o tamanho dela pelo tempo de resposta.
   */
  hash: Buffer;
}

export function lerChaves(valor: string | undefined): ChaveDeIntegracao[] {
  const texto = (valor ?? '').trim();

  if (!texto) return [];

  // O `.env` ja e validado no boot com este mesmo formato; a checagem repetida
  // aqui e para quem instancia o guard por outro caminho (o teste, um script).
  if (!FORMATO_DAS_CHAVES.test(texto)) {
    throw new Error(
      'INTEGRACAO_API_KEYS fora do formato `sistema:chave[,sistema:chave]` ' +
        `(chaves com ao menos ${TAMANHO_MINIMO_DA_CHAVE} caracteres).`,
    );
  }

  return texto.split(',').map((bruta) => {
    const entrada = bruta.trim();
    const separador = entrada.indexOf(':');

    return {
      sistema: entrada.slice(0, separador),
      hash: hashDe(entrada.slice(separador + 1)),
    };
  });
}

/**
 * O nome do sistema dono da chave recebida, ou `undefined`.
 *
 * Percorre TODAS as chaves mesmo depois de achar a certa: parar no primeiro
 * acerto faria a resposta de uma chave valida sair mais rapido que a de uma
 * invalida, conforme a posicao dela na lista.
 */
export function identificarSistema(
  recebida: string | undefined,
  chaves: readonly ChaveDeIntegracao[],
): string | undefined {
  if (!recebida) return undefined;

  const hash = hashDe(recebida);
  let sistema: string | undefined;

  for (const chave of chaves) {
    if (timingSafeEqual(hash, chave.hash) && sistema === undefined) {
      sistema = chave.sistema;
    }
  }

  return sistema;
}

/** `INTEGRACAO_IPS_PERMITIDOS`, separados por virgula. Vazio = qualquer origem. */
export function lerIps(valor: string | undefined): string[] {
  return (valor ?? '')
    .split(',')
    .map((ip) => normalizarIp(ip.trim()))
    .filter(Boolean);
}

/**
 * Comparacao EXATA, sem faixa CIDR: o caso de uso e um servidor de IP fixo, e
 * uma faixa mal escrita liberaria uma rede inteira sem ninguem perceber.
 *
 * ⚠️ So funciona com `TRUST_PROXY` correto. Sem ele, todo mundo chega com o IP
 * do proxy — e liberar esse IP libera a internet inteira.
 */
export function ipPermitido(
  ip: string | undefined,
  permitidos: readonly string[],
): boolean {
  if (permitidos.length === 0) return true;
  if (!ip) return false;

  return permitidos.includes(normalizarIp(ip));
}

function hashDe(chave: string): Buffer {
  return createHash('sha256').update(chave, 'utf8').digest();
}

/**
 * O Node entrega IPv4 como IPv6 mapeado ("::ffff:10.0.0.5") quando escuta em
 * dual stack. Sem normalizar, quem cadastrasse "10.0.0.5" seria recusado.
 */
function normalizarIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}
