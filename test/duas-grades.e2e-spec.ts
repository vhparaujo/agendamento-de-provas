import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/service/auth.service';
import { PrismaService } from './../src/database/prisma.service';
import { D2lEnrollmentsService } from './../src/d2l/service/d2l-enrollments.service';

/**
 * ============================================================================
 * DUAS GRADES NA MESMA JANELA — modulos e semestres ao mesmo tempo
 * ============================================================================
 * A UCB divide o ano de duas formas simultaneas: EaD/Semi/Modular andam por
 * MODULO (quatro por ano) e Presencial anda por SEMESTRE (dois). No Brightspace
 * isso sao dois org units de Periodo Letivo DIFERENTES e vivos ao mesmo tempo —
 * em novembro de 2026 o aluno EaD esta sob 2026/4 e o presencial sob 2026/2.
 *
 * O que so este arquivo prova, e os unitarios nao:
 *
 * 1. o mapa cadastrado pelo ADMIN (`POST /periodos`) chega ate a arvore que a
 *    Valence consulta para CADA aluno — atravessando DTO, ValidationPipe e a
 *    resolucao por modalidade;
 * 2. os dois alunos agendam na MESMA janela e cada reserva grava o org unit da
 *    grade dele;
 * 3. **a trava por PESSOA continua valendo ATRAVES das duas grades.** E o ponto
 *    que mais pode quebrar em silencio: um RA com um vinculo EaD e um Presencial
 *    tem as duas reservas sob org units diferentes, e uma trava que recortasse
 *    pelo periodo de um vinculo so nao enxergaria a do outro — a pessoa sairia
 *    com duas provas no mesmo horario, em duas salas.
 *
 * ⚠️ Como a suite da substitutiva, esta LIGA a integracao D2L (o
 * `test/setup-e2e.ts` a desliga) e substitui o cliente da Valence por um duble:
 * o e2e nao tem tenant para conversar. O duble e o coracao do teste — ele
 * devolve ofertas DIFERENTES para cada periodo letivo, que e exatamente o que o
 * Brightspace faz.
 *
 * Requer banco de pe, migrations e seed (modalidades).
 */
process.env.D2L_HABILITADO = 'true';
process.env.D2L_BASE_URL = 'https://e2e.invalido';

describe('Duas grades na mesma janela (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: AuthService;

  const POLO_NOME = 'Polo E2E Duas Grades';
  const PREFIXO_RA = 'E2E2G';
  const EMAIL_ADMIN = 'e2e-duas-grades@ucb.br';
  const SENHA_ADMIN = 'DuasGrades!2026';

  /** O modulo 2026/4 — onde vivem EaD, Semi e Modular. */
  const LETIVO_MODULAR = 'E2E-2G-MODULO';
  /** O semestre 2026/2 — onde vive o Presencial. */
  const LETIVO_SEMESTRAL = 'E2E-2G-SEMESTRE';

  const TURMA_EAD = {
    orgUnitId: '95001',
    codigo: 'E2E2G-EAD',
    titulo: 'Disciplina do modulo',
  };
  const TURMA_PRESENCIAL = {
    orgUnitId: '95002',
    codigo: 'E2E2G-PRE',
    titulo: 'Disciplina do semestre',
  };

  /**
   * O duble da Valence, e a peca central: as ofertas dependem do
   * `periodoLetivoId` pedido, do mesmo jeito que os descendentes de um org unit
   * dependem de qual org unit e. Um duble que ignorasse o parametro faria o
   * teste passar mesmo com o mapa sendo desprezado pelo service.
   */
  const OFERTAS: Record<
    string,
    { orgUnitId: string; codigo: string; titulo: string }[]
  > = {
    [LETIVO_MODULAR]: [TURMA_EAD],
    [LETIVO_SEMESTRAL]: [TURMA_PRESENCIAL],
  };

  /** Quais periodos letivos foram consultados, em ordem. */
  let periodosConsultados: string[] = [];

  const enrollments = {
    habilitado: () => true,
    ofertasDoPeriodo: (_userIdD2L: string, periodoLetivoId: string) => {
      periodosConsultados.push(periodoLetivoId);
      return Promise.resolve(
        (OFERTAS[periodoLetivoId] ?? []).map((t) => ({ ...t })),
      );
    },
    ofertasDoSemestre: (periodoLetivoId: string) =>
      Promise.resolve((OFERTAS[periodoLetivoId] ?? []).map((t) => ({ ...t }))),
    identidadePorMatricula: () => Promise.resolve({ situacao: 'SEM_CONTA' }),
  };

  let poloId: number;
  let ead: { id: number };
  let presencial: { id: number };
  /** UMA faixa, com oferta para as DUAS modalidades — e o palco da trava. */
  let faixaId: number;
  let outraFaixaId: number;

  const api = () => request(app.getHttpServer());

  const comoAluno = <T extends request.Test>(r: T, token: string) =>
    r.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(D2lEnrollmentsService)
      .useValue(enrollments)
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

    await prisma.admin.upsert({
      where: { email: EMAIL_ADMIN },
      update: {},
      create: {
        email: EMAIL_ADMIN,
        senhaHash: await bcrypt.hash(SENHA_ADMIN, 10),
        mustChangePassword: false,
      },
    });

    tokenAdmin = (
      await api()
        .post('/api/auth/login')
        .send({ email: EMAIL_ADMIN, senha: SENHA_ADMIN })
        .expect(200)
    ).body.accessToken;

    ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });
    presencial = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'PRESENCIAL' },
    });

    poloId = (await prisma.polo.create({ data: { nome: POLO_NOME } })).id;

    // As duas turmas no CSV: o filtro do periodo letivo entra ANTES do
    // cruzamento, e disciplina fora do CSV nao vira prova de qualquer jeito.
    for (const turma of [TURMA_EAD, TURMA_PRESENCIAL]) {
      await prisma.turmaImportada.create({
        data: { codigoTurma: turma.codigo, nomeDisciplina: turma.titulo },
      });
    }

    // DUAS salas: dentro de uma faixa a sala fica travada numa modalidade
    // (`sala_faixa_salaId_faixaId_key`), entao a mesma faixa so atende as duas
    // grades com uma sala para cada.
    const salaEad = await prisma.sala.create({
      data: { poloId, nome: 'S-2G-EAD', capacidade: 10 },
    });

    const salaPresencial = await prisma.sala.create({
      data: { poloId, nome: 'S-2G-PRE', capacidade: 10 },
    });

    // A MESMA faixa oferece as duas modalidades — e o que permite ao mesmo RA
    // tentar marcar as duas provas no mesmo horario.
    faixaId = (
      await prisma.faixa.create({
        data: {
          poloId,
          data: new Date('2026-12-21T00:00:00.000Z'),
          horaInicio: '08:30',
          horaFim: '11:30',
          salaFaixas: {
            create: [
              { salaId: salaEad.id, modalidadeId: ead.id, vagas: 5, ordem: 1 },
              {
                salaId: salaPresencial.id,
                modalidadeId: presencial.id,
                vagas: 5,
                ordem: 1,
              },
            ],
          },
        },
      })
    ).id;

    outraFaixaId = (
      await prisma.faixa.create({
        data: {
          poloId,
          data: new Date('2026-12-22T00:00:00.000Z'),
          horaInicio: '14:00',
          horaFim: '17:00',
          salaFaixas: {
            create: [
              {
                salaId: salaPresencial.id,
                modalidadeId: presencial.id,
                vagas: 5,
                ordem: 1,
              },
            ],
          },
        },
      })
    ).id;

    await criarJanelaComMapa();
  });

  beforeEach(() => {
    periodosConsultados = [];
  });

  /**
   * A janela e criada UMA vez, no `beforeAll` abaixo: `POST /periodos` recusa o
   * par `periodoLetivoId + rodada` repetido do vigente, e cada teste recria-la
   * bateria em 409. Ela e a mesma para todos — o que muda de teste para teste
   * sao os alunos.
   */

  afterAll(async () => {
    await limpar();
    await app.close();
  });

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
      where: { codigoTurma: { startsWith: 'E2E2G-' } },
    });

    // O mapa sai junto pelo `onDelete: Cascade`.
    await prisma.periodoAgendamento.deleteMany({
      where: { periodoLetivoId: { in: [LETIVO_MODULAR, LETIVO_SEMESTRAL] } },
    });
  }

  /**
   * A janela com o mapa, criada pela ROTA e nao pelo Prisma: o que este arquivo
   * quer provar comeca no DTO. Um `letivosPorModalidade` que o `whitelist` do
   * ValidationPipe descartasse passaria em todo teste de unidade.
   */
  async function criarJanelaComMapa(): Promise<number> {
    const { token } = comoAdmin();

    const res = await api()
      .post('/api/periodos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        periodoLetivoId: LETIVO_MODULAR,
        rodada: 'N2',
        descricao: 'e2e duas grades',
        aberto: true,
        dataFechamento: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        letivosPorModalidade: [
          { modalidadeCodigo: 'EAD', periodoLetivoId: LETIVO_MODULAR },
          { modalidadeCodigo: 'SEMI', periodoLetivoId: LETIVO_MODULAR },
          { modalidadeCodigo: 'MODULAR', periodoLetivoId: LETIVO_MODULAR },
          { modalidadeCodigo: 'PRESENCIAL', periodoLetivoId: LETIVO_SEMESTRAL },
        ],
      })
      .expect(201);

    return res.body.id as number;
  }

  /** O token do admin, emitido uma vez pelo login real e reusado. */
  let tokenAdmin: string;

  function comoAdmin() {
    return { token: tokenAdmin, email: EMAIL_ADMIN };
  }

  let proximoUserId = 95_000;

  /**
   * Cria um vinculo e devolve o token dele.
   *
   * `matricula` e parametro para o teste da trava por pessoa: la os DOIS
   * vinculos precisam do mesmo RA (e do mesmo `userIdD2L`, porque a Valence
   * conhece a PESSOA, nao o curso).
   */
  async function criarVinculo(opcoes: {
    sufixo: string;
    modalidade: 'EAD' | 'PRESENCIAL';
    matricula?: string;
    userIdD2L?: string;
  }) {
    const matricula = opcoes.matricula ?? `${PREFIXO_RA}${opcoes.sufixo}`;
    const userIdD2L = opcoes.userIdD2L ?? String((proximoUserId += 1));

    const modalidadeId = opcoes.modalidade === 'EAD' ? ead.id : presencial.id;

    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula,
        nome: `Aluno ${opcoes.sufixo}`,
        curso: `CURSO ${opcoes.modalidade}`,
        statusCurso: 'Ativo',
        ativo: true,
        modalidadeId,
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
          modalidade: opcoes.modalidade,
          poloId,
          ativo: true,
        },
      ],
    });

    return { token: accessToken, alunoId: aluno.id, matricula, userIdD2L };
  }

  // ==========================================================================

  it('grava o mapa completo e o devolve na listagem do admin', async () => {
    const { token } = comoAdmin();

    const res = await api()
      .get('/api/periodos')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const janela = res.body.find(
      (p: { periodoLetivoId: string }) => p.periodoLetivoId === LETIVO_MODULAR,
    );

    expect(janela.letivosPorModalidade).toHaveLength(4);

    const linhas = janela.letivosPorModalidade as {
      modalidadeCodigo: string;
      periodoLetivoId: string;
      herdadoDoPrincipal: boolean;
    }[];

    const porCodigo = Object.fromEntries(
      linhas.map((l) => [l.modalidadeCodigo, l.periodoLetivoId]),
    );

    expect(porCodigo).toEqual({
      EAD: LETIVO_MODULAR,
      SEMI: LETIVO_MODULAR,
      MODULAR: LETIVO_MODULAR,
      PRESENCIAL: LETIVO_SEMESTRAL,
    });

    // Nenhuma modalidade caiu no fallback: o mapa veio inteiro do cadastro.
    expect(linhas.every((l) => !l.herdadoDoPrincipal)).toBe(true);
  });

  it('recusa o mapa que deixa uma modalidade de fora, nomeando qual', async () => {
    const { token } = comoAdmin();

    const res = await api()
      .post('/api/periodos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        periodoLetivoId: LETIVO_MODULAR,
        // Rodada diferente da janela vigente: assim a recusa so pode ser do
        // MAPA. Com o par repetido, um 409 de duplicata mascararia o 400.
        rodada: 'SUB',
        dataFechamento: new Date(Date.now() + 86_400_000).toISOString(),
        letivosPorModalidade: [
          { modalidadeCodigo: 'EAD', periodoLetivoId: LETIVO_MODULAR },
        ],
      })
      .expect(400);

    // A frase precisa dizer QUAIS faltam: a modalidade esquecida cairia no
    // principal em silencio, e um periodo letivo errado nao da erro nenhum —
    // so lista vazia de disciplina para a modalidade inteira.
    expect(res.body.message).toMatch(/SEMI/);
    expect(res.body.message).toMatch(/PRESENCIAL/);
  });

  it('cada aluno busca disciplina na arvore da SUA grade', async () => {
    const aluno = await criarVinculo({ sufixo: 'EAD', modalidade: 'EAD' });
    const outro = await criarVinculo({
      sufixo: 'PRE',
      modalidade: 'PRESENCIAL',
    });

    const doEad = await comoAluno(
      api().get('/api/portal/disciplinas'),
      aluno.token,
    ).expect(200);

    const doPresencial = await comoAluno(
      api().get('/api/portal/disciplinas'),
      outro.token,
    ).expect(200);

    // O ponto do arquivo inteiro: os dois recebem lista NAO VAZIA, e listas
    // diferentes. Antes do mapa, cadastrar 2026/4 deixava o presencial sem
    // disciplina nenhuma — e cadastrar 2026/2 fazia o inverso.
    expect(doEad.body.podeAgendar).toBe(true);
    expect(doEad.body.disciplinas).toHaveLength(1);
    expect(doEad.body.disciplinas[0].orgUnitId).toBe(TURMA_EAD.orgUnitId);

    expect(doPresencial.body.podeAgendar).toBe(true);
    expect(doPresencial.body.disciplinas).toHaveLength(1);
    expect(doPresencial.body.disciplinas[0].orgUnitId).toBe(
      TURMA_PRESENCIAL.orgUnitId,
    );

    // E a Valence foi consultada nos DOIS org units, cada um uma vez.
    expect(periodosConsultados).toContain(LETIVO_MODULAR);
    expect(periodosConsultados).toContain(LETIVO_SEMESTRAL);
  });

  it('a reserva grava o periodo letivo da grade do aluno', async () => {
    const aluno = await criarVinculo({ sufixo: 'GEA', modalidade: 'EAD' });
    const outro = await criarVinculo({
      sufixo: 'GPR',
      modalidade: 'PRESENCIAL',
    });

    await comoAluno(api().post('/api/portal/agendamentos'), aluno.token)
      .send({ faixaId })
      .expect(201);

    await comoAluno(api().post('/api/portal/agendamentos'), outro.token)
      .send({ faixaId })
      .expect(201);

    const reservas = await prisma.agendamento.findMany({
      where: { matricula: { in: [aluno.matricula, outro.matricula] } },
      select: { matricula: true, periodoLetivoId: true, rodada: true },
    });

    expect(
      reservas.find((r) => r.matricula === aluno.matricula)?.periodoLetivoId,
    ).toBe(LETIVO_MODULAR);

    expect(
      reservas.find((r) => r.matricula === outro.matricula)?.periodoLetivoId,
    ).toBe(LETIVO_SEMESTRAL);

    // A rodada e a MESMA: e uma janela so, com dois org units.
    expect(reservas.map((r) => r.rodada)).toEqual(['N2', 'N2']);
  });

  /**
   * ========================================================================
   * A TRAVA POR PESSOA, ATRAVESSANDO AS DUAS GRADES
   * ========================================================================
   * O caso que motivou metade da mudanca. As duas reservas deste RA ficam sob
   * org units DIFERENTES, e a trava recorta pela JANELA inteira justamente para
   * enxergar as duas. Se ela recortasse pelo periodo do vinculo que esta
   * agendando, o segundo POST passaria — e a pessoa estaria em duas salas as
   * 08:30 do dia 21.
   */
  it('o mesmo RA nao marca duas provas no mesmo horario, mesmo em grades diferentes', async () => {
    const matricula = `${PREFIXO_RA}DUPLO`;
    const userIdD2L = String((proximoUserId += 1));

    const vinculoEad = await criarVinculo({
      sufixo: 'DUPLO-EAD',
      modalidade: 'EAD',
      matricula,
      userIdD2L,
    });

    const vinculoPresencial = await criarVinculo({
      sufixo: 'DUPLO-PRE',
      modalidade: 'PRESENCIAL',
      matricula,
      userIdD2L,
    });

    await comoAluno(api().post('/api/portal/agendamentos'), vinculoEad.token)
      .send({ faixaId })
      .expect(201);

    const recusa = await comoAluno(
      api().post('/api/portal/agendamentos'),
      vinculoPresencial.token,
    )
      .send({ faixaId })
      .expect(409);

    expect(recusa.body.message).toMatch(/ja tem prova marcada neste horario/i);

    // ...e a tela precisa dizer o MESMO, senao o aluno so descobre no clique.
    // O espelho tem que ser exato: uma faixa a menos e ele bate no 409; uma a
    // mais e a tela esconde um horario que ele podia ter.
    const faixas = await comoAluno(
      api().get('/api/portal/faixas'),
      vinculoPresencial.token,
    ).expect(200);

    const bloqueada = faixas.body.find(
      (f: { faixaId: number }) => f.faixaId === faixaId,
    );

    expect(bloqueada.conflitaComOutraProva).toBe(true);

    // A OUTRA faixa continua livre: a trava e por horario, nao por pessoa.
    const livre = faixas.body.find(
      (f: { faixaId: number }) => f.faixaId === outraFaixaId,
    );

    expect(livre.conflitaComOutraProva).toBe(false);

    // E ele consegue marcar nela — o segundo vinculo tem prova, em outro dia.
    await comoAluno(
      api().post('/api/portal/agendamentos'),
      vinculoPresencial.token,
    )
      .send({ faixaId: outraFaixaId })
      .expect(201);
  });

  /**
   * A exportacao e UMA lista: a cobranca mistura EaD e Presencial. Recortar por
   * um periodo letivo faria os presenciais sairem TODOS como "Nao Agendado" —
   * e entrarem na cobranca depois de ja terem feito a prova.
   */
  it('a exportacao do admin cobre as duas grades numa consulta so', async () => {
    const aluno = await criarVinculo({ sufixo: 'XEA', modalidade: 'EAD' });
    const outro = await criarVinculo({
      sufixo: 'XPR',
      modalidade: 'PRESENCIAL',
    });

    await comoAluno(api().post('/api/portal/agendamentos'), aluno.token)
      .send({ faixaId })
      .expect(201);

    await comoAluno(api().post('/api/portal/agendamentos'), outro.token)
      .send({ faixaId })
      .expect(201);

    const { token } = comoAdmin();

    const csv = await api()
      .get('/api/agendamentos/exportacao')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const linhas = String(csv.text)
      .split('\n')
      .filter(
        (l) => l.includes(aluno.matricula) || l.includes(outro.matricula),
      );

    expect(linhas).toHaveLength(2);
    // Nenhum dos dois pode sair como "Nao Agendado".
    expect(linhas.every((l) => !/N.o Agendado/.test(l))).toBe(true);
  });

  /**
   * A tela manda a JANELA INTEIRA no `periodoLetivoId` (lista separada por
   * virgula), e nao so o principal.
   *
   * Sem isso o filtro esconderia os presenciais em silencio — e no caso da lista
   * de presenca o sintoma so apareceria no dia da prova, com a sala cheia e a
   * folha em branco na mao do fiscal.
   */
  it('o filtro por periodo aceita a janela inteira e traz as duas grades', async () => {
    const aluno = await criarVinculo({ sufixo: 'FEA', modalidade: 'EAD' });
    const outro = await criarVinculo({
      sufixo: 'FPR',
      modalidade: 'PRESENCIAL',
    });

    await comoAluno(api().post('/api/portal/agendamentos'), aluno.token)
      .send({ faixaId })
      .expect(201);

    await comoAluno(api().post('/api/portal/agendamentos'), outro.token)
      .send({ faixaId })
      .expect(201);

    const { token } = comoAdmin();
    const janela = `${LETIVO_MODULAR},${LETIVO_SEMESTRAL}`;

    const ambas = await api()
      .get('/api/agendamentos')
      .query({ periodoLetivoId: janela, rodada: 'N2', busca: PREFIXO_RA })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const matriculas = (ambas.body.itens as { matricula: string }[]).map(
      (i) => i.matricula,
    );

    expect(matriculas).toContain(aluno.matricula);
    expect(matriculas).toContain(outro.matricula);

    // E um id sozinho continua recortando SO aquela grade — o admin que quiser
    // uma delas nao perdeu essa possibilidade.
    const soPresencial = await api()
      .get('/api/agendamentos')
      .query({
        periodoLetivoId: LETIVO_SEMESTRAL,
        rodada: 'N2',
        busca: PREFIXO_RA,
      })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const soPre = (soPresencial.body.itens as { matricula: string }[]).map(
      (i) => i.matricula,
    );

    expect(soPre).toContain(outro.matricula);
    expect(soPre).not.toContain(aluno.matricula);
  });
});
