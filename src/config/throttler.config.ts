import { ThrottlerModuleOptions } from '@nestjs/throttler';

/**
 * ============================================================================
 * LIMITES DE REQUISICAO (ASVS 5.0 6.3.1 — anti-automacao, Nivel 1)
 * ============================================================================
 * UM limitador global, apertado rota a rota com @Throttle:
 *
 * - teto geral de 120/min por IP, so para conter abuso grosseiro. Nao deve
 *   incomodar uso normal do portal, nem o admin navegando entre telas.
 * - `LIMITE_AUTENTICACAO` (5/min) no que um atacante repetiria — login,
 *   refresh, troca de senha, launch LTI e callback OAuth do D2L.
 * - `LIMITE_UPLOAD` (10 a cada 5min) na importacao de CSV.
 *
 * O contador do @nestjs/throttler e por **rota + limitador + IP**
 * (`ThrottlerGuard.generateKey` = classe + handler + nome + IP), entao apertar
 * o limitador numa rota nao mexe no orcamento das outras.
 *
 * ---------------------------------------------------------------------------
 * POR QUE UM LIMITADOR SO, E NAO DOIS NOMEADOS
 * ---------------------------------------------------------------------------
 * Ja houve aqui um segundo limitador `sensivel` de 5/min declarado em
 * `throttlers: []` junto com o `padrao`, na crenca de que ele so valeria nas
 * rotas decoradas com @Throttle. **Nao e como a lib funciona**: o
 * `ThrottlerGuard.canActivate` percorre TODOS os limitadores registrados em
 * toda requisicao, e o @Throttle apenas SOBRESCREVE ttl/limit de um limitador
 * que ja e global — nao serve para ativa-lo em uma rota.
 *
 * O efeito era o portal inteiro preso em 5 requisicoes por minuto: qualquer
 * tela do admin que carregasse mais de 5 recursos travava com 429.
 *
 * Com um limitador so, o @Throttle faz exatamente o que parece que faz. Se um
 * dia for preciso um segundo limitador nomeado, lembre que ele nasce **global**
 * e so e desligado com @SkipThrottle rota a rota.
 */
export const LIMITE_PADRAO = 'default';

export const throttlerConfig: ThrottlerModuleOptions = {
  // Nome 'default' de proposito: e o unico caso em que a lib emite o header
  // `Retry-After` puro, sem sufixo. Com nome proprio viria `Retry-After-<nome>`,
  // que nenhum cliente HTTP entende sozinho.
  throttlers: [{ name: LIMITE_PADRAO, ttl: 60_000, limit: 120 }],

  /**
   * Nos testes automatizados o limite fica DESLIGADO por padrao: um e2e de
   * autenticacao faz varios logins seguidos de proposito (provisorio -> troca ->
   * definitivo) e esbarraria no teto de 5/min, transformando protecao legitima
   * em falha de teste.
   *
   * Para exercitar o proprio limitador num teste dedicado, ligue
   * `THROTTLE_NOS_TESTES=true` naquele teste. Fora de NODE_ENV=test isto nao tem
   * efeito nenhum — producao nunca pula o limite.
   */
  skipIf: () =>
    process.env.NODE_ENV === 'test' &&
    process.env.THROTTLE_NOS_TESTES !== 'true',
};

/**
 * Rotas de credencial: 5 tentativas por minuto.
 *
 * NAO substitui bloqueio de conta; e a primeira barreira. Com 5 tentativas por
 * minuto, uma lista de 10 mil senhas leva mais de um dia por IP.
 */
export const LIMITE_AUTENTICACAO = {
  [LIMITE_PADRAO]: { ttl: 60_000, limit: 5 },
};

/**
 * Upload de CSV: caro (arquivos de milhares de linhas, gravacao em lote) e raro
 * — ninguem importa a planilha 20 vezes por minuto de forma legitima.
 */
export const LIMITE_UPLOAD = {
  [LIMITE_PADRAO]: { ttl: 300_000, limit: 10 },
};
