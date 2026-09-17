import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { AlunoService } from '../../aluno/service/aluno.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { extrairCodigoDoTitulo } from '../../turma/service/turma-match';
import type { ContextoLaunch } from '../jwt/jwt.types';
import { AuthService } from '../service/auth.service';
import {
  CLAIM_BRIGHTSPACE,
  CLAIM_CONTEXT,
  CLAIM_DEPLOYMENT_ID,
  CLAIM_MESSAGE_TYPE,
  CLAIM_VERSION,
  carregarLtiConfig,
  lerPrimeiroClaim,
  LtiConfig,
} from './lti.config';
import { LtiCodeStore } from './lti-code.store';
import { LtiStateStore } from './lti-state.store';

/**
 * Por que o launch nao passou, no vocabulario do PORTAL — nao no do HTTP.
 *
 * E uma lista curta de proposito: e ela que viaja na URL do redirect, e a URL
 * vai para historico do navegador, log de proxy e header `Referer`
 * (docs/SEGURANCA-FRONTEND.md, secao 1). Entao ela nao carrega matricula, nome
 * de variavel de ambiente, nem nada do detalhe tecnico — quem escreve o texto
 * que o aluno le e o front, a partir deste codigo.
 *
 * O detalhe continua existindo: vai para o log da aplicacao e, nos casos que
 * envolvem uma pessoa identificada, para a auditoria (`LTI_LAUNCH_RECUSADO`).
 */
export type CodigoErroLaunch =
  /** 403 — matricula valida no LMS, mas ausente da base importada. */
  | 'sem-cadastro'
  /** 401 — id_token, state ou nonce invalidos; link reaberto fora do AVA. */
  | 'sessao-invalida'
  /** 400 — o launch chegou sem `id_token` ou sem `state`. */
  | 'dados-incompletos'
  /** 503 — faltam variaveis LTI_* no ambiente. Problema nosso, nao do aluno. */
  | 'indisponivel'
  /** Qualquer outra coisa — inesperado, e por isso vai para o log como erro. */
  | 'falha';

/**
 * De que status HTTP nasce cada codigo. Fora desta tabela, o erro e inesperado
 * por definicao — e vira `falha`, com stack no log.
 */
const CODIGO_POR_STATUS: Record<number, CodigoErroLaunch> = {
  [HttpStatus.BAD_REQUEST]: 'dados-incompletos',
  [HttpStatus.UNAUTHORIZED]: 'sessao-invalida',
  [HttpStatus.FORBIDDEN]: 'sem-cadastro',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'indisponivel',
};

export interface IniciacaoOidc {
  iss?: string;
  login_hint?: string;
  target_link_uri?: string;
  lti_message_hint?: string;
  client_id?: string;
  lti_deployment_id?: string;
}

export interface VinculoLaunch {
  alunoId: number;
  curso: string;
  ativo: boolean;
  modalidade: { codigo: string; nome: string; duracaoMinutos: number };
  polo: { id: number; nome: string };
}

export interface ResultadoLaunch {
  accessToken: string;
  expiraEm: string;
  matricula: string;
  nome: string | null;
  /**
   * true quando o RA tem mais de um curso: o portal deve perguntar de qual curso
   * e a prova antes de listar as faixas, e agendar um por vez.
   */
  precisaEscolherCurso: boolean;
  vinculos: VinculoLaunch[];
  /** Turma de onde o aluno clicou. Ausente se o Brightspace nao mandar o claim. */
  contexto?: ContextoLaunch;
}

@Injectable()
export class LtiService {
  private readonly logger = new Logger(LtiService.name);
  private jwksRemoto?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly config: ConfigService,
    private readonly stateStore: LtiStateStore,
    private readonly codeStore: LtiCodeStore,
    private readonly authService: AuthService,
    private readonly alunoService: AlunoService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Passo 1 do LTI 1.3: o Brightspace chama esta rota para iniciar o login OIDC.
   * Respondemos com um redirect para a tela de autorizacao dele, carregando um
   * `state` (nosso) e um `nonce` (que exigiremos de volta dentro do id_token).
   */
  iniciarLogin(params: IniciacaoOidc): string {
    const lti = this.exigirConfig();

    if (!params.login_hint) {
      throw new BadRequestException('login_hint ausente na iniciacao OIDC');
    }

    if (params.iss && params.iss !== lti.issuer) {
      throw new UnauthorizedException(
        `Issuer inesperado na iniciacao: ${params.iss}`,
      );
    }

    const { state, nonce } = this.stateStore.criar();

    const url = new URL(lti.authLoginUrl);
    url.searchParams.set('scope', 'openid');
    url.searchParams.set('response_type', 'id_token');
    url.searchParams.set('response_mode', 'form_post');
    url.searchParams.set('prompt', 'none');
    url.searchParams.set('client_id', params.client_id || lti.clientId);
    url.searchParams.set('redirect_uri', lti.redirectUri);
    url.searchParams.set('login_hint', params.login_hint);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);

    if (params.lti_message_hint) {
      url.searchParams.set('lti_message_hint', params.lti_message_hint);
    }

    return url.toString();
  }

  /**
   * Passo 2: o Brightspace devolve o id_token por form_post. Validamos
   * assinatura, issuer, audience, state e nonce ANTES de olhar qualquer dado —
   * e so entao cruzamos a matricula com o CSV de alunos.
   */
  async processarLaunch(
    idToken: string,
    state: string,
  ): Promise<ResultadoLaunch> {
    const lti = this.exigirConfig();

    if (!idToken) throw new BadRequestException('id_token ausente no launch');
    if (!state) throw new BadRequestException('state ausente no launch');

    const nonceEsperado = this.stateStore.consumir(state);
    if (!nonceEsperado) {
      throw new UnauthorizedException(
        'State invalido, expirado ou ja utilizado',
      );
    }

    const payload = await this.verificarIdToken(idToken, lti);

    if (payload.nonce !== nonceEsperado) {
      throw new UnauthorizedException('Nonce do id_token nao confere');
    }

    this.validarClaimsLti(payload, lti);

    const matricula = lerPrimeiroClaim(payload, lti.claimsMatricula);
    const userIdD2L = lerPrimeiroClaim(payload, lti.claimsUserId);

    if (lti.debugClaims) this.logarClaims(payload, matricula, userIdD2L);

    if (!matricula) {
      throw new UnauthorizedException(
        'Nao foi possivel identificar a matricula no launch LTI. ' +
          'Verifique LTI_CLAIM_MATRICULA (ative LTI_DEBUG_CLAIMS=true para ver os claims recebidos).',
      );
    }

    if (!userIdD2L) {
      this.auditoria.registrar('LTI_LAUNCH_RECUSADO', {
        ator: matricula,
        detalhe: `claim ${CLAIM_BRIGHTSPACE}::user_id ausente no id_token`,
      });

      throw new UnauthorizedException(
        'Nao foi possivel identificar o UserId do D2L no launch LTI. ' +
          `Ele vem no claim proprietario "${CLAIM_BRIGHTSPACE}" -> user_id; ` +
          'confira as security settings do deployment (nome, e-mail e org defined id ' +
          'liberados). Ative LTI_DEBUG_CLAIMS=true para ver os claims recebidos.',
      );
    }

    // O UserId do D2L e NUMERICO. Um valor com outro formato aqui quase sempre e
    // o `sub` opaco do LTI vindo por uma configuracao errada de LTI_CLAIM_USER_ID
    // — e o `sub` e recusado pela Valence API. Sem esta checagem o launch passaria
    // e a falha so apareceria ao liberar a prova, quando ja e tarde.
    if (!/^\d+$/.test(userIdD2L)) {
      this.auditoria.registrar('LTI_LAUNCH_RECUSADO', {
        ator: matricula,
        detalhe: 'UserId do D2L nao e numerico (provavel `sub` opaco do LTI)',
      });

      throw new UnauthorizedException(
        'O UserId do D2L recebido no launch nao e numerico e nao seria aceito pela ' +
          'Valence API. Verifique LTI_CLAIM_USER_ID — o `sub` do LTI nao serve.',
      );
    }

    // Um RA pode ter mais de um vinculo (um por curso) — todos vem aqui.
    const vinculos = await this.alunoService.buscarVinculos(matricula);

    if (vinculos.length === 0) {
      // Aluno fora do CSV: nao e "senha errada", e ausencia de cadastro. Sem a
      // linha do CSV nao ha como saber formato nem polo, entao nao da para
      // agendar mesmo com o launch valido.
      this.auditoria.registrar('LTI_LAUNCH_RECUSADO', {
        ator: matricula,
        detalhe: 'matricula sem vinculo na base importada',
      });

      throw new ForbiddenException(
        `Matricula ${matricula} nao encontrada na base de alunos importada. ` +
          'Procure a secretaria academica.',
      );
    }

    const contexto = this.lerContexto(payload);

    // STATUS CURSO nao bloqueia o LOGIN: mesmo um aluno com matricula cancelada
    // e reconhecido e ve uma mensagem clara, em vez de um "nao encontrado".
    // O bloqueio acontece no AGENDAMENTO, pelo `ativo` de cada vinculo (derivado
    // da lista em src/enums/status-curso.enum.ts).
    const { accessToken, expiraEm } = await this.authService.emitirTokenAluno({
      sub: vinculos[0].matricula,
      userIdD2L,
      vinculos: vinculos.map((v) => ({
        alunoId: v.id,
        curso: v.curso,
        modalidade: v.modalidade.codigo,
        poloId: v.poloId,
        ativo: v.ativo,
      })),
      contexto,
    });

    this.auditoria.registrar('LTI_LAUNCH_OK', {
      ator: vinculos[0].matricula,
      detalhe: `${vinculos.length} vinculo(s)`,
    });

    return {
      accessToken,
      expiraEm,
      matricula: vinculos[0].matricula,
      nome: vinculos[0].nome,
      precisaEscolherCurso: vinculos.length > 1,
      vinculos: vinculos.map((v) => ({
        alunoId: v.id,
        curso: v.curso,
        ativo: v.ativo,
        modalidade: {
          codigo: v.modalidade.codigo,
          nome: v.modalidade.nome,
          duracaoMinutos: v.modalidade.duracaoMinutos,
        },
        polo: { id: v.polo.id, nome: v.polo.nome },
      })),
      contexto,
    };
  }

  /**
   * Para onde mandar o navegador do aluno depois do launch.
   *
   * `undefined` quando `PORTAL_ALUNO_URL` nao esta configurada — nesse caso a
   * rota responde o JSON do launch, que e como se testa sem front.
   *
   * A URL carrega um CODIGO de uso unico, nunca o token: URL vai para historico
   * do navegador, log de proxy e header `Referer`
   * (docs/SEGURANCA-FRONTEND.md, secao 1). Quem troca o codigo pelo token e o
   * portal, num POST — ver `resgatarSessao`.
   */
  montarDestinoDoPortal(resultado: ResultadoLaunch): string | undefined {
    const destino = this.exigirConfig().portalAlunoUrl;

    if (!destino) return undefined;

    const url = new URL(destino);

    url.searchParams.set('code', this.codeStore.criar(resultado));

    return url.toString();
  }

  /**
   * Para onde mandar o navegador do aluno quando o launch NAO passa.
   *
   * Sem isto, uma matricula fora da base termina o clique do aluno num JSON cru
   * de 403 na tela — que nao diz o que fazer, nao parece a universidade e ainda
   * expoe a mensagem interna. Com isto ele cai na mesma tela do portal, com o
   * recado escrito para quem nao e da TI.
   *
   * `undefined` quando `PORTAL_ALUNO_URL` nao esta configurada: sem front nao ha
   * tela para mostrar, e a rota volta a responder o JSON de erro de sempre — que
   * e justamente como se testa o launch sem portal.
   *
   * NAO usa `exigirConfig()` de proposito: o erro que estamos traduzindo pode
   * ser exatamente o dela (503, faltam variaveis LTI_*), e ai a tentativa de
   * montar o destino morreria com a mesma excecao que veio tratar.
   */
  montarDestinoDeErro(erro: unknown): string | undefined {
    const destino = carregarLtiConfig(this.config).portalAlunoUrl;

    if (!destino) return undefined;

    const url = new URL(destino);

    url.searchParams.set('erro', this.codigoDoErro(erro));

    return url.toString();
  }

  /**
   * Traduz a excecao para o vocabulario do portal.
   *
   * O mapa e por STATUS e nao por `instanceof` porque cobre tambem as subclasses
   * e qualquer excecao que outra camada resolva lancar com o mesmo status.
   *
   * Aqui e o ultimo ponto onde o detalhe tecnico ainda esta em maos: dali para a
   * frente so viaja o codigo. Por isso o log acontece nesta funcao — sem ele, um
   * launch que falhe por LTI_CLAIM_* errado viraria "sessao invalida" na tela do
   * aluno, e silencio no servidor.
   */
  private codigoDoErro(erro: unknown): CodigoErroLaunch {
    const mensagem = erro instanceof Error ? erro.message : String(erro);

    const codigo =
      erro instanceof HttpException
        ? CODIGO_POR_STATUS[erro.getStatus()]
        : undefined;

    if (!codigo) {
      // Inesperado: o redirect esconde o stack do aluno, entao ele precisa
      // aparecer inteiro no log — e o unico registro que sobra deste caso.
      this.logger.error(
        `Falha inesperada no launch LTI: ${mensagem}`,
        erro instanceof Error ? erro.stack : undefined,
      );

      return 'falha';
    }

    // `indisponivel` e configuracao faltando: problema NOSSO, nao do aluno, e
    // por isso sobe de nivel — ninguem vai agendar nada ate alguem olhar.
    if (codigo === 'indisponivel') {
      this.logger.error(`Launch LTI indisponivel: ${mensagem}`);
    } else {
      this.logger.warn(`Launch LTI recusado (${codigo}): ${mensagem}`);
    }

    return codigo;
  }

  /**
   * Troca o codigo do redirect pelo resultado do launch (token + vinculos).
   *
   * O codigo vale UMA vez e por 2 minutos. Reapresenta-lo — aluno que usa o
   * botao voltar, ou alguem que pescou a URL do historico — cai aqui como
   * recusa, porque a primeira troca ja o consumiu.
   */
  resgatarSessao(codigo: string): ResultadoLaunch {
    const resultado = codigo ? this.codeStore.consumir(codigo) : undefined;

    if (!resultado) {
      this.auditoria.registrar('LTI_SESSAO_RECUSADA', {
        detalhe: 'codigo de sessao invalido, expirado ou ja utilizado',
      });

      throw new UnauthorizedException(
        'Sessao invalida ou expirada. Volte ao Brightspace e abra o link da ' +
          'prova de novo.',
      );
    }

    this.auditoria.registrar('LTI_SESSAO_OK', { ator: resultado.matricula });

    return resultado;
  }

  /**
   * Claim `context` do LTI: a turma de onde o aluno clicou. O `id` e o orgUnitId
   * no D2L.
   *
   * Ausencia NAO derruba o launch: o aluno continua entrando e vendo seus
   * horarios; o que ele nao consegue e agendar, porque sem disciplina nao ha o
   * que liberar no Brightspace. Recusar o login aqui trocaria uma mensagem clara
   * no portal por um erro no meio do fluxo do Brightspace.
   */
  private lerContexto(
    payload: Record<string, unknown>,
  ): ContextoLaunch | undefined {
    const contexto = payload[CLAIM_CONTEXT];

    if (typeof contexto !== 'object' || contexto === null) return undefined;

    const { id, title, label } = contexto as Record<string, unknown>;
    const orgUnitId =
      typeof id === 'string'
        ? id.trim()
        : typeof id === 'number'
          ? String(id)
          : '';

    if (!orgUnitId) return undefined;

    const titulo = [title, label].find(
      (v) => typeof v === 'string' && v.trim(),
    ) as string | undefined;

    const rotulo = typeof label === 'string' ? label.trim() : '';

    /**
     * `context.label` e a chave de busca no CSV de turmas. Quando o Brightspace
     * nao o envia — e neste tenant ele vem VAZIO —, o codigo ainda chega grudado
     * no fim do titulo ("NOME - CODIGO"). Sem esta segunda tentativa o `codigo`
     * fica vazio e TODO launch real termina em "o launch nao trouxe codigo de
     * turma para procurar".
     */
    const codigo = rotulo || extrairCodigoDoTitulo(titulo) || undefined;

    return { orgUnitId, codigo, titulo };
  }

  private async verificarIdToken(
    idToken: string,
    lti: LtiConfig,
  ): Promise<JWTPayload & Record<string, unknown>> {
    this.jwksRemoto ??= createRemoteJWKSet(new URL(lti.jwksUrl));

    try {
      const { payload } = await jwtVerify(idToken, this.jwksRemoto, {
        issuer: lti.issuer,
        audience: lti.clientId,
        clockTolerance: 30, // relogios levemente fora de sincronia
      });

      return payload;
    } catch (erro) {
      this.logger.warn(
        `Falha ao validar id_token do LTI: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      throw new UnauthorizedException('id_token do LTI invalido');
    }
  }

  private validarClaimsLti(
    payload: Record<string, unknown>,
    lti: LtiConfig,
  ): void {
    if (payload[CLAIM_VERSION] !== '1.3.0') {
      throw new UnauthorizedException('Versao de LTI nao suportada');
    }

    if (payload[CLAIM_MESSAGE_TYPE] !== 'LtiResourceLinkRequest') {
      throw new UnauthorizedException(
        `Tipo de mensagem LTI inesperado: ${String(payload[CLAIM_MESSAGE_TYPE])}`,
      );
    }

    if (lti.deploymentId && payload[CLAIM_DEPLOYMENT_ID] !== lti.deploymentId) {
      throw new UnauthorizedException('deployment_id nao confere');
    }
  }

  /**
   * Diagnostico do launch de teste: mostra QUAIS claims chegaram, para descobrir
   * os nomes reais dos parametros customizados. So roda fora de producao e com
   * LTI_DEBUG_CLAIMS=true.
   */
  private logarClaims(
    payload: Record<string, unknown>,
    matricula?: string,
    userIdD2L?: string,
  ): void {
    this.logger.debug(
      `[LTI debug] claims recebidos: ${Object.keys(payload).join(', ')}`,
    );
    this.logger.debug(
      `[LTI debug] custom: ${JSON.stringify(payload['https://purl.imsglobal.org/spec/lti/claim/custom'] ?? null)}`,
    );
    // O claim proprietario e onde mora o user_id numerico do D2L. Sem ele no log,
    // um launch que falhe so no UserId nao diz se o valor nao veio ou se o
    // caminho configurado esta errado.
    this.logger.debug(
      `[LTI debug] ${CLAIM_BRIGHTSPACE}: ${JSON.stringify(payload[CLAIM_BRIGHTSPACE] ?? null)}`,
    );
    // O `context` decide QUAIS disciplinas o aluno consegue agendar: `label` e a
    // chave de busca no CSV de turmas e `title` desempata. Sem ele no log, um
    // "turma nao encontrada" nao diz se o Brightspace nao mandou o codigo ou se
    // a turma e que nao esta importada — foram horas de diagnostico em 04/08/2026.
    this.logger.debug(
      `[LTI debug] context: ${JSON.stringify(payload[CLAIM_CONTEXT] ?? null)}`,
    );
    this.logger.debug(
      `[LTI debug] sub=${String(payload.sub)} matricula=${matricula ?? 'NAO ENCONTRADA'} userIdD2L=${userIdD2L ?? 'NAO ENCONTRADO'}`,
    );
  }

  private exigirConfig(): LtiConfig {
    const lti = carregarLtiConfig(this.config);

    const faltando = (
      [
        ['LTI_ISSUER', lti.issuer],
        ['LTI_CLIENT_ID', lti.clientId],
        ['LTI_AUTH_LOGIN_URL', lti.authLoginUrl],
        ['LTI_JWKS_URL', lti.jwksUrl],
        ['LTI_REDIRECT_URI', lti.redirectUri],
      ] as const
    )
      .filter(([, valor]) => !valor)
      .map(([nome]) => nome);

    if (faltando.length > 0) {
      throw new ServiceUnavailableException(
        `Integracao LTI ainda nao configurada. Faltam no .env: ${faltando.join(', ')}`,
      );
    }

    return lti;
  }
}
