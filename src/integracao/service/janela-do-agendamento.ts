import { idsDaJanela } from '../../periodo/service/periodo.service';

/** O que a busca precisa de uma janela cadastrada. */
export interface JanelaCadastrada {
  periodoLetivoId: string;
  rodada: string;
  letivosPorModalidade: { periodoLetivoId: string }[];
}

/**
 * A janela (`PeriodoAgendamento`) em que uma reserva foi feita.
 *
 * `Agendamento` nao guarda o id da janela: guarda o PAR `periodoLetivoId +
 * rodada`, como fotografia. O par casa quando a rodada e a mesma e o periodo
 * letivo e um dos que a janela cobre — o principal OU um do mapa por
 * modalidade (`idsDaJanela`, a mesma leitura do portal). Comparar so com o
 * principal perderia as provas presenciais de uma janela de duas grades.
 *
 * `janelas` tem de vir da MAIS RECENTE para a mais antiga: duas linhas do mesmo
 * par podem existir, e a mais recente e a que o portal trataria como a janela
 * daquela prova.
 */
export function janelaDoAgendamento<J extends JanelaCadastrada>(
  agendamento: { periodoLetivoId: string; rodada: string },
  janelas: readonly J[],
): J | undefined {
  return janelas.find(
    (janela) =>
      janela.rodada === agendamento.rodada &&
      idsDaJanela(janela).includes(agendamento.periodoLetivoId),
  );
}
