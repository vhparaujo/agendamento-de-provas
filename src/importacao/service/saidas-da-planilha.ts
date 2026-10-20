/**
 * ============================================================================
 * FORA DA PLANILHA — quem esta no banco e nao veio no CSV COMPLETO do formato
 * ============================================================================
 * Decisao do cliente (20/10/2026): a planilha de cada formato e a lista de quem
 * esta na universidade, e quem sumiu dela saiu. O vinculo e MARCADO e bloqueado
 * para agendar — nunca apagado: a FK de `agendamento` recusa a remocao de quem
 * ja teve prova, e com razao (a prova feita precisa continuar nos relatorios).
 *
 * So roda quando o admin marca "este arquivo e a lista completa". O CSV de UM
 * aluno, usado para corrigir o status dele, e o uso normal da importacao, e
 * compara-lo com o banco bloquearia o formato inteiro.
 *
 * ⚠️ "Esta no arquivo" e decidido pelos IDS que o upsert gravou, nunca por
 * comparacao de texto. O unique `[matricula, curso]` vive numa collation que
 * ignora caixa e acento: "Pedagogia" no CSV ATUALIZA a linha "PEDAGOGIA" do
 * banco. Comparar as strings aqui marcaria como fora justamente o vinculo que
 * acabou de ser atualizado.
 *
 * Modulo puro: a importacao le o banco e grava; aqui so se decide quem sai.
 */

/**
 * Acima disto, a saida so e aplicada com uma segunda confirmacao explicita.
 * Numa virada de semestre normal sai uma fracao pequena do formato; um
 * percentual alto e quase sempre arquivo cortado, aba errada no dropdown ou o
 * CSV de um aluno so enviado com a caixa marcada.
 */
export const LIMITE_SAIDAS_PERCENTUAL = 10;

/** O vinculo como esta no banco, DEPOIS dos upserts desta importacao. */
export interface VinculoDoFormato {
  id: number;
  matricula: string;
  /** Ja marcado por uma importacao anterior: nao e marcado de novo. */
  foraDaPlanilhaEm: Date | null;
}

export interface SaidasCalculadas {
  /** Os vinculos que saem agora. */
  ids: number[];
  /** Vinculos do formato dentro da planilha — os gravados agora inclusive. */
  base: number;
  /** `ids.length / base`, em %, uma casa decimal. 0 quando a base e vazia. */
  percentual: number;
  acimaDoLimite: boolean;
}

/**
 * @param vinculos  todos os vinculos do formato do upload
 * @param gravados  ids que esta importacao criou ou atualizou
 * @param rasProtegidos RAs de linhas REJEITADAS. Linha rejeitada e cadastro
 *                  errado na planilha (CAMPUS vazio, polo que nao casa), nao
 *                  aluno que saiu — o vinculo dele nao foi gravado, mas ele
 *                  esta na lista. Protege todos os vinculos do RA.
 */
export function calcularSaidas(
  vinculos: VinculoDoFormato[],
  gravados: Set<number>,
  rasProtegidos: Set<string>,
): SaidasCalculadas {
  const dentro = vinculos.filter(
    (v) => v.foraDaPlanilhaEm === null || gravados.has(v.id),
  );

  const ids = dentro
    .filter(
      (v) =>
        !gravados.has(v.id) && !rasProtegidos.has(v.matricula.toUpperCase()),
    )
    .map((v) => v.id);

  const base = dentro.length;
  const percentual =
    base === 0 ? 0 : Math.round((ids.length / base) * 1000) / 10;

  return {
    ids,
    base,
    percentual,
    acimaDoLimite: percentual > LIMITE_SAIDAS_PERCENTUAL,
  };
}
