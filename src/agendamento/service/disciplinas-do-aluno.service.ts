import { Injectable } from '@nestjs/common';
import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import {
  DisciplinaAgendavel,
  DisciplinaValence,
  TurmaService,
} from '../../turma/service/turma.service';

/**
 * ============================================================================
 * QUAIS DISCIPLINAS A PROVA AGENDADA COBRE
 * ============================================================================
 * Regra (especificacao 3.3): disciplinas do aluno na Valence ∩ turmas reais com
 * prova (CSV) ∩ periodo letivo vigente. O cruzamento em si ja esta pronto em
 * TurmaService.filtrarAgendaveis; o que este service resolve e a PRIMEIRA parte
 * — de onde vem a lista de disciplinas do aluno.
 *
 * HOJE a fonte e a turma de onde ele clicou (claim `context` do launch LTI).
 * Nao ha credencial da Valence, entao nao ha como listar as matriculas dele.
 *
 * NA ETAPA 7 esta classe passa a consultar os enrollments pelo `userIdD2L` e
 * devolver todas as disciplinas de uma vez. Nada mais muda: quem chama recebe a
 * mesma lista ja filtrada, e o agendamento continua cobrindo N disciplinas.
 *
 * A costura existe aqui, e nao no AgendamentoService, para que a troca seja de
 * um arquivo so.
 */
@Injectable()
export class DisciplinasDoAlunoService {
  constructor(private readonly turmaService: TurmaService) {}

  /** As disciplinas que este launch consegue agendar. Pode vir vazia. */
  async agendaveis(aluno: AlunoJwtPayload): Promise<DisciplinaAgendavel[]> {
    return this.turmaService.filtrarAgendaveis(this.disciplinasDoAluno(aluno));
  }

  /**
   * TODO(etapa 7): trocar pelo enrollments da Valence
   * (GET /d2l/api/lp/{ver}/enrollments/myenrollments/ pelo userIdD2L).
   */
  private disciplinasDoAluno(aluno: AlunoJwtPayload): DisciplinaValence[] {
    if (!aluno.contexto) return [];

    return [
      {
        orgUnitId: aluno.contexto.orgUnitId,
        nome: aluno.contexto.titulo ?? null,
        // O launch nao informa o periodo letivo da turma. Deixar indefinido faz
        // o filtro de periodo passar — quem de fato garante o periodo e a
        // presenca da turma no CSV, que e importado por semestre.
        periodoLetivoId: null,
      },
    ];
  }
}
