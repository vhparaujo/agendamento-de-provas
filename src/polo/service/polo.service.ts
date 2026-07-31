import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface Polo {
  id: number;
  nome: string;
  cidade: string | null;
  ativo: boolean;
}

export interface PoloComContagens extends Polo {
  totalSalas: number;
  totalAlunos: number;
}

@Injectable()
export class PoloService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(apenasAtivos?: boolean): Promise<PoloComContagens[]> {
    const polos = await this.prisma.polo.findMany({
      where: apenasAtivos ? { ativo: true } : undefined,
      orderBy: { nome: 'asc' },
      include: { _count: { select: { salas: true, alunos: true } } },
    });

    return polos.map(({ _count, ...polo }) => ({
      ...polo,
      totalSalas: _count.salas,
      totalAlunos: _count.alunos,
    }));
  }

  async buscar(id: number): Promise<PoloComContagens> {
    const polo = await this.prisma.polo.findUnique({
      where: { id },
      include: { _count: { select: { salas: true, alunos: true } } },
    });

    if (!polo) throw new NotFoundException(`Polo ${id} nao encontrado`);

    const { _count, ...dados } = polo;

    return {
      ...dados,
      totalSalas: _count.salas,
      totalAlunos: _count.alunos,
    };
  }

  /**
   * Cadastro de polo novo. O `nome` precisa ser IDENTICO ao valor da coluna
   * CAMPUS no CSV de alunos — e por essa string que a importacao liga aluno e
   * polo. Um acento ou espaco a mais faz todos os alunos daquele campus serem
   * rejeitados no proximo upload.
   */
  async criar(dados: { nome: string; cidade?: string }): Promise<Polo> {
    const nome = dados.nome.trim();

    const jaExiste = await this.prisma.polo.findUnique({ where: { nome } });
    if (jaExiste) {
      throw new ConflictException(`Ja existe um polo chamado "${nome}"`);
    }

    return this.prisma.polo.create({
      data: { nome, cidade: dados.cidade?.trim() || null },
      select: { id: true, nome: true, cidade: true, ativo: true },
    });
  }

  /**
   * `nome` NAO e alteravel de proposito — nao ha campo para ele no DTO. Renomear
   * um polo quebraria silenciosamente o casamento com o CSV de alunos: o proximo
   * upload nao acharia mais o polo e rejeitaria o campus inteiro. Se o nome
   * estiver errado, o caminho e corrigir na origem (planilha) e criar o polo certo.
   */
  async atualizar(
    id: number,
    dados: { cidade?: string | null; ativo?: boolean },
  ): Promise<Polo> {
    await this.buscar(id);

    return this.prisma.polo.update({
      where: { id },
      data: {
        cidade:
          dados.cidade === undefined ? undefined : dados.cidade?.trim() || null,
        ativo: dados.ativo,
      },
      select: { id: true, nome: true, cidade: true, ativo: true },
    });
  }
}
