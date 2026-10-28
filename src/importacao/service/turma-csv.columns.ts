import { normalizar, TOKEN_CODIGO } from '../../turma/service/turma-match';
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
 * Tres coisas que moldam o resto do sistema:
 *
 * 1. **A terceira coluna traz DUAS informacoes na mesma celula**: o nome da
 *    disciplina e, entre parenteses, o codigo dela. Separamos na leitura —
 *    guardar a celula inteira faria o nome nunca casar com o do Brightspace.
 *
 * 2. **Esse codigo entre parenteses nao e decoracao.** Ele e o outro token do
 *    `Code` composto do Brightspace (`GSPS02_GSPS02EAD003_GSPS0I10227_2026/1`):
 *    com ele e o codigo da turma, a oferta e identificada sem depender do nome.
 *    E o que separa tres disciplinas diferentes rodando sob o MESMO codigo de
 *    turma. Ver `turma-match.ts`.
 *
 * 3. **A coluna `Curso`, se existir no arquivo, e IGNORADA.** Uma turma tem
 *    alunos de varios cursos (compartilhada, eletiva, equivalencia), entao
 *    rotula-la com um curso so seria falso — ver o comentario em
 *    `TurmaImportada` (schema.prisma).
 *
 * 4. **A coluna `idTurmaDisc` e OPCIONAL.** E o id da turma-disciplina no
 *    sistema academico, que so a API de integracao devolve. Arquivo sem ela
 *    importa normalmente, e a turma fica com `null`.
 *
 * `coluna()` tolera diferenca de caixa e espacos no cabecalho; a lista de
 * sinonimos cobre variacoes de exportacao (com e sem acento).
 */
export const TURMA_CSV_COLUNAS = {
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
  idTurmaDisc: ['idTurmaDisc', 'Id Turma Disc', 'ID Turma Disciplina'],
} as const;

/** A coluna que precisa existir para o arquivo fazer sentido (qualquer sinonimo). */
export const COLUNA_OBRIGATORIA = TURMA_CSV_COLUNAS.codigoTurma;

export interface TurmaMapeada {
  codigoTurma: string;
  nomeDisciplina: string;
  /** Codigo da DISCIPLINA, sem o prefixo do sistema de origem. */
  codigoEad: string | null;
  /** Coluna opcional: `null` quando o arquivo nao a tem ou a celula esta vazia. */
  idTurmaDisc: string | null;
}

/** Ou a turma, ou o motivo — a linha rejeitada precisa explicar o que houve. */
export type LinhaMapeada =
  { ok: true; turma: TurmaMapeada } | { ok: false; motivo: string };

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
 *      codigoEad: "GSPS06EAD003"
 *
 * Portado de `extrairCodigoDisciplina` (../brightspace-orgunits, src/csv.js).
 * Quatro recusas, todas com motivo:
 *
 *  - so o ULTIMO parentese conta: "QUÍMICA (GSPS01EAD048) NOTURNO" fica intacto;
 *  - o miolo precisa PARECER codigo (`TOKEN_CODIGO`): "(TURMA A)", "(2026)" e
 *    "(EAD)" nao sao, e o nome fica inteiro;
 *  - **o prefixo numerico sai** ("1-GSPS06EAD003" -> "GSPS06EAD003"): ele e do
 *    sistema de origem e NAO aparece no `Code` do Brightspace, entao mante-lo
 *    faria o token nunca casar;
 *  - se o nome ficaria vazio ("(GSPS01EAD048)" sozinho), nao extrai — perder o
 *    nome inteiro e pior que nao separar.
 */
export function separarDisciplina(celula: string): {
  nome: string;
  codigoEad: string | null;
} {
  const bruto = celula.trim();
  const casado = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(bruto);

  if (!casado) return { nome: bruto, codigoEad: null };

  const miolo = casado[2].trim().toUpperCase().replace(/^\d+-/, '');
  const nome = casado[1].trim();

  if (!TOKEN_CODIGO.test(miolo) || !nome) {
    return { nome: bruto, codigoEad: null };
  }

  return { nome, codigoEad: miolo };
}

/** Traduz uma linha do CSV para o formato de TurmaImportada. */
export function mapRowToTurma(linha: LinhaCsv): LinhaMapeada {
  const codigoTurma = primeira(linha, TURMA_CSV_COLUNAS.codigoTurma);
  const celula = primeira(linha, TURMA_CSV_COLUNAS.disciplina);

  // Sem codigo nao ha o que procurar; sem nome nao ha como desempatar.
  if (!codigoTurma || !celula) {
    return {
      ok: false,
      motivo:
        'código da turma ou nome da disciplina vazio — os dois são necessários ' +
        'para identificar a turma',
    };
  }

  const { nome, codigoEad } = separarDisciplina(celula);

  if (!nome) {
    return {
      ok: false,
      motivo:
        'nome da disciplina vazio depois de separar o código da disciplina',
    };
  }

  // Codigo da disciplina IGUAL ao da turma nao acrescenta nada: e o caso antigo
  // de "Nome (CODIGO)", que o `removerCodigo` do match ja resolve. Guardar os
  // dois iguais faria o tier composto casar consigo mesmo, sem separar nada.
  const disciplina =
    codigoEad && normalizar(codigoEad) !== normalizar(codigoTurma)
      ? codigoEad
      : null;

  return {
    ok: true,
    turma: {
      codigoTurma: codigoTurma.toUpperCase(),
      nomeDisciplina: nome,
      codigoEad: disciplina,
      idTurmaDisc: primeira(linha, TURMA_CSV_COLUNAS.idTurmaDisc) || null,
    },
  };
}
