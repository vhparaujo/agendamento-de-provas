/**
 * STATUS CURSO — coluna do CSV de alunos. Fonte unica da regra de elegibilidade.
 *
 * DECISAO VIGENTE (11/08/2026): **so "Ativo" agenda.** Qualquer outro status
 * bloqueia, incluindo as situacoes de transicao.
 *
 * Isto REVERTE a decisao de 31/07/2026, que tratava transferencia e mudanca de
 * habilitacao como aptas. O registro das duas fica aqui de proposito: quem
 * encontrar um aluno em "Transf. Interna" barrado precisa saber que isso e a
 * regra atual e nao um esquecimento — e, se a regra voltar a mudar, este e o
 * unico arquivo a alterar.
 *
 * ATENCAO — mudar esta lista NAO reclassifica quem ja esta no banco. O campo
 * `AlunoImportado.ativo` e derivado na IMPORTACAO e gravado; e ele que o
 * agendamento consulta. Depois de mexer aqui, rode `npm run alunos:recalcular`
 * (ou reimporte os CSVs) para a base seguir a regra nova.
 *
 * Os valores sao exatamente as grafias que aparecem nos arquivos reais — repare
 * que "Transf. de Curriculo" vem SEM acento e "Alter. de Habilitacao" COM. A
 * comparacao e feita de forma tolerante (ver `normalizar`), justamente para nao
 * depender disso.
 */
export const STATUS_PERMITEM_AGENDAR = ['Ativo'] as const;

export const STATUS_BLOQUEIAM_AGENDAR = [
  'Desistente',
  'Trancado',
  'Cancelado',
  'Formado',
  // Situacoes de transicao. Estiveram na lista de permitidos entre 31/07 e
  // 11/08/2026; continuam listadas aqui (e nao como "desconhecidas") porque sao
  // grafias REAIS dos arquivos: sinaliza-las como novidade a cada importacao
  // pediria uma decisao que ja foi tomada.
  'Transf. Interna',
  'Transf. de Curriculo',
  'Alter. de Habilitação',
] as const;

export type StatusPermitido = (typeof STATUS_PERMITEM_AGENDAR)[number];
export type StatusBloqueado = (typeof STATUS_BLOQUEIAM_AGENDAR)[number];

/**
 * Compara ignorando acentos, caixa e espacos repetidos. O CSV e ISO-8859-1 e
 * pode ser reexportado de outro jeito no futuro; um acento perdido no caminho
 * nao pode mudar a situacao de um aluno.
 */
function normalizar(status: string): string {
  return status
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos (combining marks)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const PERMITIDOS = new Set(STATUS_PERMITEM_AGENDAR.map(normalizar));
const BLOQUEADOS = new Set(STATUS_BLOQUEIAM_AGENDAR.map(normalizar));

/**
 * O aluno pode agendar prova com este STATUS CURSO?
 *
 * Status DESCONHECIDO (grafia nova que apareca num CSV futuro) bloqueia por
 * seguranca — e a importacao reporta o valor encontrado, para que alguem decida
 * conscientemente em qual das duas listas ele entra.
 */
export function permiteAgendar(status: string | null | undefined): boolean {
  if (!status) return false;

  return PERMITIDOS.has(normalizar(status));
}

/** Status que nao esta em nenhuma das duas listas — merece aviso na importacao. */
export function statusDesconhecido(status: string | null | undefined): boolean {
  if (!status) return true;

  const normalizado = normalizar(status);

  return !PERMITIDOS.has(normalizado) && !BLOQUEADOS.has(normalizado);
}
