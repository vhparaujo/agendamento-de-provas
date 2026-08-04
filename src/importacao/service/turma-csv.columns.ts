import { coluna, LinhaCsv } from './csv.util';

/**
 * ============================================================================
 * MAPEAMENTO DO CSV DE TURMAS (Tabela_Disciplinas_Turmas)
 * ============================================================================
 * Cabecalho real, separado por PONTO E VIRGULA (Excel pt-BR):
 *
 *   Curso;Código da Turma;Disciplina / Código EAD
 *   NUTRIÇÃO;GSPS0N10259;PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO (1-GSPS06EAD003)
 *
 * Duas coisas que a planilha NAO tem, e que moldam o resto do sistema:
 *
 * 1. **Nao ha orgUnitId.** Descobri-lo exigiria consultar o Brightspace. Como o
 *    launch LTI ja entrega codigo e nome da turma, o cruzamento e feito por
 *    codigo + nome e o orgUnitId fica para a fase de integracao.
 *
 * 2. **A terceira coluna traz duas informacoes na mesma celula**: o nome da
 *    disciplina e, entre parenteses, o codigo EAD dela. Separamos na leitura —
 *    guardar a celula inteira faria o nome nunca casar com o do Brightspace.
 *
 * `coluna()` tolera diferenca de caixa e espacos no cabecalho; a lista de
 * sinonimos cobre variacoes de exportacao (com e sem acento).
 */
export const TURMA_CSV_COLUNAS = {
  curso: ['Curso'],
  codigoTurma: [
    'Código da Turma',
    'Codigo da Turma',
    'codigoTurma',
    'Código',
    'Codigo',
  ],
  disciplina: [
    'Disciplina / Código EAD',
    'Disciplina / Codigo EAD',
    'Disciplina',
    'nomeDisciplina',
  ],
} as const;

/** A coluna que precisa existir para o arquivo fazer sentido. */
export const COLUNA_OBRIGATORIA = TURMA_CSV_COLUNAS.codigoTurma[0];

export interface TurmaMapeada {
  codigoTurma: string;
  nomeDisciplina: string;
  codigoEad: string | null;
  curso: string | null;
}

/** Primeiro sinonimo preenchido. */
function primeira(linha: LinhaCsv, nomes: readonly string[]): string {
  for (const nome of nomes) {
    const valor = coluna(linha, nome);
    if (valor) return valor;
  }

  return '';
}

/**
 * "PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO (1-GSPS06EAD003)"
 *   -> nome:      "PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO"
 *      codigoEad: "1-GSPS06EAD003"
 *
 * So o ULTIMO parentese conta, e so se parecer codigo (tem letra e numero):
 * disciplinas com parenteses no proprio nome — "QUIMICA (GERAL)" — nao podem
 * perder metade do titulo.
 */
export function separarDisciplina(celula: string): {
  nome: string;
  codigoEad: string | null;
} {
  const casado = /^(.*)\(([^()]+)\)\s*$/.exec(celula.trim());

  if (!casado) return { nome: celula.trim(), codigoEad: null };

  const dentro = casado[2].trim();
  const pareceCodigo = /[A-Za-z]/.test(dentro) && /\d/.test(dentro);

  if (!pareceCodigo) return { nome: celula.trim(), codigoEad: null };

  return { nome: casado[1].trim(), codigoEad: dentro.toUpperCase() };
}

/** Traduz uma linha do CSV para o formato de TurmaImportada. */
export function mapRowToTurma(linha: LinhaCsv): TurmaMapeada | null {
  const codigoTurma = primeira(linha, TURMA_CSV_COLUNAS.codigoTurma);
  const celula = primeira(linha, TURMA_CSV_COLUNAS.disciplina);

  // Sem codigo nao ha o que procurar; sem nome nao ha como desempatar.
  if (!codigoTurma || !celula) return null;

  const { nome, codigoEad } = separarDisciplina(celula);

  if (!nome) return null;

  return {
    codigoTurma: codigoTurma.toUpperCase(),
    nomeDisciplina: nome,
    codigoEad,
    curso: primeira(linha, TURMA_CSV_COLUNAS.curso) || null,
  };
}
