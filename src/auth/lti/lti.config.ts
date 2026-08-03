import { ConfigService } from '@nestjs/config';

/**
 * Caminho de um claim dentro do id_token. As chaves de claim do LTI sao URLs
 * (contem pontos), entao o separador de nivel e "::" e NAO ".".
 *   ex: "https://purl.imsglobal.org/spec/lti/claim/custom::orgdefinedid"
 * Varios candidatos podem ser listados separados por virgula — vale o primeiro
 * que vier preenchido.
 */
export const CLAIM_CUSTOM = 'https://purl.imsglobal.org/spec/lti/claim/custom';
export const CLAIM_LIS = 'https://purl.imsglobal.org/spec/lti/claim/lis';
export const CLAIM_MESSAGE_TYPE =
  'https://purl.imsglobal.org/spec/lti/claim/message_type';
export const CLAIM_VERSION =
  'https://purl.imsglobal.org/spec/lti/claim/version';
export const CLAIM_DEPLOYMENT_ID =
  'https://purl.imsglobal.org/spec/lti/claim/deployment_id';
export const CLAIM_ROLES = 'https://purl.imsglobal.org/spec/lti/claim/roles';

/**
 * De ONDE o aluno clicou. O `id` deste claim e o orgUnitId da turma no D2L — o
 * mesmo identificador que o CSV de turmas traz e que o special access usa.
 *
 * E a unica informacao de disciplina disponivel hoje: a lista completa de
 * matriculas do aluno so chega na etapa 7, pela Valence. Ver
 * src/agendamento/service/disciplinas-do-aluno.service.ts.
 */
export const CLAIM_CONTEXT =
  'https://purl.imsglobal.org/spec/lti/claim/context';

/**
 * Claim PROPRIETARIO do Brightspace — fora da especificacao LTI. E aqui que vem
 * o `user_id` numerico do D2L e o `org_defined_id`.
 *
 * Confirmado num launch real contra `catolicatest.brightspace.com` (spike de
 * LTI 1.3): os dois valores chegam neste claim, e NAO como parametros
 * customizados, como se supunha antes de haver um launch para observar.
 */
export const CLAIM_BRIGHTSPACE = 'http://www.brightspace.com';

/**
 * Onde a matricula (RA) aparece, em ordem de preferencia.
 *
 * O launch real trouxe o MESMO valor por quatro caminhos independentes
 * (`org_defined_id`, `lis.person_sourcedid`, `custom.lis_person_sourcedid` e
 * `username`). Manter os quatro nao custa nada e cobre o tenant que tiver a
 * config `d2l.Tools.Lti.SendLisPersonSourcedId` desligada — sem ela, os dois do
 * meio chegam vazios.
 */
const PADRAO_CLAIM_MATRICULA = [
  `${CLAIM_BRIGHTSPACE}::org_defined_id`,
  `${CLAIM_LIS}::person_sourcedid`,
  `${CLAIM_CUSTOM}::lis_person_sourcedid`,
  `${CLAIM_BRIGHTSPACE}::username`,
  `${CLAIM_CUSTOM}::orgdefinedid`,
  `${CLAIM_CUSTOM}::matricula`,
].join(',');

/**
 * ============================================================================
 * O `sub` NAO ENTRA NESTA LISTA — e o erro que o spike evitou
 * ============================================================================
 * O `sub` do LTI e um identificador OPACO (`<guid>_76629`) e as rotas da Valence
 * API o REJEITAM. Se ele estivesse aqui como ultimo recurso, um tenant sem o
 * claim proprietario produziria um launch aparentemente bem-sucedido, com um
 * `userIdD2L` invalido gravado em cada agendamento — e a falha so apareceria na
 * hora de liberar a prova no Brightspace, muito depois de o aluno achar que
 * estava tudo certo.
 *
 * Melhor recusar o launch na hora, com uma mensagem que diz o que configurar.
 *
 * O `sub` termina com o user_id depois de um underscore. Isso e detalhe de
 * implementacao do Brightspace: NAO parsear.
 */
const PADRAO_CLAIM_USER_ID = [
  `${CLAIM_BRIGHTSPACE}::user_id`,
  `${CLAIM_CUSTOM}::userid`,
  `${CLAIM_CUSTOM}::user_id`,
].join(',');

export interface LtiConfig {
  issuer: string;
  clientId: string;
  deploymentId?: string;
  authLoginUrl: string;
  jwksUrl: string;
  toolPrivateKey?: string;
  toolKeyId: string;
  redirectUri: string;
  portalAlunoUrl?: string;
  claimsMatricula: string[];
  claimsUserId: string[];
  debugClaims: boolean;
}

export function carregarLtiConfig(config: ConfigService): LtiConfig {
  const lista = (valor: string) =>
    valor
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  return {
    issuer: config.get<string>('LTI_ISSUER') ?? '',
    clientId: config.get<string>('LTI_CLIENT_ID') ?? '',
    deploymentId: config.get<string>('LTI_DEPLOYMENT_ID') || undefined,
    authLoginUrl: config.get<string>('LTI_AUTH_LOGIN_URL') ?? '',
    jwksUrl: config.get<string>('LTI_JWKS_URL') ?? '',
    toolPrivateKey: config.get<string>('LTI_TOOL_PRIVATE_KEY') || undefined,
    toolKeyId: config.get<string>('LTI_TOOL_KEY_ID') ?? 'agendamento-provas-1',
    redirectUri: config.get<string>('LTI_REDIRECT_URI') ?? '',
    portalAlunoUrl: config.get<string>('PORTAL_ALUNO_URL') || undefined,
    claimsMatricula: lista(
      config.get<string>('LTI_CLAIM_MATRICULA') ?? PADRAO_CLAIM_MATRICULA,
    ),
    claimsUserId: lista(
      config.get<string>('LTI_CLAIM_USER_ID') ?? PADRAO_CLAIM_USER_ID,
    ),
    debugClaims:
      config.get<string>('LTI_DEBUG_CLAIMS') === 'true' &&
      config.get<string>('NODE_ENV') !== 'production',
  };
}

/** Le um claim por caminho "chave::subchave" (aceita mais de um nivel). */
export function lerClaim(
  payload: Record<string, unknown>,
  caminho: string,
): string | undefined {
  let atual: unknown = payload;

  for (const parte of caminho.split('::')) {
    if (typeof atual !== 'object' || atual === null) return undefined;
    atual = (atual as Record<string, unknown>)[parte];
  }

  if (atual === null || atual === undefined) return undefined;
  if (typeof atual === 'string') return atual.trim() || undefined;
  if (typeof atual === 'number') return String(atual);

  return undefined;
}

/** Primeiro caminho que vier preenchido. */
export function lerPrimeiroClaim(
  payload: Record<string, unknown>,
  caminhos: string[],
): string | undefined {
  for (const caminho of caminhos) {
    const valor = lerClaim(payload, caminho);
    if (valor) return valor;
  }

  return undefined;
}
