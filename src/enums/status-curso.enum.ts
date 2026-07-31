/**
 * STATUS CURSO — coluna do CSV de alunos. Fonte unica da regra de elegibilidade.
 *
 * DECISAO (31/07/2026): a elegibilidade NAO e mais "status == Ativo". Situacoes
 * de transicao (transferencia, mudanca de habilitacao) mantem o aluno apto a
 * fazer prova; so os estados terminais barram.
 *
 * Os valores sao exatamente as grafias que aparecem nos arquivos reais — repare
 * que "Transf. de Curriculo" vem SEM acento e "Alter. de Habilitacao" COM. A
 * comparacao e feita de forma tolerante (ver `normalizar`), justamente para nao
 * depender disso.
 */
export const STATUS_PERMITEM_AGENDAR = [
  'Ativo',
  'Transf. Interna',
  'Transf. de Curriculo',
  'Alter. de Habilitação',
] as const;

export const STATUS_BLOQUEIAM_AGENDAR = [
  'Desistente',
  'Trancado',
  'Cancelado',
  'Formado',
] as const;

export type StatusPermitido = (typeof STATUS_PERMITEM_AGENDAR)[number];
export type StatusBloqueado = (typeof STATUS_BLOQUEIAM_AGENDAR)[number];

/**
 * Compara ignorando acentos, caixa e espacos repetidos. O CSV e ISO-8859-1 e
 * pode ser reexportado de outro jeito no futuro; um acento perdido no caminho
 * nao pode barrar um aluno que tem direito a fazer prova.
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
