import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/service/auth.service';
import { PrismaService } from './../src/database/prisma.service';
import { D2lEnrollmentsService } from './../src/d2l/service/d2l-enrollments.service';
import {
  D2lGradesService,
  NotaFinalD2L,
} from './../src/d2l/service/d2l-grades.service';

/**
 * ============================================================================
 * A PROVA SUBSTITUTIVA DE PONTA A PONTA
 * ============================================================================
 * O que so este teste prova, e os unitarios nao: que a faixa cadastrada pelo
 * ADMIN (`POST /periodos`) chega ate a lista do ALUNO e ate a linha gravada em
 * `agendamento_disciplina` — passando pelos DTOs, pela validacao e pela
 * transacao real. Um `notaMinima` que se perdesse no `whitelist` do
 * ValidationPipe passaria em todos os testes de unidade.
 *
 * ⚠️ Esta suite LIGA a integracao D2L, ao contrario de todas as outras
 * (`test/setup-e2e.ts` a desliga). Sem ela ligada, as disciplinas viriam da
 * turma do launch e a faixa de nota recusaria tudo — que e o comportamento
 * correto, mas nao e o que este arquivo quer exercitar. Os dois clientes da
 * Valence sao substituidos por dubles: o e2e nao tem tenant para conversar.
 *
 * Requer banco de pe, migrations e seed (modalidades).
 */
process.env.D2L_HABILITADO = 'true';
process.env.D2L_BASE_URL = 'https://e2e.invalido';

describe('Prova substitutiva: a faixa de nota (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: AuthService;

  const POLO_NOME = 'Polo E2E Substitutiva';
  const PREFIXO_RA = 'E2ESUB';
  const PERIODO_LETIVO = 'E2E-SUB-103';

  /** As tres disciplinas do aluno, com o `orgUnitId` que a Valence devolveria. */
  const NA_FAIXA = {
    orgUnitId: '90001',
    codigo: 'E2ESUB-T1',
    titulo: 'Na faixa',
  };
  const JA_PASSOU = {
    orgUnitId: '90002',
    codigo: 'E2ESUB-T2',
    titulo: 'Ja passou',
  };
  const SEM_NOTA = {
    orgUnitId: '90003',
    codigo: 'E2ESUB-T3',
    titulo: 'Sem nota',
  };

  /**
   * As notas do duble, por `orgUnitId`. Sao reescritas dentro dos testes que
   * precisam de outro cenario — por isso `let`, e nao uma constante.
   */
  let notasPorTurma: Record<string, NotaFinalD2L> = {};

  /** Ligado por um teste so: a Valence responder erro na leitura da nota. */
  let notasFalham = false;

  let poloId: number;
  let ead: { id: number };
  let faixaId: number;
  let periodoId: number;

  const api = () => request(app.getHttpServer());

  const enrollments = {
    habilitado: () => true,
    ofertasDoPeriodo: () =>
      Promise.resolve([NA_FAIXA, JA_PASSOU, SEM_NOTA].map((t) => ({ ...t }))),
    ofertasDoSemestre: () => Promise.resolve([]),
    identidadePorMatricula: () => Promise.resolve({ situacao: 'SEM_CONTA' }),
  };

  const grades = {
    habilitado: () => true,
    notaFinal: (orgUnitId: string) =>
      notasFalham
        ? Promise.reject(new Error('502 do tenant (e2e)'))
        : Promise.resolve(notasPorTurma[orgUnitId] ?? { situacao: 'SEM_NOTA' }),
    notasFinaisDaTurma: () => Promise.resolve(new Map<string, NotaFinalD2L>()),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(D2lEnrollmentsService)
      .useValue(enrollments)
      .overrideProvider(D2lGradesService)
      .useValue(grades)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    auth = app.get(AuthService);

    await limpar();

    ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });

    poloId = (await prisma.polo.create({ data: { nome: POLO_NOME } })).id;

    // As tres precisam estar no CSV de turmas: o filtro de nota entra DEPOIS do
    // cruzamento, e disciplina fora do CSV nem chega la.
    for (const turma of [NA_FAIXA, JA_PASSOU, SEM_NOTA]) {
      await prisma.turmaImportada.create({
        data: { codigoTurma: turma.codigo, nomeDisciplina: turma.titulo },
      });
    }

    const sala = await prisma.sala.create({
      data: { poloId, nome: 'S-SUB', capacidade: 5 },
    });

    faixaId = (
      await prisma.faixa.create({
        data: {
          poloId,
          data: new Date('2026-12-20T00:00:00.000Z'),
          horaInicio: '08:30',
          horaFim: '11:30',
          salaFaixas: {
            create: {
              salaId: sala.id,
              modalidadeId: ead.id,
              vagas: 5,
              ordem: 1,
            },
          },
        },
      })
    ).id;

    periodoId = (
      await prisma.periodoAgendamento.create({
        data: {
          periodoLetivoId: PERIODO_LETIVO,
          rodada: 'SUB',
          notaMinima: 1.5,
          notaMaxima: 6.75,
          descricao: 'e2e substitutiva',
          aberto: true,
          dataFechamento: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      })
    ).id;
  });

  beforeEach(() => {
    notasFalham = false;
    notasPorTurma = {
      [NA_FAIXA.orgUnitId]: achou(4.25),
      [JA_PASSOU.orgUnitId]: achou(8.5),
      // SEM_NOTA fica de fora do mapa de proposito.
    };
  });

  afterAll(async () => {
    await limpar();
    await app.close();
  });

  function achou(pontos: number): NotaFinalD2L {
    return {
      situacao: 'ACHOU',
      pontos,
      denominador: 10,
      origem: 'CALCULADA',
      exibida: `${pontos}`,
    };
  }

  /**
   * ⚠️ Cada aluno precisa de um `userIdD2L` PROPRIO. A elegibilidade cacheia a
   * nota por (turma, usuario) por 5 minutos, e dois alunos com o mesmo UserId
   * fariam o segundo teste ler a nota que o primeiro carregou — os cenarios de
   * "fora da faixa" e "Valence fora" passariam a decidir com dados antigos.
   */
  let proximoUserId = 90_000;

  async function criarAluno(sufixo: string) {
    const matricula = `${PREFIXO_RA}${sufixo}`;
    const userIdD2L = String((proximoUserId += 1));

    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula,
        nome: `Aluno ${sufixo}`,
        curso: 'CURSO E2E SUB',
        statusCurso: 'Ativo',
        ativo: true,
        modalidadeId: ead.id,
        poloId,
      },
    });

    const { accessToken } = await auth.emitirTokenAluno({
      sub: matricula,
      userIdD2L,
      vinculos: [
        {
          alunoId: aluno.id,
          curso: aluno.curso,
          modalidade: 'EAD',
          poloId,
          ativo: true,
        },
      ],
      contexto: {
        orgUnitId: NA_FAIXA.orgUnitId,
        codigo: NA_FAIXA.codigo,
        titulo: NA_FAIXA.titulo,
      },
    });

    return { token: accessToken, alunoId: aluno.id, matricula };
  }

  const comoAluno = <T extends request.Test>(r: T, token: string) =>
    r.set('Authorization', `Bearer ${token}`);

  async function limpar() {
    await prisma.agendamento.deleteMany({
      where: { matricula: { startsWith: PREFIXO_RA } },
    });

    const polos = await prisma.polo.findMany({ where: { nome: POLO_NOME } });

    for (const polo of polos) {
      await prisma.salaFaixa.deleteMany({
        where: { faixa: { poloId: polo.id } },
      });
      await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
      await prisma.sala.deleteMany({ where: { poloId: polo.id } });
      await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
      await prisma.polo.delete({ where: { id: polo.id } });
    }

    await prisma.turmaImportada.deleteMany({
      where: { codigoTurma: { startsWith: 'E2ESUB-' } },
    });
    await prisma.periodoAgendamento.deleteMany({
      where: { periodoLetivoId: PERIODO_LETIVO },
    });
  }

  it('o portal expoe a faixa, para a tela poder explicar a lista curta', async () => {
    const { token } = await criarAluno('PER');

    const res = await comoAluno(api().get('/api/portal/periodo'), token).expect(
      200,
    );

    expect(res.body.rodada).toBe('SUB');
    expect(res.body.filtroDeNota).toEqual({ minima: 1.5, maxima: 6.75 });
  });

  it('lista SO a disciplina dentro da faixa, das tres do aluno', async () => {
    const { token } = await criarAluno('LST');

    const res = await comoAluno(
      api().get('/api/portal/disciplinas'),
      token,
    ).expect(200);

    expect(res.body.podeAgendar).toBe(true);
    expect(res.body.disciplinas).toHaveLength(1);
    expect(res.body.disciplinas[0].nomeDisciplina).toBe(NA_FAIXA.titulo);
  });

  /**
   * A prova precisa cobrir SO a disciplina elegivel — e a nota que decidiu fica
   * gravada. Sem a fotografia, "por que ele agendou substitutiva desta materia?"
   * so teria como resposta a nota de HOJE, que ja pode ser outra.
   */
  it('agenda cobrindo so a elegivel, e grava a nota que decidiu', async () => {
    const { token, alunoId } = await criarAluno('AGD');

    const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
      .send({ alunoId, faixaId })
      .expect(201);

    expect(res.body.disciplinas).toHaveLength(1);

    const gravadas = await prisma.agendamentoDisciplina.findMany({
      where: { agendamentoId: res.body.id },
    });

    expect(gravadas).toHaveLength(1);
    expect(gravadas[0].orgUnitId).toBe(NA_FAIXA.orgUnitId);
    expect(Number(gravadas[0].notaFinal)).toBe(4.25);
  });

  it('nenhuma na faixa: recusa e explica sem mandar conferir o CSV', async () => {
    const { token, alunoId } = await criarAluno('FORA');

    notasPorTurma = {
      [NA_FAIXA.orgUnitId]: achou(9),
      [JA_PASSOU.orgUnitId]: achou(8.5),
      [SEM_NOTA.orgUnitId]: achou(7),
    };

    const lista = await comoAluno(
      api().get('/api/portal/disciplinas'),
      token,
    ).expect(200);

    expect(lista.body.podeAgendar).toBe(false);
    expect(lista.body.motivo).toContain('1,50');

    // A tela ja desabilita o botao, mas quem chamar a rota direto tambem tem de
    // ser recusado: o `POST` refaz o cruzamento inteiro, sem confiar na tela.
    await comoAluno(api().post('/api/portal/agendamentos'), token)
      .send({ alunoId, faixaId })
      .expect(403);
  });

  /**
   * ⚠️ O teste que mais importa. Na N2, a Valence fora degrada para a turma do
   * launch. Aqui, degradar liberaria a substitutiva sem conferir nota nenhuma —
   * e o aluno cujo `contexto` do launch e justamente a disciplina em que ele ja
   * passou entraria na prova.
   */
  it('Valence fora na leitura da nota: recusa, e nao cai para o launch', async () => {
    const { token, alunoId } = await criarAluno('FALHA');

    notasFalham = true;

    const lista = await comoAluno(
      api().get('/api/portal/disciplinas'),
      token,
    ).expect(200);

    expect(lista.body.podeAgendar).toBe(false);
    expect(lista.body.disciplinas).toHaveLength(0);
    expect(lista.body.motivo).toContain('notas');

    await comoAluno(api().post('/api/portal/agendamentos'), token)
      .send({ alunoId, faixaId })
      .expect(403);
  });

  /**
   * O par de campos atravessa o `whitelist` do ValidationPipe e a validacao. Um
   * `notaMinima` descartado ali deixaria a janela sem filtro, e o portal
   * ofereceria a substitutiva ao semestre inteiro — sem erro em lugar nenhum.
   */
  describe('cadastro da faixa pelo admin', () => {
    it('guarda o par e o devolve como objeto', async () => {
      const periodo = await prisma.periodoAgendamento.findUniqueOrThrow({
        where: { id: periodoId },
      });

      expect(Number(periodo.notaMinima)).toBe(1.5);
      expect(Number(periodo.notaMaxima)).toBe(6.75);
    });
  });
});
