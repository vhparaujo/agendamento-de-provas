import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { montarCsv } from '../../agendamento/service/csv-relatorio';
import { PrismaService } from '../../database/prisma.service';
import {
  NaoEncontradoNoBrightspace,
  RecusaDoBrightspace,
} from '../../d2l/service/d2l-http.service';
import {
  type AcessoEspecialDaLista,
  D2lQuizzesService,
  type OpcoesDeRitmo,
} from '../../d2l/service/d2l-quizzes.service';
import {
  Prisma,
  ResultadoSpecialAccess,
  StatusAgendamento,
  StatusExecucao,
  TipoMatchQuiz,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { GradeSenhasService } from '../../senha-quiz/service/grade-senhas.service';
import { casarPorNome } from '../../senha-quiz/service/quiz-body';
import { FUSO_DA_OPERACAO } from '../../senha-quiz/service/relogio';
import { carregarRitmoDoSpecialAccess } from '../config/special-access.config';
import {
  AlunoComAcesso,
  alunosDaTurma,
  corpoDoAcesso,
  planejarAcessos,
  ReservaNaTurma,
} from './acesso';
import { ConfiguracaoSpecialAccessService } from './configuracao-special-access.service';
import { ehPendencia } from './resultado';

/**
 * ============================================================================
 * O LOTE QUE GRAVA O SPECIAL ACCESS DE CADA ALUNO AGENDADO (15/09/2026)
 * ============================================================================
 * A alternativa a troca diaria de data e de grupo do questionario.
 * O questionario fica sem data e restrito a quem tem special access (o PREPARO,
 * em `src/senha-quiz`), e este lote da a cada aluno a janela da faixa dele.
 *
 * Mesma forma do lote de grupos: a rota responde na hora com o id, o lote roda
 * em segundo plano gravando o andamento a cada turma, e a tela pergunta.
 *
 * **Le antes de escrever, e escreve so a diferenca.** Para cada questionario, um
 * GET traz os special access que ja existem; quem esta certo nao gera chamada,
 * quem mudou de horario (remanejo) e atualizado, e quem teve a prova cancelada
 * perde o acesso. Rodar de novo e barato e continua de onde parou.
 *
 * **Simulacao faz as LEITURAS e nenhuma escrita.**
 *
 * **Usuario que o portal nao conhece nunca e tocado.** Um special access sem
 * reserva na turma pode ter sido dado a mao no AVA; ele vira linha informativa.
 *
 * O recorte e a JANELA VIGENTE (`periodoLetivoIds` + `rodada`): as reservas
 * confirmadas e canceladas dela, turma a turma.
 *
 * NAO faz PUT no objeto do questionario — so no recurso `specialaccess`, que e
 * separado. Por isso nao precisa da trava dos lotes de senha e data.
 */

/** Silencio maior que isto = lote morto. Mesmo criterio do compulsorio. */
const SILENCIO_ATE_MORRER_MS = 5 * 60_000;

export interface OpcoesDoSpecialAccess {
  simulacao: boolean;
  /**
   * As turmas a tocar. **Vazio = todas as que tem reserva na rodada.**
   *
   * Existe para fatiar a carga: o lote e uma chamada por aluno em cada
   * questionario, e quem decide quanto o Brightspace recebe de cada vez e a
   * secretaria — nao o tamanho da rodada.
   */
  orgUnitIds: string[];
}

/** Uma turma no seletor da tela: o tamanho do trabalho que ela representa. */
export interface TurmaDoSpecialAccess {
  orgUnitId: string;
  codigoTurma: string | null;
  nomeDisciplina: string | null;
  /** Matriculas distintas com reserva confirmada. */
  alunos: number;
  /** Reservas confirmadas — uma gravacao cada, em CADA questionario da prova. */
  acessos: number;
  /** Reservas canceladas: acesso a remover, se o portal o tiver gravado. */
  cancelados: number;
}

export interface TurmasDoSpecialAccess {
  rodada: string;
  turmas: TurmaDoSpecialAccess[];
}

export interface ExecucaoSpecialAccessIniciada {
  id: number;
  simulacao: boolean;
  totalTurmas: number;
}

export interface AndamentoDoSpecialAccess {
  id: number;
  status: StatusExecucao;
  simulacao: boolean;
  interrompida: boolean;
  periodoLetivoIds: string;
  rodada: string;
  /** As turmas escolhidas, separadas por virgula. Nulo = a rodada inteira. */
  orgUnitIds: string | null;
  nomeQuizAlvo: string;
  matchQuizAlvo: TipoMatchQuiz;
  tempoExtraNiopMinutos: number;
  iniciadoPor: string;
  totalTurmas: number;
  turmasProcessadas: number;
  gravados: number;
  atualizados: number;
  removidos: number;
  jaCorretos: number;
  pendencias: number;
  resultados: Partial<Record<ResultadoSpecialAccess, number>>;
  erro: string | null;
  iniciadoEm: Date;
  concluidoEm: Date | null;
  atualizadoEm: Date;
}

interface TurmaDoLote {
  orgUnitId: string;
  codigoTurma: string | null;
  nomeDisciplina: string | null;
  reservas: ReservaNaTurma[];
}

interface EntradaDoLote {
  execucaoId: number;
  turmas: TurmaDoLote[];
  alvo: { nomeQuiz: string; matchQuiz: TipoMatchQuiz };
  tempoExtraNiopMinutos: number;
  simulacao: boolean;
  adminEmail: string;
}

type ItemNovo = Omit<Prisma.ItemSpecialAccessCreateManyInput, 'execucaoId'>;

interface Contadores {
  gravados: number;
  atualizados: number;
  removidos: number;
  jaCorretos: number;
  pendencias: number;
}

@Injectable()
export class SpecialAccessService {
  private readonly logger = new Logger(SpecialAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quizzes: D2lQuizzesService,
    private readonly periodo: PeriodoService,
    private readonly grade: GradeSenhasService,
    private readonly configuracao: ConfiguracaoSpecialAccessService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async iniciar(
    opcoes: OpcoesDoSpecialAccess,
    adminEmail: string,
  ): Promise<ExecucaoSpecialAccessIniciada> {
    if (!this.quizzes.habilitado()) {
      throw new BadRequestException(
        'O special access depende da integracao com o Brightspace ' +
          '(D2L_HABILITADO=true, com a autorizacao OAuth feita).',
      );
    }

    const emAndamento = await this.emAndamento();

    if (emAndamento) {
      throw new ConflictException(
        `A execucao ${emAndamento.id} ainda esta rodando ` +
          `(${emAndamento.turmasProcessadas} de ${emAndamento.totalTurmas} turmas). ` +
          'Espere terminar.',
      );
    }

    const vigente = await this.periodo.janelaVigente();

    if (!vigente) {
      throw new BadRequestException(
        'Nenhum periodo de agendamento cadastrado. Sem ele nao ha como saber ' +
          'de qual prova sao as reservas.',
      );
    }

    // O MESMO alvo dos lotes de senha e de preparo: um nome so para "qual e a
    // prova". Dois lugares para configurar isso seriam dois nomes divergindo.
    const alvo = await this.grade.lerAlvo();

    if (!alvo.nomeQuiz) {
      throw new BadRequestException(
        'Nenhum questionario-alvo configurado. Informe o nome da prova em ' +
          'Senhas e datas > Questionario antes de gravar o special access.',
      );
    }

    const { tempoExtraNiopMinutos } = await this.configuracao.ler();

    let turmas = await this.turmasDoLote(
      vigente.periodoLetivoIds,
      vigente.rodada,
    );

    if (opcoes.orgUnitIds.length > 0) {
      const escolhidas = new Set(opcoes.orgUnitIds);
      const encontradas = new Set(
        turmas
          .filter((t) => escolhidas.has(t.orgUnitId))
          .map((t) => t.orgUnitId),
      );
      const semReserva = opcoes.orgUnitIds.filter((id) => !encontradas.has(id));

      // ⚠️ Recusa a lista INTEIRA quando uma das turmas nao existe na rodada, em
      // vez de rodar nas outras: quem escolheu cinco e recebeu quatro so
      // descobriria a que faltou no dia, com os alunos dela sem acesso.
      if (semReserva.length > 0) {
        throw new BadRequestException(
          `Sem reserva na rodada ${vigente.rodada}: turma(s) ${semReserva.join(', ')}.`,
        );
      }

      turmas = turmas.filter((t) => escolhidas.has(t.orgUnitId));
    }

    if (turmas.length === 0) {
      throw new BadRequestException(
        `Nenhuma reserva na rodada ${vigente.rodada}: nao ha special access a gravar.`,
      );
    }

    const execucao = await this.prisma.execucaoSpecialAccess.create({
      data: {
        simulacao: opcoes.simulacao,
        periodoLetivoIds: [...vigente.periodoLetivoIds].sort().join(','),
        rodada: vigente.rodada,
        orgUnitIds:
          opcoes.orgUnitIds.length > 0 ? opcoes.orgUnitIds.join(',') : null,
        nomeQuizAlvo: alvo.nomeQuiz,
        matchQuizAlvo: alvo.matchQuiz,
        tempoExtraNiopMinutos,
        iniciadoPor: adminEmail,
        totalTurmas: turmas.length,
      },
      select: { id: true },
    });

    this.auditoria.registrar('SPECIAL_ACCESS_INICIADO', {
      ator: adminEmail,
      detalhe:
        `execucao ${execucao.id}, ${opcoes.simulacao ? 'SIMULACAO' : 'GRAVANDO'}, ` +
        `${turmas.length} turma(s), rodada ${vigente.rodada}, ` +
        `alvo "${alvo.nomeQuiz}" (${alvo.matchQuiz}), extra NIOP ${tempoExtraNiopMinutos} min` +
        (opcoes.orgUnitIds.length > 0
          ? `, so ${opcoes.orgUnitIds.length} turma(s): ${opcoes.orgUnitIds.join(', ')}`
          : ''),
    });

    // Fire-and-forget: o `catch` dentro de `executar` e o que transforma uma
    // falha em FALHOU na tabela, em vez de um unhandled rejection.
    void this.executar({
      execucaoId: execucao.id,
      turmas,
      alvo: { nomeQuiz: alvo.nomeQuiz, matchQuiz: alvo.matchQuiz },
      tempoExtraNiopMinutos,
      simulacao: opcoes.simulacao,
      adminEmail,
    });

    return {
      id: execucao.id,
      simulacao: opcoes.simulacao,
      totalTurmas: turmas.length,
    };
  }

  /**
   * As turmas que o lote pode tocar, com o tamanho de cada uma — a lista do
   * seletor da tela.
   *
   * **So banco: nenhuma chamada ao Brightspace.** E isso que permite escolher as
   * turmas ANTES de gastar requisicao, que e a razao de o seletor existir.
   */
  async turmasDisponiveis(): Promise<TurmasDoSpecialAccess> {
    const vigente = await this.periodo.janelaVigente();

    if (!vigente) {
      throw new BadRequestException(
        'Nenhum periodo de agendamento cadastrado. Sem ele nao ha como saber ' +
          'de qual prova sao as reservas.',
      );
    }

    const turmas = await this.turmasDoLote(
      vigente.periodoLetivoIds,
      vigente.rodada,
    );

    return {
      rodada: vigente.rodada,
      turmas: turmas.map((turma) => {
        const confirmadas = turma.reservas.filter((r) => r.confirmada);

        return {
          orgUnitId: turma.orgUnitId,
          codigoTurma: turma.codigoTurma,
          nomeDisciplina: turma.nomeDisciplina,
          alunos: new Set(confirmadas.map((r) => r.matricula)).size,
          acessos: confirmadas.length,
          cancelados: turma.reservas.length - confirmadas.length,
        };
      }),
    };
  }

  async consultar(id: number): Promise<AndamentoDoSpecialAccess> {
    const execucao = await this.prisma.execucaoSpecialAccess.findUnique({
      where: { id },
    });

    if (!execucao) throw new NotFoundException(`Execucao ${id} nao encontrada`);

    const porResultado = await this.prisma.itemSpecialAccess.groupBy({
      by: ['resultado'],
      where: { execucaoId: id },
      _count: { _all: true },
    });

    return {
      ...execucao,
      interrompida: this.pareceMorta(execucao),
      resultados: Object.fromEntries(
        porResultado.map((linha) => [linha.resultado, linha._count._all]),
      ),
    };
  }

  /**
   * A execucao mais recente, ou `null` — "nunca rodou" e estado normal, nao 404.
   * E o que deixa a tela retomar o acompanhamento depois de recarregar.
   */
  async ultima(): Promise<AndamentoDoSpecialAccess | null> {
    const recente = await this.prisma.execucaoSpecialAccess.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    return recente ? this.consultar(recente.id) : null;
  }

  /**
   * O relatorio, com as PENDENCIAS primeiro. Formato do Excel pt-BR (`;` + BOM).
   *
   * Os horarios saem no relogio de BRASILIA, e o cabecalho diz isso: e a leitura
   * que mostra a diferenca do Acre — a faixa das 09:00 de Cruzeiro do Sul
   * aparece abrindo as 11:00.
   */
  async relatorioCsv(
    id: number,
  ): Promise<{ nomeArquivo: string; conteudo: string }> {
    const execucao = await this.prisma.execucaoSpecialAccess.findUnique({
      where: { id },
      select: { id: true, simulacao: true },
    });

    if (!execucao) throw new NotFoundException(`Execucao ${id} nao encontrada`);

    const itens = await this.prisma.itemSpecialAccess.findMany({
      where: { execucaoId: id },
      orderBy: { id: 'asc' },
    });

    itens.sort(
      (a, b) =>
        Number(ehPendencia(b.resultado)) - Number(ehPendencia(a.resultado)) ||
        a.resultado.localeCompare(b.resultado) ||
        (a.codigoTurma ?? a.orgUnitId).localeCompare(
          b.codigoTurma ?? b.orgUnitId,
        ) ||
        (a.matricula ?? '').localeCompare(b.matricula ?? ''),
    );

    const conteudo = montarCsv(
      [
        'Turma',
        'Disciplina',
        'orgUnitId',
        'Questionario',
        'QuizId',
        'Matricula',
        'UserId D2L',
        'NIOP',
        'Abre em (horario de Brasilia)',
        'Fecha em (horario de Brasilia)',
        'Tempo de prova (min)',
        'Resultado',
        'Pendencia',
        'O que aconteceu',
      ],
      itens.map((item) => [
        item.codigoTurma,
        item.nomeDisciplina,
        item.orgUnitId,
        item.nomeQuiz,
        item.quizId,
        item.matricula,
        item.userIdD2L,
        item.niop ? 'Sim' : 'Nao',
        horarioLegivel(item.startDate),
        horarioLegivel(item.endDate),
        item.minutos,
        item.resultado,
        ehPendencia(item.resultado) ? 'Sim' : 'Nao',
        item.detalhe,
      ]),
    );

    const hoje = new Date()
      .toLocaleDateString('pt-BR', { timeZone: FUSO_DA_OPERACAO })
      .replace(/\//g, '-');

    return {
      nomeArquivo:
        `Special access${execucao.simulacao ? ' (simulacao)' : ''} ` +
        `${hoje} (execucao ${id}).csv`,
      conteudo,
    };
  }

  /** A execucao viva, se houver. Enterra a morta, como o compulsorio. */
  async emAndamento() {
    const candidata = await this.prisma.execucaoSpecialAccess.findFirst({
      where: { status: StatusExecucao.EM_ANDAMENTO },
      orderBy: { id: 'desc' },
    });

    if (!candidata) return null;

    if (this.pareceMorta(candidata)) {
      await this.prisma.execucaoSpecialAccess.update({
        where: { id: candidata.id },
        data: {
          status: StatusExecucao.FALHOU,
          erro:
            'O processo foi interrompido durante a execucao (reinicio do ' +
            'servidor?). O que ja foi gravado no Brightspace permanece; rodar de ' +
            'novo continua de onde parou, porque o lote so escreve o que falta.',
          concluidoEm: new Date(),
        },
      });

      return null;
    }

    return candidata;
  }

  // ------------------------------------------------------------------ interno

  private pareceMorta(execucao: {
    status: StatusExecucao;
    atualizadoEm: Date;
  }): boolean {
    return (
      execucao.status === StatusExecucao.EM_ANDAMENTO &&
      Date.now() - execucao.atualizadoEm.getTime() > SILENCIO_ATE_MORRER_MS
    );
  }

  /**
   * Tudo que vem do BANCO, lido uma vez antes de o lote comecar: um remanejo no
   * meio nao pode fazer metade das turmas usar um estado e metade outro.
   *
   * As CANCELADAS entram: sao elas que dizem de quem tirar o acesso.
   */
  private async turmasDoLote(
    periodoLetivoIds: string[],
    rodada: string,
  ): Promise<TurmaDoLote[]> {
    const [niop, linhas] = await Promise.all([
      this.prisma.alunoNiop.findMany({ select: { matricula: true } }),
      this.prisma.agendamentoDisciplina.findMany({
        where: {
          agendamento: {
            status: {
              in: [StatusAgendamento.CONFIRMADO, StatusAgendamento.CANCELADO],
            },
            periodoLetivoId: { in: periodoLetivoIds },
            rodada,
          },
        },
        select: {
          orgUnitId: true,
          nomeDisciplina: true,
          agendamento: {
            select: {
              matricula: true,
              userIdD2L: true,
              status: true,
              // A modalidade da RESERVA (fotografia), e nao a do vinculo hoje:
              // a prova acontece na duracao com que foi marcada.
              modalidade: { select: { tempoDeProvaMinutos: true } },
              salaFaixa: {
                select: {
                  faixa: {
                    select: {
                      data: true,
                      horaInicio: true,
                      horaFim: true,
                      // O fuso do polo ONDE a prova acontece: a faixa foi
                      // cadastrada no relogio dele.
                      polo: { select: { fuso: true } },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: [{ orgUnitId: 'asc' }, { agendamento: { matricula: 'asc' } }],
      }),
    ]);

    const doNiop = new Set(niop.map((n) => n.matricula));
    const porTurma = new Map<string, TurmaDoLote>();

    for (const linha of linhas) {
      const { agendamento } = linha;
      const { faixa } = agendamento.salaFaixa;

      const turma = porTurma.get(linha.orgUnitId) ?? {
        orgUnitId: linha.orgUnitId,
        codigoTurma: null,
        nomeDisciplina: linha.nomeDisciplina,
        reservas: [],
      };

      turma.reservas.push({
        matricula: agendamento.matricula,
        userIdD2L: agendamento.userIdD2L,
        confirmada: agendamento.status === StatusAgendamento.CONFIRMADO,
        data: faixa.data,
        horaInicio: faixa.horaInicio,
        horaFim: faixa.horaFim,
        fuso: faixa.polo.fuso,
        tempoDeProvaMinutos: agendamento.modalidade.tempoDeProvaMinutos,
        niop: doNiop.has(agendamento.matricula),
      });

      porTurma.set(linha.orgUnitId, turma);
    }

    const doCsv = await this.prisma.turmaImportada.findMany({
      where: { orgUnitId: { in: [...porTurma.keys()] } },
      select: { orgUnitId: true, codigoTurma: true, nomeDisciplina: true },
    });

    for (const linha of doCsv) {
      const turma = porTurma.get(linha.orgUnitId!);
      if (!turma) continue;
      turma.codigoTurma = linha.codigoTurma;
      turma.nomeDisciplina = linha.nomeDisciplina;
    }

    return [...porTurma.values()].sort((a, b) =>
      (a.codigoTurma ?? a.orgUnitId).localeCompare(
        b.codigoTurma ?? b.orgUnitId,
        'pt-BR',
      ),
    );
  }

  /** O trabalho de verdade. NUNCA lanca: toda falha vira estado na tabela. */
  private async executar(entrada: EntradaDoLote): Promise<void> {
    const { execucaoId, turmas, simulacao, adminEmail } = entrada;
    const ritmo = carregarRitmoDoSpecialAccess(this.config);
    const contadores: Contadores = {
      gravados: 0,
      atualizados: 0,
      removidos: 0,
      jaCorretos: 0,
      pendencias: 0,
    };

    try {
      for (const [indice, turma] of turmas.entries()) {
        const itens: ItemNovo[] = [];

        // Uma turma que falha nao derruba as outras: vira item, e o lote segue.
        try {
          await this.aplicarNaTurma(turma, entrada, ritmo, itens, contadores);
        } catch (erro) {
          itens.push(
            item(turma, ResultadoSpecialAccess.FALHA_NA_API, {
              detalhe: motivo(erro),
            }),
          );
        }

        contadores.pendencias += itens.filter((i) =>
          ehPendencia(i.resultado),
        ).length;

        if (itens.length > 0) {
          await this.prisma.itemSpecialAccess.createMany({
            data: itens.map((i) => ({ ...i, execucaoId })),
          });
        }

        // Batido a cada turma: e o sinal de vida e a barra de progresso.
        await this.prisma.execucaoSpecialAccess.update({
          where: { id: execucaoId },
          data: { ...contadores, turmasProcessadas: indice + 1 },
        });
      }

      await this.prisma.execucaoSpecialAccess.update({
        where: { id: execucaoId },
        data: { status: StatusExecucao.CONCLUIDA, concluidoEm: new Date() },
      });

      this.auditoria.registrar('SPECIAL_ACCESS_CONCLUIDO', {
        ator: adminEmail,
        detalhe:
          `execucao ${execucaoId}${simulacao ? ' (simulacao)' : ''}: ` +
          `${contadores.gravados} gravado(s), ${contadores.atualizados} atualizado(s), ` +
          `${contadores.removidos} removido(s), ${contadores.jaCorretos} ja certo(s), ` +
          `${contadores.pendencias} pendencia(s)`,
      });
    } catch (erro) {
      const texto = motivo(erro);

      await this.prisma.execucaoSpecialAccess
        .update({
          where: { id: execucaoId },
          data: {
            status: StatusExecucao.FALHOU,
            erro: texto,
            concluidoEm: new Date(),
          },
        })
        .catch(() => undefined);

      this.auditoria.registrar('SPECIAL_ACCESS_FALHOU', {
        ator: adminEmail,
        detalhe: `execucao ${execucaoId}: ${texto}`,
      });

      this.logger.error(`Execucao ${execucaoId} falhou: ${texto}`);
    }
  }

  /**
   * Uma turma: quem deve ter acesso, os questionarios da prova, e em cada um o
   * que ja existe contra o que deveria existir.
   */
  private async aplicarNaTurma(
    turma: TurmaDoLote,
    entrada: EntradaDoLote,
    ritmo: OpcoesDeRitmo,
    itens: ItemNovo[],
    contadores: Contadores,
  ): Promise<void> {
    const { alvo, simulacao, tempoExtraNiopMinutos } = entrada;
    const { desejados, cancelados, duplicados, invalidos } = alunosDaTurma(
      turma.reservas,
      tempoExtraNiopMinutos,
    );

    for (const duplicado of duplicados) {
      itens.push(
        item(turma, ResultadoSpecialAccess.RESERVA_DUPLICADA, {
          matricula: duplicado.matricula,
          userIdD2L: String(duplicado.userId),
          detalhe: duplicado.detalhe,
        }),
      );
    }

    for (const invalido of invalidos) {
      itens.push(
        item(turma, ResultadoSpecialAccess.USER_ID_INVALIDO, {
          matricula: invalido.matricula,
          userIdD2L: invalido.userIdD2L,
          detalhe:
            'O agendamento nao tem um UserId numerico do Brightspace, entao nao ' +
            'ha para quem gravar o acesso.',
        }),
      );
    }

    // So pendencias na turma: nenhuma chamada a fazer.
    if (desejados.length === 0 && cancelados.length === 0) return;

    const lista = await this.quizzes.listarQuizzes(turma.orgUnitId, ritmo);
    const casados = casarPorNome(
      lista,
      (q) => q.Name,
      alvo.nomeQuiz,
      alvo.matchQuiz,
    );

    if (casados.length === 0) {
      itens.push(
        item(turma, ResultadoSpecialAccess.QUIZ_NAO_ENCONTRADO, {
          detalhe:
            `Nenhum questionario casou com "${alvo.nomeQuiz}" (${alvo.matchQuiz}) ` +
            `entre os ${lista.length} da turma. Os ${desejados.length} aluno(s) ` +
            'agendado(s) ficam sem acesso.',
        }),
      );
      return;
    }

    for (const quiz of casados) {
      const quizId = String(quiz.QuizId ?? '');
      const doQuiz = { quizId, nomeQuiz: quiz.Name ?? null };

      // Nao interrompe: o acesso do aluno e gravado mesmo assim. Mas a prova esta
      // aberta a turma inteira, que e exatamente o que o preparo existe para
      // fechar — e isso precisa aparecer com o peso de pendencia.
      if (quiz.AllowOnlyUsersWithSpecialAccess !== true) {
        itens.push(
          item(turma, ResultadoSpecialAccess.QUESTIONARIO_NAO_RESTRITO, {
            ...doQuiz,
            detalhe:
              'O questionario NAO esta restrito a quem tem special access: ele ' +
              'segue visivel para a turma inteira. Rode "Preparar questionarios".',
          }),
        );
      }

      let lidos: AcessoEspecialDaLista[];

      try {
        lidos = await this.quizzes.listarAcessosEspeciais(
          turma.orgUnitId,
          quizId,
          ritmo,
        );
      } catch (erro) {
        itens.push(
          item(turma, ResultadoSpecialAccess.FALHA_NA_API, {
            ...doQuiz,
            detalhe: `Ao ler os special access do questionario: ${motivo(erro)}`,
          }),
        );
        continue;
      }

      const plano = planejarAcessos({ desejados, cancelados, lidos });
      contadores.jaCorretos += plano.jaCorretos;

      for (const userId of plano.deOutros) {
        itens.push(
          item(turma, ResultadoSpecialAccess.ACESSO_DE_OUTRO_USUARIO, {
            ...doQuiz,
            userIdD2L: String(userId),
            detalhe:
              'Special access de quem nao tem reserva nesta turma na rodada. Nao ' +
              'foi tocado — pode ter sido dado a mao no AVA.',
          }),
        );
      }

      const escritas: [AlunoComAcesso, boolean][] = [
        ...plano.gravar.map((a): [AlunoComAcesso, boolean] => [a, true]),
        ...plano.atualizar.map((a): [AlunoComAcesso, boolean] => [a, false]),
      ];

      for (const [aluno, novo] of escritas) {
        const dados = {
          ...doQuiz,
          matricula: aluno.matricula,
          userIdD2L: String(aluno.userId),
          startDate: aluno.acesso.inicio,
          endDate: aluno.acesso.fim,
          minutos: aluno.acesso.minutos,
          niop: aluno.niop,
        };

        try {
          if (!simulacao) {
            await this.quizzes.gravarAcessoEspecial(
              turma.orgUnitId,
              quizId,
              aluno.userId,
              corpoDoAcesso(aluno.acesso),
              ritmo,
            );
          }

          itens.push(
            item(
              turma,
              novo
                ? ResultadoSpecialAccess.ACESSO_GRAVADO
                : ResultadoSpecialAccess.ACESSO_ATUALIZADO,
              dados,
            ),
          );

          if (novo) contadores.gravados += 1;
          else contadores.atualizados += 1;
        } catch (erro) {
          itens.push(
            item(
              turma,
              erro instanceof NaoEncontradoNoBrightspace
                ? ResultadoSpecialAccess.ALUNO_NAO_ENCONTRADO
                : ResultadoSpecialAccess.FALHA_NA_API,
              { ...dados, detalhe: motivoDaEscrita(erro) },
            ),
          );
        }
      }

      for (const aluno of plano.remover) {
        try {
          if (!simulacao) {
            await this.quizzes.removerAcessoEspecial(
              turma.orgUnitId,
              quizId,
              aluno.userId,
              ritmo,
            );
          }

          itens.push(
            item(turma, ResultadoSpecialAccess.ACESSO_REMOVIDO, {
              ...doQuiz,
              matricula: aluno.matricula,
              userIdD2L: String(aluno.userId),
              detalhe: 'A prova deste aluno nesta turma foi cancelada.',
            }),
          );
          contadores.removidos += 1;
        } catch (erro) {
          itens.push(
            item(turma, ResultadoSpecialAccess.FALHA_NA_API, {
              ...doQuiz,
              matricula: aluno.matricula,
              userIdD2L: String(aluno.userId),
              detalhe: `Ao remover o acesso: ${motivoDaEscrita(erro)}`,
            }),
          );
        }
      }
    }
  }
}

function item(
  turma: TurmaDoLote,
  resultado: ResultadoSpecialAccess,
  extra: Partial<Omit<ItemNovo, 'orgUnitId' | 'resultado'>> = {},
): ItemNovo {
  return {
    orgUnitId: turma.orgUnitId,
    codigoTurma: turma.codigoTurma,
    nomeDisciplina: turma.nomeDisciplina,
    resultado,
    ...extra,
  };
}

/** Um instante UTC como a secretaria le: dia e hora de Brasilia. */
function horarioLegivel(instante: Date | null): string | null {
  if (!instante) return null;

  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_DA_OPERACAO,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(instante);
}

function motivoDaEscrita(erro: unknown): string {
  if (erro instanceof NaoEncontradoNoBrightspace) {
    return (
      'O Brightspace nao encontrou o usuario neste questionario (404). O mais ' +
      'comum: o aluno nao esta matriculado nesta turma do Brightspace.'
    );
  }

  return motivo(erro);
}

/** Truncado: `detalhe` e para ler. O 403 ganha a dica do escopo. */
function motivo(erro: unknown): string {
  const texto = (erro instanceof Error ? erro.message : String(erro)).slice(
    0,
    400,
  );

  if (erro instanceof RecusaDoBrightspace && erro.statusHttp === 403) {
    return (
      `${texto} — Confira se quizzing:quizzes:read,write,delete esta no ` +
      'D2L_SCOPES e se a autorizacao foi refeita (npm run d2l:autorizar).'
    );
  }

  return texto;
}
