import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { StatusAgendamento } from '../../generated/prisma/client';

/** Cancelado nao ocupa lugar — mesma contagem que a alocacao usa. */
const OCUPADAS = {
  select: {
    agendamentos: { where: { status: StatusAgendamento.CONFIRMADO } },
  },
} as const;

export interface OfertaDetalhe {
  id: number;
  faixaId: number;
  salaId: number;
  salaNome: string;
  modalidade: { id: number; codigo: string; nome: string };
  vagas: number;
  ordem: number;
  ocupadas: number;
  disponiveis: number;
}

/**
 * Operacoes sobre UMA oferta (SalaFaixa) ja montada. Criar oferta e responsa-
 * bilidade do FaixaService, porque nasce junto com a faixa ou dentro dela.
 */
@Injectable()
export class SalaFaixaService {
  constructor(private readonly prisma: PrismaService) {}

  async buscar(id: number): Promise<OfertaDetalhe> {
    const oferta = await this.prisma.salaFaixa.findUnique({
      where: { id },
      include: {
        sala: { select: { id: true, nome: true, capacidade: true } },
        modalidade: true,
        _count: OCUPADAS,
      },
    });

    if (!oferta) throw new NotFoundException(`Oferta ${id} nao encontrada`);

    return {
      id: oferta.id,
      faixaId: oferta.faixaId,
      salaId: oferta.salaId,
      salaNome: oferta.sala.nome,
      modalidade: {
        id: oferta.modalidade.id,
        codigo: oferta.modalidade.codigo,
        nome: oferta.modalidade.nome,
      },
      vagas: oferta.vagas,
      ordem: oferta.ordem,
      ocupadas: oferta._count.agendamentos,
      disponiveis: Math.max(0, oferta.vagas - oferta._count.agendamentos),
    };
  }

  /**
   * Ajusta vagas e ordem de uma oferta ja publicada.
   *
   * A modalidade NAO muda: dentro de uma faixa a sala fica travada numa
   * modalidade, e trocar depois de haver agendamento colocaria alunos de uma
   * modalidade numa prova de outra duracao. Para mudar, remova e adicione de novo.
   */
  async atualizar(
    id: number,
    dados: { vagas?: number; ordem?: number },
  ): Promise<OfertaDetalhe> {
    const oferta = await this.prisma.salaFaixa.findUnique({
      where: { id },
      include: {
        sala: { select: { nome: true, capacidade: true } },
        modalidade: { select: { nome: true } },
        _count: OCUPADAS,
      },
    });

    if (!oferta) throw new NotFoundException(`Oferta ${id} nao encontrada`);

    if (dados.vagas !== undefined) {
      if (dados.vagas > oferta.sala.capacidade) {
        throw new BadRequestException(
          `A sala "${oferta.sala.nome}" tem ${oferta.sala.capacidade} lugares; ` +
            `nao da para ofertar ${dados.vagas} vagas.`,
        );
      }

      // Reduzir abaixo de quem ja agendou deixaria a sala em overbooking
      // instantaneo — e sem ninguem para desalocar automaticamente.
      if (dados.vagas < oferta._count.agendamentos) {
        throw new ConflictException(
          `Ja ha ${oferta._count.agendamentos} agendamento(s) nesta sala; ` +
            `nao da para reduzir para ${dados.vagas} vagas. ` +
            'Remaneje os alunos antes de diminuir.',
        );
      }
    }

    if (dados.ordem !== undefined && dados.ordem !== oferta.ordem) {
      const conflito = await this.prisma.salaFaixa.findFirst({
        where: {
          faixaId: oferta.faixaId,
          modalidadeId: oferta.modalidadeId,
          ordem: dados.ordem,
          id: { not: id },
        },
        include: { sala: { select: { nome: true } } },
      });

      if (conflito) {
        throw new ConflictException(
          `A ordem ${dados.ordem} ja e da sala "${conflito.sala.nome}" na ` +
            `modalidade ${oferta.modalidade.nome} desta faixa.`,
        );
      }
    }

    await this.prisma.salaFaixa.update({
      where: { id },
      data: { vagas: dados.vagas, ordem: dados.ordem },
    });

    return this.buscar(id);
  }

  async remover(id: number): Promise<{ mensagem: string }> {
    const oferta = await this.buscar(id);

    if (oferta.ocupadas > 0) {
      throw new ConflictException(
        `Esta sala ja tem ${oferta.ocupadas} aluno(s) agendado(s) e nao pode sair da faixa. ` +
          'Remaneje os agendamentos antes de remover a oferta.',
      );
    }

    await this.prisma.salaFaixa.delete({ where: { id } });

    return {
      mensagem: `Sala "${oferta.salaNome}" removida da faixa ${oferta.faixaId}`,
    };
  }
}
