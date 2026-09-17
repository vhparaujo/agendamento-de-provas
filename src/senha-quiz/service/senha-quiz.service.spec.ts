import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { D2lCondicoesService } from '../../d2l/service/d2l-condicoes.service';
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
import { GradeGruposService } from './grade-grupos.service';
import { GradeSenhasService } from './grade-senhas.service';
import { ModalidadeDaTurmaService } from './modalidade-da-turma.service';
import { ResolucaoGrupoService } from './resolucao-grupo.service';
import { ResolucaoOrgUnitService } from './resolucao-orgunit.service';
import { SenhaQuizService } from './senha-quiz.service';

/** Deixa o `void this.executar(...)` terminar antes das asserções. */
const deixarOLoteTerminar = () => new Promise((r) => setTimeout(r, 0));

/**
 * O `ConditionsData` como a instancia real devolve: um operando de grupo
 * apontando para "Prova 1", com o `State` opaco que precisa voltar intacto.
 */
const CONDICOES_PROVA_1 = {
  Expression: {
    Type: 'Expression',
    State: null,
    ExpressionParams: {
      Operator: 'All',
      Operands: [
        {
          Type: 'EnrolledInGroup',
          State: '224735',
          EnrolledInGroupParams: { GroupId: 156988, GroupCategoryId: null },
          Text: { Text: 'Membro do grupo: Prova 1', Html: '<b>Prova 1</b>' },
        },
      ],
    },
    Text: { Text: 'Todas as condicoes', Html: 'Todas as condicoes' },
  },
};

/** Uma janela que TROCA grupo — o oposto do padrao do `montar`. */
const JANELA_COM_GRUPO = {
  id: 10,
  modalidadeId: 1,
  horaInicio: '15:00',
  horaFim: '18:00',
  turno: Turno.TARDE,
  nomeGrupo: 'Prova 2',
  categoriaGrupo: null,
  ativo: true,
  versao: 3,
};

describe('SenhaQuizService', () => {
  let itensGravados: Record<string, unknown>[];
  let execucao: Record<string, unknown>;
  let gravacoes: { orgUnitId: string; quizId: string; corpo: unknown }[];
  /** Todo PUT em `conditionalRelease` que saiu do lote. */
  let condicoesGravadas: {
    orgUnitId: string;
    quizId: string;
    corpo: unknown;
  }[];
  /**
   * A ORDEM em que as escritas sairam, na linha do tempo real do lote.
   *
   * Existe porque a ordem entre a troca de grupo e o PUT do quiz e uma decisao
   * de seguranca, nao uma coincidencia de implementacao — ver o teste que a
   * verifica.
   */
  let ordemDasEscritas: string[];
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
    /** O `ConditionsData` que o GET de condicoes devolve. */
    condicoes?: Record<string, unknown> | null;
    /** orgUnitId -> os grupos que a turma tem, achatados numa categoria so. */
    gruposPorTurma?: Record<string, { GroupId: number; Name: string }[]>;
    /** A turma nao tem categoria de grupo nenhuma. */
    semCategoria?: boolean;
    lerCondicoesLanca?: boolean;
    gravarCondicoesLanca?: boolean;
    /** A celula da GRADE DE GRUPOS do dia. Ausente = o dia nao tem celula. */
    celulaDeGrupo?: Record<string, unknown> | null;
    /** A janela ja teve alguma celula na grade (em qualquer dia). */
    janelaUsaGrade?: boolean;
  }) => {
    itensGravados = [];
    gravacoes = [];
    condicoesGravadas = [];
    ordemDasEscritas = [];
    listagens = [];
    execucao = { id: 7, status: StatusExecucao.EM_ANDAMENTO };

    const prisma = {
      configuracaoSpecialAccess: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
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
                // Por padrao a janela NAO troca grupo — e o estado de quem
                // ainda nao cadastrou nada na tela, e mantem os testes antigos
                // medindo exatamente o que mediam antes.
                nomeGrupo: null,
                categoriaGrupo: null,
                ativo: true,
                versao: 3,
              }
            : opcoes.janela,
        ),
      },
      // Por padrao o dia NAO tem celula na grade de grupos e a janela nunca a
      // usou — o estado de antes de 14/09/2026, e o que mantem os testes antigos
      // medindo o nome fixo da janela.
      grupoDaJanela: {
        findUnique: jest.fn().mockResolvedValue(opcoes.celulaDeGrupo ?? null),
        count: jest.fn().mockResolvedValue(opcoes.janelaUsaGrade ? 1 : 0),
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
            ordemDasEscritas.push('quiz');
            gravacoes.push({ orgUnitId, quizId, corpo });
            return Promise.resolve();
          },
        ),
    } as unknown as D2lQuizzesService;

    const condicoesCliente = {
      habilitado: jest.fn().mockReturnValue(true),
      listarCategoriasDeGrupo: jest
        .fn()
        .mockImplementation(() =>
          opcoes.semCategoria
            ? Promise.resolve([])
            : Promise.resolve([
                { GroupCategoryId: 8882, Name: 'Separacao de provas' },
              ]),
        ),
      listarGrupos: jest.fn().mockImplementation((orgUnitId: string) =>
        Promise.resolve(
          opcoes.gruposPorTurma?.[orgUnitId] ?? [
            { GroupId: 156988, Name: 'Prova 1' },
            { GroupId: 156989, Name: 'Prova 2' },
          ],
        ),
      ),
      lerCondicoes: jest.fn().mockImplementation(() => {
        if (opcoes.lerCondicoesLanca)
          return Promise.reject(new Error('403 sem escopo de grupos'));
        return Promise.resolve(
          opcoes.condicoes === undefined ? CONDICOES_PROVA_1 : opcoes.condicoes,
        );
      }),
      gravarCondicoes: jest
        .fn()
        .mockImplementation(
          (orgUnitId: string, quizId: string, corpo: unknown) => {
            if (opcoes.gravarCondicoesLanca)
              return Promise.reject(new Error('500 do tenant'));
            ordemDasEscritas.push('condicoes');
            condicoesGravadas.push({ orgUnitId, quizId, corpo });
            return Promise.resolve();
          },
        ),
    } as unknown as D2lCondicoesService;

    const grupos = new ResolucaoGrupoService(condicoesCliente);

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
      janelaVigente: jest.fn().mockResolvedValue({
        periodoLetivoIds: ['103'],
        principal: '103',
        rodada: 'N2',
        filtroDeNota: null,
      }),
    } as unknown as PeriodoService;

    const auditoria = { registrar: jest.fn() } as unknown as AuditoriaService;

    // Por padrao o lote de SENHAS nem consulta isto — ele nao recorta por
    // formato. Fica mockado para o construtor, e os testes de DATA o
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
      condicoesCliente,
      resolucao,
      grupos,
      modalidades,
      grade,
      periodo,
      auditoria,
      // O servico de verdade sobre o prisma mockado: a regra de qual grupo vale
      // no dia (`grupo-do-dia.ts`) e exatamente o que estes testes medem.
      new GradeGruposService(prisma, auditoria),
    );

    return { servico, prisma, auditoria };
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
        configuracaoSpecialAccess: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
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
        {} as unknown as D2lCondicoesService,
        {} as unknown as ResolucaoOrgUnitService,
        {} as unknown as ResolucaoGrupoService,
        {} as unknown as ModalidadeDaTurmaService,
        {} as unknown as GradeSenhasService,
        {} as unknown as PeriodoService,
        {} as unknown as AuditoriaService,
        {} as unknown as GradeGruposService,
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
   * Mesma maquinaria, outro recorte: uma JANELA aplicada nas turmas de UM
   * formato — derivado dos agendamentos, porque `TurmaImportada` nao guarda
   * formato e nao deve guardar.
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
      detalhe: 'dois formatos nesta turma',
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
     * Turma de OUTRO formato nao e erro: ela tem a janela dela, no horario
     * dela. Relatar isso encheria o CSV de linhas que ninguem deve tratar.
     */
    it('so toca as turmas DO FORMATO da janela, em silencio quanto as outras', async () => {
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
    it('turma sem formato derivavel vira linha de relatorio', async () => {
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

    it('a fotografia da janela e do formato vai para o item', async () => {
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

  /**
   * ==========================================================================
   * A TROCA DO GRUPO QUE LIBERA A PROVA
   * ==========================================================================
   * Acontece no MESMO disparo que move a data — o cliente pediu "nos mesmos
   * horarios em que trocamos as datas". Estes testes travam as tres decisoes
   * dele (26/08/2026), que sao o que distingue este recurso de uma porta
   * aberta para o turno anterior.
   */
  describe('troca de grupo', () => {
    const EAD = {
      situacao: 'ENCONTRADA',
      modalidadeId: 1,
      codigo: 'EAD',
      nome: 'EaD',
      reservas: 40,
    };

    const OPCOES = {
      tipo: 'DATA' as const,
      janelaId: 10,
      data: '2026-09-16',
      simulacao: false,
      forcar: false,
    };

    const umaTurmaEad = {
      quizzesPorTurma: QUIZZES,
      modalidadePorTurma: { '156126': EAD },
      janela: JANELA_COM_GRUPO,
    };

    it('aponta a condicao para o grupo da janela', async () => {
      const { servico } = montar(umaTurmaEad);

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(condicoesGravadas).toHaveLength(1);
      const corpo = condicoesGravadas[0].corpo as {
        Expression: { ExpressionParams: { Operands: Record<string, any>[] } };
      };

      expect(
        corpo.Expression.ExpressionParams.Operands[0].EnrolledInGroupParams,
      ).toEqual({ GroupId: 156989, GroupCategoryId: null });

      expect(itensGravados[0]).toMatchObject({
        resultadoGrupo: 'TROCADO',
        grupoAnterior: 'Prova 1 (#156988)',
        grupoAplicado: 'Prova 2 (#156989)',
      });
    });

    /**
     * ========================================================================
     * A GRADE DE GRUPOS (14/09/2026)
     * ========================================================================
     * Os grupos de cada dia tem nomes livres, e a secretaria trocava o nome da
     * janela a mao todo dia. A celula do dia vence o nome fixo.
     */
    describe('grade de grupos do dia', () => {
      const CELULA = {
        id: 31,
        nomeGrupo: 'EaD 16-09 tarde',
        categoriaGrupo: null,
        versao: 2,
      };

      const comOGrupoDoDia = {
        ...umaTurmaEad,
        gruposPorTurma: {
          '156126': [
            { GroupId: 156988, Name: 'Prova 1' },
            { GroupId: 156989, Name: 'Prova 2' },
            { GroupId: 157001, Name: 'EaD 16-09 tarde' },
          ],
        },
        celulaDeGrupo: CELULA,
      };

      it('aponta a condicao para o grupo da GRADE, e nao para o nome fixo', async () => {
        const { servico } = montar(comOGrupoDoDia);

        await servico.iniciar(OPCOES, 'admin@ucb.br');
        await deixarOLoteTerminar();

        const corpo = condicoesGravadas[0].corpo as {
          Expression: { ExpressionParams: { Operands: Record<string, any>[] } };
        };

        expect(
          corpo.Expression.ExpressionParams.Operands[0].EnrolledInGroupParams,
        ).toEqual({ GroupId: 157001, GroupCategoryId: null });
        expect(itensGravados[0].grupoAplicado).toBe(
          'EaD 16-09 tarde (#157001)',
        );
      });

      /**
       * O nome aplicado vai CONGELADO na execucao: com um nome por dia, le-lo da
       * janela na hora de exibir mostraria o grupo de hoje no relatorio de
       * ontem. A celula e a versao dela sao a chave da idempotencia.
       */
      it('a execucao guarda a celula, a versao dela e o nome aplicado', async () => {
        const { servico, prisma } = montar(comOGrupoDoDia);

        await servico.iniciar(OPCOES, 'admin@ucb.br');
        await deixarOLoteTerminar();

        const criacao = (
          prisma.execucaoSenhaQuiz.create as unknown as jest.Mock
        ).mock.calls[0][0] as { data: Record<string, unknown> };

        expect(criacao.data).toMatchObject({
          grupoDaJanelaId: 31,
          versaoGrupoAplicada: 2,
          nomeGrupoAplicado: 'EaD 16-09 tarde',
        });
      });

      /**
       * O bug de 25/08/2026 num campo novo: corrigir o grupo das 15h depois do
       * disparo das 12:01 nao muda a versao da JANELA. Sem a celula na chave, a
       * execucao concluida bloquearia a reaplicacao.
       */
      it('a checagem de "ja aplicada" leva a celula e a versao do grupo', async () => {
        const { servico, prisma } = montar(comOGrupoDoDia);

        await servico.iniciar(OPCOES, 'admin@ucb.br');
        await deixarOLoteTerminar();

        const idempotencia = (
          prisma.execucaoSenhaQuiz.findFirst as unknown as jest.Mock
        ).mock.calls
          .map((c) => (c[0] as { where: Record<string, unknown> }).where)
          .find((w) => w.janelaDeProvaId !== undefined);

        expect(idempotencia).toMatchObject({
          janelaDeProvaId: 10,
          versaoAplicada: 3,
          grupoDaJanelaId: 31,
          versaoGrupoAplicada: 2,
        });
      });

      it('sem celula no dia, o nome fixo da janela continua valendo', async () => {
        const { servico, prisma } = montar({
          ...umaTurmaEad,
          janelaUsaGrade: true,
        });

        await servico.iniciar(OPCOES, 'admin@ucb.br');
        await deixarOLoteTerminar();

        expect(itensGravados[0].grupoAplicado).toBe('Prova 2 (#156989)');

        const criacao = (
          prisma.execucaoSenhaQuiz.create as unknown as jest.Mock
        ).mock.calls[0][0] as { data: Record<string, unknown> };

        expect(criacao.data).toMatchObject({
          grupoDaJanelaId: null,
          versaoGrupoAplicada: null,
          nomeGrupoAplicado: 'Prova 2',
        });
      });

      /**
       * O dia esquecido na grade. A DATA entra (falha de grupo nao bloqueia a
       * data, decisao de 26/08/2026), mas cada questionario vira PENDENCIA — sem
       * isso a execucao sairia verde com a prova aberta para a sessao anterior.
       */
      it('dia em branco numa janela que usa a grade vira pendencia, e a data entra', async () => {
        const { servico, auditoria } = montar({
          ...umaTurmaEad,
          janela: { ...JANELA_COM_GRUPO, nomeGrupo: null },
          janelaUsaGrade: true,
        });

        await servico.iniciar(OPCOES, 'admin@ucb.br');
        await deixarOLoteTerminar();

        expect(gravacoes).toHaveLength(1);
        expect(condicoesGravadas).toHaveLength(0);
        expect(itensGravados[0]).toMatchObject({
          resultado: 'DEFINIDA',
          resultadoGrupo: 'SEM_GRUPO_NO_DIA',
        });
        expect(execucao).toMatchObject({ gruposPendentes: 1 });
        const { registrar } = auditoria as unknown as { registrar: jest.Mock };
        expect(registrar).toHaveBeenCalledWith(
          'DATA_QUIZ_SEM_GRUPO_NO_DIA',
          expect.anything(),
        );
      });
    });

    /**
     * ⚠️ A ORDEM NAO E INDIFERENTE. O PUT do quiz e o que ABRE a prova no
     * horario novo. Com o grupo primeiro, o estado entre as duas escritas e
     * "janela antiga + grupo novo" — prova fechada, inofensivo. Na ordem
     * inversa seria "janela nova + grupo antigo": a prova ABERTA para a sessao
     * anterior, que e o que este recurso existe para impedir.
     */
    it('troca o grupo ANTES de gravar a janela no questionario', async () => {
      const { servico } = montar(umaTurmaEad);

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(ordemDasEscritas).toEqual(['condicoes', 'quiz']);
    });

    /**
     * A outra metade da mesma decisao: se o quiz nao pode nem ser lido, o grupo
     * JA foi trocado. O estado resultante e "janela antiga + grupo novo" —
     * prova fechada, ninguem prejudicado. Se a ordem se invertesse um dia, este
     * teste passaria a ver `resultadoGrupo` nulo.
     */
    it('o grupo ja foi trocado quando a leitura do quiz falha', async () => {
      const { servico } = montar({
        ...umaTurmaEad,
        quizLido: undefined,
        gravarLanca: true,
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(itensGravados[0]).toMatchObject({
        resultado: ResultadoSenhaQuiz.FALHA_AO_GRAVAR,
        resultadoGrupo: 'TROCADO',
      });
      expect(ordemDasEscritas).toEqual(['condicoes']);
    });

    /**
     * DECISAO 2 do cliente: falha de grupo NAO bloqueia a data. Sem a data a
     * prova nao abre para NINGUEM; sem a troca de grupo ela abre para o grupo
     * anterior. Bloquear a data trocaria o problema menor pelo maior.
     */
    it('aplica a DATA mesmo quando o grupo nao existe na turma', async () => {
      const { servico } = montar({
        ...umaTurmaEad,
        gruposPorTurma: { '156126': [{ GroupId: 1, Name: 'Outro grupo' }] },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(gravacoes).toHaveLength(1);
      expect(condicoesGravadas).toHaveLength(0);
      expect(itensGravados[0]).toMatchObject({
        resultado: ResultadoSenhaQuiz.DEFINIDA,
        resultadoGrupo: 'GRUPO_NAO_ENCONTRADO',
      });
      expect(String(itensGravados[0].detalhe)).toContain('Outro grupo');
    });

    it('aplica a DATA mesmo quando o PUT das condicoes falha', async () => {
      const { servico } = montar({
        ...umaTurmaEad,
        gravarCondicoesLanca: true,
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(gravacoes).toHaveLength(1);
      expect(itensGravados[0]).toMatchObject({
        resultado: ResultadoSenhaQuiz.DEFINIDA,
        resultadoGrupo: 'FALHA_AO_GRAVAR_CONDICOES',
      });
    });

    /**
     * DECISAO 3: so se TROCA condicao existente, nunca se CRIA. Criar mudaria o
     * comportamento de uma prova que talvez seja aberta a todos de proposito.
     */
    it('nao cria condicao onde nao ha — nenhum PUT sai', async () => {
      const { servico } = montar({
        ...umaTurmaEad,
        condicoes: {
          Expression: {
            Type: 'Expression',
            State: null,
            ExpressionParams: { Operator: 'All', Operands: [] },
          },
        },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(condicoesGravadas).toHaveLength(0);
      expect(itensGravados[0].resultadoGrupo).toBe('SEM_CONDICAO_DE_GRUPO');
    });

    /**
     * ⚠️ ZERO PUT no dry-run, aqui como no do quiz. E a unica conferencia
     * possivel antes de mexer na condicao de liberacao de toda a instituicao.
     */
    it('SIMULACAO nao emite nenhum PUT de condicoes', async () => {
      const { servico } = montar(umaTurmaEad);

      await servico.iniciar({ ...OPCOES, simulacao: true }, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(condicoesGravadas).toHaveLength(0);
      expect(gravacoes).toHaveLength(0);
      expect(itensGravados[0]).toMatchObject({
        resultado: ResultadoSenhaQuiz.SIMULADA,
        resultadoGrupo: 'SIMULADO',
        grupoAplicado: 'Prova 2 (#156989)',
      });
    });

    /**
     * O backup e a UNICA forma de voltar atras: o PUT substitui tudo e a API nao
     * guarda historico. Gravado tambem no dry-run, porque e nele que se descobre
     * o que a prova tem hoje.
     */
    it('guarda as condicoes anteriores, inclusive na simulacao', async () => {
      const { servico } = montar(umaTurmaEad);

      await servico.iniciar({ ...OPCOES, simulacao: true }, 'admin@ucb.br');
      await deixarOLoteTerminar();

      const backup = JSON.parse(
        String(itensGravados[0].condicoesAnteriores),
      ) as typeof CONDICOES_PROVA_1;

      expect(backup).toEqual(CONDICOES_PROVA_1);
    });

    it('reconhece quando a prova JA estava no grupo, sem gravar', async () => {
      const { servico } = montar({
        ...umaTurmaEad,
        condicoes: {
          Expression: {
            Type: 'Expression',
            State: null,
            ExpressionParams: {
              Operator: 'All',
              Operands: [
                {
                  Type: 'EnrolledInGroup',
                  State: 'x',
                  EnrolledInGroupParams: {
                    GroupId: 156989,
                    GroupCategoryId: null,
                  },
                },
              ],
            },
          },
        },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(condicoesGravadas).toHaveLength(0);
      expect(itensGravados[0].resultadoGrupo).toBe('JA_ERA_O_GRUPO');
    });

    /**
     * O contador `gruposPendentes` tem o MESMO peso de `naoEncontradas`: uma
     * execucao com 0 falhas e N aqui NAO e verde. Ver a licao de 26/08/2026
     * sobre `semModalidade` aparecer com "0 pendencia(s)".
     */
    it('conta trocados e pendentes separado do resultado da data', async () => {
      const { servico } = montar({
        resolucao: {
          totalNoCsv: 2,
          resolvidas: [
            turmaResolvida(1, '156126'),
            turmaResolvida(2, '156127'),
          ],
          naoResolvidas: [],
          aprendidos: 0,
        },
        quizzesPorTurma: {
          '156126': [{ QuizId: 42, Name: 'Prova N1' }],
          '156127': [{ QuizId: 43, Name: 'Prova N1' }],
        },
        modalidadePorTurma: { '156126': EAD, '156127': EAD },
        // A segunda turma nao tem o grupo — anomalia de cadastro, ja que toda
        // turma deveria te-lo.
        gruposPorTurma: {
          '156127': [{ GroupId: 1, Name: 'Outro' }],
        },
        janela: JANELA_COM_GRUPO,
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(execucao).toMatchObject({
        definidas: 2,
        falhas: 0,
        gruposTrocados: 1,
        gruposPendentes: 1,
      });
    });

    /**
     * O estado de quem ainda nao cadastrou nada na tela. O lote precisa se
     * comportar EXATAMENTE como antes de 26/08/2026 — nenhuma chamada de grupo,
     * e `resultadoGrupo` nulo (ausencia de tentativa, nao desfecho ruim).
     */
    it('janela SEM grupo nao toca em condicao nenhuma', async () => {
      const { servico } = montar({
        quizzesPorTurma: QUIZZES,
        modalidadePorTurma: { '156126': EAD },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(condicoesGravadas).toHaveLength(0);
      expect(gravacoes).toHaveLength(1);
      expect(itensGravados[0].resultadoGrupo).toBeNull();
      expect(execucao).toMatchObject({
        gruposTrocados: 0,
        gruposPendentes: 0,
      });
    });

    /**
     * Um `"  "` salvo por engano na tela passaria por qualquer checagem de
     * "tem grupo?" e faria a resolucao procurar um grupo sem nome em cada turma,
     * produzindo uma pendencia por turma sem que nada estivesse configurado.
     */
    it('nome so com espacos conta como SEM grupo', async () => {
      const { servico } = montar({
        quizzesPorTurma: QUIZZES,
        modalidadePorTurma: { '156126': EAD },
        janela: { ...JANELA_COM_GRUPO, nomeGrupo: '   ' },
      });

      await servico.iniciar(OPCOES, 'admin@ucb.br');
      await deixarOLoteTerminar();

      expect(condicoesGravadas).toHaveLength(0);
      expect(itensGravados[0].resultadoGrupo).toBeNull();
    });

    /**
     * O lote de SENHAS nao tem janela, logo nao tem grupo — ele toca TODAS as
     * turmas do CSV, e trocar a condicao de liberacao ali apontaria a prova de
     * toda a instituicao para o grupo de uma sessao so.
     */
    it('o lote de SENHAS nunca toca em condicoes', async () => {
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

      expect(condicoesGravadas).toHaveLength(0);
      expect(itensGravados[0].resultadoGrupo).toBeNull();
    });
  });
});
