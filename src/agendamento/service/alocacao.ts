export interface OfertaParaAlocar {
  /** Id da SalaFaixa. */
  id: number;
  ordem: number;
  vagas: number;
  ocupadas: number;
}

/**
 * ============================================================================
 * ALOCACAO SEQUENCIAL
 * ============================================================================
 * Enche a sala de MENOR `ordem` ate lotar; so entao usa a proxima.
 *
 * O contrario — espalhar os alunos entre as salas — daria a mesma contagem total
 * e seria pior na pratica: cinco salas com dez alunos cada exigem cinco fiscais e
 * cinco salas abertas, enquanto duas salas cheias e tres vazias exigem dois. A
 * ordem e o admin quem define ao montar a faixa, justamente porque a escolha e
 * operacional (sala melhor, mais perto, com mais acessibilidade primeiro).
 *
 * Funcao pura de proposito: a regra de negocio fica testavel sem banco, e a parte
 * dificil (a transacao que garante que `ocupadas` esta correto) fica so no
 * service.
 */
export function escolherOferta(
  ofertas: OfertaParaAlocar[],
): OfertaParaAlocar | null {
  return (
    [...ofertas]
      .sort((a, b) => a.ordem - b.ordem)
      .find((oferta) => oferta.ocupadas < oferta.vagas) ?? null
  );
}

/** Vagas ainda livres somando todas as salas — o numero que o aluno ve. */
export function totalDisponivel(ofertas: OfertaParaAlocar[]): number {
  return ofertas.reduce(
    (total, oferta) => total + Math.max(0, oferta.vagas - oferta.ocupadas),
    0,
  );
}
