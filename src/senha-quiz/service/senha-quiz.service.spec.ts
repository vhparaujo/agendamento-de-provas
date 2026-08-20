import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { D2lQuizzesService } from '../../d2l/service/d2l-quizzes.service';
import { PrismaService } from '../../database/prisma.service';
import {
  OrigemExecucao,
  ResultadoSenhaQuiz,
  StatusExecucao,
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { GradeSenhasService } from './grade-senhas.service';
import { ResolucaoOrgUnitService } from './resolucao-orgunit.service';
import { SenhaQuizService } from './senha-quiz.service';

/** Deixa o `void this.executar(...)` terminar antes das asserções. */
const deixarOLoteTerminar = () => new Promise((r) => setTimeout(r, 0));

describe('SenhaQuizService', () => {
  let itensGravados: Record<string, unknown>[];
  let execucao: Record<string, unknown>;
  let gravacoes: { orgUnitId: string; quizId: string; corpo: unknown }[];
  /** Turmas cuja listagem de questionarios chegou a ser pedida ao Brightspace. */
  let listagens: string[];

  const turmaResolvida = (id: number, orgUnitId: string) => ({
    turmaId: id,
    orgUnitId,
    codigoTurma: `T${id}`,
    nomeDisciplina: `DISCIPLINA ${id}`,
  });

  const montar = (opcoes: {
    resolucao?: Partial<{
      totalNoCsv: number;
      resolvidas: ReturnType<typeof turmaResolvida>[];
      naoResolvidas: unknown[];
      aprendidos: number;
    }>;
    quizzesPorTurma?: Record<string, { QuizId: number; Name: string }[]>;
    quizLido?: Record<string, unknown>;
    listarLanca?: boolean;
    gravarLanca?: boolean;
    celula?: Record<string, unknown> | null;
    emAndamento?: Record<string, unknown> | null;
    jaAplicada?: Record<string, unknown> | null;
    habilitado?: boolean;
    /** `null` = ninguem escolheu o questionario ainda. */
    alvo?: string | null;
  }) => {
    itensGravados = [];
    gravacoes = [];
    listagens = [];
    execucao = { id: 7, status: StatusExecucao.EM_ANDAMENTO };

    const prisma = {
      senhaDeProva: {
        findUnique: jest.fn().mockResolvedValue(
          opcoes.celula === undefined
            ? {
                id: 1,
                data: new Date('2026-09-16T00:00:00.000Z'),
                turno: Turno.MANHA,
                senha: 'manha1609',
                versao: 1,
              }
            : opcoes.celula,
        ),
      },
      execucaoSenhaQuiz: {
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
            Promise.resolve(
              where.status === StatusExecucao.EM_ANDAMENTO
                ? (opcoes.emAndamento ?? null)
                : (opcoes.jaAplicada ?? null),
            ),
          ),
        create: jest.fn().mockResolvedValue({ id: 7 }),
        update: jest.fn().mockImplementation(({ data }) => {
          execucao = { ...execucao, ...data };
          return Promise.resolve(execucao);
        }),
      },
      itemSenhaQuiz: {
        createMany: jest.fn().mockImplementation(({ data }) => {
          itensGravados.push(...data);
          return Promise.resolve({ count: data.length });
        }),
      },
    } as unknown as PrismaService;

    const quizzes = {
      habilitado: jest.fn().mockReturnValue(opcoes.habilitado ?? true),
      listarQuizzes: jest.fn().mockImplementation((orgUnitId: string) => {
        listagens.push(orgUnitId);
        if (opcoes.listarLanca)
          return Promise.reject(new Error('tenant fora do ar'));
        return Promise.resolve(opcoes.quizzesPorTurma?.[orgUnitId] ?? []);
      }),
      lerQuiz: jest.fn().mockResolvedValue(
        opcoes.quizLido ?? {
          QuizId: 42,
          Name: 'Prova N1',
          Password: 'antiga',
        },
      ),
      gravarQuiz: jest
        .fn()
        .mockImplementation(
          (orgUnitId: string, quizId: string, corpo: unknown) => {
            if (opcoes.gravarLanca)
              return Promise.reject(new Error('403 sem escopo'));
            gravacoes.push({ orgUnitId, quizId, corpo });
            return Promise.resolve();
          },
        ),
    } as unknown as D2lQuizzesService;

    const resolucao = {
      resolver: jest.fn().mockResolvedValue({
        totalNoCsv: 1,
        resolvidas: [turmaResolvida(1, '156126')],
        naoResolvidas: [],
        aprendidos: 0,
        ...opcoes.resolucao,
      }),
    } as unknown as ResolucaoOrgUnitService;

    const grade = {
      lerAlvo: jest.fn().mockResolvedValue({
        nomeQuiz: opcoes.alvo === undefined ? 'Prova' : opcoes.alvo,
        matchQuiz: TipoMatchQuiz.CONTEM,
      }),
    } as unknown as GradeSenhasService;

    const periodo = {
      periodoLetivoVigente: jest
        .fn()
        .mockResolvedValue({ periodoLetivoId: '103', rodada: 'N2' }),
    } as unknown as PeriodoService;

    const auditoria = { registrar: jest.fn() } as unknown as AuditoriaService;

    const servico = new SenhaQuizService(
      prisma,
      new ConfigService({
        SENHA_QUIZ_DELAY_MS: '0',
        SENHA_QUIZ_CONCORRENCIA: '4',
      }),
      quizzes,
      resolucao,
      grade,
      periodo,
      auditoria,
    );

    return { servico };
  };

  const QUIZZES = { '156126': [{ QuizId: 42, Name: 'Prova N1' }] };

  /**
   * ==========================================================================
   * O TESTE MAIS IMPORTANTE DO ARQUIVO
   * ==========================================================================
   * O dry-run e a unica conferencia antes de mexer na prova de toda a
   * instituicao. Se ele emitir um PUT, ele deixa de ser dry-run — e a garantia
   * que a tela oferece ao admin passa a ser falsa.
   */
  it('dry-run NAO emite nenhum PUT', async () => {
    const { servico } = montar({ quizzesPorTurma: QUIZZES });

    await servico.iniciar(
      {
        data: '2026-09-16',
        turno: Turno.MANHA,
        simulacao: true,
        forcar: false,
      },
      'admin@ucb.br',
    );
    await deixarOLoteTerminar();

    // O questionario FOI lido (o dry-run precisa disso para dizer o que casou)...
    expect(listagens).toEqual(['156126']);
    // ...e nada foi gravado. E esse o contrato inteiro do dry-run.
    expect(gravacoes).toHaveLength(0);
    expect(itensGravados.map((i) => i.resultado)).toEqual([
      ResultadoSenhaQuiz.SIMULADA,
    ]);
  });

  it('aplicando de verdade, grava o corpo COMPLETO com a senha da celula', async () => {
    const { servico } = montar({ quizzesPorTurma: QUIZZES });

    await servico.iniciar(
      {
        data: '2026-09-16',
        turno: Turno.MANHA,
        simulacao: false,
        forcar: false,
      },
      'admin@ucb.br',
    );
    await deixarOLoteTerminar();

    expect(gravacoes).toHaveLength(1);
    expect(gravacoes[0].orgUnitId).toBe('156126');
    expect((gravacoes[0].corpo as { Password: string }).Password).toBe(
      'manha1609',
    );
    expect(itensGravados[0].resultado).toBe(ResultadoSenhaQuiz.DEFINIDA);
  });

  /**
   * A saida mais importante do relatorio: uma turma inteira que nao abriria a
   * prova, e que nao aparece como falha nenhuma.
   */
  it('turma sem quiz casado vira QUIZ_NAO_ENCONTRADO sem interromper as outras', async () => {
    const { servico } = montar({
      resolucao: {
        totalNoCsv: 2,
        resolvidas: [turmaResolvida(1, '156126'), turmaResolvida(2, '156127')],
      },
      quizzesPorTurma: {
        '156126': [{ QuizId: 42, Name: 'Prova N1' }],
        '156127': [{ QuizId: 99, Name: 'Simulado de revisao' }],
      },
    });

    await servico.iniciar(
      {
        data: '2026-09-16',
        turno: Turno.MANHA,
        simulacao: false,
        forcar: false,
      },
      'admin@ucb.br',
    );
    await deixarOLoteTerminar();

    const porResultado = itensGravados.map((i) => i.resultado).sort();
    expect(porResultado).toEqual([
      ResultadoSenhaQuiz.DEFINIDA,
      ResultadoSenhaQuiz.QUIZ_NAO_ENCONTRADO,
    ]);
    expect(execucao.naoEncontradas).toBe(1);
    expect(execucao.definidas).toBe(1);
    expect(execucao.status).toBe(StatusExecucao.CONCLUIDA);
  });

  it('falha de UMA turma nao derruba a fatia', async () => {
    const { servico } = montar({ quizzesPorTurma: QUIZZES, listarLanca: true });

    await servico.iniciar(
      {
        data: '2026-09-16',
        turno: Turno.MANHA,
        simulacao: false,
        forcar: false,
      },
      'admin@ucb.br',
    );
    await deixarOLoteTerminar();

    expect(itensGravados[0].resultado).toBe(ResultadoSenhaQuiz.FALHA_AO_LISTAR);
    expect(execucao.status).toBe(StatusExecucao.CONCLUIDA);
    expect(execucao.falhas).toBe(1);
  });

  it('403 na gravacao vira FALHA_AO_GRAVAR, nao excecao do lote', async () => {
    const { servico } = montar({ quizzesPorTurma: QUIZZES, gravarLanca: true });

    await servico.iniciar(
      {
        data: '2026-09-16',
        turno: Turno.MANHA,
        simulacao: false,
        forcar: false,
      },
      'admin@ucb.br',
    );
    await deixarOLoteTerminar();

    expect(itensGravados[0].resultado).toBe(ResultadoSenhaQuiz.FALHA_AO_GRAVAR);
    expect(itensGravados[0].detalhe).toContain('403');
  });

  it('turma nao resolvida entra no relatorio sem virar chamada de rede', async () => {
    const { servico } = montar({
      resolucao: {
        totalNoCsv: 1,
        resolvidas: [],
        naoResolvidas: [
          {
            turmaId: 9,
            codigoTurma: 'ANTIGA',
            nomeDisciplina: 'DE 2025',
            ambigua: false,
            motivo: 'Nenhuma oferta casou.',
          },
        ],
      },
    });

    await servico.iniciar(
      {
        data: '2026-09-16',
        turno: Turno.MANHA,
        simulacao: false,
        forcar: false,
      },
      'admin@ucb.br',
    );
    await deixarOLoteTerminar();

    expect(listagens).toHaveLength(0);
    expect(itensGravados[0].resultado).toBe(
      ResultadoSenhaQuiz.ORGUNIT_NAO_RESOLVIDO,
    );
  });

  it('registra que a senha anterior foi lida (diagnostico da senha invisivel)', async () => {
    const { servico } = montar({
      quizzesPorTurma: QUIZZES,
      quizLido: { QuizId: 42, Name: 'Prova N1', Password: null },
    });

    await servico.iniciar(
      {
        data: '2026-09-16',
        turno: Turno.MANHA,
        simulacao: true,
        forcar: false,
      },
      'admin@ucb.br',
    );
    await deixarOLoteTerminar();

    expect(itensGravados[0].senhaAnteriorLida).toBe(false);
    expect(execucao.comSenhaLida).toBe(0);
  });

  describe('recusas', () => {
    const iniciar = (servico: SenhaQuizService) =>
      servico.iniciar(
        {
          data: '2026-09-16',
          turno: Turno.MANHA,
          simulacao: false,
          forcar: false,
        },
        'admin@ucb.br',
      );

    it('recusa com a integracao D2L desligada', async () => {
      const { servico } = montar({ habilitado: false });
      await expect(iniciar(servico)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    /**
     * Nao ha mais semente no .env para o alvo. Um default plausivel seria PIOR
     * que a ausencia: o lote rodaria, casaria com o questionario que estivesse
     * por perto e ninguem saberia ate o dia da prova.
     */
    it('recusa quando ninguem escolheu o questionario-alvo', async () => {
      const { servico } = montar({ alvo: null });
      await expect(iniciar(servico)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('recusa quando a celula da grade nao tem senha cadastrada', async () => {
      const { servico } = montar({ celula: null });
      await expect(iniciar(servico)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('recusa quando outra execucao esta viva', async () => {
      const { servico } = montar({
        emAndamento: {
          id: 3,
          status: StatusExecucao.EM_ANDAMENTO,
          atualizadoEm: new Date(),
          processadas: 2,
          turmasResolvidas: 10,
        },
      });
      await expect(iniciar(servico)).rejects.toBeInstanceOf(ConflictException);
    });

    it('recusa reaplicar a mesma versao sem forcar', async () => {
      const { servico } = montar({
        jaAplicada: { id: 5, concluidoEm: new Date() },
      });
      await expect(iniciar(servico)).rejects.toBeInstanceOf(ConflictException);
    });

    it('com forcar, reaplica', async () => {
      const { servico } = montar({
        quizzesPorTurma: QUIZZES,
        jaAplicada: { id: 5, concluidoEm: new Date() },
      });

      await expect(
        servico.iniciar(
          {
            data: '2026-09-16',
            turno: Turno.MANHA,
            simulacao: false,
            forcar: true,
          },
          'admin@ucb.br',
          OrigemExecucao.MANUAL,
        ),
      ).resolves.toMatchObject({ id: 7, simulacao: false });
    });
  });

  /**
   * A rota que a tela usa para enxergar o CRON. O disparo automatico nao tem
   * quem o acompanhe — sem ela, a tela ficava muda enquanto a senha da
   * instituicao inteira era trocada, e muda depois de a troca acabar.
   */
  describe('ultima', () => {
    const montarConsulta = (recente: Record<string, unknown> | null) => {
      const findFirst = jest
        .fn()
        .mockResolvedValue(recente ? { id: recente.id } : null);

      const prisma = {
        execucaoSenhaQuiz: {
          findFirst,
          findUnique: jest.fn().mockResolvedValue(recente),
        },
        itemSenhaQuiz: { groupBy: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;

      const servico = new SenhaQuizService(
        prisma,
        new ConfigService({}),
        {} as unknown as D2lQuizzesService,
        {} as unknown as ResolucaoOrgUnitService,
        {} as unknown as GradeSenhasService,
        {} as unknown as PeriodoService,
        {} as unknown as AuditoriaService,
      );

      return { servico, findFirst };
    };

    /**
     * "Nunca rodou" e o estado normal de um ambiente recem-configurado. Se isso
     * virasse excecao, a tela nao teria como distingui-lo de "nao consegui
     * perguntar" — e mostraria erro num servidor que esta perfeitamente bem.
     */
    it('devolve null quando nunca houve execucao, sem lancar', async () => {
      const { servico } = montarConsulta(null);

      await expect(servico.ultima()).resolves.toBeNull();
    });

    /**
     * Sem o filtro, um lote MANUAL rodado as 09h esconderia o resultado da troca
     * automatica das 07:30 — justamente a pergunta que a tela precisa responder.
     */
    it('com origem CRON, pergunta so pelo disparo automatico', async () => {
      const { servico, findFirst } = montarConsulta({
        id: 9,
        origem: OrigemExecucao.CRON,
        status: StatusExecucao.CONCLUIDA,
        data: new Date('2026-09-16T00:00:00.000Z'),
        turno: Turno.MANHA,
        comSenhaLida: 3,
        atualizadoEm: new Date(),
        concluidoEm: new Date(),
      });

      await expect(servico.ultima(OrigemExecucao.CRON)).resolves.toMatchObject({
        id: 9,
        origem: OrigemExecucao.CRON,
        data: '2026-09-16',
      });

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { origem: OrigemExecucao.CRON } }),
      );
    });
  });
});
