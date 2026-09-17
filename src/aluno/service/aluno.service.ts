import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AlunoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cruzamento matricula (RA) x CSV importado — a fonte de verdade de formato
   * e polo do aluno.
   *
   * Devolve TODOS os vinculos do RA (um por curso), porque um mesmo aluno pode
   * estar em dois cursos com formatos diferentes e precisa agendar os dois.
   * Na maioria esmagadora dos casos vem exatamente um.
   *
   * O RA e alfanumerico e usado como string exata ("UC25426847", "0009552430",
   * "A06103080"): nada de converter para numero, porque zeros a esquerda fazem
   * parte do identificador. So aparamos espacos e normalizamos a caixa, ja que o
   * CSV vem todo em maiusculas.
   */
  buscarVinculos(matricula: string) {
    return this.prisma.alunoImportado.findMany({
      where: { matricula: matricula.trim().toUpperCase() },
      include: { modalidade: true, polo: true },
      orderBy: { curso: 'asc' },
    });
  }
}
