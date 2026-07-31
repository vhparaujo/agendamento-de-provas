import { coluna, LinhaCsv } from './csv.util';

/**
 * ============================================================================
 * TODO: ajustar quando o CSV real de turmas chegar.
 * ============================================================================
 * ESTE E O UNICO PONTO que precisa mudar. Endpoint, auditoria, idempotencia,
 * persistencia e o cruzamento de disciplinas ja estao escritos e testados
 * (fixture em test/fixtures/turmas-exemplo.csv) — nenhuma regra de negocio muda
 * quando o arquivo real aparecer, so os nomes abaixo.
 *
 * Se o cabecalho real vier com outros nomes, basta reescrever estas strings.
 * `coluna()` ja tolera diferenca de caixa e espacos, entao "orgunitid",
 * "OrgUnitId" e " OrgUnitID " funcionam sem alteracao.
 *
 * orgUnitId e o unico campo OBRIGATORIO: e a chave que casa a disciplina do
 * aluno na Valence com a turma que realmente tera prova.
 */
export const TURMA_CSV_COLUNAS = {
  orgUnitId: 'orgUnitId',
  nomeDisciplina: 'nomeDisciplina',
  codigoTurma: 'codigoTurma',
} as const;

export interface TurmaMapeada {
  orgUnitId: string;
  nomeDisciplina: string | null;
  codigoTurma: string | null;
}

/** Traduz uma linha do CSV para o formato de TurmaImportada. */
export function mapRowToTurma(linha: LinhaCsv): TurmaMapeada | null {
  const orgUnitId = coluna(linha, TURMA_CSV_COLUNAS.orgUnitId);

  if (!orgUnitId) return null;

  return {
    orgUnitId,
    nomeDisciplina: coluna(linha, TURMA_CSV_COLUNAS.nomeDisciplina) || null,
    codigoTurma: coluna(linha, TURMA_CSV_COLUNAS.codigoTurma) || null,
  };
}
