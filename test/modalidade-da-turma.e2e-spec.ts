import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

/**
 * ============================================================================
 * O DESEMPATE DA TURMA AMBIGUA, pela porta HTTP
 * ============================================================================
 *
 * O caso real de 10/09/2026: uma turma com EAD (583) e MODULAR (1). Sem
 * formato derivavel ela fica de fora do lote de datas, e a prova continua no
 * horario antigo — para os 583 tanto quanto para o 1.
 *
 * O que estas rotas precisam provar NAO e que gravam e leem. E que continuam
 * dizendo NAO nos casos em que o sistema se recusa a escolher:
 *
 *  - turma que nao esta ambigua (o formato ja se deriva sozinha);
 *  - turma sem agendamento nenhum (nao e ambiguidade, e ausencia);
 *  - formato sem nenhum aluno com prova ali.
 *
 * Sem essas tres, a rota seria "definir o formato de qualquer turma" — a
 * coluna de cadastro que a decisao de 10/08/2026 recusou, com outro nome.
 *
 * ⚠️ **Estas rotas nao dependem do Brightspace**, ao contrario de
 * `GET /senhas-de-prova/turmas`: elas so leem agendamentos e gravam a decisao.
 * Por isso rodam com `D2L_HABILITADO=false`, que e o default do e2e.
 */
describe('Formato escolhido da turma ambigua (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;

  const EMAIL = 'e2e-modalidade-turma@ucb.br';
  const SENHA_ADMIN = 'senha-do-teste-123';
  const POLO_NOME = 'Polo E2E Formato Da Turma';
  const PERIODO_LETIVO = 'e2e-mod-turma-103';
  const RODADA = 'N2';

  /** A turma disputada, e uma segunda com um formato so. */
  const ORG_AMBIGUA = 'ou-e2e-mod-ambigua';
  const ORG_UNANIME = 'ou-e2e-mod-unanime';
  const ORG_SEM_PROVA = 'ou-e2e-mod-sem-prova';
  const CODIGO_AMBIGUA = 'E2EMOD-AMB';
  const CODIGO_UNANIME = 'E2EMOD-UNI';
  const CODIGO_SEM_PROVA = 'E2EMOD-VAZIA';
  const CODIGO_SEM_ORGUNIT = 'E2EMOD-SEM-OU';

  let turmaAmbiguaId: number;
  let turmaUnanimeId: number;
  let turmaSemProvaId: number;
  let turmaSemOrgUnitId: number;
  let eadId: number;
  let modularId: number;
  let semiId: number;

  const api = () => request(app.getHttpServer());
  const comoAdmin = <T extends request.Test>(r: T) =>
    r.set('Authorization', `Bearer ${token}`);

  const rota = (turmaId: number) =>
    `/api/senhas-de-prova/turmas/${turmaId}/modalidade`;

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

    await limpar();

    await prisma.admin.create({
      data: {
        email: EMAIL,
        senhaHash: await bcrypt.hash(SENHA_ADMIN, 10),
        mustChangePassword: false,
      },
    });

    token = (
      await api()
        .post('/api/auth/login')
        .send({ email: EMAIL, senha: SENHA_ADMIN })
        .expect(200)
    ).body.accessToken;

    const modalidades = await prisma.modalidade.findMany({
      where: { codigo: { in: ['EAD', 'MODULAR', 'SEMI'] } },
    });

    eadId = modalidades.find((m) => m.codigo === 'EAD')!.id;
    modularId = modalidades.find((m) => m.codigo === 'MODULAR')!.id;
    semiId = modalidades.find((m) => m.codigo === 'SEMI')!.id;

    const polo = await prisma.polo.create({ data: { nome: POLO_NOME } });
    const sala = await prisma.sala.create({
      data: { poloId: polo.id, nome: 'E2EMOD-101', capacidade: 10 },
    });

    const faixa = await prisma.faixa.create({
      data: {
        poloId: polo.id,
        data: new Date('2099-11-20T00:00:00.000Z'),
        horaInicio: '09:00',
        horaFim: '12:00',
        salaFaixas: {
          create: [
            { salaId: sala.id, modalidadeId: eadId, vagas: 10, ordem: 1 },
          ],
        },
      },
      include: { salaFaixas: true },
    });

    const salaFaixaId = faixa.salaFaixas[0].id;

    // O vigente e o cadastrado mais recentemente — por isso este vem por ultimo
    // no beforeAll de qualquer suite. `maxWorkers: 1` garante a serie.
    await prisma.periodoAgendamento.create({
      data: {
        periodoLetivoId: PERIODO_LETIVO,
        rodada: RODADA,
        aberto: false,
        dataFechamento: new Date('2099-11-01T23:59:00.000Z'),
      },
    });

    const turmas = await Promise.all(
      [
        { codigoTurma: CODIGO_AMBIGUA, orgUnitId: ORG_AMBIGUA },
        { codigoTurma: CODIGO_UNANIME, orgUnitId: ORG_UNANIME },
        { codigoTurma: CODIGO_SEM_PROVA, orgUnitId: ORG_SEM_PROVA },
        // A que nem chegou ao lote: sem orgUnitId ela e uma `naoResolvida`.
        { codigoTurma: CODIGO_SEM_ORGUNIT, orgUnitId: null },
      ].map((t) =>
        prisma.turmaImportada.create({
          data: { ...t, nomeDisciplina: `DISCIPLINA ${t.codigoTurma}` },
        }),
      ),
    );

    [turmaAmbiguaId, turmaUnanimeId, turmaSemProvaId, turmaSemOrgUnitId] =
      turmas.map((t) => t.id);

    // 583 x 1 na turma ambigua — a proporcao real que motivou o recurso, em
    // escala: o que importa e que sao DOIS formatos, e que a minoria e uma.
    await reservar('E2EMOD-A1', eadId, polo.id, salaFaixaId, ORG_AMBIGUA);
    await reservar('E2EMOD-A2', eadId, polo.id, salaFaixaId, ORG_AMBIGUA);
    await reservar('E2EMOD-A3', modularId, polo.id, salaFaixaId, ORG_AMBIGUA);

    // A unanime tem so EaD, e por isso o formato dela se deriva sozinha.
    await reservar('E2EMOD-U1', eadId, polo.id, salaFaixaId, ORG_UNANIME);
  }, 60_000);

  afterAll(async () => {
    await limpar();
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  /** Um aluno com prova confirmada cobrindo uma turma. */
  async function reservar(
    matricula: string,
    modalidadeId: number,
    poloId: number,
    salaFaixaId: number,
    orgUnitId: string,
  ) {
    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula,
        nome: `ALUNO ${matricula}`,
        curso: 'CURSO E2E FORMATO',
        statusCurso: 'Ativo',
        ativo: true,
        modalidadeId,
        poloId,
      },
    });

    await prisma.agendamento.create({
      data: {
        alunoId: aluno.id,
        salaFaixaId,
        matricula,
        userIdD2L: '90001',
        periodoLetivoId: PERIODO_LETIVO,
        rodada: RODADA,
        modalidadeId,
        poloId,
        disciplinas: { create: { orgUnitId } },
      },
    });
  }

  async function limpar() {
    await prisma.modalidadeEscolhidaDaTurma.deleteMany({
      where: { orgUnitId: { in: [ORG_AMBIGUA, ORG_UNANIME, ORG_SEM_PROVA] } },
    });

    await prisma.turmaImportada.deleteMany({
      where: {
        codigoTurma: {
          in: [
            CODIGO_AMBIGUA,
            CODIGO_UNANIME,
            CODIGO_SEM_PROVA,
            CODIGO_SEM_ORGUNIT,
          ],
        },
      },
    });

    await prisma.periodoAgendamento.deleteMany({
      where: { periodoLetivoId: PERIODO_LETIVO },
    });

    const polos = await prisma.polo.findMany({ where: { nome: POLO_NOME } });

    for (const polo of polos) {
      const agendamentos = await prisma.agendamento.findMany({
        where: { poloId: polo.id },
        select: { id: true },
      });

      await prisma.agendamentoDisciplina.deleteMany({
        where: { agendamentoId: { in: agendamentos.map((a) => a.id) } },
      });
      await prisma.agendamento.deleteMany({ where: { poloId: polo.id } });
      await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
      await prisma.salaFaixa.deleteMany({
        where: { faixa: { poloId: polo.id } },
      });
      await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
      await prisma.sala.deleteMany({ where: { poloId: polo.id } });
      await prisma.polo.delete({ where: { id: polo.id } });
    }
  }

  describe('PUT — a decisao', () => {
    afterEach(async () => {
      await prisma.modalidadeEscolhidaDaTurma.deleteMany({
        where: { orgUnitId: ORG_AMBIGUA },
      });
    });

    it('define o formato da turma ambigua e devolve a linha pronta', async () => {
      const res = await comoAdmin(api().put(rota(turmaAmbiguaId)))
        .send({ modalidadeId: eadId })
        .expect(200);

      expect(res.body.modalidadeCodigo).toBe('EAD');
      expect(res.body.motivoSemModalidade).toBeNull();
      expect(res.body.modalidadeEscolhidaPor).toBe(EMAIL);
      // As candidatas continuam vindo: e com elas que a tela oferece a TROCA
      // sem exigir um "desfazer" antes.
      expect(
        res.body.candidatas.map((c: { codigo: string }) => c.codigo),
      ).toEqual(['EAD', 'MODULAR']);
    });

    /**
     * A minoria tambem pode ser a resposta certa. Se houvesse voto de maioria
     * por baixo, este teste passaria por acidente — por isso ele escolhe o lado
     * de 1 aluno e confere que foi ele que ficou.
     */
    it('a MINORIA e uma escolha valida', async () => {
      const res = await comoAdmin(api().put(rota(turmaAmbiguaId)))
        .send({ modalidadeId: modularId })
        .expect(200);

      expect(res.body.modalidadeCodigo).toBe('MODULAR');
    });

    it('trocar a escolha e um upsert, nao um erro', async () => {
      await comoAdmin(api().put(rota(turmaAmbiguaId)))
        .send({ modalidadeId: eadId })
        .expect(200);

      const res = await comoAdmin(api().put(rota(turmaAmbiguaId)))
        .send({ modalidadeId: modularId })
        .expect(200);

      expect(res.body.modalidadeCodigo).toBe('MODULAR');
      expect(
        await prisma.modalidadeEscolhidaDaTurma.count({
          where: { orgUnitId: ORG_AMBIGUA },
        }),
      ).toBe(1);
    });

    /**
     * ⚠️ A trava principal. Sem ela isto vira uma coluna de formato no
     * cadastro da turma — o que a decisao de 10/08/2026 recusou, com outro nome.
     */
    it('RECUSA turma que nao esta ambigua', async () => {
      const res = await comoAdmin(api().put(rota(turmaUnanimeId)))
        .send({ modalidadeId: eadId })
        .expect(400);

      expect(res.body.message).toMatch(/não está ambígua/i);
      expect(
        await prisma.modalidadeEscolhidaDaTurma.count({
          where: { orgUnitId: ORG_UNANIME },
        }),
      ).toBe(0);
    });

    it('RECUSA turma sem agendamento nenhum', async () => {
      const res = await comoAdmin(api().put(rota(turmaSemProvaId)))
        .send({ modalidadeId: eadId })
        .expect(400);

      expect(res.body.message).toMatch(/ausência/i);
    });

    /**
     * SEMI e um formato real e existente — e nao tem nenhum aluno com prova
     * nesta turma. Aplicar a janela dela fecharia a prova para a turma INTEIRA,
     * e nao so para a minoria.
     */
    it('RECUSA formato sem nenhum aluno com prova na turma', async () => {
      const res = await comoAdmin(api().put(rota(turmaAmbiguaId)))
        .send({ modalidadeId: semiId })
        .expect(400);

      expect(res.body.message).toMatch(/Nenhum aluno/i);
    });

    it('RECUSA turma que nem teve o orgUnitId resolvido', async () => {
      await comoAdmin(api().put(rota(turmaSemOrgUnitId)))
        .send({ modalidadeId: eadId })
        .expect(400);
    });

    it('turma inexistente e 404', async () => {
      await comoAdmin(api().put(rota(99_999_999)))
        .send({ modalidadeId: eadId })
        .expect(404);
    });

    /** `forbidNonWhitelisted`: campo a mais no corpo derruba a requisicao. */
    it('recusa corpo com campo desconhecido', async () => {
      await comoAdmin(api().put(rota(turmaAmbiguaId)))
        .send({ modalidadeId: eadId, orgUnitId: 'chutado' })
        .expect(400);
    });
  });

  describe('DELETE — desfazer', () => {
    it('desfaz a decisao e a turma volta a ser ambigua', async () => {
      await comoAdmin(api().put(rota(turmaAmbiguaId)))
        .send({ modalidadeId: eadId })
        .expect(200);

      const res = await comoAdmin(api().delete(rota(turmaAmbiguaId))).expect(
        200,
      );

      expect(res.body.modalidadeCodigo).toBeNull();
      expect(res.body.motivoSemModalidade).toMatch(/EAD \(2\)/);
      expect(
        await prisma.modalidadeEscolhidaDaTurma.count({
          where: { orgUnitId: ORG_AMBIGUA },
        }),
      ).toBe(0);
    });

    /**
     * Dois cliques no mesmo botao devolvem o mesmo estado. E tambem o caminho
     * de saida de uma decisao que ja caducou sozinha na leitura.
     */
    it('desfazer o que nao existe NAO e erro', async () => {
      await comoAdmin(api().delete(rota(turmaAmbiguaId))).expect(200);
      await comoAdmin(api().delete(rota(turmaAmbiguaId))).expect(200);
    });

    /** Ao contrario do PUT: apagar nunca aplica nada em prova nenhuma. */
    it('desfazer NAO exige que a turma continue ambigua', async () => {
      await comoAdmin(api().delete(rota(turmaUnanimeId))).expect(200);
    });
  });

  describe('protecao das rotas', () => {
    it('PUT exige token de admin', async () => {
      await api()
        .put(rota(turmaAmbiguaId))
        .send({ modalidadeId: eadId })
        .expect(401);
    });

    it('DELETE exige token de admin', async () => {
      await api().delete(rota(turmaAmbiguaId)).expect(401);
    });
  });
});
