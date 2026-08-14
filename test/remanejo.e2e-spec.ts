import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/service/auth.service';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Troca e cancelamento pelo aluno, remanejo e cancelamento pelo admin.
 *
 * O que estes testes protegem: a vaga tem de ser devolvida quando alguem sai, e
 * a troca nao pode deixar o aluno sem horario nenhum.
 */
describe('Remanejo, troca e cancelamento (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: AuthService;
  let token: string;

  const EMAIL = 'e2e-remanejo@ucb.br';
  const SENHA = 'senha-do-teste-123';
  const POLO_NOME = 'Polo E2E Remanejo';
  const OUTRO_POLO = 'Polo E2E Remanejo Distante';
  const TURMA = 'E2E-REM-TURMA';
  const PERIODO_LETIVO = 'E2E-REM-700';
  const PREFIXO = 'E2EREM';

  let poloId: number;
  let outroPoloId: number;
  let ead: { id: number };
  let semi: { id: number };
  let faixaA: number;
  let faixaB: number;
  let faixaOutroPolo: number;
  let ofertaA1: number;
  let ofertaSemi: number;
  let periodoId: number;

  const api = () => request(app.getHttpServer());
  const comoAdmin = <T extends request.Test>(r: T) =>
    r.set('Authorization', `Bearer ${token}`);
  const como = <T extends request.Test>(r: T, t: string) =>
    r.set('Authorization', `Bearer ${t}`);

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
    semi = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'SEMI' },
    });

    poloId = (await prisma.polo.create({ data: { nome: POLO_NOME } })).id;
    outroPoloId = (await prisma.polo.create({ data: { nome: OUTRO_POLO } })).id;

    await prisma.turmaImportada.create({
      data: { codigoTurma: TURMA, nomeDisciplina: 'Disciplina do Remanejo' },
    });

    periodoId = (
      await prisma.periodoAgendamento.create({
        data: {
          periodoLetivoId: PERIODO_LETIVO,
          aberto: true,
          dataFechamento: new Date(Date.now() + 7 * 86_400_000),
        },
      })
    ).id;

    // Faixa A: duas salas EaD, uma vaga cada — para provar a alocacao e a troca
    const salaA1 = await criarSala('REM-A1', 1);
    const salaA2 = await criarSala('REM-A2', 1);
    ({
      faixaId: faixaA,
      ofertas: [ofertaA1],
    } = await criarFaixa('2026-11-20', poloId, [
      { salaId: salaA1.id, modalidadeId: ead.id, vagas: 1, ordem: 1 },
      { salaId: salaA2.id, modalidadeId: ead.id, vagas: 1, ordem: 2 },
    ]));

    const salaB = await criarSala('REM-B', 5);
    ({ faixaId: faixaB } = await criarFaixa('2026-11-21', poloId, [
      { salaId: salaB.id, modalidadeId: ead.id, vagas: 5, ordem: 1 },
    ]));

    // Faixa que oferta OUTRA modalidade — o remanejo tem de recusar
    const salaS = await criarSala('REM-S', 5);
    ({
      ofertas: [ofertaSemi],
    } = await criarFaixa('2026-11-22', poloId, [
      { salaId: salaS.id, modalidadeId: semi.id, vagas: 5, ordem: 1 },
    ]));

    const salaOutro = await prisma.sala.create({
      data: { poloId: outroPoloId, nome: 'REM-X', capacidade: 5 },
    });
    ({ faixaId: faixaOutroPolo } = await criarFaixa('2026-11-23', outroPoloId, [
      { salaId: salaOutro.id, modalidadeId: ead.id, vagas: 5, ordem: 1 },
    ]));
  }, 60_000);

  afterAll(async () => {
    await limpar();
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  const criarSala = (nome: string, capacidade: number) =>
    prisma.sala.create({ data: { poloId, nome, capacidade } });

  async function criarFaixa(
    data: string,
    polo: number,
    salas: {
      salaId: number;
      modalidadeId: number;
      vagas: number;
      ordem: number;
    }[],
  ) {
    const faixa = await prisma.faixa.create({
      data: {
        poloId: polo,
        data: new Date(`${data}T00:00:00.000Z`),
        horaInicio: '08:30',
        horaFim: '11:30',
        salaFaixas: { create: salas },
      },
      include: { salaFaixas: { orderBy: { ordem: 'asc' } } },
    });

    return {
      faixaId: faixa.id,
      ofertas: faixa.salaFaixas.map((sf) => sf.id),
    };
  }

  async function criarAluno(sufixo: string) {
    const matricula = `${PREFIXO}${sufixo}`;

    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula,
        nome: `Aluno ${sufixo}`,
        curso: 'CURSO REMANEJO',
        statusCurso: 'Ativo',
        ativo: true,
        modalidadeId: ead.id,
        poloId,
      },
    });

    const { accessToken } = await auth.emitirTokenAluno({
      sub: matricula,
      userIdD2L: `d2l-${sufixo}`,
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
        titulo: 'Disciplina do Remanejo',
      },
    });

    return { token: accessToken, alunoId: aluno.id, matricula };
  }

  async function limpar() {
    await prisma.agendamento.deleteMany({
      where: { matricula: { startsWith: PREFIXO } },
    });

    const polos = await prisma.polo.findMany({
      where: { nome: { in: [POLO_NOME, OUTRO_POLO] } },
    });

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

  const agendar = async (t: string, faixaId: number) =>
    (
      await como(api().post('/api/portal/agendamentos'), t)
        .send({ faixaId })
        .expect(201)
    ).body;

  describe('o aluno troca de horario', () => {
    let aluno: { token: string; matricula: string };
    let agendamentoId: number;

    beforeAll(async () => {
      aluno = await criarAluno('TROCA');
      agendamentoId = (await agendar(aluno.token, faixaB)).id;
    });

    it('recusa trocar para o horario em que ja esta', async () => {
      await como(
        api().patch(`/api/portal/agendamentos/${agendamentoId}`),
        aluno.token,
      )
        .send({ faixaId: faixaB })
        .expect(409);
    });

    it('recusa trocar para horario de outro polo', async () => {
      await como(
        api().patch(`/api/portal/agendamentos/${agendamentoId}`),
        aluno.token,
      )
        .send({ faixaId: faixaOutroPolo })
        .expect(403);
    });

    it('troca e LIBERA a vaga antiga', async () => {
      const res = await como(
        api().patch(`/api/portal/agendamentos/${agendamentoId}`),
        aluno.token,
      )
        .send({ faixaId: faixaA })
        .expect(200);

      expect(res.body.sala.nome).toBe('REM-A1');

      const antiga = await prisma.agendamento.count({
        where: { salaFaixa: { faixaId: faixaB }, status: 'CONFIRMADO' },
      });

      expect(antiga).toBe(0);
    });

    it('a troca que NAO cabe deixa o aluno onde estava', async () => {
      // Enche as duas vagas da faixa A com outras pessoas
      const b = await criarAluno('TROCA-B');
      await agendar(b.token, faixaA); // pega a REM-A2 (a A1 e do aluno acima)

      const c = await criarAluno('TROCA-C');
      const doC = await agendar(c.token, faixaB);

      // C tenta ir para a faixa A, que agora esta cheia
      await como(api().patch(`/api/portal/agendamentos/${doC.id}`), c.token)
        .send({ faixaId: faixaA })
        .expect(409);

      // e continua exatamente onde estava
      const depois = await como(
        api().get('/api/portal/agendamentos'),
        c.token,
      ).expect(200);

      expect(depois.body[0].id).toBe(doC.id);
      expect(depois.body[0].sala.nome).toBe('REM-B');
    });

    it('nao deixa mexer no agendamento de outra pessoa', async () => {
      const intruso = await criarAluno('INTRUSO');

      await como(
        api().patch(`/api/portal/agendamentos/${agendamentoId}`),
        intruso.token,
      )
        .send({ faixaId: faixaB })
        .expect(403);

      await como(
        api().delete(`/api/portal/agendamentos/${agendamentoId}`),
        intruso.token,
      ).expect(403);
    });
  });

  describe('o aluno cancela', () => {
    it('cancela, devolve a vaga e permite marcar de novo', async () => {
      const aluno = await criarAluno('CANCELA');
      const ag = await agendar(aluno.token, faixaB);

      await como(
        api().delete(`/api/portal/agendamentos/${ag.id}`),
        aluno.token,
      ).expect(200);

      // some da lista do aluno
      const meus = await como(
        api().get('/api/portal/agendamentos'),
        aluno.token,
      ).expect(200);
      expect(meus.body).toHaveLength(0);

      // o registro NAO sumiu do banco — vira CANCELADO
      const registro = await prisma.agendamento.findUniqueOrThrow({
        where: { id: ag.id },
      });
      expect(registro.status).toBe('CANCELADO');

      // e da para marcar de novo
      await agendar(aluno.token, faixaB);
    });

    it('recusa cancelar duas vezes', async () => {
      const aluno = await criarAluno('CANCELA2');
      const ag = await agendar(aluno.token, faixaB);

      await como(
        api().delete(`/api/portal/agendamentos/${ag.id}`),
        aluno.token,
      ).expect(200);
      await como(
        api().delete(`/api/portal/agendamentos/${ag.id}`),
        aluno.token,
      ).expect(409);
    });

    /**
     * A duvida que isto trava: "cancelei todo mundo, por que a faixa nao apaga?".
     * Cancelado continua no banco (e a FK para SalaFaixa e Restrict), entao a
     * faixa segue bloqueada — mas a mensagem tem que DIZER que sao cancelados,
     * senao o admin acha que o sistema esta errado e fica tentando de novo.
     */
    it('faixa com agendamentos so CANCELADOS continua sem poder ser apagada, e a mensagem explica', async () => {
      const aluno = await criarAluno('SOCANCEL');
      const sala = await criarSala('SO-CANCEL', 2);
      const { faixaId } = await criarFaixa('2030-11-05', poloId, [
        { salaId: sala.id, modalidadeId: ead.id, vagas: 1, ordem: 1 },
      ]);

      const ag = await agendar(aluno.token, faixaId);
      await como(
        api().delete(`/api/portal/agendamentos/${ag.id}`),
        aluno.token,
      ).expect(200);

      const res = await comoAdmin(
        api().delete(`/api/faixas/${faixaId}`),
      ).expect(409);

      expect(res.body.message).toContain('CANCELADO');
      expect(res.body.message).toContain('ativo=false');

      // e o caminho que a mensagem indica funciona
      await comoAdmin(api().patch(`/api/faixas/${faixaId}`))
        .send({ ativo: false })
        .expect(200);
    });

    it('fora do prazo o aluno nao cancela nem troca sozinho', async () => {
      const aluno = await criarAluno('PRAZO');
      const ag = await agendar(aluno.token, faixaB);

      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: false },
      });

      await como(
        api().delete(`/api/portal/agendamentos/${ag.id}`),
        aluno.token,
      ).expect(403);
      await como(api().patch(`/api/portal/agendamentos/${ag.id}`), aluno.token)
        .send({ faixaId: faixaA })
        .expect(403);

      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: true },
      });
    });
  });

  describe('remanejo administrativo', () => {
    let agendamentoId: number;

    beforeAll(async () => {
      const aluno = await criarAluno('ADM');
      agendamentoId = (await agendar(aluno.token, faixaB)).id;
    });

    it('exige exatamente um destino', async () => {
      await comoAdmin(
        api().patch(`/api/agendamentos/${agendamentoId}/remanejar`),
      )
        .send({})
        .expect(400);

      await comoAdmin(
        api().patch(`/api/agendamentos/${agendamentoId}/remanejar`),
      )
        .send({ faixaId: faixaB, salaFaixaId: ofertaA1 })
        .expect(400);
    });

    it('RECUSA remanejar para outro polo', async () => {
      const res = await comoAdmin(
        api().patch(`/api/agendamentos/${agendamentoId}/remanejar`),
      )
        .send({ faixaId: faixaOutroPolo })
        .expect(400);

      expect(res.body.message).toMatch(/polo/i);
    });

    it('RECUSA remanejar para sala de outra modalidade', async () => {
      const res = await comoAdmin(
        api().patch(`/api/agendamentos/${agendamentoId}/remanejar`),
      )
        .send({ salaFaixaId: ofertaSemi })
        .expect(400);

      expect(res.body.message).toMatch(/modalidade/i);
    });

    it('RECUSA sala lotada', async () => {
      // ofertaA1 e ofertaA2 tem 1 vaga cada e ja foram tomadas
      const res = await comoAdmin(
        api().patch(`/api/agendamentos/${agendamentoId}/remanejar`),
      )
        .send({ salaFaixaId: ofertaA1 })
        .expect(409);

      expect(res.body.message).toMatch(/lugares ocupados/i);
    });

    it('move para a sala escolhida e marca alocadoManual', async () => {
      const nova = await criarSala('REM-MANUAL', 2);
      const { ofertas } = await criarFaixa('2026-11-25', poloId, [
        { salaId: nova.id, modalidadeId: ead.id, vagas: 2, ordem: 1 },
      ]);

      const res = await comoAdmin(
        api().patch(`/api/agendamentos/${agendamentoId}/remanejar`),
      )
        .send({ salaFaixaId: ofertas[0] })
        .expect(200);

      expect(res.body).toMatchObject({
        sala: 'REM-MANUAL',
        alocadoManual: true,
      });
    });

    it('funciona com o periodo FECHADO — e o caso de uso', async () => {
      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: false },
      });

      await comoAdmin(
        api().patch(`/api/agendamentos/${agendamentoId}/remanejar`),
      )
        .send({ faixaId: faixaB })
        .expect(200);

      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: true },
      });
    });

    it('o admin cancela e a vaga volta', async () => {
      const antes = await comoAdmin(
        api().get(`/api/agendamentos/resumo?faixaId=${faixaB}`),
      ).expect(200);

      await comoAdmin(
        api().delete(`/api/agendamentos/${agendamentoId}`),
      ).expect(200);

      const depois = await comoAdmin(
        api().get(`/api/agendamentos/resumo?faixaId=${faixaB}`),
      ).expect(200);

      expect(depois.body[0].ocupadas).toBe(antes.body[0].ocupadas - 1);
    });

    it('nao remaneja agendamento cancelado', async () => {
      await comoAdmin(
        api().patch(`/api/agendamentos/${agendamentoId}/remanejar`),
      )
        .send({ faixaId: faixaA })
        .expect(409);
    });

    it('o cancelado sai da listagem padrao mas aparece com o filtro', async () => {
      const padrao = await comoAdmin(
        api().get(`/api/agendamentos?busca=${PREFIXO}ADM`),
      ).expect(200);
      expect(padrao.body.total).toBe(0);

      const cancelados = await comoAdmin(
        api().get(`/api/agendamentos?busca=${PREFIXO}ADM&status=CANCELADO`),
      ).expect(200);
      expect(cancelados.body.total).toBe(1);
      expect(cancelados.body.itens[0].matricula).toBe(`${PREFIXO}ADM`);
      expect(cancelados.body.itens[0].status).toBe('CANCELADO');
    });
  });

  describe('HISTORICO: quem alterou o agendamento', () => {
    it('registra o aluno quando foi o proprio aluno', async () => {
      const aluno = await criarAluno('HIST-A');
      const ag = await agendar(aluno.token, faixaB);

      const nova = await criarSala('HIST-DEST', 3);
      const { faixaId } = await criarFaixa('2026-11-27', poloId, [
        { salaId: nova.id, modalidadeId: ead.id, vagas: 3, ordem: 1 },
      ]);

      await como(api().patch(`/api/portal/agendamentos/${ag.id}`), aluno.token)
        .send({ faixaId })
        .expect(200);

      const res = await comoAdmin(
        api().get(`/api/agendamentos/${ag.id}/historico`),
      ).expect(200);

      // mais recente primeiro
      expect(res.body[0]).toMatchObject({
        evento: 'TROCADO',
        autorTipo: 'ALUNO',
        autor: `${PREFIXO}HIST-A`,
      });
      expect(res.body[0].de).toMatch(/REM-B/);
      expect(res.body[0].para).toMatch(/HIST-DEST/);

      expect(res.body[1]).toMatchObject({
        evento: 'CRIADO',
        autorTipo: 'ALUNO',
      });
    });

    it('registra o administrador, com o e-mail, quando foi ele', async () => {
      const aluno = await criarAluno('HIST-B');
      const ag = await agendar(aluno.token, faixaB);

      const nova = await criarSala('HIST-ADM', 3);
      const { ofertas } = await criarFaixa('2026-11-28', poloId, [
        { salaId: nova.id, modalidadeId: ead.id, vagas: 3, ordem: 1 },
      ]);

      await comoAdmin(api().patch(`/api/agendamentos/${ag.id}/remanejar`))
        .send({ salaFaixaId: ofertas[0] })
        .expect(200);

      const res = await comoAdmin(
        api().get(`/api/agendamentos/${ag.id}/historico`),
      ).expect(200);

      expect(res.body[0]).toMatchObject({
        evento: 'REMANEJADO',
        autorTipo: 'ADMIN',
        autor: EMAIL,
      });
      expect(res.body[0].para).toMatch(/HIST-ADM/);
    });

    it('distingue os dois numa mesma linha do tempo', async () => {
      const aluno = await criarAluno('HIST-C');
      const ag = await agendar(aluno.token, faixaB);

      const s1 = await criarSala('HIST-C1', 3);
      const f1 = await criarFaixa('2026-11-29', poloId, [
        { salaId: s1.id, modalidadeId: ead.id, vagas: 3, ordem: 1 },
      ]);

      // o aluno troca...
      await como(api().patch(`/api/portal/agendamentos/${ag.id}`), aluno.token)
        .send({ faixaId: f1.faixaId })
        .expect(200);

      // ...e depois o admin remaneja de volta
      await comoAdmin(api().patch(`/api/agendamentos/${ag.id}/remanejar`))
        .send({ faixaId: faixaB })
        .expect(200);

      const res = await comoAdmin(
        api().get(`/api/agendamentos/${ag.id}/historico`),
      ).expect(200);

      expect(
        res.body.map((e: { evento: string; autorTipo: string }) => [
          e.evento,
          e.autorTipo,
        ]),
      ).toEqual([
        ['REMANEJADO', 'ADMIN'],
        ['TROCADO', 'ALUNO'],
        ['CRIADO', 'ALUNO'],
      ]);
    });

    it('registra o cancelamento com o autor certo', async () => {
      const doAluno = await criarAluno('HIST-D');
      const ag1 = await agendar(doAluno.token, faixaB);
      await como(
        api().delete(`/api/portal/agendamentos/${ag1.id}`),
        doAluno.token,
      ).expect(200);

      const h1 = await comoAdmin(
        api().get(`/api/agendamentos/${ag1.id}/historico`),
      ).expect(200);
      expect(h1.body[0]).toMatchObject({
        evento: 'CANCELADO',
        autorTipo: 'ALUNO',
      });

      const doAdmin = await criarAluno('HIST-E');
      const ag2 = await agendar(doAdmin.token, faixaB);
      await comoAdmin(api().delete(`/api/agendamentos/${ag2.id}`)).expect(200);

      const h2 = await comoAdmin(
        api().get(`/api/agendamentos/${ag2.id}/historico`),
      ).expect(200);
      expect(h2.body[0]).toMatchObject({
        evento: 'CANCELADO',
        autorTipo: 'ADMIN',
        autor: EMAIL,
      });
    });

    it('404 para agendamento inexistente', async () => {
      await comoAdmin(api().get('/api/agendamentos/99999999/historico')).expect(
        404,
      );
    });

    it('o historico e do admin — o aluno nao acessa', async () => {
      const aluno = await criarAluno('HIST-F');
      const ag = await agendar(aluno.token, faixaB);

      await como(
        api().get(`/api/agendamentos/${ag.id}/historico`),
        aluno.token,
      ).expect(401);
    });
  });

  describe('o aluno so enxerga o periodo VIGENTE', () => {
    it('nao lista nem deixa cancelar prova de periodo anterior', async () => {
      const sala = await criarSala('PER-ANTIGO', 3);
      const { faixaId } = await criarFaixa('2026-12-01', poloId, [
        { salaId: sala.id, modalidadeId: ead.id, vagas: 3, ordem: 1 },
      ]);

      const aluno = await criarAluno('ANTIGO');
      const ag = await agendar(aluno.token, faixaId);

      // Chega o semestre seguinte: um periodo novo vira o vigente.
      const novo = await prisma.periodoAgendamento.create({
        data: {
          periodoLetivoId: `${PERIODO_LETIVO}-B`,
          aberto: true,
          dataFechamento: new Date(Date.now() + 7 * 86_400_000),
        },
      });

      try {
        // a prova do semestre passado some da lista dele
        const meus = await como(
          api().get('/api/portal/agendamentos'),
          aluno.token,
        ).expect(200);
        expect(meus.body).toHaveLength(0);

        // e ele nao consegue cancelar nem trocar uma prova que ja aconteceu
        await como(
          api().delete(`/api/portal/agendamentos/${ag.id}`),
          aluno.token,
        ).expect(404);

        await como(
          api().patch(`/api/portal/agendamentos/${ag.id}`),
          aluno.token,
        )
          .send({ faixaId: faixaA })
          .expect(404);

        // mas o admin continua vendo tudo
        await comoAdmin(api().get(`/api/agendamentos/${ag.id}`)).expect(200);
      } finally {
        await prisma.periodoAgendamento.delete({ where: { id: novo.id } });
      }
    });

    it('prazo fechado NAO esconde a prova do aluno', async () => {
      const sala = await criarSala('PER-FECHADO', 3);
      const { faixaId } = await criarFaixa('2026-12-02', poloId, [
        { salaId: sala.id, modalidadeId: ead.id, vagas: 3, ordem: 1 },
      ]);

      const aluno = await criarAluno('VE-FECHADO');
      await agendar(aluno.token, faixaId);

      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: false },
      });

      try {
        // fechar tranca a escolha, nao a consulta: ele precisa saber onde e quando
        const meus = await como(
          api().get('/api/portal/agendamentos'),
          aluno.token,
        ).expect(200);

        expect(meus.body).toHaveLength(1);
        expect(meus.body[0].sala.nome).toBe('PER-FECHADO');
      } finally {
        await prisma.periodoAgendamento.update({
          where: { id: periodoId },
          data: { aberto: true },
        });
      }
    });
  });

  describe('protecao das rotas', () => {
    it('remanejo e cancelamento exigem admin', async () => {
      await api()
        .patch('/api/agendamentos/1/remanejar')
        .send({ faixaId: 1 })
        .expect(401);
      await api().delete('/api/agendamentos/1').expect(401);
    });

    it('troca e cancelamento do portal exigem aluno', async () => {
      await api()
        .patch('/api/portal/agendamentos/1')
        .send({ faixaId: 1 })
        .expect(401);
      await api().delete('/api/portal/agendamentos/1').expect(401);
    });
  });
});
