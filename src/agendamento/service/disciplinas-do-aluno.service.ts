import { Injectable, Logger } from '@nestjs/common';
import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import { D2lEnrollmentsService } from '../../d2l/service/d2l-enrollments.service';
import { PeriodoService } from '../../periodo/service/periodo.service';
import {
  DisciplinaAgendavel,
  ResultadoDoCruzamento,
  TurmaService,
} from '../../turma/service/turma.service';
import type { TurmaDoLaunch } from '../../turma/service/turma-match';

/** De onde saiu a lista de turmas. So muda a mensagem quando nao ha nenhuma. */
type Origem = 'LAUNCH' | 'ENROLLMENTS';

const SEM_PERIODO_LETIVO =
  'O periodo letivo ainda nao foi configurado. Procure a secretaria academica.';

/**
 * ============================================================================
 * QUAIS DISCIPLINAS A PROVA AGENDADA COBRE
 * ============================================================================
 * Regra (especificacao 3.3): disciplinas do aluno ∩ turmas reais com prova
 * (CSV) ∩ periodo letivo vigente.
 *
 * Sao DUAS fontes possiveis para o primeiro conjunto, e a escolha e a unica
 * coisa que este arquivo decide:
 *
 * - `D2L_HABILITADO=true`  -> os enrollments da Valence, filtrados pelo periodo
 *   letivo que o ADMIN cadastrou em `PeriodoAgendamento`. Traz TODAS as
 *   disciplinas do aluno no semestre, nao so a que ele clicou.
 * - `D2L_HABILITADO=false` -> a turma de onde ele clicou (claim `context` do
 *   LTI). E o comportamento anterior, e continua sendo o de quem ainda nao tem
 *   credencial da Valence.
 *
 * O cruzamento com o CSV e o mesmo nos dois casos (`TurmaService`): a costura
 * existe aqui, e nao no `AgendamentoService`, para que a troca de fonte seja de
 * um arquivo so.
 *
 * O aluno NAO agenda disciplina por disciplina: um agendamento cobre TODAS as
 * disciplinas com prova dele, de uma vez. Ele clica o link LTI de dentro de
 * qualquer uma delas e ve a lista inteira.
 *
 * ⚠️ **A lista nao e separada por vinculo** (decisao de 10/08/2026). Uma turma
 * tem alunos de varios cursos, entao o CSV de turmas nao pode dizer de qual
 * curso cada oferta e — e sem isso nao ha como atribuir a disciplina a um
 * vinculo. Quem tem dois vinculos NA MESMA MATRICULA recebe as disciplinas dos
 * dois cursos juntas pelos enrollments, com duracoes de prova diferentes. Sao 2
 * alunos em 7519 na base real; resolver isso exige a informacao do par
 * (aluno, turma), que nenhum dos dois CSVs tem hoje.
 */
@Injectable()
export class DisciplinasDoAlunoService {
  private readonly logger = new Logger(DisciplinasDoAlunoService.name);

  /** Ver `avisarSeFiltroDesligado`: o aviso sai uma vez por processo. */
  private avisouFiltroDesligado = false;

  constructor(
    private readonly turmaService: TurmaService,
    private readonly enrollments: D2lEnrollmentsService,
    private readonly periodo: PeriodoService,
  ) {}

  /** As disciplinas que o aluno consegue agendar. Pode vir vazia. */
  async agendaveis(aluno: AlunoJwtPayload): Promise<DisciplinaAgendavel[]> {
    const { agendaveis } = await this.cruzar(aluno);
    return agendaveis;
  }

  /**
   * Igual ao anterior, mas devolve tambem o MOTIVO de nao ter achado — o portal
   * usa para dizer ao aluno algo melhor que "nao ha o que agendar".
   */
  async cruzar(aluno: AlunoJwtPayload): Promise<ResultadoDoCruzamento> {
    const origem = await this.turmasDoAluno(aluno);

    if (origem.motivo) return { agendaveis: [], motivo: origem.motivo };

    this.avisarSeFiltroDesligado(origem.origem);

    return this.turmaService.filtrarAgendaveis(origem.turmas);
  }

  /**
   * `TURMAS_FILTER_ENABLED=false` ficou MUITO mais perigoso com os enrollments.
   *
   * Com a turma clicada, desligar o filtro liberava uma disciplina — a que o
   * aluno escolheu. Com os enrollments, libera o semestre inteiro dele: o CSV de
   * turmas e justamente quem diz QUAIS turmas tem prova, e sem ele toda
   * disciplina vira prova. O aviso sai uma vez por processo, para nao virar
   * ruido em cada request.
   */
  private avisarSeFiltroDesligado(origem: Origem): void {
    if (origem !== 'ENROLLMENTS' || this.turmaService.filtroAtivo()) return;
    if (this.avisouFiltroDesligado) return;

    this.avisouFiltroDesligado = true;

    this.logger.warn(
      'TURMAS_FILTER_ENABLED=false com os enrollments ligados: TODA disciplina do ' +
        'semestre esta sendo tratada como disciplina com prova. Ligue o filtro e ' +
        'importe o CSV de turmas.',
    );
  }

  /** As turmas do aluno, antes de qualquer filtro de prova. */
  private async turmasDoAluno(aluno: AlunoJwtPayload): Promise<{
    turmas: TurmaDoLaunch[];
    origem: Origem;
    motivo?: string;
  }> {
    if (!this.enrollments.habilitado()) {
      return {
        turmas: aluno.contexto ? [aluno.contexto] : [],
        origem: 'LAUNCH',
      };
    }

    // O semestre e o que o admin cadastrou, nao o "atual" segundo o relogio: e
    // ele quem diz quais ofertas do Brightspace contam nesta janela.
    const periodoLetivoId = await this.periodo.periodoLetivoVigente();

    if (!periodoLetivoId) {
      return { turmas: [], origem: 'ENROLLMENTS', motivo: SEM_PERIODO_LETIVO };
    }

    const ofertas = await this.enrollments.ofertasDoPeriodo(
      aluno.userIdD2L,
      periodoLetivoId,
    );

    return {
      turmas: ofertas,
      origem: 'ENROLLMENTS',
      motivo:
        ofertas.length === 0
          ? 'Nenhuma disciplina sua aparece no periodo letivo vigente. Procure a secretaria academica.'
          : undefined,
    };
  }
}
