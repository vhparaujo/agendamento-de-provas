import { ConfigService } from '@nestjs/config';

/**
 * ============================================================================
 * CONFIGURACAO DO OAUTH 2.0 DA VALENCE (Authorization Code)
 * ============================================================================
 * Este arquivo cobre APENAS o fluxo (b) do .env.example — Authorization Code +
 * refresh token —, que e o que a tela "Registrar um Aplicativo" do Brightspace
 * produz. O fluxo preferido (client credentials + usuario de servico) nao passa
 * por aqui: ele nao tem redirect nem refresh token.
 *
 * Endpoints sao GLOBAIS da D2L, nao do tenant: o `auth.brightspace.com` atende
 * todos os Brightspace. Por isso tem padrao — o que varia por tenant e o
 * `D2L_BASE_URL` das chamadas REST, que nao e usado nesta etapa.
 */

/** Documentado em docs/D2L_API_REFERENCE.md §2.2. */
export const D2L_TOKEN_URL_PADRAO =
  'https://auth.brightspace.com/core/connect/token';

export interface D2lOauthConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * Precisa ser IDENTICA a "URI de redirecionamento" cadastrada no registro do
   * app — o Brightspace compara byte a byte na troca do code, e a divergencia
   * mais comum e uma barra final a mais.
   */
  redirectUri: string;
}

/**
 * Le uma variavel tratando string VAZIA como ausente.
 *
 * Nao e preciosismo: `??` so cai no padrao quando o valor e `undefined`, e uma
 * variavel declarada e em branco no .env chega como "". Foi exatamente assim que
 * um launch LTI real falhou em 04/08/2026 — a lista de claims virou vazia e o
 * launch recusou uma matricula que estava no token. Ver
 * src/auth/lti/lti.config.ts.
 */
function ler(config: ConfigService, nome: string, padrao = ''): string {
  return config.get<string>(nome)?.trim() || padrao;
}

export function carregarD2lOauthConfig(config: ConfigService): D2lOauthConfig {
  return {
    tokenUrl: ler(config, 'D2L_TOKEN_URL', D2L_TOKEN_URL_PADRAO),
    clientId: ler(config, 'D2L_CLIENT_ID'),
    clientSecret: ler(config, 'D2L_CLIENT_SECRET'),
    redirectUri: ler(config, 'D2L_REDIRECT_URI'),
  };
}

/**
 * Nomes das variaveis que faltam para a troca do code funcionar.
 *
 * Devolver a LISTA (em vez de um booleano) e o que permite a rota responder "o
 * que voce precisa preencher" em vez de "nao configurado" — o admin que acabou
 * de cadastrar o app no Brightspace esta com os valores na mao, e a mensagem diz
 * onde colar cada um.
 */
export function faltandoParaOauth(cfg: D2lOauthConfig): string[] {
  return [
    ...faltandoParaRefresh(cfg),
    // Exigido so na troca do code: e o redirect que o Brightspace confere contra
    // o cadastro. No refresh nao ha navegacao, entao ele nao entra no pedido.
    ...(cfg.redirectUri ? [] : ['D2L_REDIRECT_URI']),
  ];
}

/** O subconjunto que o `grant_type=refresh_token` realmente precisa. */
export function faltandoParaRefresh(cfg: D2lOauthConfig): string[] {
  return (
    [
      ['D2L_CLIENT_ID', cfg.clientId],
      ['D2L_CLIENT_SECRET', cfg.clientSecret],
      ['D2L_TOKEN_URL', cfg.tokenUrl],
    ] as const
  )
    .filter(([, valor]) => !valor)
    .map(([nome]) => nome);
}

// ============================================================================
// CHAMADAS REST (Valence LP/LE) — diferente do OAuth acima
// ============================================================================
// O OAuth fala com um endpoint GLOBAL da D2L; as chamadas REST falam com o
// TENANT. Por isso a configuracao e outra, e so ela precisa da `D2L_BASE_URL`.

/** 1.82+ e obrigatorio: rotas de quiz anteriores estao obsoletas. */
export const D2L_API_VERSION_PADRAO = '1.82';

/**
 * Type Ids de org unit DESTE tenant, validados no Postman (§4.2 da referencia).
 * Course Offering e 3 em qualquer Brightspace; o Periodo Letivo da UCB e um tipo
 * CUSTOMIZADO (103) — o Semester padrao (5) nao e usado aqui. Por isso os dois
 * sao configuraveis: outro tenant teria outro numero.
 */
export const D2L_TIPO_OFERTA_PADRAO = 3;
export const D2L_TIPO_PERIODO_LETIVO_PADRAO = 103;

export interface D2lApiConfig {
  /** `false` (default) = nenhuma chamada de rede sai daqui. */
  habilitado: boolean;
  baseUrl: string;
  apiVersion: string;
  tipoOferta: number;
  tipoPeriodoLetivo: number;
}

function lerNumero(
  config: ConfigService,
  nome: string,
  padrao: number,
): number {
  const valor = Number(ler(config, nome));
  return Number.isFinite(valor) && valor > 0 ? valor : padrao;
}

export function carregarD2lApiConfig(config: ConfigService): D2lApiConfig {
  return {
    habilitado: ler(config, 'D2L_HABILITADO') === 'true',
    // Sem barra final: as rotas sao montadas com `/d2l/api/...` na frente.
    baseUrl: ler(config, 'D2L_BASE_URL').replace(/\/+$/, ''),
    apiVersion: ler(config, 'D2L_API_VERSION', D2L_API_VERSION_PADRAO),
    tipoOferta: lerNumero(config, 'D2L_TIPO_OFERTA', D2L_TIPO_OFERTA_PADRAO),
    tipoPeriodoLetivo: lerNumero(
      config,
      'D2L_TIPO_PERIODO_LETIVO',
      D2L_TIPO_PERIODO_LETIVO_PADRAO,
    ),
  };
}

/**
 * O que falta para as chamadas REST funcionarem. So a `D2L_BASE_URL` nao tem
 * padrao possivel: ela e o endereco do tenant, e chutar significaria consultar a
 * instancia errada do Brightspace.
 */
export function faltandoParaApi(cfg: D2lApiConfig): string[] {
  return cfg.baseUrl ? [] : ['D2L_BASE_URL'];
}
