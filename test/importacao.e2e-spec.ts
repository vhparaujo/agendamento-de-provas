import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { PeriodoService } from './../src/periodo/service/periodo.service';

/**
 * Importacao ponta a ponta. Os CSVs reais ficam fora do repositorio (dados de
 * aluno); os testes que dependem deles sao pulados se nao estiverem presentes.
 */
const CSV_REAIS = {
  EAD: '/Users/vhparaujo/Desktop/EaD - Dados(EaD).csv',
  SEMI: '/Users/vhparaujo/Desktop/EaD - Dados(Semi).csv',
  MODULAR: '/Users/vhparaujo/Desktop/EaD - Dados(Modular).csv',
};

const temCsvReais = Object.values(CSV_REAIS).every((p) => existsSync(p));
const seTemCsvReais = temCsvReais ? describe : describe.skip;

describe('Importacao de CSVs (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;

  const EMAIL = 'e2e-import@ucb.br';
  const SENHA = 'senha-do-teste-123';

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
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await prisma.admin.create({
      data: {
        email: EMAIL,
        senhaHash: await bcrypt.hash(SENHA, 10),
        mustChangePassword: false,
      },
    });

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: EMAIL, senha: SENHA })
      .expect(200);

    token = login.body.accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  const enviarAlunos = (caminho: string, modalidade: string) =>
    request(app.getHttpServer())
      .post('/api/importacao/alunos')
      .set('Authorization', `Bearer ${token}`)
      .field('modalidade', modalidade)
      .attach('arquivo', readFileSync(caminho), {
        filename: caminho.split('/').pop(),
        contentType: 'text/csv',
      });

  describe('protecao e validacao', () => {
    it('exige autenticacao de admin', async () => {
      await request(app.getHttpServer())
        .post('/api/importacao/alunos')
        .expect(401);
    });

    it('recusa formato invalido', async () => {
      await request(app.getHttpServer())
        .post('/api/importacao/alunos')
        .set('Authorization', `Bearer ${token}`)
        .field('modalidade', 'INVENTADA')
        .attach('arquivo', Buffer.from('RA\nUC1\n'), 'x.csv')
        .expect(400);
    });

    it('recusa arquivo que nao seja .csv', async () => {
      await request(app.getHttpServer())
        .post('/api/importacao/alunos')
        .set('Authorization', `Bearer ${token}`)
        .field('modalidade', 'EAD')
        .attach('arquivo', Buffer.from('RA\nUC1\n'), 'planilha.xlsx')
        .expect(400);
    });

    it('recusa CSV sem as colunas obrigatorias, dizendo quais faltam', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/importacao/alunos')
        .set('Authorization', `Bearer ${token}`)
        .field('modalidade', 'EAD')
        .attach('arquivo', Buffer.from('RA,ALUNO\nUC1,MARIA\n'), 'x.csv')
        .expect(400);

      expect(res.body.message).toMatch(/CAMPUS/);
    });
  });

  describe('turmas (formato real: Curso;Codigo da Turma;Disciplina)', () => {
    const subir = (nome: string) =>
      request(app.getHttpServer())
        .post('/api/importacao/turmas')
        .set('Authorization', `Bearer ${token}`)
        .attach(
          'arquivo',
          readFileSync(join(__dirname, 'fixtures', nome)),
          nome,
        );

    afterEach(async () => {
      await prisma.turmaImportada.deleteMany({
        where: { codigoTurma: { startsWith: 'E2E' } },
      });
    });

    it('importa a fixture de exemplo e e idempotente', async () => {
      const primeira = await subir('turmas-exemplo.csv').expect(201);

      expect(primeira.body.totalLinhas).toBe(4);
      expect(primeira.body.rejeitadas).toEqual([]);
      expect(primeira.body.criadas).toBe(4);

      // A 3a coluna traz nome e codigo da disciplina na MESMA celula; a
      // importacao separa os dois e TIRA o prefixo do sistema de origem ("1-"),
      // que nao aparece no `Code` do Brightspace. Arquivo separado por ";".
      const turma = await prisma.turmaImportada.findFirstOrThrow({
        where: {
          codigoTurma: 'E2EFIX0001',
          nomeDisciplina: { contains: 'HIST' },
        },
      });
      expect(turma.nomeDisciplina).toBe('HISTÓRIA E CULTURA DO CORPO');
      expect(turma.codigoEad).toBe('E2EFIX02EAD003');
      // o CSV nao traz orgUnitId — ele so aparece quando um aluno faz launch
      expect(turma.orgUnitId).toBeNull();

      // Duas disciplinas sob o MESMO codigo de turma convivem: a chave e o PAR.
      const mesmoCodigo = await prisma.turmaImportada.findMany({
        where: { codigoTurma: 'E2EFIX0001' },
      });
      expect(mesmoCodigo).toHaveLength(2);
      expect(mesmoCodigo.map((t) => t.codigoEad).sort()).toEqual([
        'E2EFIX02EAD003',
        'E2EFIX02TP001',
      ]);

      // Celula sem parenteses: nome inteiro, sem codigo de disciplina.
      const semParentese = await prisma.turmaImportada.findFirstOrThrow({
        where: { codigoTurma: 'E2EFIX0003' },
      });
      expect(semParentese.nomeDisciplina).toBe('SAÚDE COLETIVA');
      expect(semParentese.codigoEad).toBeNull();

      // reenviar nao duplica: tudo vira atualizacao
      const segunda = await subir('turmas-exemplo.csv').expect(201);
      expect(segunda.body.criadas).toBe(0);
      expect(segunda.body.atualizadas).toBe(4);
    });

    it('rejeita as linhas ruins sem derrubar a boa', async () => {
      const res = await subir('turmas-invalidas.csv').expect(201);

      // linha 1: sem codigo · 2: sem disciplina · 4: repete o par da linha 3
      expect(res.body.rejeitadas.map((r: any) => r.linha)).toEqual([1, 2, 4]);
      expect(res.body.rejeitadas[0].motivo).toMatch(/código da turma/);
      expect(res.body.rejeitadas[2].motivo).toMatch(/repetida/);

      // uma planilha com erro nao trava a importacao inteira
      expect(res.body.criadas).toBe(1);
      const gravadas = await prisma.turmaImportada.findMany({
        where: { codigoTurma: { startsWith: 'E2EBAD' } },
      });
      expect(gravadas.map((t) => t.codigoTurma)).toEqual(['E2EBAD0002']);
    });

    it('recusa arquivo sem a coluna "Codigo da Turma"', async () => {
      const res = await subir('turmas-sem-coluna.csv').expect(400);

      expect(res.body.message).toMatch(/Código da Turma/);
    });
  });

  /**
   * O aviso de troca com prova marcada.
   *
   * Formato e polo sao os dois campos que a importacao troca POR BAIXO de uma
   * reserva confirmada sem que nada mais reclame — a reserva continua na sala
   * antiga, com outra duracao ou em outro campus. Aqui se prova que a
   * importacao passou a dizer isso em voz alta, e que nao grita a toa.
   */
  describe('aviso: troca de formato/polo em quem ja tem prova marcada', () => {
    const RA = 'E2EAVISO01';
    const RA_SEM_PROVA = 'E2EAVISO02';
    const CURSO = 'CURSO E2E AVISO';
    const POLO_A = 'Polo E2E Aviso A';
    const POLO_B = 'Polo E2E Aviso B';
    const PERIODO_VIGENTE = 'E2E-AVISO-VIGENTE';
    const PERIODO_ANTIGO = 'E2E-AVISO-ANTIGO';

    let poloAId: number;
    let alunoId: number;
    let salaFaixaId: number;
    let ead: { id: number; nome: string };
    // Nomes de exibicao vindos do seed ("EaD", "Modular") — o aviso
    // fala em nomes, nao em ids, entao o teste tambem.
    let nomeEad: string;
    let nomeModular: string;

    const csv = (campus: string, status = 'Ativo') =>
      [
        'RA;ALUNO;EMAIL INSTITUCIONAL;CURSO;STATUS CURSO;CAMPUS',
        `${RA};ALUNO COM PROVA;;${CURSO};${status};${campus}`,
        `${RA_SEM_PROVA};ALUNO SEM PROVA;;${CURSO};${status};${campus}`,
      ].join('\r\n');

    const subir = (campus: string, modalidade: string, status = 'Ativo') =>
      request(app.getHttpServer())
        .post('/api/importacao/alunos')
        .set('Authorization', `Bearer ${token}`)
        .field('modalidade', modalidade)
        .attach(
          'arquivo',
          Buffer.from(csv(campus, status), 'utf8'),
          'alunos-e2e.csv',
        );

    async function limpar() {
      await prisma.agendamento.deleteMany({
        where: { matricula: { in: [RA, RA_SEM_PROVA] } },
      });

      for (const nome of [POLO_A, POLO_B]) {
        const polo = await prisma.polo.findUnique({ where: { nome } });

        if (!polo) continue;

        await prisma.salaFaixa.deleteMany({
          where: { faixa: { poloId: polo.id } },
        });
        await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
        await prisma.sala.deleteMany({ where: { poloId: polo.id } });
        await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
        await prisma.polo.delete({ where: { id: polo.id } });
      }

      await prisma.periodoAgendamento.deleteMany({
        where: { periodoLetivoId: { in: [PERIODO_VIGENTE, PERIODO_ANTIGO] } },
      });
    }

    beforeAll(async () => {
      await limpar();

      poloAId = (await prisma.polo.create({ data: { nome: POLO_A } })).id;
      await prisma.polo.create({ data: { nome: POLO_B } });

      ead = await prisma.modalidade.findUniqueOrThrow({
        where: { codigo: 'EAD' },
      });

      nomeEad = ead.nome;
      nomeModular = (
        await prisma.modalidade.findUniqueOrThrow({
          where: { codigo: 'MODULAR' },
        })
      ).nome;

      const sala = await prisma.sala.create({
        data: { poloId: poloAId, nome: 'AVISO-101', capacidade: 5 },
      });

      const faixa = await prisma.faixa.create({
        data: {
          poloId: poloAId,
          data: new Date('2026-12-10T00:00:00.000Z'),
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
        include: { salaFaixas: true },
      });

      salaFaixaId = faixa.salaFaixas[0].id;

      // O vigente e o cadastrado mais recentemente — por isso este vem por ultimo.
      await prisma.periodoAgendamento.create({
        data: {
          periodoLetivoId: PERIODO_ANTIGO,
          dataFechamento: new Date('2026-01-31T23:59:00.000Z'),
        },
      });
      await prisma.periodoAgendamento.create({
        data: {
          periodoLetivoId: PERIODO_VIGENTE,
          aberto: true,
          dataFechamento: new Date('2026-12-01T23:59:00.000Z'),
        },
      });

      // Carga inicial: os dois alunos entram como EaD no polo A.
      const primeira = await subir(POLO_A, 'EAD').expect(201);

      expect(primeira.body.criados).toBe(2);
      expect(primeira.body.alteracoesComAgendamento).toEqual([]);

      alunoId = (
        await prisma.alunoImportado.findFirstOrThrow({
          where: { matricula: RA },
        })
      ).id;

      // So o primeiro aluno marca prova.
      await prisma.agendamento.create({
        data: {
          alunoId,
          salaFaixaId,
          matricula: RA,
          userIdD2L: '77777',
          periodoLetivoId: PERIODO_VIGENTE,
          rodada: 'N2',
          // Fotografia do vinculo no momento da reserva: EaD no polo A, que e
          // exatamente o que as reimportacoes deste bloco vao mudar por baixo.
          modalidadeId: ead.id,
          poloId: poloAId,
        },
      });
    }, 60_000);

    afterAll(limpar);

    it('reimportar identico nao gera aviso nenhum', async () => {
      const res = await subir(POLO_A, 'EAD').expect(201);

      expect(res.body.atualizados).toBe(2);
      expect(res.body.alteracoesComAgendamento).toEqual([]);
    });

    it('avisa quando o FORMATO muda em quem tem prova marcada', async () => {
      const res = await subir(POLO_A, 'MODULAR').expect(201);

      // O aluno sem prova mudou igual, e NAO entra no aviso: nao ha reserva
      // para ficar inconsistente.
      expect(res.body.alteracoesComAgendamento).toHaveLength(1);

      const aviso = res.body.alteracoesComAgendamento[0];

      expect(aviso).toMatchObject({
        matricula: RA,
        curso: CURSO,
        agendamentosConfirmados: 1,
        modalidade: { de: nomeEad, para: nomeModular },
      });
      // so o formato mudou
      expect(aviso.polo).toBeUndefined();

      // Avisa, mas NAO bloqueia: a gravacao acontece.
      const depois = await prisma.alunoImportado.findFirstOrThrow({
        where: { matricula: RA },
        include: { modalidade: true },
      });
      expect(depois.modalidade.codigo).toBe('MODULAR');
    });

    it('avisa quando o POLO muda, e reporta as duas trocas juntas', async () => {
      const res = await subir(POLO_B, 'EAD').expect(201);

      const aviso = res.body.alteracoesComAgendamento[0];

      expect(res.body.alteracoesComAgendamento).toHaveLength(1);
      expect(aviso).toMatchObject({
        matricula: RA,
        polo: { de: POLO_A, para: POLO_B },
        // desfazendo a troca do teste anterior
        modalidade: { de: nomeModular, para: nomeEad },
        agendamentosConfirmados: 1,
      });
    });

    it('prova de semestre passado nao vira ruido', async () => {
      // A reserva do semestre anterior ja aconteceu: avisar sobre ela ensinaria
      // o time a ignorar o aviso.
      await prisma.agendamento.updateMany({
        where: { matricula: RA },
        data: { periodoLetivoId: PERIODO_ANTIGO },
      });

      const res = await subir(POLO_A, 'MODULAR').expect(201);

      expect(res.body.alteracoesComAgendamento).toEqual([]);

      await prisma.agendamento.updateMany({
        where: { matricula: RA },
        data: { periodoLetivoId: PERIODO_VIGENTE },
      });
    });

    it('reserva CANCELADA tambem nao gera aviso', async () => {
      await prisma.agendamento.updateMany({
        where: { matricula: RA },
        data: { status: 'CANCELADO' },
      });

      const res = await subir(POLO_A, 'EAD').expect(201);

      expect(res.body.alteracoesComAgendamento).toEqual([]);

      await prisma.agendamento.updateMany({
        where: { matricula: RA },
        data: { status: 'CONFIRMADO' },
      });
    });

    /**
     * O caso mais silencioso dos tres: "Transf. Interna" e um status CONHECIDO,
     * entao ele nao entra em `statusDesconhecidos`, e como formato e polo
     * nao mudaram nada mais no upload muda de cor. Antes deste aviso, a unica
     * pista era `bloqueados` subir um.
     */
    it('avisa quando o aluno PERDE a elegibilidade com prova marcada', async () => {
      const res = await subir(POLO_A, 'EAD', 'Transf. Interna').expect(201);

      // O aluno SEM prova perdeu a elegibilidade igual e nao entra: nao ha
      // reserva para ficar orfa. Mesmo criterio de formato e polo.
      expect(res.body.alteracoesComAgendamento).toHaveLength(1);

      const aviso = res.body.alteracoesComAgendamento[0];

      expect(aviso).toMatchObject({
        matricula: RA,
        curso: CURSO,
        agendamentosConfirmados: 1,
        statusCurso: { de: 'Ativo', para: 'Transf. Interna' },
      });
      // so o status mudou
      expect(aviso.modalidade).toBeUndefined();
      expect(aviso.polo).toBeUndefined();

      // Status conhecido: nao e novidade a classificar, e por isso o aviso
      // precisa existir por conta propria.
      expect(res.body.statusDesconhecidos).toEqual([]);
      expect(res.body.podemAgendar).toBe(0);

      // Avisa e NAO bloqueia: a perda de elegibilidade e gravada...
      const depois = await prisma.alunoImportado.findFirstOrThrow({
        where: { matricula: RA },
      });
      expect(depois.ativo).toBe(false);
      expect(depois.statusCurso).toBe('Transf. Interna');

      // ...e a prova continua de pe. Cancelar e decisao da administracao.
      const prova = await prisma.agendamento.findFirstOrThrow({
        where: { matricula: RA },
      });
      expect(prova.status).toBe('CONFIRMADO');
    });

    it('trocar entre dois status que JA bloqueavam nao gera aviso', async () => {
      // Monta a precondicao aqui e nao no teste anterior: o aviso e sobre a
      // TRANSICAO, entao um teste que dependesse da ordem estaria medindo o
      // estado deixado por outro.
      await subir(POLO_A, 'EAD', 'Transf. Interna').expect(201);

      // O aluno ja estava barrado; repetir o aviso a cada planilha e o que
      // ensina o time a ignora-lo.
      const res = await subir(POLO_A, 'EAD', 'Cancelado').expect(201);

      expect(res.body.alteracoesComAgendamento).toEqual([]);
    });

    it('RECUPERAR a elegibilidade nao gera aviso', async () => {
      await subir(POLO_A, 'EAD', 'Matrícula Trancada').expect(201);

      // Voltar a poder agendar tendo prova marcada nao deixa nada
      // inconsistente — a reserva ja era dele.
      const res = await subir(POLO_A, 'EAD', 'Ativo').expect(201);

      expect(res.body.alteracoesComAgendamento).toEqual([]);
      expect(res.body.podemAgendar).toBe(2);
    });
  });

  /**
   * O ciclo inteiro do curso renomeado: a planilha muda a grafia, o upsert cria
   * um segundo vinculo, a importacao denuncia, a administracao mescla e a prova
   * volta para uma linha so.
   */
  describe('curso renomeado: deteccao e mesclagem', () => {
    const RA = 'E2EGRAFIA01';
    const CURSO_ANTIGO = 'PSICOLOGIA';
    const CURSO_NOVO = 'Psicologia — Bacharelado';
    const OUTRO_CURSO = 'ENFERMAGEM';
    const POLO = 'Polo E2E Grafia';
    const PERIODO = 'E2E-GRAFIA';

    let poloId: number;
    let salaFaixaId: number;
    let modalidade: { id: number; nome: string };

    const csv = (...cursos: string[]) =>
      [
        'RA;ALUNO;EMAIL INSTITUCIONAL;CURSO;STATUS CURSO;CAMPUS',
        ...cursos.map((c) => `${RA};ANA PAULA SOUZA;;${c};Ativo;${POLO}`),
      ].join('\r\n');

    const subir = (...cursos: string[]) =>
      request(app.getHttpServer())
        .post('/api/importacao/alunos')
        .set('Authorization', `Bearer ${token}`)
        .field('modalidade', 'EAD')
        .attach(
          'arquivo',
          Buffer.from(csv(...cursos), 'utf8'),
          'alunos-grafia.csv',
        );

    async function limpar() {
      await prisma.agendamento.deleteMany({ where: { matricula: RA } });

      const polo = await prisma.polo.findUnique({ where: { nome: POLO } });

      if (polo) {
        await prisma.salaFaixa.deleteMany({
          where: { faixa: { poloId: polo.id } },
        });
        await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
        await prisma.sala.deleteMany({ where: { poloId: polo.id } });
        await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
        await prisma.polo.delete({ where: { id: polo.id } });
      }
    }

    beforeAll(async () => {
      await limpar();

      poloId = (await prisma.polo.create({ data: { nome: POLO } })).id;

      modalidade = await prisma.modalidade.findUniqueOrThrow({
        where: { codigo: 'EAD' },
      });

      const sala = await prisma.sala.create({
        data: { poloId, nome: 'GRAFIA-101', capacidade: 5 },
      });

      const faixa = await prisma.faixa.create({
        data: {
          poloId,
          data: new Date('2026-11-20'),
          horaInicio: '08:30',
          horaFim: '11:30',
          salaFaixas: {
            create: [
              {
                salaId: sala.id,
                modalidadeId: modalidade.id,
                vagas: 5,
                ordem: 1,
              },
            ],
          },
        },
        include: { salaFaixas: true },
      });

      salaFaixaId = faixa.salaFaixas[0].id;
    }, 60_000);

    afterAll(limpar);

    it('a carga inicial nao acusa nada', async () => {
      const res = await subir(CURSO_ANTIGO).expect(201);

      expect(res.body.criados).toBe(1);
      expect(res.body.cursosRenomeados).toEqual([]);
    });

    it('a mudanca de grafia CRIA um segundo vinculo e e denunciada', async () => {
      // A prova fica presa ao vinculo antigo — e o que a mesclagem vai resgatar.
      const antigo = await prisma.alunoImportado.findFirstOrThrow({
        where: { matricula: RA, curso: CURSO_ANTIGO },
      });

      await prisma.agendamento.create({
        data: {
          alunoId: antigo.id,
          salaFaixaId,
          matricula: RA,
          userIdD2L: '55555',
          periodoLetivoId: PERIODO,
          rodada: 'N2',
          modalidadeId: modalidade.id,
          poloId,
        },
      });

      const res = await subir(CURSO_NOVO).expect(201);

      expect(res.body.criados).toBe(1);
      expect(res.body.cursosRenomeados).toHaveLength(1);

      const aviso = res.body.cursosRenomeados[0];
      expect(aviso.matricula).toBe(RA);
      expect(aviso.curso).toBe(CURSO_NOVO);
      expect(aviso.candidatas).toHaveLength(1);
      expect(aviso.candidatas[0]).toMatchObject({
        alunoId: antigo.id,
        curso: CURSO_ANTIGO,
        semelhanca: 'tokens-contidos',
        agendamentosConfirmados: 1,
      });
    });

    it('curso DIFERENTE no mesmo RA nao e confundido com renomeacao', async () => {
      const res = await subir(CURSO_NOVO, OUTRO_CURSO).expect(201);

      expect(res.body.cursosRenomeados).toEqual([]);
    });

    it('as duas grafias no MESMO arquivo sao dois vinculos, nao um renomeado', async () => {
      const res = await subir(CURSO_ANTIGO, CURSO_NOVO).expect(201);

      expect(res.body.cursosRenomeados).toEqual([]);
    });

    it('a mesclagem move a prova e apaga o vinculo antigo', async () => {
      const [antigo, novo] = await Promise.all([
        prisma.alunoImportado.findFirstOrThrow({
          where: { matricula: RA, curso: CURSO_ANTIGO },
        }),
        prisma.alunoImportado.findFirstOrThrow({
          where: { matricula: RA, curso: CURSO_NOVO },
        }),
      ]);

      const res = await request(app.getHttpServer())
        .post(`/api/alunos/${novo.id}/mesclar`)
        .set('Authorization', `Bearer ${token}`)
        .send({ absorverId: antigo.id })
        .expect(201);

      expect(res.body.agendamentosMovidos).toBe(1);
      expect(res.body.avisos).toEqual([]);

      // O vinculo antigo deixou de existir...
      expect(
        await prisma.alunoImportado.findUnique({ where: { id: antigo.id } }),
      ).toBeNull();

      // ...e a prova esta no que ficou.
      const prova = await prisma.agendamento.findFirstOrThrow({
        where: { matricula: RA },
      });
      expect(prova.alunoId).toBe(novo.id);
    });

    it('RECUSA mesclar vinculos de matriculas diferentes', async () => {
      const novo = await prisma.alunoImportado.findFirstOrThrow({
        where: { matricula: RA, curso: CURSO_NOVO },
      });

      const outraPessoa = await prisma.alunoImportado.create({
        data: {
          matricula: 'E2EGRAFIA99',
          curso: CURSO_ANTIGO,
          statusCurso: 'Ativo',
          ativo: true,
          modalidadeId: modalidade.id,
          poloId,
        },
      });

      await request(app.getHttpServer())
        .post(`/api/alunos/${novo.id}/mesclar`)
        .set('Authorization', `Bearer ${token}`)
        .send({ absorverId: outraPessoa.id })
        .expect(400);

      // Nada foi apagado.
      expect(
        await prisma.alunoImportado.findUnique({
          where: { id: outraPessoa.id },
        }),
      ).not.toBeNull();
    });

    it('RECUSA quando os dois tem prova confirmada no mesmo periodo', async () => {
      const novo = await prisma.alunoImportado.findFirstOrThrow({
        where: { matricula: RA, curso: CURSO_NOVO },
      });

      const outro = await prisma.alunoImportado.findFirstOrThrow({
        where: { matricula: RA, curso: OUTRO_CURSO },
      });

      await prisma.agendamento.create({
        data: {
          alunoId: outro.id,
          salaFaixaId,
          matricula: RA,
          userIdD2L: '55555',
          periodoLetivoId: PERIODO,
          rodada: 'N2',
          modalidadeId: modalidade.id,
          poloId,
        },
      });

      await request(app.getHttpServer())
        .post(`/api/alunos/${novo.id}/mesclar`)
        .set('Authorization', `Bearer ${token}`)
        .send({ absorverId: outro.id })
        .expect(409);
    });
  });

  seTemCsvReais('com os 3 CSVs reais de alunos', () => {
    const resumo: Record<string, any> = {};

    it('importa os tres arquivos', async () => {
      for (const [modalidade, caminho] of Object.entries(CSV_REAIS)) {
        const res = await enviarAlunos(caminho, modalidade).expect(201);
        resumo[modalidade] = res.body;
      }

      expect(resumo.EAD.totalLinhas).toBe(2515);
      expect(resumo.SEMI.totalLinhas).toBe(3385);
      expect(resumo.MODULAR.totalLinhas).toBe(1621);
    }, 300_000);

    it('rejeita exatamente as 11 linhas do Modular sem CAMPUS', () => {
      expect(resumo.MODULAR.rejeitadas).toHaveLength(11);
      expect(resumo.MODULAR.rejeitadas[0].motivo).toMatch(/CAMPUS vazio/);
      expect(resumo.EAD.rejeitadas).toHaveLength(0);
      expect(resumo.SEMI.rejeitadas).toHaveLength(0);
    });

    it('casa todos os CAMPUS com os polos do seed', () => {
      for (const r of Object.values(resumo)) {
        expect(r.polosNaoEncontrados).toEqual([]);
      }
    });

    it('nao encontra nenhum STATUS CURSO fora das listas conhecidas', () => {
      for (const r of Object.values(resumo)) {
        expect(r.statusDesconhecidos).toEqual([]);
      }
    });

    it('aplica a regra de elegibilidade por STATUS CURSO', async () => {
      const podem = await prisma.alunoImportado.count({
        where: { ativo: true },
      });
      const bloqueados = await prisma.alunoImportado.count({
        where: { ativo: false },
      });

      // 7.521 linhas nos arquivos - 11 rejeitadas (CAMPUS vazio) = 7.510 gravadas
      expect(podem + bloqueados).toBe(7510);

      // REGRA VIGENTE (20/10/2026): "Ativo", "Cursando" e "Matriculado"
      // agendam (a planilha real nao tem os dois ultimos, entao as contagens
      // abaixo nao mudam).
      // Bloqueados = Cancelado 130 + Matrícula Trancada 116 (era "Trancado" ate 20/10/2026) + Desistente 20 + Formado 3
      // + as situacoes de transicao, que voltaram a barrar:
      // Transf. Interna 12 + Transf. de Curriculo 1 + Alter. de Habilitacao 1.
      expect(bloqueados).toBe(269 + 14);

      // Ativos sao 7.238 na planilha; ficam 11 a menos porque as 11 linhas sem
      // CAMPUS sao todas "Ativo" e foram rejeitadas — sao alunos elegiveis que
      // NAO estao no sistema ate a planilha ser corrigida.
      expect(podem).toBe(7238 - 11);
    });

    it('guarda o STATUS CURSO bruto, para a regra poder mudar sem reimportar', async () => {
      const transferencias = await prisma.alunoImportado.count({
        where: { statusCurso: 'Transf. Interna' },
      });

      expect(transferencias).toBe(12);

      // O valor cru sobrevive; o que NAO se recalcula sozinho e a coluna
      // `ativo`, derivada na importacao. Trocar a lista de elegibilidade exige
      // `npm run alunos:recalcular` (ou reimportar) para a base seguir a regra.
      const transferenciasAtivas = await prisma.alunoImportado.count({
        where: { statusCurso: 'Transf. Interna', ativo: true },
      });

      expect(transferenciasAtivas).toBe(0);
    });

    it('grava os dois vinculos da aluna em dois cursos', async () => {
      const monica = await prisma.alunoImportado.findMany({
        where: { matricula: 'UC24424289' },
        include: { modalidade: true },
      });

      expect(monica).toHaveLength(2);
      expect(monica.map((v) => v.modalidade.codigo).sort()).toEqual([
        'EAD',
        'MODULAR',
      ]);
      // ambos elegiveis: Ativo nos dois cursos
      expect(monica.every((v) => v.ativo)).toBe(true);
    });

    it('a aluna em Transf. Interna + Ativo agenda SO pelo vinculo ativo', async () => {
      const karen = await prisma.alunoImportado.findMany({
        where: { matricula: 'UC25426277' },
      });

      // Caso real de dois vinculos com status diferentes. Sob a regra vigente
      // ("Ativo", "Cursando" e "Matriculado" agendam), a transferencia nao entra: ela faz a prova de um
      // curso so.
      expect(karen).toHaveLength(2);
      expect(karen.filter((v) => v.ativo)).toHaveLength(1);
      expect(karen.find((v) => !v.ativo)?.statusCurso).toBe('Transf. Interna');
    });

    it('reimportar o mesmo arquivo nao duplica nada', async () => {
      const antes = await prisma.alunoImportado.count();

      const res = await enviarAlunos(CSV_REAIS.EAD, 'EAD').expect(201);

      expect(res.body.criados).toBe(0);
      expect(res.body.atualizados).toBe(2515);
      await expect(prisma.alunoImportado.count()).resolves.toBe(antes);
    }, 300_000);

    it('registra a auditoria de cada upload', async () => {
      const historico = await request(app.getHttpServer())
        .get('/api/importacao')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const alunos = historico.body.filter(
        (i: { tipo: string }) => i.tipo === 'ALUNOS',
      );

      expect(alunos.length).toBeGreaterThanOrEqual(4);
      expect(alunos[0].importadoPor).toBe(EMAIL);
      expect(alunos[0].nomeArquivo).toMatch(/\.csv$/);
    });
  });

  /**
   * FORA DA PLANILHA (20/10/2026): o CSV marcado como lista completa do formato
   * aponta quem esta no banco e nao veio nele, e so marca no segundo envio.
   *
   * ⚠️ Roda em PRESENCIAL de proposito. O e2e usa o banco de desenvolvimento,
   * com os alunos reais de EaD/Semi/Modular: aplicar uma "lista completa" de
   * dez alunos em EaD marcaria todos os outros como fora. Se um dia houver
   * presenciais reais no banco, os testes que aplicam FALHAM com a explicacao,
   * em vez de marca-los.
   */
  describe('lista completa: quem saiu da planilha', () => {
    const POLO = 'Polo E2E Fora da Planilha';
    const CURSO = 'CURSO E2E FORA';
    const RAS = Array.from(
      { length: 10 },
      (_, i) => `E2EFORA${String(i + 1).padStart(2, '0')}`,
    );
    const RA_COM_PROVA = RAS[9];

    let presencialId: number;
    let alheios = 0;

    const csv = (ras: string[], semCampus: string[] = []) =>
      [
        'RA;ALUNO;EMAIL INSTITUCIONAL;CURSO;STATUS CURSO;CAMPUS',
        ...ras.map((ra) => `${ra};ALUNO ${ra};;${CURSO};Ativo;${POLO}`),
        ...semCampus.map((ra) => `${ra};ALUNO ${ra};;${CURSO};Ativo;`),
      ].join('\r\n');

    const subir = (conteudo: string, campos: Record<string, string> = {}) => {
      let req = request(app.getHttpServer())
        .post('/api/importacao/alunos')
        .set('Authorization', `Bearer ${token}`)
        .field('modalidade', 'PRESENCIAL');

      for (const [campo, valor] of Object.entries(campos)) {
        req = req.field(campo, valor);
      }

      return req.attach(
        'arquivo',
        Buffer.from(conteudo, 'utf8'),
        'alunos-fora.csv',
      );
    };

    const vinculo = (ra: string) =>
      prisma.alunoImportado.findFirstOrThrow({ where: { matricula: ra } });

    function exigirPresencialIsolado() {
      if (alheios > 0) {
        throw new Error(
          `Ha ${alheios} vinculo(s) PRESENCIAL reais neste banco: aplicar a ` +
            'lista completa do teste os marcaria como fora da planilha. ' +
            'Rode este bloco num banco sem presenciais.',
        );
      }
    }

    async function limpar() {
      await prisma.agendamento.deleteMany({
        where: { matricula: { in: RAS } },
      });

      const polo = await prisma.polo.findUnique({ where: { nome: POLO } });

      if (polo) {
        await prisma.salaFaixa.deleteMany({
          where: { faixa: { poloId: polo.id } },
        });
        await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
        await prisma.sala.deleteMany({ where: { poloId: polo.id } });
        await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
        await prisma.polo.delete({ where: { id: polo.id } });
      }
    }

    /** Volta os dez ao estado inicial: todos dentro da planilha. */
    async function recarregarTodos() {
      await subir(csv(RAS)).expect(201);
    }

    beforeAll(async () => {
      await limpar();

      const polo = await prisma.polo.create({ data: { nome: POLO } });
      presencialId = (
        await prisma.modalidade.findUniqueOrThrow({
          where: { codigo: 'PRESENCIAL' },
        })
      ).id;

      alheios = await prisma.alunoImportado.count({
        where: { modalidadeId: presencialId, matricula: { notIn: RAS } },
      });

      await recarregarTodos();

      // O ultimo da lista tem prova marcada no semestre que a importacao
      // olha — o mesmo que ela vai resolver para PRESENCIAL.
      const periodoLetivoId =
        (await app.get(PeriodoService).periodoLetivoDaModalidade('PRESENCIAL'))
          ?.periodoLetivoId ?? 'E2E-FORA';

      const sala = await prisma.sala.create({
        data: { poloId: polo.id, nome: 'FORA-101', capacidade: 5 },
      });
      const faixa = await prisma.faixa.create({
        data: {
          poloId: polo.id,
          data: new Date('2026-12-10T00:00:00.000Z'),
          horaInicio: '08:30',
          horaFim: '10:30',
          salaFaixas: {
            create: {
              salaId: sala.id,
              modalidadeId: presencialId,
              vagas: 5,
              ordem: 1,
            },
          },
        },
        include: { salaFaixas: true },
      });

      await prisma.agendamento.create({
        data: {
          alunoId: (await vinculo(RA_COM_PROVA)).id,
          salaFaixaId: faixa.salaFaixas[0].id,
          matricula: RA_COM_PROVA,
          userIdD2L: '88888',
          periodoLetivoId,
          rodada: 'N2',
          modalidadeId: presencialId,
          poloId: polo.id,
        },
      });
    }, 60_000);

    afterAll(limpar);

    it('arquivo PARCIAL (o padrao) nao compara nada', async () => {
      const res = await subir(csv([RAS[0]])).expect(201);

      expect(res.body.listaCompleta).toBe(false);
      expect(res.body.saidas).toBeNull();
      expect((await vinculo(RAS[1])).foraDaPlanilhaEm).toBeNull();
    });

    it('aplicar sem lista completa e recusado antes de gravar qualquer coisa', async () => {
      const antes = await prisma.importacaoCsv.count();

      const res = await subir(csv(RAS), { aplicarSaidas: 'true' }).expect(400);

      expect(res.body.message).toMatch(/lista completa/);
      expect(await prisma.importacaoCsv.count()).toBe(antes);
    });

    it('lista completa SIMULA: aponta quem saiu, com prova primeiro, e nao marca ninguem', async () => {
      const res = await subir(csv(RAS.slice(0, 8)), {
        listaCompleta: 'true',
      }).expect(201);

      const saidas = res.body.saidas;
      const nossos = saidas.vinculos.filter((v: { matricula: string }) =>
        RAS.includes(v.matricula),
      );

      expect(saidas.aplicadas).toBe(false);
      expect(nossos.map((v: { matricula: string }) => v.matricula)).toEqual([
        RA_COM_PROVA,
        RAS[8],
      ]);
      expect(nossos[0].agendamentosConfirmados).toBe(1);
      expect((await vinculo(RAS[8])).foraDaPlanilhaEm).toBeNull();
      expect((await vinculo(RAS[8])).ativo).toBe(true);
    });

    it('"false" no multipart continua false (nao vira true na conversao)', async () => {
      const res = await subir(csv(RAS.slice(0, 8)), {
        listaCompleta: 'false',
      }).expect(201);

      expect(res.body.saidas).toBeNull();
    });

    it('APLICAR marca e bloqueia, mantem a prova e registra na importacao', async () => {
      exigirPresencialIsolado();

      const res = await subir(csv(RAS.slice(0, 9)), {
        listaCompleta: 'true',
        aplicarSaidas: 'true',
      }).expect(201);

      expect(res.body.saidas).toMatchObject({
        aplicadas: true,
        total: 1,
        base: 10,
        percentual: 10,
        acimaDoLimite: false,
      });

      const saiu = await vinculo(RA_COM_PROVA);

      expect(saiu.ativo).toBe(false);
      expect(saiu.foraDaPlanilhaEm).not.toBeNull();
      expect(saiu.foraDaPlanilhaImportacaoId).toBe(res.body.importacaoId);

      // A prova NAO e cancelada (decisao do cliente): quem decide e a administracao.
      expect(
        await prisma.agendamento.count({
          where: { matricula: RA_COM_PROVA, status: 'CONFIRMADO' },
        }),
      ).toBe(1);

      const importacao = await prisma.importacaoCsv.findUniqueOrThrow({
        where: { id: res.body.importacaoId },
      });

      expect(importacao).toMatchObject({
        listaCompleta: true,
        saidasMarcadas: 1,
      });

      const busca = await request(app.getHttpServer())
        .get('/api/alunos')
        .query({ busca: 'E2EFORA', foraDaPlanilha: 'true' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        busca.body.itens.map((i: { matricula: string }) => i.matricula),
      ).toEqual([RA_COM_PROVA]);
    });

    it('voltar num arquivo PARCIAL tira a marca e libera de novo', async () => {
      exigirPresencialIsolado();

      const res = await subir(csv([RA_COM_PROVA])).expect(201);

      expect(res.body.voltaramParaAPlanilha).toBe(1);

      const voltou = await vinculo(RA_COM_PROVA);

      expect(voltou.foraDaPlanilhaEm).toBeNull();
      expect(voltou.ativo).toBe(true);
    });

    it('acima do limite, aplicar sem a segunda confirmacao NAO marca ninguem', async () => {
      exigirPresencialIsolado();
      await recarregarTodos();

      // O CSV de UM aluno com a caixa marcada: 90% do formato "sairia".
      const res = await subir(csv([RAS[0]]), {
        listaCompleta: 'true',
        aplicarSaidas: 'true',
      }).expect(201);

      expect(res.body.saidas).toMatchObject({
        aplicadas: false,
        bloqueadasPeloLimite: true,
        acimaDoLimite: true,
        total: 9,
      });
      expect(
        await prisma.alunoImportado.count({
          where: { matricula: { in: RAS }, foraDaPlanilhaEm: { not: null } },
        }),
      ).toBe(0);
    });

    it('acima do limite COM a segunda confirmacao, marca', async () => {
      exigirPresencialIsolado();
      await recarregarTodos();

      const res = await subir(csv(RAS.slice(0, 5)), {
        listaCompleta: 'true',
        aplicarSaidas: 'true',
        confirmarAcimaDoLimite: 'true',
      }).expect(201);

      expect(res.body.saidas.aplicadas).toBe(true);
      expect(res.body.saidas.total).toBe(5);

      await recarregarTodos();
    });

    it('linha REJEITADA protege o RA: cadastro errado nao e saida', async () => {
      exigirPresencialIsolado();
      await recarregarTodos();

      // RAS[9] veio sem CAMPUS: rejeitada, mas presente na planilha.
      const res = await subir(csv(RAS.slice(0, 9), [RA_COM_PROVA]), {
        listaCompleta: 'true',
        aplicarSaidas: 'true',
      }).expect(201);

      expect(res.body.rejeitadas).toHaveLength(1);
      expect(res.body.saidas.total).toBe(0);
      expect((await vinculo(RA_COM_PROVA)).foraDaPlanilhaEm).toBeNull();
    });
  });
});
