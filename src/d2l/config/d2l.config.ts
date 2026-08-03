import { ConfigService } from '@nestjs/config';

/**
 * Qual fluxo OAuth 2.0 usar contra o Brightspace.
 *
 * `CLIENT_CREDENTIALS` e o preferido: usuario de servico + JWT assertion, sem
 * segredo compartilhado e sem refresh token para guardar. `REFRESH_TOKEN` existe
 * para tenants que ainda nao tem Usuarios de Servico habilitados.
 */
export type FluxoOAuth = 'CLIENT_CREDENTIALS' | 'REFRESH_TOKEN';

export interface D2lConfig {
  habilitado: boolean;
  baseUrl: string;
  apiVersion: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  /** Chave privada PEM (ou base64 de um PEM) da client assertion. */
  assertionKey?: string;
  assertionKeyId?: string;
  refreshTokenInicial?: string;
  scopes: string;
  tipoOferta: number;
  tipoPeriodoLetivo: number;
  /** Termos que identificam o quiz da prova, em ordem de preferencia. */
  quizTermos: string[];
  timeZone: string;
}

const PADRAO_QUIZ_TERMOS = 'prova final,prova presencial,prova';

export function carregarD2lConfig(config: ConfigService): D2lConfig {
  const texto = (chave: string, padrao = '') =>
    (config.get<string>(chave) ?? padrao).trim();

  const numero = (chave: string, padrao: number) => {
    const valor = Number(texto(chave));
    return Number.isFinite(valor) && valor > 0 ? valor : padrao;
  };

  return {
    habilitado: texto('D2L_HABILITADO') === 'true',
    // Sem barra no fim: as URLs sao montadas com `/d2l/api/...` na frente.
    baseUrl: texto('D2L_BASE_URL').replace(/\/+$/, ''),
    // 1.82+ e obrigatorio: as rotas de quiz anteriores estao obsoletas.
    apiVersion: texto('D2L_API_VERSION', '1.82'),
    tokenUrl: texto(
      'D2L_TOKEN_URL',
      'https://auth.brightspace.com/core/connect/token',
    ),
    clientId: texto('D2L_CLIENT_ID'),
    clientSecret: texto('D2L_CLIENT_SECRET') || undefined,
    assertionKey: texto('D2L_CLIENT_ASSERTION_KEY') || undefined,
    assertionKeyId: texto('D2L_ASSERTION_KEY_ID') || undefined,
    refreshTokenInicial: texto('D2L_REFRESH_TOKEN') || undefined,
    scopes: texto(
      'D2L_SCOPES',
      'enrollment:orgunit:read quizzing:quizzes:read quizzing:quizzes:write',
    ),
    // Course Offering = 3. O Periodo Letivo da UCB e um tipo CUSTOMIZADO (103);
    // o Semester padrao (5) nao e usado neste tenant.
    tipoOferta: numero('D2L_TIPO_OFERTA', 3),
    tipoPeriodoLetivo: numero('D2L_TIPO_PERIODO_LETIVO', 103),
    quizTermos: texto('D2L_QUIZ_TERMOS', PADRAO_QUIZ_TERMOS)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    timeZone: texto('D2L_TIMEZONE', 'America/Sao_Paulo'),
  };
}

/**
 * Qual fluxo a configuracao atual descreve — ou o que falta para descrever um.
 *
 * A checagem existe para que "esqueci de preencher uma variavel" apareca como
 * uma mensagem nomeando a variavel, e nao como um 400 do Brightspace tres passos
 * adiante.
 */
export function resolverFluxo(
  cfg: D2lConfig,
): { fluxo: FluxoOAuth } | { faltando: string[] } {
  const base: string[] = [];

  if (!cfg.baseUrl) base.push('D2L_BASE_URL');
  if (!cfg.clientId) base.push('D2L_CLIENT_ID');

  // Assertion tem precedencia: se a chave existe, o admin escolheu o fluxo
  // preferido, e cobrar o refresh token seria confuso.
  if (cfg.assertionKey) {
    return base.length > 0
      ? { faltando: base }
      : { fluxo: 'CLIENT_CREDENTIALS' };
  }

  if (cfg.refreshTokenInicial || cfg.clientSecret) {
    const faltando = [...base];
    if (!cfg.clientSecret) faltando.push('D2L_CLIENT_SECRET');
    if (!cfg.refreshTokenInicial) faltando.push('D2L_REFRESH_TOKEN');

    return faltando.length > 0 ? { faltando } : { fluxo: 'REFRESH_TOKEN' };
  }

  return {
    faltando: [
      ...base,
      'D2L_CLIENT_ASSERTION_KEY (fluxo preferido) OU D2L_CLIENT_SECRET + D2L_REFRESH_TOKEN',
    ],
  };
}
