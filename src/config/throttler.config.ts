import { ThrottlerModuleOptions } from '@nestjs/throttler';

/**
 * ============================================================================
 * LIMITES DE REQUISICAO (ASVS 5.0 6.3.1 — anti-automacao, Nivel 1)
 * ============================================================================
 * Dois limites nomeados, aplicados por IP:
 *
 * - `padrao`: teto largo, so para conter abuso grosseiro. Nao deve incomodar
 *   uso normal do portal, nem o admin navegando entre telas.
 * - `sensivel`: para o que um atacante repetiria — login, refresh, troca de
 *   senha e launch LTI. Aplicado rota a rota com @Throttle.
 *
 * `sensivel` NAO substitui bloqueio de conta; e a primeira barreira. Com 5
 * tentativas por minuto, uma lista de 10 mil senhas leva mais de um dia por IP.
 */
export const LIMITE_PADRAO = 'padrao';
export const LIMITE_SENSIVEL = 'sensivel';

export const throttlerConfig: ThrottlerModuleOptions = {
  throttlers: [
    { name: LIMITE_PADRAO, ttl: 60_000, limit: 120 },
    { name: LIMITE_SENSIVEL, ttl: 60_000, limit: 5 },
  ],

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
 * Atalho para as rotas sensiveis: mantem o teto largo do `padrao` e aperta o
 * `sensivel`. Usar a constante evita que cada rota invente o proprio numero.
 */
export const LIMITE_AUTENTICACAO = {
  [LIMITE_SENSIVEL]: { ttl: 60_000, limit: 5 },
};

/**
 * Upload de CSV: caro (arquivos de milhares de linhas, gravacao em lote) e raro
 * — ninguem importa a planilha 20 vezes por minuto de forma legitima.
 */
export const LIMITE_UPLOAD = {
  [LIMITE_SENSIVEL]: { ttl: 300_000, limit: 10 },
};
