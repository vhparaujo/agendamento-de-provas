import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface Sala {
  id: number;
  poloId: number;
  nome: string;
  capacidade: number;
  ativo: boolean;
}

export interface SalaComPolo extends Sala {
  polo: { id: number; nome: string };
  /** Em quantas faixas esta sala ja foi ofertada. */
  totalOfertas: number;
}

const SELECAO = {
  id: true,
  poloId: true,
  nome: true,
  capacidade: true,
  ativo: true,
} as const;

@Injectable()
export class SalaService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(filtros: {
    poloId?: number;
    apenasAtivas?: boolean;
  }): Promise<SalaComPolo[]> {
    const salas = await this.prisma.sala.findMany({
      where: {
        poloId: filtros.poloId,
        ativo: filtros.apenasAtivas ? true : undefined,
      },
      orderBy: [{ poloId: 'asc' }, { nome: 'asc' }],
      include: {
        polo: { select: { id: true, nome: true } },
        _count: { select: { salaFaixas: true } },
      },
    });

    return salas.map(({ _count, ...sala }) => ({
      ...sala,
      totalOfertas: _count.salaFaixas,
    }));
  }

  async buscar(id: number): Promise<SalaComPolo> {
    const sala = await this.prisma.sala.findUnique({
      where: { id },
      include: {
        polo: { select: { id: true, nome: true } },
        _count: { select: { salaFaixas: true } },
      },
    });

    if (!sala) throw new NotFoundException(`Sala ${id} nao encontrada`);

    const { _count, ...dados } = sala;

    return { ...dados, totalOfertas: _count.salaFaixas };
  }

  async criar(dados: {
    poloId: number;
    nome: string;
    capacidade: number;
  }): Promise<Sala> {
    const polo = await this.prisma.polo.findUnique({
      where: { id: dados.poloId },
    });

    if (!polo) {
      throw new NotFoundException(`Polo ${dados.poloId} nao encontrado`);
    }

    const nome = dados.nome.trim();

    const jaExiste = await this.prisma.sala.findUnique({
      where: { poloId_nome: { poloId: dados.poloId, nome } },
    });

    if (jaExiste) {
      throw new ConflictException(
        `O polo "${polo.nome}" ja tem uma sala chamada "${nome}"`,
      );
    }

    return this.prisma.sala.create({
      data: { poloId: dados.poloId, nome, capacidade: dados.capacidade },
      select: SELECAO,
    });
  }

  /**
   * O POLO da sala nao muda: a sala e um espaco fisico, nao se transfere de
   * campus. Alem disso, mover uma sala ja ofertada em faixas levaria alunos a
   * viajar para o polo errado. Sala no lugar errado = criar no polo certo e
   * desativar a antiga.
   */
  async atualizar(
    id: number,
    dados: { nome?: string; capacidade?: number; ativo?: boolean },
  ): Promise<Sala> {
    const sala = await this.buscar(id);
    const nome = dados.nome?.trim();

    if (nome && nome !== sala.nome) {
      const conflito = await this.prisma.sala.findUnique({
        where: { poloId_nome: { poloId: sala.poloId, nome } },
      });

      if (conflito) {
        throw new ConflictException(
          `O polo "${sala.polo.nome}" ja tem uma sala chamada "${nome}"`,
        );
      }
    }

    // Reduzir a capacidade nao mexe nas vagas das faixas ja montadas: `vagas`
    // vive na SalaFaixa e e o numero que valeu quando aquela oferta foi criada.
    // Mudar retroativamente poderia deixar uma sala com mais agendamentos que vagas.
    return this.prisma.sala.update({
      where: { id },
      data: { nome, capacidade: dados.capacidade, ativo: dados.ativo },
      select: SELECAO,
    });
  }

  /**
   * So apaga sala que nunca foi ofertada. Sala com historico vira inativa: os
   * agendamentos passados precisam continuar apontando para um lugar com nome.
   */
  async remover(id: number): Promise<{ mensagem: string }> {
    const sala = await this.buscar(id);

    if (sala.totalOfertas > 0) {
      throw new ConflictException(
        `A sala "${sala.nome}" ja foi usada em ${sala.totalOfertas} faixa(s) e nao pode ser apagada. ` +
          'Desative-a (PATCH ativo=false) para tira-la das proximas montagens.',
      );
    }

    await this.prisma.sala.delete({ where: { id } });

    return { mensagem: `Sala "${sala.nome}" removida` };
  }
}
