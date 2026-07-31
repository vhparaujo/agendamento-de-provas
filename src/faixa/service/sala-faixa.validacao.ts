import { BadRequestException, NotFoundException } from '@nestjs/common';
import { duracaoEmMinutos } from '../../components/horario.util';

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
      `A sala "${sala.nome}" pertence a outro polo e nao pode entrar nesta faixa.`,
    );
  }

  if (!sala.ativo) {
    throw new BadRequestException(
      `A sala "${sala.nome}" esta inativa e nao pode ser ofertada.`,
    );
  }

  // 2. A prova precisa CABER na faixa. Uma faixa de 1h30 com sala EaD (3h)
  //    e uma oferta impossivel: o aluno agendaria e nao teria tempo de prova.
  const janela = duracaoEmMinutos(faixa.horaInicio, faixa.horaFim);

  if (janela < modalidade.duracaoMinutos) {
    throw new BadRequestException(
      `A faixa ${faixa.horaInicio}–${faixa.horaFim} tem ${janela} min, ` +
        `mas a prova ${modalidade.nome} dura ${modalidade.duracaoMinutos} min. ` +
        'Aumente a faixa ou escolha outra modalidade para esta sala.',
    );
  }

  // 3. Nao ofertar mais vagas do que existem lugares.
  if (vagas > sala.capacidade) {
    throw new BadRequestException(
      `A sala "${sala.nome}" tem ${sala.capacidade} lugares; ` +
        `nao da para ofertar ${vagas} vagas.`,
    );
  }
}

/** Janela da faixa, ja recusando fim antes do inicio. */
export function janelaDaFaixa(horaInicio: string, horaFim: string): number {
  const minutos = duracaoEmMinutos(horaInicio, horaFim);

  if (minutos <= 0) {
    throw new BadRequestException(
      `horaFim (${horaFim}) precisa ser depois de horaInicio (${horaInicio}). ` +
        'Faixa que vira a meia-noite nao e suportada.',
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
