import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface Modalidade {
  id: number;
  codigo: string;
  nome: string;
  duracaoMinutos: number;
}

@Injectable()
export class ModalidadeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Popula o dropdown de modalidade na montagem da faixa. */
  listar(): Promise<Modalidade[]> {
    return this.prisma.modalidade.findMany({ orderBy: { id: 'asc' } });
  }

  async buscar(id: number): Promise<Modalidade> {
    const modalidade = await this.prisma.modalidade.findUnique({
      where: { id },
    });

    if (!modalidade) {
      throw new NotFoundException(`Modalidade ${id} nao encontrada`);
    }

    return modalidade;
  }
}
