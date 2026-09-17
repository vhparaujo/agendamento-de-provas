import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/service/auth.service';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Troca pelo aluno, remanejo e cancelamento pelo admin.
 *
 * O que estes testes protegem: a vaga tem de ser devolvida quando alguem sai, e
 * a troca nao pode deixar o aluno sem horario nenhum.
 *
 * **O aluno nao cancela** (17/08/2026): a troca e a unica alteracao dele, e
 * `DELETE /portal/agendamentos/:id` nao existe mais. Todo cancelamento daqui
 * para baixo passa por `DELETE /agendamentos/:id`, do admin — inclusive quando o
 * teste so precisa de um agendamento CANCELADO como cenario.
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

    // Faixa que oferta OUTRO formato — o remanejo tem de recusar
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
    });
  });

  describe('o aluno NAO cancela', () => {
    /**
     * A trava da decisao de 17/08/2026. Tirar o botao da tela e deixar o
     * endpoint de pe manteria a regra valendo em um lugar so: com o token do
     * aluno na mao, um DELETE ainda devolveria a vaga dele.
     *
     * 404 e o que o roteador do Nest responde para rota inexistente — e e a
     * afirmacao que este caso quer: nao existe cancelamento pelo portal.
     */
    it('a rota de cancelamento do portal nao existe mais', async () => {
      const aluno = await criarAluno('SEMCANCEL');
      const ag = await agendar(aluno.token, faixaB);

      await como(
        api().delete(`/api/portal/agendamentos/${ag.id}`),
        aluno.token,
      ).expect(404);

      // e a prova continua de pe, no mesmo lugar
      const registro = await prisma.agendamento.findUniqueOrThrow({
        where: { id: ag.id },
      });
      expect(registro.status).toBe('CONFIRMADO');

      const meus = await como(
        api().get('/api/portal/agendamentos'),
        aluno.token,
      ).expect(200);
      expect(meus.body).toHaveLength(1);
    });

    /**
     * O aluno perdeu o cancelamento, e a vaga continua tendo de voltar quando
     * alguem sai — agora pela unica porta que restou, a da secretaria.
     */
    it('o cancelamento do admin devolve a vaga, e o aluno pode marcar de novo', async () => {
      const aluno = await criarAluno('CANCELA');
      const ag = await agendar(aluno.token, faixaB);

      await comoAdmin(api().delete(`/api/agendamentos/${ag.id}`)).expect(200);

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
      await comoAdmin(api().delete(`/api/agendamentos/${ag.id}`)).expect(200);

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

    it('fora do prazo o aluno nao troca sozinho', async () => {
      const aluno = await criarAluno('PRAZO');
      const ag = await agendar(aluno.token, faixaB);

      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: false },
      });

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

    it('RECUSA remanejar para sala de outro formato', async () => {
      const res = await comoAdmin(
        api().patch(`/api/agendamentos/${agendamentoId}/remanejar`),
      )
        .send({ salaFaixaId: ofertaSemi })
        .expect(400);

      expect(res.body.message).toMatch(/formato/i);
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

  /**
   * ==========================================================================
   * O RA COM DOIS CURSOS NAO FAZ AS DUAS PROVAS AO MESMO TEMPO
   * ==========================================================================
   * Regra do cliente, 14/08/2026. O portal recusa, e o REMANEJO tambem — mover
   * o aluno para o horario da outra prova dele criaria em silencio exatamente
   * o estado que a regra existe para evitar. Nao trava a secretaria: basta
   * mover primeiro a outra prova, e o teste abaixo prova esse caminho.
   */
  describe('dois vinculos do mesmo RA no mesmo horario', () => {
    const RA = `${PREFIXO}DOIS`;

    let pedagogia: number;
    let psicologia: number;
    let daPedagogia: number;
    let daPsicologia: number;
    let faixaLivre: number;

    beforeAll(async () => {
      const criarVinculo = async (curso: string) =>
        prisma.alunoImportado.create({
          data: {
            matricula: RA,
            nome: 'Aluno de Dois Cursos',
            curso,
            statusCurso: 'Ativo',
            ativo: true,
            modalidadeId: ead.id,
            poloId,
          },
        });

      pedagogia = (await criarVinculo('PEDAGOGIA REMANEJO')).id;
      psicologia = (await criarVinculo('PSICOLOGIA REMANEJO')).id;

      // Duas faixas com folga, para que a recusa nunca possa ser confundida
      // com falta de vaga.
      const sala1 = await criarSala('REM-DOIS-1', 10);
      const sala2 = await criarSala('REM-DOIS-2', 10);

      const ocupada = await criarFaixa('2026-12-01', poloId, [
        { salaId: sala1.id, modalidadeId: ead.id, vagas: 10, ordem: 1 },
      ]);
      const livre = await criarFaixa('2026-12-02', poloId, [
        { salaId: sala2.id, modalidadeId: ead.id, vagas: 10, ordem: 1 },
      ]);

      faixaLivre = livre.faixaId;

      const criarAgendamento = async (alunoId: number, salaFaixaId: number) =>
        (
          await prisma.agendamento.create({
            data: {
              alunoId,
              salaFaixaId,
              matricula: RA,
              userIdD2L: 'd2l-dois-remanejo',
              periodoLetivoId: PERIODO_LETIVO,
              rodada: 'N2',
              modalidadeId: ead.id,
              poloId,
            },
            select: { id: true },
          })
        ).id;

      // Cada curso no seu horario — o estado correto.
      daPedagogia = await criarAgendamento(pedagogia, ocupada.ofertas[0]);
      daPsicologia = await criarAgendamento(psicologia, livre.ofertas[0]);
    });

    it('RECUSA mover para o horario onde a MESMA PESSOA ja tem a outra prova', async () => {
      const res = await comoAdmin(
        api().patch(`/api/agendamentos/${daPsicologia}/remanejar`),
      )
        // A faixa da prova de PEDAGOGIA, com 9 vagas livres.
        .send({ faixaId: (await faixaDe(daPedagogia)).faixaId })
        .expect(409);

      expect(res.body.message).toMatch(/ja tem prova marcada neste horario/i);
      expect(res.body.message).toMatch(/PEDAGOGIA REMANEJO/);
    });

    it('nao confunde o agendamento com ELE MESMO ao remanejar de sala', async () => {
      // Mover dentro da propria faixa: o `exceto` e o que impede a reserva de
      // conflitar consigo mesma e devolver 409 sem motivo.
      const outra = await criarSala('REM-DOIS-3', 10);

      await prisma.salaFaixa.create({
        data: {
          salaId: outra.id,
          faixaId: faixaLivre,
          modalidadeId: ead.id,
          vagas: 10,
          ordem: 2,
        },
      });

      await comoAdmin(
        api().patch(`/api/agendamentos/${daPsicologia}/remanejar`),
      )
        .send({ faixaId: faixaLivre })
        .expect(200);
    });

    it('libera depois que a outra prova sai da frente', async () => {
      const alvo = (await faixaDe(daPedagogia)).faixaId;

      // A secretaria move primeiro a de PEDAGOGIA para o horario livre...
      await comoAdmin(api().patch(`/api/agendamentos/${daPedagogia}/remanejar`))
        .send({ faixaId: faixaLivre })
        .expect(409);

      // ...e ate isso e recusado, porque PSICOLOGIA esta la. E o par completo:
      // os dois horarios estao tomados um por cada curso, e a regra segura os
      // dois lados. Um terceiro horario resolve.
      const sala = await criarSala('REM-DOIS-4', 10);
      const terceira = await criarFaixa('2026-12-03', poloId, [
        { salaId: sala.id, modalidadeId: ead.id, vagas: 10, ordem: 1 },
      ]);

      await comoAdmin(api().patch(`/api/agendamentos/${daPedagogia}/remanejar`))
        .send({ faixaId: terceira.faixaId })
        .expect(200);

      // Agora o horario antigo de PEDAGOGIA esta vazio e aceita PSICOLOGIA.
      await comoAdmin(
        api().patch(`/api/agendamentos/${daPsicologia}/remanejar`),
      )
        .send({ faixaId: alvo })
        .expect(200);
    });

    /** A faixa em que um agendamento esta agora. */
    async function faixaDe(agendamentoId: number) {
      const { salaFaixa } = await prisma.agendamento.findUniqueOrThrow({
        where: { id: agendamentoId },
        select: { salaFaixa: { select: { faixaId: true } } },
      });

      return salaFaixa;
    }
  });

  describe('HISTORICO: quem alterou o agendamento', () => {
    /**
     * Faixa so deste bloco, com folga — pela mesma razao do bloco do
     * agendamento administrativo. A `faixaHistorico` compartilhada tem 5 vagas e chega
     * aqui praticamente cheia: os casos daqui pediam mais reservas do que
     * sobrava, e o 409 de "vagas esgotadas" aparecia como se o historico
     * estivesse quebrado, longe da causa.
     */
    let faixaHistorico: number;

    beforeAll(async () => {
      const sala = await criarSala('HIST-BASE', 30);
      ({ faixaId: faixaHistorico } = await criarFaixa('2027-04-10', poloId, [
        { salaId: sala.id, modalidadeId: ead.id, vagas: 30, ordem: 1 },
      ]));
    });

    it('registra o aluno quando foi o proprio aluno', async () => {
      const aluno = await criarAluno('HIST-A');
      const ag = await agendar(aluno.token, faixaHistorico);

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
      expect(res.body[0].de).toMatch(/HIST-BASE/);
      expect(res.body[0].para).toMatch(/HIST-DEST/);

      expect(res.body[1]).toMatchObject({
        evento: 'CRIADO',
        autorTipo: 'ALUNO',
      });
    });

    it('registra o administrador, com o e-mail, quando foi ele', async () => {
      const aluno = await criarAluno('HIST-B');
      const ag = await agendar(aluno.token, faixaHistorico);

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
      const ag = await agendar(aluno.token, faixaHistorico);

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
        .send({ faixaId: faixaHistorico })
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

    /**
     * Todo CANCELADO e de ADMIN desde 17/08/2026 — nao ha mais como o aluno
     * cancelar. E exatamente o que a secretaria precisa poder mostrar no balcao:
     * "cancelaram minha prova" tem um e-mail com nome e sobrenome do outro lado.
     */
    it('registra o cancelamento com o e-mail de quem cancelou', async () => {
      const aluno = await criarAluno('HIST-E');
      const ag = await agendar(aluno.token, faixaHistorico);
      await comoAdmin(api().delete(`/api/agendamentos/${ag.id}`)).expect(200);

      const h = await comoAdmin(
        api().get(`/api/agendamentos/${ag.id}/historico`),
      ).expect(200);
      expect(h.body[0]).toMatchObject({
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
      const ag = await agendar(aluno.token, faixaHistorico);

      await como(
        api().get(`/api/agendamentos/${ag.id}/historico`),
        aluno.token,
      ).expect(401);
    });
  });

  describe('o aluno so enxerga o periodo VIGENTE', () => {
    it('nao lista nem deixa trocar prova de periodo anterior', async () => {
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

        // e ele nao consegue trocar o horario de uma prova que ja aconteceu
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

  /**
   * ==========================================================================
   * O ADMIN AGENDA POR UM ALUNO ESPECIFICO
   * ==========================================================================
   * A outra ponta do compulsorio: uma pessoa, no balcao, em vez do lote inteiro.
   *
   * Estes testes rodam com `D2L_HABILITADO=false` (fixado em test/setup-e2e.ts;
   * o default do codigo virou `true` em 18/08/2026), entao todos
   * passam pelo caminho da RESERVA_ANTERIOR. E de proposito: e o caminho que a
   * secretaria mais usa (quem cancelou e nao remarcou) e o unico que funciona
   * sem a Valence de pe.
   */
  describe('agendamento administrativo (POST /agendamentos)', () => {
    let faixaAdmin: number;
    let ofertaAdmin: number;

    /**
     * Faixa so deste bloco, com folga.
     *
     * A `faixaB` compartilhada tem 5 vagas e chega aqui ocupada pelos testes de
     * cima — e uma reserva a menos do que o esperado transformaria "o admin
     * agendou" em "409 sem motivo aparente", varias vezes, longe da causa.
     */
    let faixaOrigem: number;

    beforeAll(async () => {
      const sala = await criarSala('ADM-NOVO', 30);
      const criada = await criarFaixa('2027-03-10', poloId, [
        { salaId: sala.id, modalidadeId: ead.id, vagas: 30, ordem: 1 },
      ]);

      faixaAdmin = criada.faixaId;
      ofertaAdmin = criada.ofertas[0];

      const origem = await criarSala('ADM-ORIGEM', 30);
      ({ faixaId: faixaOrigem } = await criarFaixa('2027-03-09', poloId, [
        { salaId: origem.id, modalidadeId: ead.id, vagas: 30, ordem: 1 },
      ]));
    });

    /**
     * Agenda pelo portal e a secretaria cancela: e assim que nasce a reserva
     * anterior de onde esta rota copia as disciplinas.
     *
     * O cancelamento e do ADMIN porque e o unico que existe (17/08/2026) — o que
     * nao muda o cenario: a fotografia das disciplinas fica no agendamento
     * cancelado do mesmo jeito, independentemente de quem apertou o botao.
     */
    async function alunoQueCancelou(sufixo: string) {
      const aluno = await criarAluno(sufixo);
      const ag = await agendar(aluno.token, faixaOrigem);

      await comoAdmin(api().delete(`/api/agendamentos/${ag.id}`)).expect(200);

      return aluno;
    }

    it('exige exatamente um destino', async () => {
      const aluno = await alunoQueCancelou('POST-DEST');

      await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId })
        .expect(400);

      await comoAdmin(api().post('/api/agendamentos'))
        .send({
          alunoId: aluno.alunoId,
          faixaId: faixaAdmin,
          salaFaixaId: ofertaAdmin,
        })
        .expect(400);
    });

    it('404 para vinculo inexistente', async () => {
      await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: 99_999_999, faixaId: faixaAdmin })
        .expect(404);
    });

    /**
     * Sem a Valence e sem reserva anterior nao ha de onde tirar as disciplinas —
     * e `userIdD2L` e coluna obrigatoria. Recusar com o motivo escrito e melhor
     * que gravar uma prova que nao cobre disciplina nenhuma.
     */
    it('RECUSA quem nunca agendou, quando nao ha de onde tirar as disciplinas', async () => {
      const aluno = await criarAluno('POST-SEMDISC');

      const res = await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, faixaId: faixaAdmin })
        .expect(409);

      expect(res.body.message).toMatch(/reserva anterior/i);
    });

    it('agenda deixando a alocacao escolher a sala, como ADMIN e alocadoManual', async () => {
      const aluno = await alunoQueCancelou('POST-AUTO');

      const res = await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, faixaId: faixaAdmin })
        .expect(201);

      expect(res.body).toMatchObject({
        origemDasDisciplinas: 'RESERVA_ANTERIOR',
        agendamento: { sala: 'ADM-NOVO', alocadoManual: true },
      });

      // As disciplinas vieram junto — sem elas a prova nao libera nada no LMS.
      expect(res.body.agendamento.disciplinas.length).toBeGreaterThan(0);

      const historico = await comoAdmin(
        api().get(`/api/agendamentos/${res.body.agendamento.id}/historico`),
      ).expect(200);

      expect(historico.body[0]).toMatchObject({
        evento: 'CRIADO',
        autorTipo: 'ADMIN',
        autor: EMAIL,
      });
    });

    it('agenda na SALA escolhida pelo admin', async () => {
      const aluno = await alunoQueCancelou('POST-SALA');
      const outra = await criarSala('ADM-ESCOLHIDA', 5);

      const { ofertas } = await criarFaixa('2027-03-11', poloId, [
        { salaId: outra.id, modalidadeId: ead.id, vagas: 5, ordem: 1 },
      ]);

      const res = await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, salaFaixaId: ofertas[0] })
        .expect(201);

      expect(res.body.agendamento.sala).toBe('ADM-ESCOLHIDA');
    });

    it('RECUSA polo e formato diferentes do aluno', async () => {
      const aluno = await alunoQueCancelou('POST-INCOMP');

      const doPolo = await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, faixaId: faixaOutroPolo })
        .expect(400);
      expect(doPolo.body.message).toMatch(/polo/i);

      const daModalidade = await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, salaFaixaId: ofertaSemi })
        .expect(400);
      expect(daModalidade.body.message).toMatch(/formato/i);
    });

    it('RECUSA sala lotada', async () => {
      const aluno = await alunoQueCancelou('POST-LOTADA');
      const cheia = await criarSala('ADM-LOTADA', 1);

      const { ofertas } = await criarFaixa('2027-03-12', poloId, [
        { salaId: cheia.id, modalidadeId: ead.id, vagas: 1, ordem: 1 },
      ]);

      const outro = await alunoQueCancelou('POST-LOTADA-B');
      await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: outro.alunoId, salaFaixaId: ofertas[0] })
        .expect(201);

      const res = await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, salaFaixaId: ofertas[0] })
        .expect(409);

      expect(res.body.message).toMatch(/lugares ocupados/i);
    });

    it('RECUSA quem ja tem prova no semestre, mandando usar o remanejo', async () => {
      const aluno = await alunoQueCancelou('POST-JATEM');

      await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, faixaId: faixaAdmin })
        .expect(201);

      const res = await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, faixaId: faixaAdmin })
        .expect(409);

      expect(res.body.message).toMatch(/remanejo/i);
    });

    /**
     * A situacao do curso bloqueia por padrao (como no portal) e libera com uma
     * decisao EXPLICITA — que volta em `avisos` e vai para a auditoria. Sem a
     * saida, a secretaria ficaria travada justamente no caso em que precisa da
     * valvula de escape.
     */
    it('RECUSA statusCurso bloqueado, e agenda com ignorarStatusCurso avisando', async () => {
      const aluno = await alunoQueCancelou('POST-TRANCADO');

      await prisma.alunoImportado.update({
        where: { id: aluno.alunoId },
        data: { statusCurso: 'Trancado', ativo: false },
      });

      const recusa = await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, faixaId: faixaAdmin })
        .expect(409);
      expect(recusa.body.message).toMatch(/Trancado/);

      const res = await comoAdmin(api().post('/api/agendamentos'))
        .send({
          alunoId: aluno.alunoId,
          faixaId: faixaAdmin,
          ignorarStatusCurso: true,
        })
        .expect(201);

      expect(res.body.avisos.join(' ')).toMatch(/Trancado/);
    });

    it('funciona com o periodo FECHADO — e o caso de uso', async () => {
      const aluno = await alunoQueCancelou('POST-FECHADO');

      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: false },
      });

      try {
        await comoAdmin(api().post('/api/agendamentos'))
          .send({ alunoId: aluno.alunoId, faixaId: faixaAdmin })
          .expect(201);
      } finally {
        await prisma.periodoAgendamento.update({
          where: { id: periodoId },
          data: { aberto: true },
        });
      }
    });

    /** Regra 4b: uma prova por PESSOA em cada horario, o admin inclusive. */
    it('RECUSA a segunda prova da MESMA PESSOA no mesmo horario', async () => {
      const aluno = await alunoQueCancelou('POST-DOIS');

      const outroCurso = await prisma.alunoImportado.create({
        data: {
          matricula: aluno.matricula,
          nome: 'Aluno de Dois Cursos (POST)',
          curso: 'SEGUNDO CURSO POST',
          statusCurso: 'Ativo',
          ativo: true,
          modalidadeId: ead.id,
          poloId,
        },
      });

      await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: aluno.alunoId, faixaId: faixaAdmin })
        .expect(201);

      // O segundo vinculo herda as disciplinas da reserva do primeiro (a busca
      // e por MATRICULA), o que isola a recusa na regra do horario em vez de
      // parar antes, em "sem disciplina de onde copiar".
      const res = await comoAdmin(api().post('/api/agendamentos'))
        .send({ alunoId: outroCurso.id, faixaId: faixaAdmin })
        .expect(409);

      expect(res.body.message).toMatch(/ja tem prova marcada neste horario/i);
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

    it('o agendamento administrativo exige admin', async () => {
      await api()
        .post('/api/agendamentos')
        .send({ alunoId: 1, faixaId: 1 })
        .expect(401);
    });

    it('a troca do portal exige aluno', async () => {
      await api()
        .patch('/api/portal/agendamentos/1')
        .send({ faixaId: 1 })
        .expect(401);
    });
  });
});
