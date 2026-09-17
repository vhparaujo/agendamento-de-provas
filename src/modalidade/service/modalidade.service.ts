import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface Modalidade {
  id: number;
  codigo: string;
  nome: string;
  duracaoMinutos: number;
  /** O `TimeLimitValue` do special access. Editado em Special access > Configuracao. */
  tempoDeProvaMinutos: number;
}

@Injectable()
export class ModalidadeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Popula o dropdown de formato na montagem da faixa. */
  listar(): Promise<Modalidade[]> {
    return this.prisma.modalidade.findMany({ orderBy: { id: 'asc' } });
  }

  async buscar(id: number): Promise<Modalidade> {
    const modalidade = await this.prisma.modalidade.findUnique({
      where: { id },
    });

    if (!modalidade) {
      throw new NotFoundException(
        'Formato não encontrado. Atualize a página e tente de novo.',
      );
    }

    return modalidade;
  }
}
