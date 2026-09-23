import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { type Andamento } from './../src/agendamento/service/compulsorio.service';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

/**
 * O HISTORICO do compulsorio — `GET /agendamentos/compulsorio`.
 *
 * A tela so conhecia o lote que ELA mesma disparou: o `id` do POST vivia na
 * memoria da aba, e a propria tela manda fechar a aba porque o lote leva dezenas
 * de minutos. Fechou, deu F5 ou abriu de outra maquina — tela em branco, com o
 * resultado de uma execucao inteira visivel so no log do servidor.
 *
 * O que esta sob teste, e por que erra calado:
 *
 * - **A ordem e a mais recente primeiro.** A tela abre pela primeira linha; se a
 *   ordem virasse, ela abriria mostrando o lote mais VELHO como se fosse o de
 *   agora — e "1.562 alocados" de uma simulacao antiga passaria por resultado do
 *   lote que acabou de rodar.
 * - **Cada item ja traz a contagem de excecoes**, e as da pagina inteira saem num
 *   `groupBy` so. Contagem trocada entre execucoes e o erro mais caro aqui: e por
 *   ela que se decide abrir sala.
 * - **O `porPagina` tem teto.** Sem ele, uma tela pedindo "todas" montaria a
 *   resposta inteira em memoria.
 * - **`interrompida` vale na lista também**: um lote morto continua
 *   `EM_ANDAMENTO` na tabela, e a lista que o mostrasse como "rodando" faria a
 *   administracao esperar por um lote que nao vai terminar.
 */
describe('Compulsorio — historico de execucoes (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;

  const EMAIL = 'e2e-compulsorio-historico@ucb.br';
  const SENHA = 'senha-do-teste-123';
  const POLO = 'Polo E2E Historico Compulsorio';
  const MATRICULA = 'E2EHIST0001';
  const PERIODO = 'E2E-HIST';

  let alunoId: number;
  /** Da mais antiga para a mais recente — a rota devolve ao contrario. */
  let execucaoIds: number[] = [];

  const api = () => request(app.getHttpServer());
  const comoAdmin = <T extends request.Test>(r: T) =>
    r.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    await limpar();

    await prisma.admin.create({
      data: {
        email: EMAIL,
        senhaHash: await bcrypt.hash(SENHA, 10),
        mustChangePassword: false,
      },
    });

    token = (
      await api()
        .post('/api/auth/login')
        .send({ email: EMAIL, senha: SENHA })
        .expect(200)
    ).body.accessToken;

    const ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });
    const polo = await prisma.polo.create({ data: { nome: POLO } });

    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula: MATRICULA,
        curso: 'CURSO E2E HISTORICO',
        statusCurso: 'Ativo',
        modalidadeId: ead.id,
        poloId: polo.id,
      },
    });
    alunoId = aluno.id;

    // Tres execucoes, criadas em ordem: a simulacao que encontrou gente sem
    // vaga, a repetida depois de abrir sala, e uma que morreu no meio.
    const simulacao = await criarExecucao({
      simulacao: true,
      status: 'CONCLUIDA',
      alocados: 8,
      concluidoEm: new Date(),
    });

    await prisma.excecaoCompulsorio.createMany({
      data: [
        {
          execucaoId: simulacao,
          alunoId,
          matricula: MATRICULA,
          motivo: 'SEM_VAGA',
        },
        {
          execucaoId: simulacao,
          alunoId,
          matricula: MATRICULA,
          motivo: 'SEM_VAGA',
        },
        {
          execucaoId: simulacao,
          alunoId,
          matricula: MATRICULA,
          motivo: 'SEM_CONTA_D2L',
        },
      ],
    });

    const real = await criarExecucao({
      simulacao: false,
      status: 'CONCLUIDA',
      alocados: 10,
      concluidoEm: new Date(),
    });

    await prisma.excecaoCompulsorio.create({
      data: {
        execucaoId: real,
        alunoId,
        matricula: MATRICULA,
        motivo: 'SEM_CONTA_D2L',
      },
    });

    const morta = await criarExecucao({
      simulacao: false,
      status: 'EM_ANDAMENTO',
      alocados: 3,
      // Sem sinal de vida ha muito mais que os 5 min: lote MORTO, nao lento.
      atualizadoEm: new Date(Date.now() - 60 * 60_000),
    });

    execucaoIds = [simulacao, real, morta];
  });

  afterAll(async () => {
    await limpar();
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  async function criarExecucao(dados: {
    simulacao: boolean;
    status: 'EM_ANDAMENTO' | 'CONCLUIDA' | 'FALHOU';
    alocados: number;
    concluidoEm?: Date;
    atualizadoEm?: Date;
  }): Promise<number> {
    const { atualizadoEm, ...resto } = dados;

    const execucao = await prisma.execucaoCompulsorio.create({
      data: {
        ...resto,
        periodoLetivoId: PERIODO,
        rodada: 'N2',
        iniciadoPor: EMAIL,
        totalElegiveis: 10,
        processados: 10,
      },
      select: { id: true },
    });

    if (atualizadoEm) {
      // `@updatedAt` sobrescreve no create; envelhecer exige um update cru.
      await prisma.$executeRaw`UPDATE execucao_compulsorio SET atualizadoEm = ${atualizadoEm} WHERE id = ${execucao.id}`;
    }

    return execucao.id;
  }

  async function limpar() {
    await prisma.excecaoCompulsorio.deleteMany({
      where: { matricula: MATRICULA },
    });
    await prisma.execucaoCompulsorio.deleteMany({
      where: { periodoLetivoId: PERIODO },
    });
    await prisma.alunoImportado.deleteMany({ where: { matricula: MATRICULA } });
    await prisma.polo.deleteMany({ where: { nome: POLO } });
  }

  /**
   * So as execucoes deste teste: o banco do e2e e compartilhado.
   *
   * Tipado com `Andamento` — a linha que a rota realmente devolve — e nao com
   * `{ periodoLetivoId: string }`: com o tipo estreito, o retorno do filtro
   * herdava so esse campo, os testes deixavam de enxergar `id`, `excecoes` e
   * `status`, e o `tsc` recusava o arquivo inteiro.
   */
  const doTeste = (itens: Andamento[]) =>
    itens.filter((i) => i.periodoLetivoId === PERIODO);

  it('lista da mais recente para a mais antiga', async () => {
    const { body } = await comoAdmin(
      api().get('/api/agendamentos/compulsorio').query({ porPagina: 50 }),
    ).expect(200);

    expect(doTeste(body.itens).map((i: { id: number }) => i.id)).toEqual(
      [...execucaoIds].reverse(),
    );
  });

  it('cada linha ja vem com a contagem de excecoes daquela execucao', async () => {
    const { body } = await comoAdmin(
      api().get('/api/agendamentos/compulsorio').query({ porPagina: 50 }),
    ).expect(200);

    const [morta, real, simulacao] = doTeste(body.itens);

    expect(simulacao.excecoes).toEqual({ SEM_VAGA: 2, SEM_CONTA_D2L: 1 });
    // A sala aberta entre uma e outra: o SEM_VAGA sumiu, e e essa comparacao que
    // a lista existe para permitir.
    expect(real.excecoes).toEqual({ SEM_CONTA_D2L: 1 });
    expect(morta.excecoes).toEqual({});
  });

  it('marca como interrompida o lote sem sinal de vida, igual ao acompanhamento', async () => {
    const { body } = await comoAdmin(
      api().get('/api/agendamentos/compulsorio').query({ porPagina: 50 }),
    ).expect(200);

    const [morta] = doTeste(body.itens);

    expect(morta.status).toBe('EM_ANDAMENTO');
    expect(morta.interrompida).toBe(true);

    const individual = await comoAdmin(
      api().get(`/api/agendamentos/compulsorio/${morta.id}`),
    ).expect(200);

    expect(individual.body.interrompida).toBe(true);
  });

  it('pagina, e a pagina 1 e a mais recente', async () => {
    const primeira = await comoAdmin(
      api().get('/api/agendamentos/compulsorio').query({ porPagina: 1 }),
    ).expect(200);

    expect(primeira.body.itens).toHaveLength(1);
    expect(primeira.body.porPagina).toBe(1);
    expect(primeira.body.totalPaginas).toBe(primeira.body.total);
    // A mais recente do banco inteiro — e a primeira linha que a tela abre.
    expect(primeira.body.itens[0].id).toBe(
      (
        await prisma.execucaoCompulsorio.findFirstOrThrow({
          orderBy: { id: 'desc' },
          select: { id: true },
        })
      ).id,
    );

    const segunda = await comoAdmin(
      api()
        .get('/api/agendamentos/compulsorio')
        .query({ porPagina: 1, pagina: 2 }),
    ).expect(200);

    expect(segunda.body.itens[0].id).toBeLessThan(primeira.body.itens[0].id);
  });

  it('nao deixa pedir a tabela inteira numa pagina so', async () => {
    const { body } = await comoAdmin(
      api().get('/api/agendamentos/compulsorio').query({ porPagina: 5000 }),
    ).expect(200);

    expect(body.porPagina).toBe(50);
  });

  it('exige admin', async () => {
    await api().get('/api/agendamentos/compulsorio').expect(401);
  });
});
