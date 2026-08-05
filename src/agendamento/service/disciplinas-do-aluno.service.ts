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

/** De onde saiu a lista de turmas. Muda o que fazer com curso desconhecido. */
type Origem = 'LAUNCH' | 'ENROLLMENTS';

/** O vinculo (curso) desta prova — quem decide a atribuicao das disciplinas. */
export interface VinculoDaProva {
  curso: string;
}

const SEM_PERIODO_LETIVO =
  'O periodo letivo ainda nao foi configurado. Procure a secretaria academica.';

/** Compara nome de curso ignorando acento, caixa e espaco duplicado. */
function normalizarCurso(curso: string | null | undefined): string {
  return String(curso ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

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

  /** As disciplinas que este vinculo consegue agendar. Pode vir vazia. */
  async agendaveis(
    aluno: AlunoJwtPayload,
    vinculo: VinculoDaProva,
  ): Promise<DisciplinaAgendavel[]> {
    const { agendaveis } = await this.cruzar(aluno, vinculo);
    return agendaveis;
  }

  /**
   * Igual ao anterior, mas devolve tambem o MOTIVO de nao ter achado — o portal
   * usa para dizer ao aluno algo melhor que "nao ha o que agendar".
   */
  async cruzar(
    aluno: AlunoJwtPayload,
    vinculo: VinculoDaProva,
  ): Promise<ResultadoDoCruzamento> {
    const origem = await this.turmasDoAluno(aluno);

    if (origem.motivo) return { agendaveis: [], motivo: origem.motivo };

    this.avisarSeFiltroDesligado(origem.origem);

    const cruzado = await this.turmaService.filtrarAgendaveis(origem.turmas);

    return this.doVinculo(cruzado, aluno, vinculo, origem.origem);
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

  /**
   * ==========================================================================
   * DE QUAL CURSO E CADA DISCIPLINA
   * ==========================================================================
   * Um agendamento cobre as disciplinas de UM vinculo (regra 4): quem tem dois
   * cursos faz duas provas, com duracoes diferentes. Enquanto a fonte era a
   * turma clicada, o proprio clique dizia de qual curso era a prova. Os
   * enrollments vem pelo RA — chegam misturados, e alguem precisa separar.
   *
   * Quem separa e a coluna Curso do CSV de turmas, comparada com o curso do
   * vinculo. Vinculo unico nao passa por aqui: nao ha o que decidir, e filtrar
   * transformaria uma divergencia de grafia no CSV em "voce nao tem prova".
   *
   * Curso desconhecido (`null` no CSV) e tratado conforme a origem, e a
   * diferenca importa: no LAUNCH o aluno CLICOU naquela turma — a escolha e
   * dele, e nao ha o que atribuir; nos ENROLLMENTS ninguem escolheu nada, entao
   * uma disciplina que nao se sabe de que curso e nao pode entrar numa prova de
   * curso especifico.
   */
  private doVinculo(
    resultado: ResultadoDoCruzamento,
    aluno: AlunoJwtPayload,
    vinculo: VinculoDaProva,
    origem: Origem,
  ): ResultadoDoCruzamento {
    if (aluno.vinculos.length <= 1 || resultado.agendaveis.length === 0) {
      return resultado;
    }

    const doCurso = normalizarCurso(vinculo.curso);

    const dele = resultado.agendaveis.filter((d) => {
      const curso = normalizarCurso(d.curso);

      if (!curso) return origem === 'LAUNCH';
      return curso === doCurso;
    });

    const foraDoCurso = resultado.agendaveis.length - dele.length;

    if (foraDoCurso > 0) {
      // Nao e erro: aluno de dois cursos tem disciplinas dos dois no semestre, e
      // cada prova cobre so as suas. Fica no log porque tambem e o sintoma de
      // grafia divergente entre os dois CSVs — e ai a secretaria precisa saber.
      this.logger.debug(
        `Matricula ${aluno.sub}: ${foraDoCurso} disciplina(s) de outro curso fora da prova de "${vinculo.curso}".`,
      );
    }

    return dele.length > 0
      ? { agendaveis: dele }
      : {
          agendaveis: [],
          motivo:
            `Nenhuma das suas disciplinas com prova neste semestre pertence ao curso ` +
            `${vinculo.curso}. Se voce tem mais de um curso, escolha o outro; ` +
            'se o erro continuar, procure a secretaria academica.',
        };
  }
}
