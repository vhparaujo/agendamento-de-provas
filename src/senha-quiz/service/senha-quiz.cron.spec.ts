import { ConfigService } from '@nestjs/config';
import { D2lQuizzesService } from '../../d2l/service/d2l-quizzes.service';
import { PrismaService } from '../../database/prisma.service';
import { StatusExecucao, Turno } from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { GradeGruposService } from './grade-grupos.service';
import { SenhaQuizCron } from './senha-quiz.cron';
import { SenhaQuizService } from './senha-quiz.service';

/**
 * As saidas antecipadas do tick, mais a idempotencia. O miolo da decisao de
 * horario tem teste proprio em `janela.spec.ts`; aqui o que importa e que
 * nenhuma dessas saidas dispare o lote — e que nenhuma derrube o tick.
 *
 * ⚠️ **Desde 21/09/2026 ha UM calendario.** Os horarios de turno sairam do
 * banco junto com o cron de senhas proprio: quem dispara e a
 * `janela_de_prova` de cada formato, e o lote de DATAS ja grava a senha da
 * sessao. O caminho so-senha sobrou para o modo em que o special access
 * substitui as janelas, e e assim que ele e exercitado aqui.
 */
describe('SenhaQuizCron', () => {
  /** So o que e do SERVIDOR mora no .env. O calendario esta no banco. */
  const ENV_LIGADO = {
    SENHA_QUIZ_CRON_HABILITADO: 'true',
    SENHA_QUIZ_CRON_TOLERANCIA_MIN: '30',
    SENHA_QUIZ_CRON_MAX_TENTATIVAS: '3',
  };

  /** 16/09/2026 07:30 em Sao Paulo = 10:30 UTC. */
  const NA_HORA = new Date('2026-09-16T10:30:00.000Z');

  /**
   * Uma janela EaD que dispara exatamente as 07:30 — o horario dos testes.
   *
   * Ela e o calendario PADRAO deste arquivo: sem janela ativa nao ha disparo
   * nenhum desde 21/09/2026, nem de data nem de senha.
   */
  const JANELA_AS_0730 = {
    id: 31,
    modalidadeId: 1,
    horaDisparo: '07:30',
    horaInicio: '09:00',
    horaFim: '12:00',
    turno: Turno.MANHA,
    diaSeguinte: false,
    ativo: true,
    versao: 1,
    nomeGrupo: null,
    categoriaGrupo: null,
    modalidade: { codigo: 'EAD' },
  };

  /** O modo em que so a senha troca — e onde o lote `SENHA` ainda dispara. */
  const SO_SENHA = { substituiJanelas: true };

  /**
   * Os timestamps das execucoes precisam ser ANCORADOS em `NA_HORA`, nunca em
   * `new Date()`: o argumento de `montar` e avaliado ANTES de os fake timers
   * entrarem, entao um `new Date()` aqui traria a hora real e toda execucao
   * pareceria morta por meses de diferenca.
   */
  const minutosAntes = (n: number) => new Date(NA_HORA.getTime() - n * 60_000);

  let iniciar: jest.Mock;
  let eventos: string[];

  /**
   * So os avisos do lote de SENHAS.
   *
   * O caminho so-senha tambem emite `DATA_QUIZ_CRON_SUBSTITUIDO` a cada dia,
   * porque e o modo do special access que o leva ali. Filtrar mantem cada teste
   * falando do que ele exercita, em vez de casar a lista inteira e quebrar toda
   * vez que um aviso novo nascer do outro lado.
   */
  const eventosDeSenha = () => eventos.filter((e) => e.startsWith('SENHA_'));

  const montar = (opcoes: {
    env?: Record<string, string>;
    agora?: Date;
    celula?: Record<string, unknown> | null;
    habilitado?: boolean;
    execucoes?: Record<string, unknown>[];
    /**
     * As janelas ATIVAS no banco. O padrao e a de 07:30 — sem nenhuma, o tick
     * nao dispara nada, nem data nem senha.
     */
    janelas?: Record<string, unknown>[];
    /** A celula da grade de GRUPOS do dia alvo. Ausente = sem celula. */
    celulaDeGrupo?: Record<string, unknown> | null;
    /** A configuracao do special access. Ausente = nunca salva. */
    specialAccess?: { substituiJanelas: boolean } | null;
  }) => {
    jest.useFakeTimers().setSystemTime(opcoes.agora ?? NA_HORA);

    iniciar = jest.fn().mockResolvedValue({ id: 7 });
    eventos = [];

    const prisma = {
      senhaDeProva: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            opcoes.celula === undefined ? { id: 1, versao: 1 } : opcoes.celula,
          ),
      },
      execucaoSenhaQuiz: {
        findMany: jest.fn().mockResolvedValue(opcoes.execucoes ?? []),
      },
      janelaDeProva: {
        findMany: jest
          .fn()
          .mockResolvedValue(opcoes.janelas ?? [JANELA_AS_0730]),
      },
      grupoDaJanela: {
        findUnique: jest.fn().mockResolvedValue(opcoes.celulaDeGrupo ?? null),
        count: jest.fn().mockResolvedValue(0),
      },
      configuracaoSpecialAccess: {
        findUnique: jest.fn().mockResolvedValue(opcoes.specialAccess ?? null),
      },
    } as unknown as PrismaService;

    const quizzes = {
      habilitado: jest.fn().mockReturnValue(opcoes.habilitado ?? true),
    } as unknown as D2lQuizzesService;

    const auditoria = {
      registrar: jest.fn().mockImplementation((e: string) => eventos.push(e)),
    } as unknown as AuditoriaService;

    return new SenhaQuizCron(
      new ConfigService({ ...ENV_LIGADO, ...opcoes.env }),
      prisma,
      quizzes,
      { iniciar } as unknown as SenhaQuizService,
      auditoria,
      new GradeGruposService(prisma, auditoria),
    );
  };

  afterEach(() => jest.useRealTimers());

  describe('special access substituindo as janelas (15/09/2026)', () => {
    it('sem a opcao, a janela do horario dispara as datas', async () => {
      const cron = montar({});

      await cron.tick();

      expect(iniciar).toHaveBeenCalledTimes(1);
      expect(iniciar.mock.calls[0][0]).toMatchObject({
        tipo: 'DATA',
        janelaId: 31,
      });
    });

    /**
     * O questionario preparado nao tem data. Uma janela aplicada pelo cron o
     * abriria no horario de UM formato para todos — e a senha precisa
     * continuar trocando, porque ela e o unico fator que resta.
     */
    it('com a opcao, nao aplica a janela e troca SO a senha', async () => {
      const cron = montar({ specialAccess: SO_SENHA });

      await cron.tick();

      expect(eventos).toContain('DATA_QUIZ_CRON_SUBSTITUIDO');
      expect(iniciar).toHaveBeenCalledTimes(1);
      // Mesma janela, e por isso mesmo recorte e mesma celula — o que muda e o
      // tipo do lote, que aqui nao carrega `tipo` (o default e SENHA).
      expect(iniciar.mock.calls[0][0]).toMatchObject({ janelaId: 31 });
      expect(iniciar.mock.calls[0][0]).not.toHaveProperty('tipo');
    });
  });

  it('dispara no horario, SEM simulacao e com origem CRON', async () => {
    await montar({ specialAccess: SO_SENHA }).tick();

    expect(iniciar).toHaveBeenCalledWith(
      {
        data: '2026-09-16',
        janelaId: 31,
        simulacao: false,
        forcar: false,
      },
      'cron',
      'CRON',
    );
  });

  it('(1) nao faz nada quando o cron esta desligado — o default', async () => {
    await montar({ env: { SENHA_QUIZ_CRON_HABILITADO: 'false' } }).tick();
    expect(iniciar).not.toHaveBeenCalled();
  });

  /**
   * Cron ligado no servidor e nenhuma janela ativa cadastrada: ele nunca vai
   * disparar. Calar aqui entregaria um cron que PARECE armado e nao esta — e
   * ninguem descobriria antes do dia da prova.
   *
   * Desde 21/09/2026 este aviso vale pelos TRES calendarios de uma vez: sem
   * janela nao ha data, nem grupo, nem senha.
   */
  it('(2a) sem nenhuma janela ativa, avisa UMA vez e nao dispara', async () => {
    const cron = montar({ janelas: [] });

    await cron.tick();
    await cron.tick();

    expect(iniciar).not.toHaveBeenCalled();
    expect(eventos).toEqual(['DATA_QUIZ_CRON_SEM_JANELA']);
  });

  /**
   * Horario mal digitado nao pode passar por "sessao desligada" sem barulho: o
   * `PUT /janelas` recusa o formato, mas se algo escapar para o banco a janela
   * simplesmente nao casa nenhum minuto — e nenhum disparo sai dela.
   */
  it('(2a) horario mal digitado no banco nao dispara', async () => {
    const cron = montar({
      janelas: [{ ...JANELA_AS_0730, horaDisparo: '7:30' }],
    });

    await cron.tick();

    expect(iniciar).not.toHaveBeenCalled();
  });

  it('(3) nao faz nada fora da janela', async () => {
    await montar({ agora: new Date('2026-09-16T13:00:00.000Z') }).tick();
    expect(iniciar).not.toHaveBeenCalled();
  });

  /**
   * O ponto de o calendario estar no banco: o admin corrige o horario pela tela
   * e o tick seguinte ja usa o valor novo, sem reiniciar o servidor.
   */
  it('usa o horario do BANCO, nao do .env', async () => {
    await montar({
      agora: new Date('2026-09-16T13:00:00.000Z'), // 10:00 em Sao Paulo
      janelas: [{ ...JANELA_AS_0730, horaDisparo: '10:00' }],
    }).tick();

    expect(iniciar).toHaveBeenCalledWith(
      expect.objectContaining({ janelaId: 31 }),
      'cron',
      'CRON',
    );
  });

  /**
   * Sabado a noite nao tem prova, e a grade do cliente reflete isso. O aviso e o
   * valor: o horario chegou e ninguem gerou a senha daquela sessao.
   *
   * ⚠️ Sem a celula, a JANELA tambem nao e aplicada — o PUT substitui o
   * questionario inteiro e nao pode preservar a senha lida. Por isso o caminho
   * normal avisa com `DATA_QUIZ_CRON_SEM_GRADE`, e nao so o so-senha.
   */
  it('(4) sem celula na grade, avisa UMA vez e nao dispara', async () => {
    const cron = montar({ celula: null });

    await cron.tick();
    await cron.tick();
    await cron.tick();

    expect(iniciar).not.toHaveBeenCalled();
    expect(eventos).toEqual(['DATA_QUIZ_CRON_SEM_GRADE']);
  });

  it('(4) o mesmo vale no modo so-senha', async () => {
    const cron = montar({ celula: null, specialAccess: SO_SENHA });

    await cron.tick();
    await cron.tick();
    await cron.tick();

    expect(iniciar).not.toHaveBeenCalled();
    expect(eventosDeSenha()).toEqual(['SENHA_QUIZ_CRON_SEM_GRADE']);
  });

  it('(5) integracao desligada avisa uma vez e nao derruba o tick', async () => {
    const cron = montar({ habilitado: false, specialAccess: SO_SENHA });

    await cron.tick();
    await cron.tick();

    expect(iniciar).not.toHaveBeenCalled();
    expect(eventosDeSenha()).toEqual(['SENHA_QUIZ_CRON_IGNORADO']);
  });

  describe('(6) idempotencia — a guarda que sobrevive ao restart', () => {
    it('nao repete uma celula ja aplicada', async () => {
      await montar({
        execucoes: [
          {
            id: 1,
            status: StatusExecucao.CONCLUIDA,
            atualizadoEm: minutosAntes(1),
          },
        ],
      }).tick();

      expect(iniciar).not.toHaveBeenCalled();
    });

    it('nao atropela uma execucao ainda viva', async () => {
      await montar({
        execucoes: [
          {
            id: 1,
            status: StatusExecucao.EM_ANDAMENTO,
            atualizadoEm: minutosAntes(1),
          },
        ],
      }).tick();

      expect(iniciar).not.toHaveBeenCalled();
    });

    it('assume o lugar de uma execucao MORTA', async () => {
      await montar({
        execucoes: [
          {
            id: 1,
            status: StatusExecucao.EM_ANDAMENTO,
            atualizadoEm: minutosAntes(10),
          },
        ],
      }).tick();

      expect(iniciar).toHaveBeenCalled();
    });

    /**
     * O caso real: token sem escopo de quizzing devolve 403 sempre. Sem o teto,
     * o cron bateria no Brightspace a cada minuto por toda a janela.
     */
    it('para de insistir depois do teto de tentativas', async () => {
      const falha = {
        status: StatusExecucao.FALHOU,
        atualizadoEm: minutosAntes(1),
      };

      await montar({ execucoes: [falha, falha, falha] }).tick();

      expect(iniciar).not.toHaveBeenCalled();
    });
  });

  it('erro inesperado nao derruba o tick', async () => {
    const cron = montar({});
    (cron as unknown as { decidir: () => Promise<void> }).decidir = () =>
      Promise.reject(new Error('banco fora'));

    await expect(cron.tick()).resolves.toBeUndefined();
  });

  /**
   * ==========================================================================
   * O LOTE DE DATAS
   * ==========================================================================
   * O tick decide DUAS coisas desde 25/08/2026, e a data vem primeiro: sem a
   * janela nova o questionario nao abre, e ai ninguem faz a prova.
   */
  describe('datas do questionario', () => {
    const EAD = 1;
    const SEMI = 2;

    /** 16/09/2026 12:01 em Sao Paulo = 15:01 UTC. As 12:01 disparam as duas. */
    const AS_1201 = new Date('2026-09-16T15:01:00.000Z');

    const janela = (sobrepor: Record<string, unknown> = {}) => ({
      id: 10,
      modalidadeId: EAD,
      ordem: 2,
      horaDisparo: '12:01',
      horaInicio: '15:00',
      horaFim: '18:00',
      turno: Turno.TARDE,
      diaSeguinte: false,
      ativo: true,
      versao: 1,
      modalidade: { codigo: 'EAD' },
      ...sobrepor,
    });

    it('dispara a janela do minuto, SEM simulacao e com origem CRON', async () => {
      await montar({
        agora: AS_1201,
        janelas: [janela()],
      }).tick();

      expect(iniciar).toHaveBeenCalledWith(
        {
          tipo: 'DATA',
          janelaId: 10,
          data: '2026-09-16',
          simulacao: false,
          forcar: false,
        },
        'cron',
        'CRON',
      );
    });

    /**
     * O disparo das 22:01 (EaD) e das 21:31 (Semi/Modular) arma a prova da MANHA
     * SEGUINTE. Errar isso poria a prova no dia que ja passou, e o sintoma seria
     * um questionario que nunca abre.
     */
    it('`diaSeguinte` manda a janela para AMANHA', async () => {
      // 16/09/2026 22:01 em Sao Paulo = 17/09 01:01 UTC.
      await montar({
        agora: new Date('2026-09-17T01:01:00.000Z'),
        janelas: [
          janela({
            id: 11,
            ordem: 1,
            horaDisparo: '22:01',
            horaInicio: '09:00',
            horaFim: '12:00',
            turno: Turno.MANHA,
            diaSeguinte: true,
          }),
        ],
      }).tick();

      expect(iniciar).toHaveBeenCalledWith(
        expect.objectContaining({ janelaId: 11, data: '2026-09-17' }),
        'cron',
        'CRON',
      );
    });

    /**
     * As 12:01 tres formatos tem janela. Os dois lotes fazem GET -> PUT no
     * mesmo questionario e `recusarSeJaRodando` os serializa, entao disparar
     * dois no mesmo minuto so produziria um 409. O tick pega UM; a tolerancia
     * de 30 min cobre os outros nos minutos seguintes.
     */
    it('dispara UMA janela por tick, mesmo com varias no mesmo minuto', async () => {
      await montar({
        agora: AS_1201,
        janelas: [
          janela({ id: 10, modalidadeId: EAD }),
          janela({
            id: 20,
            modalidadeId: SEMI,
            horaInicio: '14:00',
            horaFim: '15:30',
          }),
        ],
      }).tick();

      expect(iniciar).toHaveBeenCalledTimes(1);
    });

    it('pula a janela ja concluida e dispara a seguinte', async () => {
      const cron = montar({
        agora: AS_1201,
        janelas: [
          janela({ id: 10, modalidadeId: EAD }),
          janela({
            id: 20,
            modalidadeId: SEMI,
            horaInicio: '14:00',
            horaFim: '15:30',
          }),
        ],
      });

      // O do formato 1 ja rodou hoje; a da 2 ainda nao.
      const prisma = (cron as unknown as { prisma: Record<string, any> })
        .prisma;
      prisma.execucaoSenhaQuiz.findMany = jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { janelaDeProvaId: number } }) =>
            Promise.resolve(
              where.janelaDeProvaId === 10
                ? [
                    {
                      id: 1,
                      status: StatusExecucao.CONCLUIDA,
                      atualizadoEm: NA_HORA,
                    },
                  ]
                : [],
            ),
        );

      await cron.tick();

      expect(iniciar).toHaveBeenCalledWith(
        expect.objectContaining({ janelaId: 20 }),
        'cron',
        'CRON',
      );
    });

    /**
     * A trava que impede o apagamento silencioso da senha: o PUT reenvia
     * `Password`, e o lote de datas NAO pode preservar a lida (o GET pode
     * devolve-la nula num quiz que tem senha). Sem celula, a janela nao vai.
     */
    it('sem senha na grade, NAO aplica a janela e avisa', async () => {
      await montar({
        agora: AS_1201,
        janelas: [janela()],
        celula: null,
      }).tick();

      expect(iniciar).not.toHaveBeenCalled();
      expect(eventos).toContain('DATA_QUIZ_CRON_SEM_GRADE');
    });

    it('nenhuma janela ativa cadastrada avisa UMA vez', async () => {
      const cron = montar({ agora: AS_1201, janelas: [] });

      await cron.tick();
      await cron.tick();

      expect(
        eventos.filter((e) => e === 'DATA_QUIZ_CRON_SEM_JANELA'),
      ).toHaveLength(1);
    });

    it('fora de qualquer janela nao dispara nem avisa', async () => {
      // 09:00 em Sao Paulo = 12:00 UTC; nenhuma janela abre ai.
      await montar({
        agora: new Date('2026-09-16T12:00:00.000Z'),
        janelas: [janela()],
      }).tick();

      expect(iniciar).not.toHaveBeenCalled();
      expect(eventos.filter((e) => e.startsWith('DATA_'))).toEqual([]);
    });

    it('integracao desligada nao derruba o tick', async () => {
      await montar({
        agora: AS_1201,
        janelas: [janela()],
        habilitado: false,
      }).tick();

      expect(iniciar).not.toHaveBeenCalled();
      expect(eventos).toContain('DATA_QUIZ_CRON_IGNORADO');
    });

    /**
     * ==========================================================================
     * O BUG DE 25/08/2026
     * ==========================================================================
     * O admin viu que a janela tinha disparado com o horario errado, corrigiu na
     * tela e salvou. O `upsert` de `salvarJanelas` PRESERVA o id da linha, entao
     * a checagem "esta janela ja rodou hoje?" encontrava a execucao antiga e
     * pulava — em silencio. A correcao so passaria a valer no dia seguinte.
     *
     * `versao` (gemea de `SenhaDeProva.versao`) entrou na chave: a execucao
     * antiga tem outra `versaoAplicada` e deixa de bloquear.
     */
    it('execucao concluida de OUTRA versao NAO bloqueia o disparo', async () => {
      const cron = montar({ agora: AS_1201, janelas: [janela({ versao: 2 })] });

      const prisma = (cron as unknown as { prisma: Record<string, any> })
        .prisma;
      prisma.execucaoSenhaQuiz.findMany = jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { versaoAplicada?: number } }) =>
            Promise.resolve(
              // So a versao 1 tem execucao concluida; a janela agora e versao 2.
              where.versaoAplicada === 1
                ? [
                    {
                      id: 9,
                      status: StatusExecucao.CONCLUIDA,
                      atualizadoEm: NA_HORA,
                    },
                  ]
                : [],
            ),
        );

      await cron.tick();

      expect(iniciar).toHaveBeenCalledWith(
        expect.objectContaining({ tipo: 'DATA', janelaId: 10 }),
        'cron',
        'CRON',
      );
    });

    /**
     * O outro lado: sem correcao nenhuma, a janela ja aplicada nao roda de novo
     * — e agora ela DEIXA RASTRO. Um tick que encontra janela no horario e nao
     * aplica nada, calado, e indistinguivel de um cron quebrado; foi assim que o
     * bug acima passou despercebido.
     */
    it('janela ja aplicada nesta versao nao dispara, e diz por que', async () => {
      await montar({
        agora: AS_1201,
        janelas: [janela()],
        execucoes: [
          { id: 9, status: StatusExecucao.CONCLUIDA, atualizadoEm: NA_HORA },
        ],
      }).tick();

      expect(iniciar).not.toHaveBeenCalled();
      expect(eventos).toContain('DATA_QUIZ_CRON_NADA_A_FAZER');
    });

    /**
     * A grade de grupos (14/09/2026), o mesmo bug de 25/08/2026 num campo novo:
     * a administracao corrige o grupo do dia depois do disparo das 12:01. A JANELA
     * nao mudou de versao, entao so a celula na chave libera o novo disparo.
     */
    it('corrigir o grupo do dia libera um novo disparo HOJE', async () => {
      const cron = montar({
        agora: AS_1201,
        janelas: [janela()],
        celulaDeGrupo: {
          id: 31,
          nomeGrupo: 'EaD 16-09 tarde',
          categoriaGrupo: null,
          versao: 2,
        },
      });

      const prisma = (cron as unknown as { prisma: Record<string, any> })
        .prisma;
      prisma.execucaoSenhaQuiz.findMany = jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { versaoGrupoAplicada?: number | null } }) =>
            Promise.resolve(
              // So a versao 1 da celula foi aplicada; a celula agora e versao 2.
              where.versaoGrupoAplicada === 1
                ? [
                    {
                      id: 9,
                      status: StatusExecucao.CONCLUIDA,
                      atualizadoEm: NA_HORA,
                    },
                  ]
                : [],
            ),
        );

      await cron.tick();

      expect(prisma.execucaoSenhaQuiz.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            grupoDaJanelaId: 31,
            versaoGrupoAplicada: 2,
          }),
        }),
      );
      expect(iniciar).toHaveBeenCalledWith(
        expect.objectContaining({ tipo: 'DATA', janelaId: 10 }),
        'cron',
        'CRON',
      );
    });

    it('o teto de tentativas vale tambem para a janela', async () => {
      await montar({
        agora: AS_1201,
        janelas: [janela()],
        execucoes: [
          {
            id: 1,
            status: StatusExecucao.FALHOU,
            atualizadoEm: minutosAntes(3),
          },
          {
            id: 2,
            status: StatusExecucao.FALHOU,
            atualizadoEm: minutosAntes(2),
          },
          {
            id: 3,
            status: StatusExecucao.FALHOU,
            atualizadoEm: minutosAntes(1),
          },
        ],
      }).tick();

      expect(iniciar).not.toHaveBeenCalled();
    });
  });
});
