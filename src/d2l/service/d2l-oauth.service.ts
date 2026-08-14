import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import {
  carregarD2lOauthConfig,
  D2lOauthConfig,
  faltandoParaOauth,
  faltandoParaRefresh,
} from '../config/d2l.config';

/** Resposta do token endpoint do Brightspace (campos que nos interessam). */
interface RespostaToken {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface ResultadoAutorizacao {
  expiraEmSegundos: number;
  escopos: string;
  refreshTokenGravado: boolean;
  /** Presente so fora de producao — ver comentario em `montarResultado`. */
  accessToken?: string;
}

/** Access token pronto para uso nas chamadas REST da Valence. */
export interface AccessTokenD2L {
  valor: string;
  expiraEm: Date;
  escopos: string;
}

/** O token endpoint e externo: sem limite, um travamento dele trava a rota. */
const TIMEOUT_MS = 15_000;

/**
 * Margem de seguranca para considerar o token em cache ainda valido.
 *
 * Sem ela, um token com 2s de vida passaria na checagem e expiraria no meio da
 * chamada seguinte — o erro apareceria como 401 da Valence, longe da causa.
 */
const MARGEM_EXPIRACAO_MS = 60_000;

/** Qual fluxo pediu o token: muda a acao que a mensagem de erro recomenda. */
type Fluxo = 'code' | 'refresh';

@Injectable()
export class D2lOauthService {
  private readonly logger = new Logger(D2lOauthService.name);

  /** Access token vivo. Em memoria de proposito: expira em 1h e nao vale o banco. */
  private cache?: { valor: string; expiraEmMs: number; escopos: string };

  /**
   * Renovacao em andamento.
   *
   * Existe por causa da ROTACAO: cada refresh emite um token novo e invalida o
   * anterior. Duas chamadas concorrentes com o mesmo refresh token fariam a
   * segunda receber `invalid_grant` — e, pior, a primeira ja teria gravado o
   * substituto por cima. Compartilhar a promessa garante uma renovacao por vez.
   *
   * Isso resolve o processo atual. Se um dia rodarem varias instancias, a
   * exclusao precisa subir para o banco (SELECT ... FOR UPDATE na linha 1), como
   * ja e feito na alocacao de vagas.
   */
  private renovacaoEmVoo?: Promise<AccessTokenD2L>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Troca o `code` do callback por access + refresh token e PERSISTE o refresh.
   *
   * A persistencia acontece aqui, e nao em quem chama, porque e a unica coisa
   * desta rota que nao pode ser refeita: o `code` e de uso unico. Se o refresh
   * token so aparecesse na resposta HTTP e o admin fechasse a aba, a unica saida
   * seria repetir a autorizacao inteira no Brightspace.
   */
  async trocarCodigoPorTokens(code: string): Promise<ResultadoAutorizacao> {
    const cfg = carregarD2lOauthConfig(this.config);
    this.exigirConfig(faltandoParaOauth(cfg));

    const dados = await this.pedirToken(
      cfg,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
      },
      'code',
    );

    const gravado = await this.guardarRefreshToken(dados.refresh_token);
    this.guardarNoCache(dados);

    this.auditoria.registrar('D2L_AUTORIZACAO_OK', {
      detalhe: `escopos=${dados.scope ?? '(nao informados)'} refreshTokenGravado=${gravado}`,
    });

    return this.montarResultado(dados, gravado);
  }

  /**
   * Ha refresh token gravado? E o que separa "integracao configurada" de
   * "integracao que funciona".
   *
   * Existe para o `/health`: `D2lEnrollmentsService.habilitado()` so le o .env, e
   * responde `true` num ambiente que nunca foi autorizado — exatamente o estado
   * em que todo agendamento falha. Sem esta consulta nao havia como monitorar a
   * diferenca, e ela so aparecia quando um aluno tentava agendar.
   *
   * NAO renova nem valida o token contra o Brightspace de proposito: o /health e
   * consultado pelo healthcheck do compose a cada 30s, e cada renovacao ROTACIONA
   * o refresh — monitorar acabaria gastando a credencial que monitora.
   */
  async autorizado(): Promise<boolean> {
    const guardado = await this.prisma.integracaoD2L.findUnique({
      where: { id: 1 },
    });

    return Boolean(guardado?.refreshToken);
  }

  /**
   * O access token para falar com a Valence — a porta de entrada de todo o resto
   * da integracao.
   *
   * Reaproveita o token em cache enquanto ele durar e so entao usa o refresh
   * gravado. Renovar a toa nao seria so desperdicio de rede: cada renovacao
   * ROTACIONA o refresh token, e uma rotacao que falhe no meio deixa a
   * integracao sem acesso ate alguem reautorizar no browser.
   */
  async obterAccessToken(): Promise<AccessTokenD2L> {
    const emCache = this.cache;

    if (emCache && emCache.expiraEmMs - MARGEM_EXPIRACAO_MS > Date.now()) {
      return {
        valor: emCache.valor,
        expiraEm: new Date(emCache.expiraEmMs),
        escopos: emCache.escopos,
      };
    }

    this.renovacaoEmVoo ??= this.renovar().finally(() => {
      this.renovacaoEmVoo = undefined;
    });

    return this.renovacaoEmVoo;
  }

  private async renovar(): Promise<AccessTokenD2L> {
    const cfg = carregarD2lOauthConfig(this.config);
    this.exigirConfig(faltandoParaRefresh(cfg));

    const guardado = await this.prisma.integracaoD2L.findUnique({
      where: { id: 1 },
    });

    if (!guardado?.refreshToken) {
      throw new ServiceUnavailableException(
        'Nenhum refresh token gravado: a integracao com o D2L nunca foi autorizada. ' +
          'Autorize uma vez pelo browser (o redirect cai em GET /d2l/callback) — o passo a passo esta no README.',
      );
    }

    const dados = await this.pedirToken(
      cfg,
      { grant_type: 'refresh_token', refresh_token: guardado.refreshToken },
      'refresh',
    );

    // Grava ANTES de devolver: se o processo morrer entre a resposta e o commit,
    // o token que temos em memoria seria o unico valido no mundo e ele morre com
    // o processo — a integracao acordaria sem acesso e sem aviso.
    await this.guardarRefreshToken(dados.refresh_token);

    const token = this.guardarNoCache(dados);

    this.auditoria.registrar('D2L_TOKEN_RENOVADO', {
      detalhe: `expira em ${dados.expires_in ?? 0}s; escopos=${dados.scope ?? '(nao informados)'}`,
    });

    return token;
  }

  /** A chamada ao token endpoint, comum aos dois fluxos. */
  private async pedirToken(
    cfg: D2lOauthConfig,
    parametros: Record<string, string>,
    fluxo: Fluxo,
  ): Promise<RespostaToken> {
    const corpo = new URLSearchParams({
      ...parametros,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });

    let resposta: Response;

    try {
      resposta = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: corpo,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);
      this.auditarFalha(fluxo, `falha de rede no token endpoint: ${motivo}`);

      throw new BadGatewayException(
        `Nao foi possivel falar com o token endpoint do Brightspace: ${motivo}`,
      );
    }

    const dados = (await resposta.json().catch(() => ({}))) as RespostaToken;

    if (!resposta.ok || !dados.access_token) {
      throw this.recusar(resposta.status, dados, fluxo);
    }

    return dados;
  }

  /**
   * O refresh token e o que faz a integracao sobreviver a restart — e o .env NAO
   * serve para guarda-lo: cada refresh emite um token novo e invalida o anterior,
   * entao um valor em arquivo vira lixo no primeiro uso (armadilha documentada em
   * docs/D2L_API_REFERENCE.md §2.2). Por isso a tabela de uma linha so.
   *
   * O fluxo de client credentials nao devolve refresh token; nesse caso nao ha o
   * que gravar, e isso nao e erro.
   */
  private async guardarRefreshToken(token?: string): Promise<boolean> {
    if (!token) {
      this.logger.warn(
        'O Brightspace nao devolveu refresh_token — a integracao so tera acesso enquanto o access token durar.',
      );
      return false;
    }

    await this.prisma.integracaoD2L.upsert({
      where: { id: 1 },
      update: { refreshToken: token },
      create: { id: 1, refreshToken: token },
    });

    return true;
  }

  private guardarNoCache(dados: RespostaToken): AccessTokenD2L {
    const expiraEmMs = Date.now() + (dados.expires_in ?? 0) * 1000;

    this.cache = {
      valor: dados.access_token!,
      expiraEmMs,
      escopos: dados.scope ?? '',
    };

    return {
      valor: dados.access_token!,
      expiraEm: new Date(expiraEmMs),
      escopos: dados.scope ?? '',
    };
  }

  private exigirConfig(faltando: string[]): void {
    if (faltando.length > 0) {
      throw new ServiceUnavailableException(
        `Integracao D2L ainda nao configurada. Faltam no .env: ${faltando.join(', ')}`,
      );
    }
  }

  /**
   * O access token volta na resposta APENAS fora de producao.
   *
   * Ele e a ferramenta de trabalho desta etapa: com ele na mao da para paginar o
   * `orgstructure/?orgUnitType=103` e conferir os `descendants` por curl, sem
   * escrever cliente nenhum. Mas e uma credencial: em producao a rota confirma o
   * sucesso e nada mais, porque ali a autorizacao e feita uma vez por um humano e
   * quem usa o token e o servidor. Mesma linha de corte do `LTI_DEBUG_CLAIMS` e
   * do script token:aluno.
   */
  private montarResultado(
    dados: RespostaToken,
    refreshTokenGravado: boolean,
  ): ResultadoAutorizacao {
    const producao = this.config.get<string>('NODE_ENV') === 'production';

    return {
      expiraEmSegundos: dados.expires_in ?? 0,
      escopos: dados.scope ?? '',
      refreshTokenGravado,
      accessToken: producao ? undefined : dados.access_token,
    };
  }

  private auditarFalha(fluxo: Fluxo, detalhe: string): void {
    this.auditoria.registrar(
      fluxo === 'code'
        ? 'D2L_AUTORIZACAO_FALHOU'
        : 'D2L_TOKEN_RENOVACAO_FALHOU',
      { detalhe },
    );
  }

  /**
   * Traduz a recusa do Brightspace na ACAO que resolve. `invalid_grant` significa
   * coisas diferentes nos dois fluxos — no code, "refaca a autorizacao"; no
   * refresh, "o token gravado nao vale mais" —, e a mensagem crua do OAuth nao
   * distingue as duas.
   */
  private recusar(status: number, dados: RespostaToken, fluxo: Fluxo): Error {
    const erro = dados.error ?? `HTTP ${status}`;
    const descricao = dados.error_description ?? '';

    this.auditarFalha(
      fluxo,
      `token endpoint recusou: ${erro} ${descricao}`.trim(),
    );

    if (erro === 'invalid_grant') {
      // No refresh isto e o fim da linha sem intervencao humana: o token gravado
      // foi rotacionado por outro processo, revogado no Brightspace, ou o app
      // perdeu a autorizacao. Nenhum retry recupera.
      if (fluxo === 'refresh') {
        return new ServiceUnavailableException(
          'O refresh token gravado nao e mais valido (rotacionado, revogado ou expirado). ' +
            'E preciso reautorizar a integracao pelo browser — GET /d2l/callback recebe o novo code.',
        );
      }

      return new BadRequestException(
        'O code de autorizacao e invalido, expirado ou ja foi usado (ele vale uma vez so). ' +
          'Refaca a autorizacao no Brightspace para obter um novo.',
      );
    }

    // Cliente errado ou redirect_uri diferente do cadastrado: nenhum retry
    // resolve, o cadastro e o .env e que precisam bater.
    if (erro === 'invalid_client' || erro === 'invalid_request') {
      return new BadRequestException(
        `O Brightspace recusou a troca (${erro}${descricao ? `: ${descricao}` : ''}). ` +
          'Confira se D2L_CLIENT_ID, D2L_CLIENT_SECRET e D2L_REDIRECT_URI sao exatamente ' +
          'os do registro do aplicativo — o redirect_uri e comparado byte a byte.',
      );
    }

    return new BadGatewayException(
      `Resposta inesperada do token endpoint do Brightspace: ${erro}${descricao ? ` (${descricao})` : ''}`,
    );
  }
}
