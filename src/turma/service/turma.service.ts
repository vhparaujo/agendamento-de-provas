import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';

/** Disciplina do aluno vinda da Valence (enrollments). */
export interface DisciplinaValence {
  orgUnitId: string;
  nome?: string | null;
  /** Periodo letivo (semester/term) ao qual a disciplina pertence no D2L. */
  periodoLetivoId?: string | null;
}

export interface DisciplinaAgendavel {
  orgUnitId: string;
  nomeDisciplina: string | null;
}

@Injectable()
export class TurmaService {
  private readonly logger = new Logger(TurmaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * O cruzamento triplo da especificacao (secao 3.3):
   *
   *   disciplinas do aluno na Valence
   *   ∩ turmas reais com prova (TurmaImportada)
   *   ∩ periodo letivo vigente
   *
   * NAO sao todas as disciplinas do aluno — so as que efetivamente terao prova.
   */
  async filtrarAgendaveis(
    disciplinas: DisciplinaValence[],
    periodoLetivoId?: string,
  ): Promise<DisciplinaAgendavel[]> {
    const periodo =
      periodoLetivoId ?? this.config.get<string>('PERIODO_LETIVO_ID');

    // 1) periodo letivo vigente. Disciplina sem periodo informado passa: quem
    //    filtra o periodo de verdade e a consulta de enrollments na Valence.
    const doPeriodo = periodo
      ? disciplinas.filter(
          (d) => !d.periodoLetivoId || d.periodoLetivoId === periodo,
        )
      : disciplinas;

    if (doPeriodo.length === 0) return [];

    // 2) interseccao com as turmas reais
    if (!(await this.filtroDeTurmasAtivo())) {
      // Sem filtro: toda disciplina do periodo e agendavel.
      return doPeriodo.map((d) => ({
        orgUnitId: d.orgUnitId,
        nomeDisciplina: d.nome ?? null,
      }));
    }

    const turmas = await this.prisma.turmaImportada.findMany({
      where: { orgUnitId: { in: doPeriodo.map((d) => d.orgUnitId) } },
      select: { orgUnitId: true, nomeDisciplina: true },
    });

    const porOrgUnit = new Map(turmas.map((t) => [t.orgUnitId, t]));

    return doPeriodo
      .filter((d) => porOrgUnit.has(d.orgUnitId))
      .map((d) => ({
        orgUnitId: d.orgUnitId,
        // o nome da turma importada manda; o da Valence e fallback
        nomeDisciplina:
          porOrgUnit.get(d.orgUnitId)?.nomeDisciplina ?? d.nome ?? null,
      }));
  }

  /**
   * O filtro de turmas esta valendo?
   *
   * `TURMAS_FILTER_ENABLED=true` (DEFAULT SEGURO): so e agendavel o que estiver
   * na tabela de turmas. Com a tabela vazia, NADA e agendavel — de proposito:
   * e melhor ninguem agendar do que liberar prova para a disciplina errada
   * enquanto o CSV de turmas nao chega.
   *
   * `TURMAS_FILTER_ENABLED=false`: o filtro nao restringe nada; toda disciplina
   * do periodo vira agendavel. So use conscientemente.
   */
  async filtroDeTurmasAtivo(): Promise<boolean> {
    const ativo = this.config.get<string>('TURMAS_FILTER_ENABLED') !== 'false';

    if (ativo && (await this.prisma.turmaImportada.count()) === 0) {
      this.logger.warn(
        'Nenhuma turma importada e TURMAS_FILTER_ENABLED=true: nada e agendavel. ' +
          'Importe o CSV de turmas (POST /api/importacao/turmas).',
      );
    }

    return ativo;
  }
}
