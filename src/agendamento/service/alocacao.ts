import { paraMinutos } from '../../components/horario.util';

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

export interface FaixaParaAlocar {
  id: number;
  /** Coluna `@db.Date`: so a data importa, a hora vem de `horaInicio`. */
  data: Date;
  /** "08:30" — validado por PADRAO_HORA na entrada da faixa. */
  horaInicio: string;
}

/**
 * ============================================================================
 * A ORDEM DOS DIAS — a segunda dimensao, usada so pelo COMPULSORIO
 * ============================================================================
 * No portal quem escolhe o dia e o aluno; o backend nunca precisou ordenar
 * faixas. No agendamento compulsorio nao ha quem escolha, entao a regra passa a
 * ser: enche da data MAIS PROXIMA para a mais distante, e so abre a proxima
 * quando todas as salas daquela lotam.
 *
 * E a mesma logica do `escolherOferta` uma dimensao acima, e pelo mesmo motivo
 * operacional: concentrar em vez de espalhar. Espalhar 7 mil alunos por todas
 * as datas manteria o campus inteiro mobilizado durante todo o periodo de
 * provas, com fiscal em sala quase vazia no ultimo dia.
 *
 * `id` desempata o que cai no mesmo dia e horario. Nao e detalhe: sem ele, duas
 * faixas empatadas poderiam sair em ordens diferentes entre a SIMULACAO e a
 * EXECUCAO do lote — e o admin veria um resultado diferente do que aprovou.
 */
export function ordenarPorProximidade<T extends FaixaParaAlocar>(
  faixas: T[],
): T[] {
  return [...faixas].sort(
    (a, b) =>
      a.data.getTime() - b.data.getTime() ||
      paraMinutos(a.horaInicio) - paraMinutos(b.horaInicio) ||
      a.id - b.id,
  );
}

/** O estado mutavel de uma oferta durante a simulacao do compulsorio. */
export interface VagaSimulada {
  vagas: number;
  ocupadas: number;
  ordem: number;
}

/**
 * ============================================================================
 * A ALOCACAO DA SIMULACAO — as duas dimensoes juntas, sem tocar no banco
 * ============================================================================
 * Percorre as faixas na ordem recebida (`ordenarPorProximidade`) e, dentro de
 * cada uma, as salas por `ordem`. Ocupa a primeira vaga que achar e devolve
 * `true`; devolve `false` quando nao cabe em lugar nenhum — o `SEM_VAGA` do
 * relatorio.
 *
 * **`ocupacao` e mutado de proposito.** E ele que carrega, de um aluno para o
 * proximo, a vaga que acabou de ser tomada. Trabalhar sobre uma copia faria
 * todos caberem na primeira sala, e a simulacao responderia "cabe todo mundo"
 * justamente no caso em que nao cabe — que e a unica pergunta que ela existe
 * para responder.
 *
 * **`faixasDaPessoa` e mutado pelo mesmo motivo, e responde a outra regra:** uma
 * pessoa nao pode ter duas provas na mesma faixa, nem que sejam de dois cursos
 * (`exigirUmaProvaPorFaixa`). O conjunto entra com as faixas que aquele RA JA
 * tem no banco e sai com a que acabou de ser escolhida; sem ele, os dois
 * vinculos do mesmo aluno cairiam no mesmo horario aqui e em horarios
 * diferentes na execucao real — e a simulacao deixaria de prever o lote, que e
 * a unica coisa que ela precisa fazer.
 *
 * Nao ha equivalente `ComLock` aqui porque nada disto vai para o banco: a
 * execucao real usa `escolherOfertaComLock`, sob transacao.
 */
export function ocuparVagaSimulada(
  faixas: { id: number; ofertas: { id: number; modalidadeId: number }[] }[],
  modalidadeId: number,
  ocupacao: Map<number, VagaSimulada>,
  faixasDaPessoa: Set<number>,
): boolean {
  for (const faixa of faixas) {
    // A pessoa ja tem prova neste horario pelo outro curso: pula para a proxima
    // data, igual ao que a execucao real faz ao pegar o ConflictException.
    if (faixasDaPessoa.has(faixa.id)) continue;

    const daModalidade = faixa.ofertas
      .filter((o) => o.modalidadeId === modalidadeId)
      // O objeto VIVO do mapa, nunca uma copia — ver o paragrafo acima.
      .map((o) => ocupacao.get(o.id))
      .filter((o) => o !== undefined)
      .sort((a, b) => a.ordem - b.ordem);

    const escolhida = daModalidade.find((o) => o.ocupadas < o.vagas);

    if (escolhida) {
      escolhida.ocupadas++;
      faixasDaPessoa.add(faixa.id);
      return true;
    }
  }

  return false;
}

/** Vagas ainda livres somando todas as salas — o numero que o aluno ve. */
export function totalDisponivel(ofertas: OfertaParaAlocar[]): number {
  return ofertas.reduce(
    (total, oferta) => total + Math.max(0, oferta.vagas - oferta.ocupadas),
    0,
  );
}
