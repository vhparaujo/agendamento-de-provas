import { ResultadoSpecialAccess } from '../../generated/prisma/client';

/**
 * Quais resultados pedem ACAO de alguem. Lista unica: o contador `pendencias`
 * da execucao e a ordem do relatorio leem daqui.
 *
 * `ACESSO_DE_OUTRO_USUARIO` fica de fora de proposito: e um special access que o
 * portal nao deu (um professor pode ter dado a mao) e que o lote nunca toca —
 * contar como pendencia faria a execucao nunca ficar verde.
 */
export const PENDENCIAS_SPECIAL_ACCESS: ReadonlySet<ResultadoSpecialAccess> =
  new Set([
    ResultadoSpecialAccess.QUIZ_NAO_ENCONTRADO,
    ResultadoSpecialAccess.QUESTIONARIO_NAO_RESTRITO,
    ResultadoSpecialAccess.RESERVA_DUPLICADA,
    ResultadoSpecialAccess.USER_ID_INVALIDO,
    ResultadoSpecialAccess.ALUNO_NAO_ENCONTRADO,
    ResultadoSpecialAccess.FALHA_NA_API,
  ]);

export function ehPendencia(resultado: ResultadoSpecialAccess): boolean {
  return PENDENCIAS_SPECIAL_ACCESS.has(resultado);
}
