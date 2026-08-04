import { Injectable } from '@nestjs/common';
import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import {
  DisciplinaAgendavel,
  ResultadoDoCruzamento,
  TurmaService,
} from '../../turma/service/turma.service';

/**
 * ============================================================================
 * QUAIS DISCIPLINAS A PROVA AGENDADA COBRE
 * ============================================================================
 * Regra (especificacao 3.3): disciplinas do aluno ∩ turmas reais com prova
 * (CSV) ∩ periodo letivo vigente.
 *
 * HOJE a fonte e a turma de onde ele clicou — o claim `context` do launch LTI,
 * que traz codigo, nome e orgUnitId. O cruzamento com o CSV e feito por
 * **codigo + nome**, sem depender da Valence API.
 *
 * NA FASE DE INTEGRACAO isto passa a consultar os enrollments pelo `userIdD2L` e
 * devolver todas as disciplinas de uma vez. Quem chama recebe a mesma lista, ja
 * filtrada — a costura existe aqui, e nao no AgendamentoService, para que a
 * troca seja de um arquivo so.
 */
@Injectable()
export class DisciplinasDoAlunoService {
  constructor(private readonly turmaService: TurmaService) {}

  /** As disciplinas que este launch consegue agendar. Pode vir vazia. */
  async agendaveis(aluno: AlunoJwtPayload): Promise<DisciplinaAgendavel[]> {
    const { agendaveis } = await this.cruzar(aluno);
    return agendaveis;
  }

  /**
   * Igual ao anterior, mas devolve tambem o MOTIVO de nao ter achado — o portal
   * usa para dizer ao aluno algo melhor que "nao ha o que agendar".
   */
  async cruzar(aluno: AlunoJwtPayload): Promise<ResultadoDoCruzamento> {
    // TODO(integracao D2L): trocar por
    // GET /d2l/api/lp/{ver}/enrollments/users/{userIdD2L}/orgUnits/
    return this.turmaService.filtrarAgendaveis(aluno.contexto);
  }
}
