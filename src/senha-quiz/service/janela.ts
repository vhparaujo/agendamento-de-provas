import { minutosDaHora } from './turno';

/**
 * ============================================================================
 * QUAL JANELA DE PROVA O CRON DEVE APLICAR AGORA
 * ============================================================================
 *
 * Irma de `turnoParaDisparar` (`turno.ts`), com o mesmo desenho e pelos mesmos
 * motivos: funcao PURA chamada por um tick de um minuto, em vez de `@Cron` com
 * expressao — decorator e avaliado uma vez, na subida, e os horarios sao
 * escolhidos pelo admin na tela. Salvar 15:31 as 15:25 precisa valer as 15:31.
 *
 * ⚠️ **DEVOLVE UMA LISTA, e essa e a diferenca que importa.** As 12:01 disparam
 * EaD (que passa para 15:00-18:00) e Semi/Modular (que passa para 14:00-15:30)
 * ao MESMO tempo, com janelas diferentes. Devolver um item so faria uma das duas
 * modalidades perder a sessao inteira, e o sintoma seria alunos batendo num
 * questionario fechado — sem erro nenhum no log.
 *
 * As janelas escolhidas entram todas na MESMA execucao, que percorre as turmas
 * uma vez e escolhe a janela pela modalidade derivada de cada turma. E o que
 * garante que nenhuma turma seja tocada duas vezes no mesmo disparo — dois PUTs
 * no mesmo questionario, e o ultimo venceria.
 *
 * ⚠️ Esta janela NAO seleciona turma, do mesmo jeito que o turno nao seleciona.
 * O conjunto continua sendo o das turmas do CSV no periodo letivo vigente; a
 * janela so diz QUAIS DATAS entram, e a modalidade da turma diz qual das janelas
 * e a dela.
 */

/**
 * A janela e do DIA SEGUINTE?
 *
 * Nao e configuracao, e ARITMETICA: se o disparo acontece depois da hora de
 * abertura, ele nao pode ser para hoje. Nao da para abrir uma prova as 08:30
 * quando ja sao 22:01 — a unica leitura possivel e "amanha as 08:30".
 *
 * E o que fecha o ciclo do dia: o ultimo disparo arma a primeira sessao da manha
 * seguinte, e todos os outros apontam para o proprio dia. Nos tres calendarios
 * semeados isso da exatamente uma janela por modalidade.
 *
 * ⚠️ **Deixou de ser escolha do admin em 25/08/2026.** Antes era um checkbox na
 * tela, e nao havia resposta certa que ele pudesse dar: marcar "hoje" numa
 * janela que dispara depois da abertura produz uma prova que abre no passado —
 * a API aceita, e o questionario nasce fechado. Um campo cuja unica resposta
 * correta e derivavel nao e configuracao, e uma chance de errar.
 *
 * Fica GRAVADO mesmo sendo derivado, como `AlunoImportado.ativo`: e o que faz a
 * tabela ser legivel sozinha, e o que o cron le sem ter de recalcular. O calculo
 * acontece em toda escrita (`salvarJanelas` e o seed), entao so um UPDATE
 * manual no banco poderia desalinha-lo.
 *
 * Empate (`disparo == abertura`) conta como HOJE: aplicar a janela no minuto
 * exato em que ela abre e apertado, mas nao e impossivel — e joga-la para amanha
 * deixaria a prova de hoje fechada.
 */
export function ehDoDiaSeguinte(
  horaDisparo: string,
  horaInicio: string,
): boolean {
  const disparo = minutosDaHora(horaDisparo);
  const inicio = minutosDaHora(horaInicio);

  // Hora mal formada nao decide nada: quem valida o formato e
  // `salvarJanelas`, e ali o erro vira 400 com a linha citada.
  if (disparo == null || inicio == null) return false;

  return disparo > inicio;
}

/** O que a decisao precisa saber de uma janela. */
export interface JanelaCandidata {
  id: number;
  modalidadeId: number;
  /** "HH:MM" no fuso da operacao. */
  horaDisparo: string;
  ativo: boolean;
}

/**
 * As janelas a disparar neste minuto — no maximo UMA por modalidade.
 *
 * A JANELA DE TOLERANCIA e a mesma de `turnoParaDisparar`, semiaberta
 * (`[inicio, inicio + tolerancia)`), e existe pelo mesmo motivo: um servidor que
 * estava fora as 15:31 e sobe as 15:42 ainda aplica a sessao das 16:00. Sem ela,
 * um deploy na hora errada custaria uma sessao inteira de alunos travados.
 *
 * Empate dentro da MESMA modalidade (tolerancia grande o bastante para duas
 * janelas se sobreporem): vence a que COMECOU MAIS TARDE — e a sessao corrente,
 * e aplicar a anterior por cima reabriria a prova que acabou de fechar. Com os
 * horarios semeados isso nao acontece: o menor intervalo entre dois disparos da
 * mesma modalidade e de 120 min (10:01 -> 12:01), contra os 30 min de tolerancia
 * padrao. A regra existe para o dia em que alguem apertar os horarios na tela.
 *
 * Modalidades diferentes NUNCA competem entre si: cada uma tem o seu calendario,
 * e duas janelas no mesmo minuto e o caso NORMAL (12:01), nao um conflito.
 *
 * Nao ha travessia de meia-noite, a mesma limitacao declarada em `turno.ts` —
 * e os horarios semeados a respeitam: o disparo mais tarde e 22:01, que com 30
 * min de tolerancia fecha as 22:31, ainda no mesmo dia. O que "vira o dia" e o
 * ALVO da janela (`diaSeguinte`), nunca o momento do disparo.
 */
export function janelasParaDisparar<T extends JanelaCandidata>(
  agoraHhMm: string,
  janelas: readonly T[],
  toleranciaMin: number,
): T[] {
  const agora = minutosDaHora(agoraHhMm);
  if (agora == null) return [];

  const tolerancia = Number.isFinite(toleranciaMin)
    ? Math.max(0, toleranciaMin)
    : 0;

  /** modalidadeId -> a candidata vencedora daquela modalidade. */
  const escolhidas = new Map<number, { janela: T; inicio: number }>();

  for (const janela of janelas) {
    // Janela desligada na tela. Diferente de apagada: o horario fica guardado
    // para o semestre em que a sessao voltar.
    if (!janela.ativo) continue;

    const inicio = minutosDaHora(janela.horaDisparo);
    // Horario mal digitado nao derruba o tick — as outras janelas do dia
    // dependem de ele continuar de pe. Mesma escolha de `minutosDaHora`.
    if (inicio == null) continue;

    // Piso de 1: a janela precisa conter ao menos o proprio minuto de inicio,
    // senao `tolerancia = 0` viraria "cron desligado" sem ninguem pedir isso.
    const fim = inicio + Math.max(tolerancia, 1);
    if (agora < inicio || agora >= fim) continue;

    const atual = escolhidas.get(janela.modalidadeId);
    if (!atual || inicio > atual.inicio) {
      escolhidas.set(janela.modalidadeId, { janela, inicio });
    }
  }

  // Ordem estavel por modalidade: o relatorio e o log de duas execucoes com os
  // mesmos dados precisam sair iguais, como em `alocacao.ts`.
  return [...escolhidas.values()]
    .sort((a, b) => a.janela.modalidadeId - b.janela.modalidadeId)
    .map((e) => e.janela);
}
