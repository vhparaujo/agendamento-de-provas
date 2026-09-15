import type { ModalidadeDaTurma } from '../../senha-quiz/service/modalidade-da-turma.service';

/**
 * ============================================================================
 * OS TRES BLOCOS DE GRUPOS — e a categoria de cada um (14/09/2026)
 * ============================================================================
 * Decisao do cliente: toda disciplina EaD tem a categoria "Provas Presenciais -
 * EAD"; toda disciplina Semipresencial ou Modular tem "Provas Presenciais - Semi
 * e Modular". Semi e Modular dividem a categoria porque dividem o calendario —
 * seis sessoes por dia, contra tres do EaD. O Presencial tem a sua (15/09/2026):
 * "Provas Presenciais - Presencial", cinco sessoes por dia.
 *
 * Os nomes ficam CRAVADOS aqui, e nao em tela de configuracao: sao a chave com
 * que o lote reencontra a categoria em cada turma, e uma categoria renomeada na
 * tela depois de criada faria o proximo lote criar OUTRA, duplicando os grupos
 * de 150 turmas. Mudar um destes textos exige renomear a categoria no
 * Brightspace antes.
 */

export const BLOCOS_DE_GRUPOS = ['EAD', 'SEMI_MODULAR', 'PRESENCIAL'] as const;

export type BlocoDeGrupos = (typeof BLOCOS_DE_GRUPOS)[number];

export interface DefinicaoDoBloco {
  nome: string;
  categoria: string;
  /** Codigos de `Modalidade`. */
  modalidades: readonly string[];
}

export const DEFINICAO_DO_BLOCO: Record<BlocoDeGrupos, DefinicaoDoBloco> = {
  EAD: {
    nome: 'EaD',
    categoria: 'Provas Presenciais - EAD',
    modalidades: ['EAD'],
  },
  SEMI_MODULAR: {
    nome: 'Semipresencial e Modular',
    categoria: 'Provas Presenciais - Semi e Modular',
    modalidades: ['SEMI', 'MODULAR'],
  },
  PRESENCIAL: {
    nome: 'Presencial',
    categoria: 'Provas Presenciais - Presencial',
    modalidades: ['PRESENCIAL'],
  },
};

/** Todas as modalidades que tem grupo de prova. */
export const MODALIDADES_COM_GRUPO: readonly string[] =
  BLOCOS_DE_GRUPOS.flatMap((bloco) => DEFINICAO_DO_BLOCO[bloco].modalidades);

export function blocoDaModalidade(
  codigo: string | null | undefined,
): BlocoDeGrupos | null {
  const alvo = String(codigo ?? '')
    .trim()
    .toUpperCase();

  return (
    BLOCOS_DE_GRUPOS.find((bloco) =>
      DEFINICAO_DO_BLOCO[bloco].modalidades.includes(alvo),
    ) ?? null
  );
}

export type BlocoDaTurma =
  | { situacao: 'BLOCO'; bloco: BlocoDeGrupos }
  /** Sem agendamento, ou modalidade sem bloco: nao ha grupo a criar. */
  | { situacao: 'FORA' }
  | { situacao: 'AMBIGUA'; detalhe: string };

/**
 * Em qual categoria a turma recebe os grupos.
 *
 * Reusa a derivacao do lote de datas (`ModalidadeDaTurmaService`) em vez de uma
 * propria: a troca de condicao do quiz procura o grupo na categoria da
 * modalidade que ELA decidiu, e duas regras acabariam criando os grupos numa
 * categoria e procurando em outra.
 *
 * ⚠️ **Semi + Modular na mesma turma NAO e ambiguidade aqui**, embora seja para
 * o lote de datas. As duas vao para a mesma categoria e tem os mesmos horarios,
 * entao nao ha o que decidir. So modalidades de BLOCOS diferentes na mesma
 * turma (EaD com Semi/Modular, qualquer um com Presencial) pedem o desempate da
 * tela "Senhas e datas".
 */
export function blocoDaTurma(decisao: ModalidadeDaTurma): BlocoDaTurma {
  if (decisao.situacao === 'ENCONTRADA') {
    const bloco = blocoDaModalidade(decisao.codigo);
    return bloco ? { situacao: 'BLOCO', bloco } : { situacao: 'FORA' };
  }

  if (decisao.motivo === 'SEM_AGENDAMENTO') return { situacao: 'FORA' };

  const blocos = new Set(
    decisao.candidatas.map((c) => blocoDaModalidade(c.codigo)),
  );

  if (blocos.size === 1) {
    const [unico] = [...blocos];
    return unico ? { situacao: 'BLOCO', bloco: unico } : { situacao: 'FORA' };
  }

  return {
    situacao: 'AMBIGUA',
    detalhe:
      `${decisao.detalhe} Sem saber a modalidade, nao ha como escolher a ` +
      'categoria. Desempate a turma na aba "Senhas e datas".',
  };
}

/** A D2L recusa estes caracteres no `Code` do grupo. */
const PROIBIDOS_NO_CODIGO = /[\\:*?"<>|'#,%&]/g;

export const TAMANHO_MAXIMO_DO_CODIGO = 50;

/**
 * O `Code` do grupo, derivado do nome.
 *
 * O cliente so digita o nome; pedir o codigo tambem dobraria a chance de erro
 * sem ganho nenhum — o lote reencontra o grupo pelo NOME, nunca pelo codigo.
 * Os caracteres que a API recusa viram `-`, e o corte em 50 e o limite dela.
 */
export function codigoDoGrupo(nome: string): string {
  return nome
    .replace(PROIBIDOS_NO_CODIGO, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TAMANHO_MAXIMO_DO_CODIGO)
    .trim();
}
