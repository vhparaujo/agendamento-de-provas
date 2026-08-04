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
    const fixture = join(__dirname, 'fixtures', 'turmas-exemplo.csv');

    it('importa a fixture de exemplo e e idempotente', async () => {
      const primeira = await request(app.getHttpServer())
        .post('/api/importacao/turmas')
        .set('Authorization', `Bearer ${token}`)
        .attach('arquivo', readFileSync(fixture), 'turmas-exemplo.csv')
        .expect(201);

      expect(primeira.body.totalLinhas).toBe(3);
      expect(primeira.body.rejeitadas).toEqual([]);

      // A terceira coluna traz nome e codigo EAD na mesma celula; a importacao
      // separa os dois. E o arquivo e separado por ";" (Excel pt-BR).
      const turma = await prisma.turmaImportada.findFirstOrThrow({
        where: { codigoTurma: 'E2EFIX0001' },
      });
      expect(turma.nomeDisciplina).toBe(
        'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
      );
      expect(turma.codigoEad).toBe('1-E2EFIX02EAD003');
      expect(turma.curso).toBe('EDUCAÇÃO FÍSICA');
      // o CSV nao traz orgUnitId — ele so aparece quando um aluno faz launch
      expect(turma.orgUnitId).toBeNull();

      const segunda = await request(app.getHttpServer())
        .post('/api/importacao/turmas')
        .set('Authorization', `Bearer ${token}`)
        .attach('arquivo', readFileSync(fixture), 'turmas-exemplo.csv')
        .expect(201);

      // reenviar nao duplica: tudo vira atualizacao
      expect(segunda.body.criadas).toBe(0);
      expect(segunda.body.atualizadas).toBe(3);

      await prisma.turmaImportada.deleteMany({
        where: { codigoTurma: { startsWith: 'E2EFIX' } },
      });
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

      // Bloqueados: Cancelado 130 + Trancado 116 + Desistente 20 + Formado 3
      expect(bloqueados).toBe(269);

      // Elegiveis pelo status seriam 7.252 (Ativo 7.238 + Transf. Interna 12
      // + Transf. de Curriculo 1 + Alter. de Habilitacao 1). Ficam 11 a menos
      // porque as 11 linhas sem CAMPUS sao todas "Ativo" e foram rejeitadas —
      // sao alunos elegiveis que NAO estao no sistema ate a planilha ser corrigida.
      expect(podem).toBe(7252 - 11);
    });

    it('guarda o STATUS CURSO bruto, permitindo mudar a regra sem reimportar', async () => {
      const transferencias = await prisma.alunoImportado.count({
        where: { statusCurso: 'Transf. Interna' },
      });

      expect(transferencias).toBe(12);
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

    it('a aluna em Transf. Interna + Ativo tambem tem dois vinculos elegiveis', async () => {
      const karen = await prisma.alunoImportado.findMany({
        where: { matricula: 'UC25426277' },
      });

      expect(karen).toHaveLength(2);
      expect(karen.every((v) => v.ativo)).toBe(true);
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
