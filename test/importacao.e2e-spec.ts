import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Importacao ponta a ponta. Os CSVs reais ficam fora do repositorio (dados de
 * aluno); os testes que dependem deles sao pulados se nao estiverem presentes.
 */
const CSV_REAIS = {
  EAD: '/Users/vhparaujo/Desktop/EaD - Dados(EaD).csv',
  SEMI: '/Users/vhparaujo/Desktop/EaD - Dados(Semi).csv',
  MODULAR: '/Users/vhparaujo/Desktop/EaD - Dados(Híbrido).csv',
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

    it('recusa modalidade invalida', async () => {
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
      expect(res.body.rejeitadas[0].motivo).toMatch(/codigo da turma/);
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
   * Modalidade e polo sao os dois campos que a importacao troca POR BAIXO de uma
   * reserva confirmada sem que nada mais reclame — a reserva continua na sala
   * antiga, com outra duracao ou em outro campus. Aqui se prova que a
   * importacao passou a dizer isso em voz alta, e que nao grita a toa.
   */
  describe('aviso: troca de modalidade/polo em quem ja tem prova marcada', () => {
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
    // Nomes de exibicao vindos do seed ("EaD", "Modular / Hibrido") — o aviso
    // fala em nomes, nao em ids, entao o teste tambem.
    let nomeEad: string;
    let nomeModular: string;

    const csv = (campus: string) =>
      [
        'RA;ALUNO;EMAIL INSTITUCIONAL;CURSO;STATUS CURSO;CAMPUS',
        `${RA};ALUNO COM PROVA;;${CURSO};Ativo;${campus}`,
        `${RA_SEM_PROVA};ALUNO SEM PROVA;;${CURSO};Ativo;${campus}`,
      ].join('\r\n');

    const subir = (campus: string, modalidade: string) =>
      request(app.getHttpServer())
        .post('/api/importacao/alunos')
        .set('Authorization', `Bearer ${token}`)
        .field('modalidade', modalidade)
        .attach('arquivo', Buffer.from(csv(campus), 'utf8'), 'alunos-e2e.csv');

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

    it('avisa quando a MODALIDADE muda em quem tem prova marcada', async () => {
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
      // so a modalidade mudou
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
  });

  /**
   * O ciclo inteiro do curso renomeado: a planilha muda a grafia, o upsert cria
   * um segundo vinculo, a importacao denuncia, a secretaria mescla e a prova
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

    it('rejeita exatamente as 11 linhas do Hibrido sem CAMPUS', () => {
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

      // REGRA VIGENTE (11/08/2026): so "Ativo" agenda.
      // Bloqueados = Cancelado 130 + Trancado 116 + Desistente 20 + Formado 3
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
      // (so "Ativo" agenda), a transferencia nao entra: ela faz a prova de um
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
});
