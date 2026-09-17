import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { duracaoEmMinutos, paraMinutos } from '../../components/horario.util';

export interface SalaParaValidar {
  id: number;
  nome: string;
  poloId: number;
  capacidade: number;
  ativo: boolean;
}

export interface ModalidadeParaValidar {
  id: number;
  nome: string;
  duracaoMinutos: number;
}

export interface FaixaParaValidar {
  poloId: number;
  horaInicio: string;
  horaFim: string;
}

/**
 * ============================================================================
 * REGRAS QUE TORNAM UMA OFERTA (SalaFaixa) VALIDA
 * ============================================================================
 * Compartilhadas entre criar a faixa inteira e adicionar uma sala depois — as
 * duas portas de entrada precisam das MESMAS regras, senao a segunda vira um
 * caminho para criar oferta impossivel.
 *
 * Todas sao erros de configuracao do admin, detectaveis na hora. Deixar passar
 * significa descobrir no dia da prova.
 */
export function validarOferta(
  faixa: FaixaParaValidar,
  sala: SalaParaValidar,
  modalidade: ModalidadeParaValidar,
  vagas: number,
): void {
  // 1. A sala precisa ser do MESMO polo da faixa. Sem isto, um aluno de
  //    Taguatinga poderia ser alocado numa sala de Ceilandia.
  if (sala.poloId !== faixa.poloId) {
    throw new BadRequestException(
      `A sala "${sala.nome}" pertence a outro polo e não pode entrar nesta faixa.`,
    );
  }

  if (!sala.ativo) {
    throw new BadRequestException(
      `A sala "${sala.nome}" está inativa e não pode ser usada em faixas. ` +
        'Reative a sala na tela de Salas, se ela voltou a ser usada.',
    );
  }

  // 2. A prova precisa CABER na faixa. Uma faixa de 1h30 com sala EaD (3h)
  //    e uma oferta impossivel: o aluno agendaria e nao teria tempo de prova.
  const janela = duracaoEmMinutos(faixa.horaInicio, faixa.horaFim);

  if (janela < modalidade.duracaoMinutos) {
    throw new BadRequestException(
      `A faixa ${faixa.horaInicio}–${faixa.horaFim} tem ${janela} min, ` +
        `mas a prova ${modalidade.nome} dura ${modalidade.duracaoMinutos} min. ` +
        'Aumente a faixa ou escolha outro formato para esta sala.',
    );
  }

  // 3. Nao ofertar mais vagas do que existem lugares.
  if (vagas > sala.capacidade) {
    throw new BadRequestException(
      `A sala "${sala.nome}" tem ${sala.capacidade} lugares; ` +
        `não é possível oferecer ${vagas} vagas.`,
    );
  }
}

/**
 * Uma oferta que JA existe e disputa a mesma sala fisica no mesmo dia.
 * `faixaAtiva` e `confirmados` decidem se ela de fato ocupa a sala — ver
 * exigirSalaLivreNoHorario.
 */
export interface OfertaConcorrente {
  faixaId: number;
  horaInicio: string;
  horaFim: string;
  faixaAtiva: boolean;
  salaId: number;
  salaNome: string;
  confirmados: number;
}

/**
 * Duas janelas do MESMO dia se cruzam no relogio.
 *
 * Intervalo semiaberto: 08:30-10:00 e 10:00-11:30 NAO se sobrepoem. A sala vaga
 * no instante em que a prova anterior acaba, e exigir um intervalo de virada
 * seria inventar uma regra que a universidade nao pediu — quem quiser folga
 * entre as provas cadastra a faixa seguinte mais tarde, como ja faz hoje.
 */
export function seSobrepoem(
  a: { horaInicio: string; horaFim: string },
  b: { horaInicio: string; horaFim: string },
): boolean {
  return (
    paraMinutos(a.horaInicio) < paraMinutos(b.horaFim) &&
    paraMinutos(b.horaInicio) < paraMinutos(a.horaFim)
  );
}

/**
 * ============================================================================
 * A MESMA SALA NAO RECEBE DUAS PROVAS AO MESMO TEMPO
 * ============================================================================
 * O unique de SalaFaixa e `[salaId, faixaId]` — por FAIXA, nao por HORARIO.
 * Ele impede a sala de entrar duas vezes na mesma faixa, e so. Nada no banco
 * impedia isto:
 *
 *   17/08  09:00-12:00  Sala 1  EAD      <- duas faixas diferentes,
 *   17/08  10:30-12:00  Sala 1  SEMI     <- as duas validas, a mesma porta
 *
 * Sao duas ofertas internamente coerentes, cada uma com seu formato, e o
 * sintoma so apareceria no dia: duas listas de presenca para a mesma sala, com
 * alunos de formatos e duracoes diferentes disputando as cadeiras.
 *
 * QUANDO UMA FAIXA CONCORRENTE **NAO** OCUPA A SALA: quando esta inativa E nao
 * tem ninguem confirmado. Faixa inativa sumiu do portal, entao nao ganha aluno
 * novo; sem confirmado, nao ha ninguem para aparecer no dia. Bloquear tambem
 * esse caso deixaria o admin sem saida, porque faixa com agendamento CANCELADO
 * nao pode ser apagada (FaixaService.remover) e prenderia a sala para sempre.
 *
 * Faixa inativa COM confirmado continua ocupando: desativar nao cancela prova
 * nenhuma (regra 7), e o admin pode agendar de proposito numa faixa desativada.
 * Aquelas pessoas vao estar na sala.
 */
export function exigirSalaLivreNoHorario(
  janela: { horaInicio: string; horaFim: string },
  concorrentes: OfertaConcorrente[],
): void {
  const choques = concorrentes
    .filter((c) => c.faixaAtiva || c.confirmados > 0)
    .filter((c) => seSobrepoem(janela, c))
    // Ordem estavel: a mensagem nao pode mudar a cada chamada com os mesmos
    // dados, senao o teste do front vira loteria.
    .sort(
      (a, b) =>
        a.salaNome.localeCompare(b.salaNome, 'pt-BR') ||
        paraMinutos(a.horaInicio) - paraMinutos(b.horaInicio),
    );

  if (choques.length === 0) return;

  const [primeiro] = choques;
  const outrasSalas = new Set(choques.map((c) => c.salaId)).size - 1;

  throw new ConflictException(
    `A sala "${primeiro.salaNome}" já tem prova das ${primeiro.horaInicio} às ` +
      `${primeiro.horaFim} neste dia (faixa #${primeiro.faixaId}), que se ` +
      `sobrepõe ao horário ${janela.horaInicio}–${janela.horaFim}. ` +
      'Uma sala não pode receber duas provas ao mesmo tempo.' +
      (outrasSalas > 0
        ? ` Outra(s) ${outrasSalas} sala(s) desta faixa têm o mesmo problema.`
        : '') +
      ' Use outra sala ou mude o horário.',
  );
}

/** Janela da faixa, ja recusando fim antes do inicio. */
export function janelaDaFaixa(horaInicio: string, horaFim: string): number {
  const minutos = duracaoEmMinutos(horaInicio, horaFim);

  if (minutos <= 0) {
    throw new BadRequestException(
      `A hora de fim (${horaFim}) precisa ser depois da hora de início (${horaInicio}). ` +
        'Não é possível cadastrar faixa que passa da meia-noite.',
    );
  }

  return minutos;
}

export function exigirEncontrado<T>(valor: T | null, mensagem: string): T {
  if (valor === null || valor === undefined) {
    throw new NotFoundException(mensagem);
  }

  return valor;
}
