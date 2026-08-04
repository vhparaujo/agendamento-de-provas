import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/service/auth.service';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Periodo de agendamento (CRUD do admin) e o relatorio: consulta, ocupacao por
 * sala e exportacao em CSV.
 *
 * Monta um agendamento de verdade pelo portal do aluno, para o relatorio ter o
 * que mostrar — um relatorio testado sobre tabela vazia nao prova nada.
 */
describe('Periodo e relatorio de agendamentos (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: AuthService;
  let token: string;
  let alunoToken: string;

  const EMAIL = 'e2e-relatorio@ucb.br';
  const SENHA = 'senha-do-teste-123';
  const POLO_NOME = 'Polo E2E Relatorio';
  const TURMA = 'E2E-REL-TURMA';
  const MATRICULA = 'E2EREL001';
  const PERIODO_LETIVO = 'E2E-REL-500';
  const DATA_PROVA = '2026-11-12';

  let poloId: number;
  let salaId: number;
  let faixaId: number;
  let ead: { id: number };
  let periodoId: number;

  const api = () => request(app.getHttpServer());
  const comoAdmin = <T extends request.Test>(r: T) =>
    r.set('Authorization', `Bearer ${token}`);
  const comoAluno = <T extends request.Test>(r: T) =>
    r.set('Authorization', `Bearer ${alunoToken}`);

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
    auth = app.get(AuthService);

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

    ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });

    poloId = (await prisma.polo.create({ data: { nome: POLO_NOME } })).id;
    salaId = (
      await prisma.sala.create({
        data: { poloId, nome: 'REL-101', capacidade: 5 },
      })
    ).id;

    faixaId = (
      await prisma.faixa.create({
        data: {
          poloId,
          data: new Date(`${DATA_PROVA}T00:00:00.000Z`),
          horaInicio: '08:30',
          horaFim: '11:30',
          salaFaixas: {
            create: { salaId, modalidadeId: ead.id, vagas: 5, ordem: 1 },
          },
        },
      })
    ).id;

    await prisma.turmaImportada.create({
      data: { codigoTurma: TURMA, nomeDisciplina: 'Disciplina do Relatorio' },
    });

    // Nome com ";" e com "=" de proposito: o CSV precisa aguentar os dois.
    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula: MATRICULA,
        nome: '=SILVA; MARIA DA',
        email: 'maria@aluno.ucb.br',
        curso: 'NUTRIÇÃO',
        statusCurso: 'Ativo',
        ativo: true,
        modalidadeId: ead.id,
        poloId,
      },
    });

    alunoToken = (
      await auth.emitirTokenAluno({
        sub: MATRICULA,
        userIdD2L: '99999',
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
          orgUnitId: 'ou-' + TURMA,
          codigo: TURMA,
          titulo: 'Disciplina do Relatorio',
        },
      })
    ).accessToken;
  }, 60_000);

  afterAll(async () => {
    await limpar();
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  async function limpar() {
    await prisma.agendamento.deleteMany({ where: { matricula: MATRICULA } });

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

    await prisma.turmaImportada.deleteMany({ where: { codigoTurma: TURMA } });
    await prisma.periodoAgendamento.deleteMany({
      where: { periodoLetivoId: PERIODO_LETIVO },
    });
  }

  describe('CRUD do periodo de agendamento', () => {
    it('recusa janela invertida', async () => {
      await comoAdmin(api().post('/api/periodos'))
        .send({
          periodoLetivoId: PERIODO_LETIVO,
          dataAbertura: '2026-09-10T08:00:00-03:00',
          dataFechamento: '2026-09-01T23:59:00-03:00',
        })
        .expect(400);
    });

    it('cria FECHADO por padrao — o admin confere as faixas antes de liberar', async () => {
      const res = await comoAdmin(api().post('/api/periodos'))
        .send({
          periodoLetivoId: PERIODO_LETIVO,
          descricao: 'e2e relatorio',
          dataFechamento: '2026-11-01T23:59:00-03:00',
        })
        .expect(201);

      periodoId = res.body.id;

      expect(res.body).toMatchObject({
        aberto: false,
        vigente: true,
        aceitandoAgendamento: false,
        totalAgendamentos: 0,
      });
    });

    it('o aluno ainda nao consegue agendar', async () => {
      const res = await comoAluno(api().post('/api/portal/agendamentos'))
        .send({ faixaId })
        .expect(403);

      expect(res.body.message).toMatch(/fechado/i);
    });

    it('recusa outro periodo para o mesmo periodo letivo', async () => {
      await comoAdmin(api().post('/api/periodos'))
        .send({
          periodoLetivoId: PERIODO_LETIVO,
          dataFechamento: '2026-12-01T23:59:00-03:00',
        })
        .expect(409);
    });

    it('abre o agendamento', async () => {
      const res = await comoAdmin(api().patch(`/api/periodos/${periodoId}`))
        .send({ aberto: true })
        .expect(200);

      expect(res.body.aceitandoAgendamento).toBe(true);
    });

    it('prazo vencido fecha sozinho, sem ninguem mexer no `aberto`', async () => {
      await comoAdmin(api().patch(`/api/periodos/${periodoId}`))
        .send({ dataFechamento: '2020-01-01T23:59:00-03:00' })
        .expect(200);

      const res = await comoAdmin(
        api().get(`/api/periodos/${periodoId}`),
      ).expect(200);

      expect(res.body).toMatchObject({
        aberto: true,
        aceitandoAgendamento: false,
      });

      // devolve o prazo para o resto da suite
      await comoAdmin(api().patch(`/api/periodos/${periodoId}`))
        .send({ dataFechamento: '2026-11-01T23:59:00-03:00' })
        .expect(200);
    });
  });

  describe('o aluno agenda, e o admin ve', () => {
    it('o aluno confirma a prova', async () => {
      const res = await comoAluno(api().post('/api/portal/agendamentos'))
        .send({ faixaId })
        .expect(201);

      expect(res.body.sala.nome).toBe('REL-101');
    });

    it('aparece na listagem administrativa', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos?poloId=${poloId}`),
      ).expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.itens[0]).toMatchObject({
        matricula: MATRICULA,
        curso: 'NUTRIÇÃO',
        modalidade: 'EaD',
        polo: POLO_NOME,
        sala: 'REL-101',
        horaInicio: '08:30',
        status: 'CONFIRMADO',
      });
      expect(res.body.itens[0].disciplinas).toHaveLength(1);
    });

    it('a busca casa por matricula, nome e curso', async () => {
      for (const busca of [MATRICULA, 'SILVA', 'NUTRI']) {
        const res = await comoAdmin(
          api().get(`/api/agendamentos?poloId=${poloId}&busca=${busca}`),
        ).expect(200);

        expect(res.body.total).toBe(1);
      }
    });

    it('o filtro de data usa a data da PROVA', async () => {
      const dentro = await comoAdmin(
        api().get(
          `/api/agendamentos?poloId=${poloId}&de=${DATA_PROVA}&ate=${DATA_PROVA}`,
        ),
      ).expect(200);
      expect(dentro.body.total).toBe(1);

      const fora = await comoAdmin(
        api().get(`/api/agendamentos?poloId=${poloId}&de=2026-12-01`),
      ).expect(200);
      expect(fora.body.total).toBe(0);
    });

    it('o periodo passa a contar o agendamento', async () => {
      const res = await comoAdmin(
        api().get(`/api/periodos/${periodoId}`),
      ).expect(200);

      expect(res.body.totalAgendamentos).toBe(1);
    });

    it('detalha um agendamento', async () => {
      const lista = await comoAdmin(
        api().get(`/api/agendamentos?poloId=${poloId}`),
      ).expect(200);

      const res = await comoAdmin(
        api().get(`/api/agendamentos/${lista.body.itens[0].id}`),
      ).expect(200);

      expect(res.body.matricula).toBe(MATRICULA);
    });

    it('404 para agendamento inexistente', async () => {
      await comoAdmin(api().get('/api/agendamentos/99999999')).expect(404);
    });
  });

  describe('ocupacao por sala', () => {
    it('mostra vagas, ocupadas e disponiveis', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos/resumo?poloId=${poloId}`),
      ).expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        polo: POLO_NOME,
        sala: 'REL-101',
        modalidade: 'EaD',
        vagas: 5,
        ocupadas: 1,
        disponiveis: 4,
      });
    });
  });

  describe('exportacao em CSV', () => {
    it('devolve um arquivo para download', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
      ).expect(200);

      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename="agendamentos-.*\.csv"/,
      );
    });

    it('comeca com BOM UTF-8 e separa por ponto e virgula', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
      ).expect(200);

      // Sem o BOM, o Excel em Windows le "Câmpus" como "CÃ¢mpus".
      expect(res.text.charCodeAt(0)).toBe(0xfeff);
      expect(res.text).toContain('Matricula;Aluno;E-mail;Curso');
    });

    it('traz a linha do aluno com todos os dados', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
      ).expect(200);

      const linha = res.text
        .split('\r\n')
        .find((l) => l.includes(MATRICULA)) as string;

      expect(linha).toBeDefined();
      expect(linha).toContain('NUTRIÇÃO');
      expect(linha).toContain('REL-101');
      expect(linha).toContain('12/11/2026'); // data da prova, no fuso certo
      expect(linha).toContain('08:30');
      expect(linha).toContain('Disciplina do Relatorio');
    });

    it('NEUTRALIZA formula do Excel vinda do nome importado', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
      ).expect(200);

      // O nome cadastrado e `=SILVA; MARIA DA`. Sem tratamento, o Excel
      // executaria isso ao abrir o relatorio.
      expect(res.text).toContain('"\'=SILVA; MARIA DA"');
      expect(res.text).not.toMatch(/;=SILVA/);
    });

    it('respeita o filtro (polo sem agendamento sai so com cabecalho)', async () => {
      const res = await comoAdmin(
        api().get('/api/agendamentos/exportacao?poloId=999999'),
      ).expect(200);

      expect(res.text).not.toContain(MATRICULA);
      expect(res.text.split('\r\n').filter(Boolean)).toHaveLength(1);
    });
  });

  describe('protecao das rotas', () => {
    it.each([
      ['/api/periodos'],
      ['/api/agendamentos'],
      ['/api/agendamentos/resumo'],
      ['/api/agendamentos/exportacao'],
    ])('GET %s exige token de admin', async (rota) => {
      await api().get(rota).expect(401);
    });

    it('o token de aluno nao serve para o relatorio', async () => {
      await comoAluno(api().get('/api/agendamentos')).expect(401);
    });
  });
});
