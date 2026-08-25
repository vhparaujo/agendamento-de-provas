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
import { ModalidadeDaTurmaService } from './modalidade-da-turma.service';
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
    /** orgUnitId -> a decisao do `ModalidadeDaTurmaService`. */
    modalidadePorTurma?: Record<string, unknown>;
    janela?: Record<string, unknown> | null;
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
      janelaDeProva: {
        findUnique: jest.fn().mockResolvedValue(
          opcoes.janela === undefined
            ? {
                id: 10,
                modalidadeId: 1,
                horaInicio: '15:00',
                horaFim: '18:00',
                turno: Turno.TARDE,
                ativo: true,
                versao: 3,
              }
            : opcoes.janela,
        ),
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

    // Por padrao o lote de SENHAS nem consulta isto — ele nao recorta por
    // modalidade. Fica mockado para o construtor, e os testes de DATA o
    // sobrescrevem.
    const modalidades = {
      resolver: jest.fn().mockResolvedValue({
        totalComAgendamento: 0,
        de: (orgUnitId: string) =>
          opcoes.modalidadePorTurma?.[orgUnitId] ?? {
            situacao: 'SEM_MODALIDADE',
            motivo: 'SEM_AGENDAMENTO',
            candidatas: [],
            detalhe: 'sem agendamento confirmado nesta turma',
          },
      }),
    } as unknown as ModalidadeDaTurmaService;

    const servico = new SenhaQuizService(
      prisma,
      new ConfigService({
        SENHA_QUIZ_DELAY_MS: '0',
        SENHA_QUIZ_CONCORRENCIA: '4',
      }),
      quizzes,
      resolucao,
      modalidades,
      grade,
      periodo,
      auditoria,
    );

    return { servico, prisma };
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
        {} as unknown as ModalidadeDaTurmaService,
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

  /**
   * ==========================================================================
   * O LOTE DE DATAS
   * ==========================================================================
   * Mesma maquinaria, outro recorte: uma JANELA aplicada nas turmas de UMA
   * modalidade — derivada dos agendamentos, porque `TurmaImportada` nao guarda
   * modalidade e nao deve guardar.
   */
  describe('lote de DATAS', () => {
    const EAD = {
      situacao: 'ENCONTRADA',
      modalidadeId: 1,
      codigo: 'EAD',
      nome: 'EaD',
      reservas: 40,
    };
    const SEMI = {
      situacao: 'ENCONTRADA',
      modalidadeId: 2,
      codigo: 'SEMI',
      nome: 'Semi',
      reservas: 12,
    };
    const AMBIGUA = {
      situacao: 'SEM_MODALIDADE',
      motivo: 'AMBIGUA',
      candidatas: [],
      detalhe: 'duas modalidades nesta turma',
    };

    const OPCOES = {
      tipo: 'DATA' as const,
      janelaId: 10,
      data: '2026-09-16',
      simulacao: false,
      forcar: false,
    };

    const tresTurmas = {
      resolucao: {
        totalNoCsv: 3,
        resolvidas: [
          turmaResolvida(1, '156126'),
          turmaResolvida(2, '156127'),
          turmaResolvida(3, '156128'),
        ],
        naoResolvidas: [],
        aprendidos: 0,
      },
      quizzesPorTurma: {
        '156126': [{ QuizId: 42, Name: 'Prova N1' }],
        '156127': [{ QuizId: 43, Name: 'Prova N1' }],
        '156128': [{ QuizId: 44, Name: 'Prova N1' }],
      },
    };

    it('grava StartDate e EndDate em UTC-Z, preservando o resto', async () => {
      const { servico } = montar({
        ...tresTurmas,
        modalidadePorTurma: { '156126': EAD, '156127': SEMI, '156128': SEMI },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(gravacoes).toHaveLength(1);
      const corpo = gravacoes[0].corpo as Record<string, unknown>;

      // 15:00-18:00 em Sao Paulo = 18:00-21:00 UTC.
      expect(corpo.StartDate).toBe('2026-09-16T18:00:00.000Z');
      expect(corpo.EndDate).toBe('2026-09-16T21:00:00.000Z');
      expect(corpo.Name).toBe('Prova N1');
    });

    /**
     * A trava contra o apagamento silencioso: o GET pode devolver `Password`
     * nulo num quiz que TEM senha, entao o lote de datas grava a senha da GRADE
     * em vez de preservar a leitura.
     */
    it('grava tambem a SENHA DA GRADE, nunca a lida', async () => {
      const { servico } = montar({
        ...tresTurmas,
        modalidadePorTurma: { '156126': EAD },
        quizLido: { QuizId: 42, Name: 'Prova N1', Password: null },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      const corpo = gravacoes[0].corpo as Record<string, unknown>;
      expect(corpo.Password).toBe('manha1609');
    });

    /**
     * Turma de OUTRA modalidade nao e erro: ela tem a janela dela, no horario
     * dela. Relatar isso encheria o CSV de linhas que ninguem deve tratar.
     */
    it('so toca as turmas DA MODALIDADE da janela, em silencio quanto as outras', async () => {
      const { servico } = montar({
        ...tresTurmas,
        modalidadePorTurma: { '156126': EAD, '156127': SEMI, '156128': SEMI },
      });

      const resultado = await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(listagens).toEqual(['156126']);
      expect(resultado.totalTurmas).toBe(1);
      // Nenhuma linha de relatorio para as duas turmas SEMI.
      expect(itensGravados).toHaveLength(1);
    });

    /**
     * Estas SIM viram linha de relatorio: sao turmas que ficam com a data velha,
     * ou seja, alunos que nao abrem a prova.
     */
    it('turma sem modalidade derivavel vira linha de relatorio', async () => {
      const { servico } = montar({
        ...tresTurmas,
        modalidadePorTurma: { '156126': EAD, '156127': AMBIGUA },
      });

      const resultado = await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(resultado.modalidadeAmbigua).toBe(1);
      // 156128 nao esta no mapa -> SEM_AGENDAMENTO.
      expect(resultado.semModalidade).toBe(1);

      const porResultado = itensGravados.map((i) => i.resultado).sort();
      expect(porResultado).toEqual([
        ResultadoSenhaQuiz.DEFINIDA,
        ResultadoSenhaQuiz.MODALIDADE_AMBIGUA,
        ResultadoSenhaQuiz.SEM_AGENDAMENTO,
      ]);
    });

    it('a fotografia da janela e da modalidade vai para o item', async () => {
      const { servico } = montar({
        ...tresTurmas,
        modalidadePorTurma: { '156126': EAD },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      const aplicado = itensGravados.find(
        (i) => i.resultado === ResultadoSenhaQuiz.DEFINIDA,
      );
      expect(aplicado?.modalidadeCodigo).toBe('EAD');
      expect((aplicado?.startDateAplicado as Date).toISOString()).toBe(
        '2026-09-16T18:00:00.000Z',
      );
    });

    it('dry-run de datas NAO emite nenhum PUT', async () => {
      const { servico } = montar({
        ...tresTurmas,
        modalidadePorTurma: { '156126': EAD },
      });

      await servico.iniciar({ ...OPCOES, simulacao: true }, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(listagens).toEqual(['156126']);
      expect(gravacoes).toHaveLength(0);
    });

    /**
     * O lote de datas depende da celula da grade tanto quanto o de senhas — e
     * por um motivo mais duro: sem ela o PUT apagaria a senha.
     */
    it('recusa quando nao ha senha na grade daquele turno', async () => {
      const { servico } = montar({ ...tresTurmas, celula: null });

      await expect(servico.iniciar(OPCOES, 'admin@ucb.br')).rejects.toThrow(
        /senha cadastrada/i,
      );
      expect(gravacoes).toHaveLength(0);
    });

    /**
     * O BUG DE 25/08/2026, travado.
     *
     * `salvarJanelas` faz upsert e PRESERVA o id da linha. Sem a versao na chave
     * de idempotencia, a execucao concluida das 12:01 bloqueava o disparo das
     * 12:45 depois de o admin corrigir o horario — e a correcao so passava a
     * valer no dia seguinte, sem nada no log.
     */
    it('a checagem de "ja aplicada" leva a VERSAO da janela', async () => {
      const { servico, prisma } = montar({
        ...tresTurmas,
        modalidadePorTurma: { '156126': EAD },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      const consultas = (
        prisma.execucaoSenhaQuiz.findFirst as unknown as jest.Mock
      ).mock.calls.map(
        (c) => (c[0] as { where: Record<string, unknown> }).where,
      );

      const idempotencia = consultas.find(
        (w) => w.janelaDeProvaId !== undefined,
      );

      expect(idempotencia).toMatchObject({
        janelaDeProvaId: 10,
        versaoAplicada: 3,
        simulacao: false,
      });
    });

    it('recusa um janelaId inexistente com 404', async () => {
      const { servico } = montar({ ...tresTurmas, janela: null });

      await expect(servico.iniciar(OPCOES, 'admin@ucb.br')).rejects.toThrow(
        /Janela 10 nao encontrada/,
      );
    });

    /**
     * `turno` nulo e o que separa uma execucao de datas de uma de senhas nas
     * consultas da grade: gravar um turno "plausivel" faria a celula parecer
     * aplicada antes de o turno dela ter rodado.
     *
     * `versaoAplicada` guarda a versao da JANELA (e nao da celula) — e o que faz
     * a idempotencia liberar um novo disparo hoje quando o admin corrige o
     * horario. Ver o bug de 25/08/2026 na coluna `janela_de_prova.versao`.
     */
    it('a execucao nasce com tipo DATA, sem turno e com a versao da JANELA', async () => {
      const { servico, prisma } = montar({
        ...tresTurmas,
        modalidadePorTurma: { '156126': EAD },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      const criacao = (prisma.execucaoSenhaQuiz.create as unknown as jest.Mock)
        .mock.calls[0][0] as { data: Record<string, unknown> };

      expect(criacao.data.tipo).toBe('DATA');
      expect(criacao.data.turno).toBeNull();
      // A versao da JANELA (3 no mock), nao a da celula da grade (1).
      expect(criacao.data.versaoAplicada).toBe(3);
      expect(criacao.data.janelaDeProvaId).toBe(10);
      expect(criacao.data.horaInicioAplicada).toBe('15:00');
    });
  });
});
