import { ConfigService } from '@nestjs/config';
import { D2lQuizzesService } from '../../d2l/service/d2l-quizzes.service';
import { PrismaService } from '../../database/prisma.service';
import { StatusExecucao, Turno } from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { GradeSenhasService } from './grade-senhas.service';
import { SenhaQuizCron } from './senha-quiz.cron';
import { SenhaQuizService } from './senha-quiz.service';

/**
 * As saidas antecipadas do tick, mais a idempotencia. O miolo da decisao
 * de horario tem teste proprio em `turno.spec.ts`; aqui o que importa e que
 * nenhuma dessas saidas dispare o lote — e que nenhuma derrube o tick.
 */
describe('SenhaQuizCron', () => {
  /**
   * So o que e do SERVIDOR continua no .env. Os horarios saem do BANCO desde
   * 19/08/2026 — ver `HORARIOS` abaixo.
   */
  const ENV_LIGADO = {
    SENHA_QUIZ_CRON_HABILITADO: 'true',
    SENHA_QUIZ_CRON_TOLERANCIA_MIN: '30',
    SENHA_QUIZ_CRON_MAX_TENTATIVAS: '3',
  };

  const HORARIOS = {
    [Turno.MANHA]: '07:30',
    [Turno.TARDE]: null,
    [Turno.NOITE]: null,
  };

  /** 16/09/2026 07:30 em Sao Paulo = 10:30 UTC. */
  const NA_HORA = new Date('2026-09-16T10:30:00.000Z');

  /**
   * Os timestamps das execucoes precisam ser ANCORADOS em `NA_HORA`, nunca em
   * `new Date()`: o argumento de `montar` e avaliado ANTES de os fake timers
   * entrarem, entao um `new Date()` aqui traria a hora real e toda execucao
   * pareceria morta por meses de diferenca.
   */
  const minutosAntes = (n: number) => new Date(NA_HORA.getTime() - n * 60_000);

  let iniciar: jest.Mock;
  let eventos: string[];

  const montar = (opcoes: {
    env?: Record<string, string>;
    agora?: Date;
    celula?: Record<string, unknown> | null;
    habilitado?: boolean;
    execucoes?: Record<string, unknown>[];
    horarios?: Record<Turno, string | null>;
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
    } as unknown as PrismaService;

    const quizzes = {
      habilitado: jest.fn().mockReturnValue(opcoes.habilitado ?? true),
    } as unknown as D2lQuizzesService;

    const auditoria = {
      registrar: jest.fn().mockImplementation((e: string) => eventos.push(e)),
    } as unknown as AuditoriaService;

    const grade = {
      horariosDoCron: jest.fn().mockResolvedValue(opcoes.horarios ?? HORARIOS),
    } as unknown as GradeSenhasService;

    return new SenhaQuizCron(
      new ConfigService({ ...ENV_LIGADO, ...opcoes.env }),
      prisma,
      quizzes,
      { iniciar } as unknown as SenhaQuizService,
      grade,
      auditoria,
    );
  };

  afterEach(() => jest.useRealTimers());

  it('dispara no horario, SEM simulacao e com origem CRON', async () => {
    await montar({}).tick();

    expect(iniciar).toHaveBeenCalledWith(
      {
        data: '2026-09-16',
        turno: Turno.MANHA,
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
   * Cron ligado no servidor e nenhum horario cadastrado na tela: ele nunca vai
   * disparar. Calar aqui entregaria um cron que PARECE armado e nao esta — e
   * ninguem descobriria antes do dia da prova.
   */
  it('(2a) sem nenhum horario cadastrado, avisa UMA vez e nao dispara', async () => {
    const cron = montar({
      horarios: {
        [Turno.MANHA]: null,
        [Turno.TARDE]: null,
        [Turno.NOITE]: null,
      },
    });

    await cron.tick();
    await cron.tick();

    expect(iniciar).not.toHaveBeenCalled();
    expect(eventos).toEqual(['SENHA_QUIZ_CRON_SEM_HORARIO']);
  });

  /**
   * Horario mal digitado nao pode passar por "turno desligado" sem barulho: o
   * `PUT /horarios` recusa o formato, mas se algo escapar para o banco, o
   * aviso de "nenhum horario" e o que sobra.
   */
  it('(2a) horario mal digitado no banco cai no mesmo aviso', async () => {
    const cron = montar({
      horarios: {
        [Turno.MANHA]: '7:30',
        [Turno.TARDE]: '',
        [Turno.NOITE]: null,
      },
    });

    await cron.tick();

    expect(iniciar).not.toHaveBeenCalled();
    expect(eventos).toEqual(['SENHA_QUIZ_CRON_SEM_HORARIO']);
  });

  it('(3) nao faz nada fora da janela', async () => {
    await montar({ agora: new Date('2026-09-16T13:00:00.000Z') }).tick();
    expect(iniciar).not.toHaveBeenCalled();
  });

  /**
   * O ponto de mover os horarios para o banco: o admin corrige o horario pela
   * tela e o tick seguinte ja usa o valor novo, sem reiniciar o servidor.
   */
  it('usa o horario do BANCO, nao do .env', async () => {
    await montar({
      agora: new Date('2026-09-16T13:00:00.000Z'), // 10:00 em Sao Paulo
      horarios: {
        [Turno.MANHA]: '10:00',
        [Turno.TARDE]: null,
        [Turno.NOITE]: null,
      },
    }).tick();

    expect(iniciar).toHaveBeenCalledWith(
      expect.objectContaining({ turno: Turno.MANHA }),
      'cron',
      'CRON',
    );
  });

  /**
   * Sabado a noite nao tem prova, e a grade do cliente reflete isso. O aviso e o
   * valor: o horario chegou e ninguem preencheu.
   */
  it('(4) sem celula na grade, avisa UMA vez e nao dispara', async () => {
    const cron = montar({ celula: null });

    await cron.tick();
    await cron.tick();
    await cron.tick();

    expect(iniciar).not.toHaveBeenCalled();
    expect(eventos).toEqual(['SENHA_QUIZ_CRON_SEM_GRADE']);
  });

  it('(5) integracao desligada avisa uma vez e nao derruba o tick', async () => {
    const cron = montar({ habilitado: false });

    await cron.tick();
    await cron.tick();

    expect(iniciar).not.toHaveBeenCalled();
    expect(eventos).toEqual(['SENHA_QUIZ_CRON_IGNORADO']);
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
});
