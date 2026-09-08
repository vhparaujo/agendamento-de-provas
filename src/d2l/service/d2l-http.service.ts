import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  carregarD2lApiConfig,
  D2lApiConfig,
  faltandoParaApi,
} from '../config/d2l.config';
import { D2lOauthService } from './d2l-oauth.service';

/**
 * ============================================================================
 * O CANAL HTTP COM A VALENCE — um so, para os dois usos
 * ============================================================================
 * Extraido de `D2lEnrollmentsService` em 18/08/2026, quando a troca de senha dos
 * questionarios passou a precisar de **PUT** (o `pedir` de la era privado e so
 * fazia GET).
 *
 * As alternativas eram piores:
 *  - generalizar o `pedir` do enrollments faria o servico de MATRICULAS tambem
 *    fazer quizzes, num arquivo que ja tem 600 linhas;
 *  - dar ao servico de quizzes um helper proprio duplicaria a montagem de URL, o
 *    Bearer e a traducao de erro — e criaria DUAS politicas de 429 batendo no
 *    mesmo tenant, cada uma sem saber da outra.
 *
 * ⚠️ **`atrasoMs` e `retentar429` sao OPT-IN POR CHAMADA, nunca default.**
 * E isso que mantem esta extracao segura: o portal do aluno (enrollments) chama
 * sem eles e continua com o mesmo timeout de 15s, sem espera e sem retry —
 * nenhum comportamento do caminho critico mudou. Quem liga o freio e so o lote
 * de senhas, que pode se dar ao luxo de ser lento.
 */

/** A Valence e externa: sem limite, um travamento dela trava o portal. */
const TIMEOUT_PADRAO_MS = 15_000;

/**
 * Teto da espera pedida por um 429.
 *
 * O CLI de origem obedecia qualquer `Retry-After`. Um `Retry-After: 3600` (que a
 * D2L pode mandar) travaria o lote inteiro por uma hora dentro de uma janela de
 * tolerancia de 30 minutos — pior que falhar e ser reprocessado.
 */
const TETO_RETRY_AFTER_MS = 60_000;

export interface OpcoesChamadaD2L {
  /** GET por default: e o que 90% das chamadas fazem. */
  metodo?: 'GET' | 'PUT' | 'POST';
  corpo?: unknown;
  query?: Record<string, string>;
  /** Entra na mensagem de erro: "nao foi possivel ler {oQue} no Brightspace". */
  oQue: string;
  /**
   * Inverte o significado do 404 para UMA chamada: em vez de "id errado no
   * cadastro", passa a ser "nao existe", devolvido como `null`.
   */
  nuloEm404?: boolean;
  /** O que a mensagem de 404 recomenda. Sem isto, o texto fica generico. */
  dicaDe404?: string;
  /** Espera ANTES da chamada. Só o lote usa — o portal do aluno nao pode pagar. */
  atrasoMs?: number;
  /** 1 retry honrando o `Retry-After`. Só o lote usa. */
  retentar429?: boolean;
  timeoutMs?: number;
}

/**
 * O tenant respondeu, e recusou.
 *
 * Existe para separar **"esta leitura nao vai funcionar nunca"** de **"a rede
 * falhou agora"** — duas coisas que a mensagem de erro conta e nenhum `catch`
 * conseguia distinguir sem comparar string. Um 4xx e determinístico: repetir a
 * mesma chamada da mesma forma da o mesmo resultado, e quem depende dela pode
 * parar de tenta-la. Um 5xx ou um timeout, nao.
 *
 * Continua sendo `BadGatewayException`: para quem so quer devolver o erro ao
 * cliente, nada mudou. O `statusHttp` e para quem precisa DECIDIR.
 */
export class RecusaDoBrightspace extends BadGatewayException {
  constructor(
    mensagem: string,
    readonly statusHttp: number,
  ) {
    super(mensagem);
  }
}

/** O tenant recusou de forma determinística: repetir nao muda o resultado. */
export function recusaDefinitiva(erro: unknown): boolean {
  return (
    erro instanceof RecusaDoBrightspace &&
    erro.statusHttp >= 400 &&
    erro.statusHttp < 500
  );
}

@Injectable()
export class D2lHttpService {
  private readonly logger = new Logger(D2lHttpService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly oauth: D2lOauthService,
  ) {}

  /** Enquanto `false`, nenhuma chamada de rede deve sair. */
  habilitado(): boolean {
    const cfg = carregarD2lApiConfig(this.config);
    return cfg.habilitado && faltandoParaApi(cfg).length === 0;
  }

  /**
   * A configuracao, ou uma recusa que diz o que falta.
   *
   * Chamar com a integracao desligada e erro de PROGRAMACAO: quem chama deve
   * consultar `habilitado()` antes e escolher o outro caminho.
   */
  exigirConfigurado(): D2lApiConfig {
    const cfg = carregarD2lApiConfig(this.config);
    const faltando = faltandoParaApi(cfg);

    if (!cfg.habilitado || faltando.length > 0) {
      throw new BadGatewayException(
        'Integracao D2L desligada ou incompleta' +
          (faltando.length ? `: faltam ${faltando.join(', ')}` : '.'),
      );
    }

    return cfg;
  }

  /**
   * A URL de um recurso.
   *
   * A versao acompanha o PRODUTO: `lp` e `le` numeram separado e um numero
   * valido num deles pode nao existir no outro — ver D2L_API_VERSION_LP_PADRAO.
   */
  url(
    cfg: D2lApiConfig,
    produto: 'lp' | 'le',
    caminho: string,
    query: Record<string, string> = {},
  ): string {
    const parametros = new URLSearchParams(query).toString();
    const versao = produto === 'lp' ? cfg.apiVersaoLp : cfg.apiVersaoLe;

    return (
      `${cfg.baseUrl}/d2l/api/${produto}/${versao}/${caminho}` +
      (parametros ? `?${parametros}` : '')
    );
  }

  /**
   * As sobrecargas existem para que so quem passa `nuloEm404` precise tratar o
   * `null` — os outros chamadores continuam com o tipo nao-nulavel.
   */
  async chamarUrl<T>(url: string, opcoes: OpcoesChamadaD2L): Promise<T>;
  async chamarUrl<T>(
    url: string,
    opcoes: OpcoesChamadaD2L & { nuloEm404: true },
  ): Promise<T | null>;
  async chamarUrl<T>(url: string, opcoes: OpcoesChamadaD2L): Promise<T | null> {
    return this.executar<T>(url, opcoes, 0);
  }

  /**
   * O corpo real da chamada. Separado das sobrecargas publicas porque a
   * recursao do retry precisa passar `tentativa`, e uma sobrecarga nao
   * expoe esse parametro — nem deveria: contar tentativas e assunto interno.
   */
  private async executar<T>(
    url: string,
    opcoes: OpcoesChamadaD2L,
    tentativa: number,
  ): Promise<T | null> {
    const metodo = opcoes.metodo ?? 'GET';

    // Rate limiting PROATIVO: esperar antes e mais barato que ser recusado e
    // ter de voltar. So o lote pede isto.
    if (opcoes.atrasoMs && opcoes.atrasoMs > 0) {
      await D2lHttpService.dormir(opcoes.atrasoMs);
    }

    const token = await this.oauth.obterAccessToken();

    let resposta: Response;

    try {
      resposta = await fetch(url, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${token.valor}`,
          Accept: 'application/json',
          ...(opcoes.corpo === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(opcoes.corpo === undefined
          ? {}
          : { body: JSON.stringify(opcoes.corpo) }),
        signal: AbortSignal.timeout(opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS),
      });
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);

      throw new BadGatewayException(
        `Nao foi possivel ${this.verbo(metodo)} ${opcoes.oQue} no Brightspace: ${motivo}`,
      );
    }

    if (resposta.status === 429 && opcoes.retentar429 && tentativa === 0) {
      const espera = D2lHttpService.esperaDo429(resposta);

      this.logger.warn(
        `429 do Brightspace ao ${this.verbo(metodo)} ${opcoes.oQue}: ` +
          `aguardando ${Math.round(espera / 1000)}s e tentando de novo.`,
      );

      await D2lHttpService.dormir(espera);
      return this.executar<T>(url, opcoes, tentativa + 1);
    }

    if (!resposta.ok) {
      const corpo = (await resposta.text().catch(() => '')).slice(0, 300);

      if (resposta.status === 404 && opcoes.nuloEm404) return null;

      if (resposta.status === 404) {
        throw new BadGatewayException(
          `O Brightspace nao encontrou ${opcoes.oQue} (404).` +
            (opcoes.dicaDe404 ? ` ${opcoes.dicaDe404}` : ''),
        );
      }

      throw new RecusaDoBrightspace(
        `O Brightspace recusou a ${this.substantivo(metodo)} de ${opcoes.oQue} ` +
          `(HTTP ${resposta.status}). ${corpo}`.trim(),
        resposta.status,
      );
    }

    if (resposta.status === 204) return null;

    // GET sempre traz JSON, e o `json()` cru preserva exatamente o
    // comportamento que o enrollments tinha antes desta extracao — inclusive
    // estourar se a resposta vier malformada, que e informacao, nao ruido.
    if (metodo === 'GET') return (await resposta.json()) as T;

    // Escrita e outra historia: `PUT .../quizzes/{id}` responde 200 com corpo
    // VAZIO neste tenant, e ali um `json()` sem rede estouraria DEPOIS de a
    // senha ja ter sido gravada — o pior lugar possivel para falhar.
    return (await resposta.json().catch(() => null)) as T;
  }

  /** Atalho: monta a URL a partir do produto e do caminho, e chama. */
  async chamar<T>(
    cfg: D2lApiConfig,
    produto: 'lp' | 'le',
    caminho: string,
    opcoes: OpcoesChamadaD2L,
  ): Promise<T> {
    return this.chamarUrl<T>(
      this.url(cfg, produto, caminho, opcoes.query),
      opcoes,
    );
  }

  private verbo(metodo: string): string {
    return metodo === 'GET' ? 'ler' : 'gravar';
  }

  private substantivo(metodo: string): string {
    return metodo === 'GET' ? 'leitura' : 'gravacao';
  }

  /**
   * Quanto esperar depois de um 429. Respeita o `Retry-After` (em segundos),
   * limitado pelo teto — ver TETO_RETRY_AFTER_MS.
   */
  private static esperaDo429(resposta: Response): number {
    const cabecalho = resposta.headers.get('retry-after');
    const segundos = Number(cabecalho);

    // `>= 0` e nao `> 0`: `Retry-After: 0` significa "pode tentar agora", e
    // trocar isso por 2s de espera inventaria lentidao que o servidor nao pediu.
    // Sem o cabecalho (NaN), 2s e um chute conservador.
    const pedido =
      Number.isFinite(segundos) && segundos >= 0 ? segundos * 1000 : 2_000;

    return Math.min(pedido, TETO_RETRY_AFTER_MS);
  }

  private static dormir(ms: number): Promise<void> {
    return new Promise((resolver) => setTimeout(resolver, ms));
  }
}
