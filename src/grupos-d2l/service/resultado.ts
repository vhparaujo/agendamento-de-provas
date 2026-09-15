import { ResultadoGruposD2L } from '../../generated/prisma/client';

/**
 * Quais resultados pedem ACAO de alguem. Lista unica: o contador `pendencias`
 * da execucao, a ordem do relatorio e a "nada mudou" (so vale se a anterior nao
 * teve pendencia) leem daqui.
 *
 * `GRUPO_SOBRANDO` fica de fora de proposito: e um grupo com alunos que saiu da
 * lista — ninguem precisa fazer nada, e contar como pendencia faria a execucao
 * nunca mais ficar verde depois de um nome corrigido.
 */
export const PENDENCIAS_GRUPOS_D2L: ReadonlySet<ResultadoGruposD2L> = new Set([
  ResultadoGruposD2L.TURMA_AMBIGUA,
  ResultadoGruposD2L.CATEGORIA_AUSENTE,
  ResultadoGruposD2L.CATEGORIA_DUPLICADA,
  ResultadoGruposD2L.CATEGORIA_EM_PROCESSAMENTO,
  ResultadoGruposD2L.GRUPO_NAO_ENCONTRADO,
  ResultadoGruposD2L.HORARIO_SEM_JANELA,
  ResultadoGruposD2L.SEM_GRUPO_NO_DIA,
  ResultadoGruposD2L.ALUNO_DE_OUTRA_MODALIDADE,
  ResultadoGruposD2L.USER_ID_INVALIDO,
  ResultadoGruposD2L.ALUNO_NAO_ENCONTRADO,
  ResultadoGruposD2L.CONFLITO_NO_GRUPO,
  ResultadoGruposD2L.FALHA_NA_API,
]);

export function ehPendencia(resultado: ResultadoGruposD2L): boolean {
  return PENDENCIAS_GRUPOS_D2L.has(resultado);
}
