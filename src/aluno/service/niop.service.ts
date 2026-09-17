import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';

export interface SituacaoNiop {
  matricula: string;
  niop: boolean;
  marcadoPor: string | null;
  marcadoEm: Date | null;
}

/**
 * A marca do NIOP (Nucleo de Inclusao — pessoas com deficiencia): quem a tem
 * recebe, no special access, o tempo de prova do formato mais o extra
 * configurado.
 *
 * E a unica escrita sobre ALUNO que nao vem do CSV, e por isso mora em tabela
 * propria (`aluno_niop`), por matricula: a importacao sobrescreve o vinculo a
 * cada upload e apagaria uma coluna marcada na tela. O direito e da PESSOA — os
 * dois cursos de um RA valem igual.
 */
@Injectable()
export class NiopService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async marcar(matricula: string, adminEmail: string): Promise<SituacaoNiop> {
    const ra = this.limpar(matricula);

    // So quem existe na base: marcar um RA digitado errado deixaria a pessoa
    // certa sem a hora a mais, e ninguem veria o erro.
    const aluno = await this.prisma.alunoImportado.findFirst({
      where: { matricula: ra },
      select: { id: true },
    });

    if (!aluno) {
      throw new NotFoundException(
        `Nenhum aluno importado com a matrícula ${ra}.`,
      );
    }

    const ja = await this.prisma.alunoNiop.findUnique({
      where: { matricula: ra },
    });

    const linha =
      ja ??
      (await this.prisma.alunoNiop.create({
        data: { matricula: ra, marcadoPor: adminEmail },
      }));

    if (!ja) {
      this.auditoria.registrar('NIOP_MARCADO', {
        ator: adminEmail,
        detalhe: `matricula ${ra}`,
      });
    }

    return {
      matricula: ra,
      niop: true,
      marcadoPor: linha.marcadoPor,
      marcadoEm: linha.createdAt,
    };
  }

  async desmarcar(
    matricula: string,
    adminEmail: string,
  ): Promise<SituacaoNiop> {
    const ra = this.limpar(matricula);

    const { count } = await this.prisma.alunoNiop.deleteMany({
      where: { matricula: ra },
    });

    if (count > 0) {
      this.auditoria.registrar('NIOP_DESMARCADO', {
        ator: adminEmail,
        detalhe: `matricula ${ra}`,
      });
    }

    return { matricula: ra, niop: false, marcadoPor: null, marcadoEm: null };
  }

  private limpar(matricula: string): string {
    const ra = String(matricula ?? '').trim();

    if (!ra || ra.length > 64) {
      throw new BadRequestException('Matrícula inválida.');
    }

    return ra;
  }
}
