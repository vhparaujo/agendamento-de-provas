import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Fluxo completo do admin montando a estrutura: polo -> salas -> faixa com
 * oferta de vagas. Requer banco de pe, migrations e seed (polos + modalidades).
 */
describe('Estrutura: polo, sala, faixa e oferta (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;

  const EMAIL = 'e2e-estrutura@ucb.br';
  const SENHA = 'senha-do-teste-123';
  const POLO_NOME = 'Polo E2E Estrutura';
  const OUTRO_POLO_NOME = 'Polo E2E Outro';
  const POLO_CICLO_NOME = 'Polo E2E Ciclo';

  let poloId: number;
  let outroPoloId: number;
  let salaGrandeId: number;
  let salaPequenaId: number;
  let salaDeOutroPoloId: number;
  let ead: { id: number; duracaoMinutos: number };
  let modular: { id: number; duracaoMinutos: number };

  const api = () => request(app.getHttpServer());
  const auth = <T extends request.Test>(r: T) =>
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

    const login = await api()
      .post('/api/auth/login')
      .send({ email: EMAIL, senha: SENHA })
      .expect(200);

    token = login.body.accessToken;

    ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });
    modular = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'MODULAR' },
    });
  }, 30_000);

  afterAll(async () => {
    await limpar();
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  async function limpar() {
    const polos = await prisma.polo.findMany({
      where: { nome: { in: [POLO_NOME, OUTRO_POLO_NOME, POLO_CICLO_NOME] } },
    });

    for (const polo of polos) {
      await prisma.salaFaixa.deleteMany({
        where: { faixa: { poloId: polo.id } },
      });
      await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
      await prisma.sala.deleteMany({ where: { poloId: polo.id } });
      await prisma.polo.delete({ where: { id: polo.id } });
    }
  }

  describe('polos', () => {
    it('lista os 27 polos do seed com contagens', async () => {
      const res = await auth(api().get('/api/polos')).expect(200);

      expect(res.body.length).toBeGreaterThanOrEqual(27);
      expect(res.body[0]).toHaveProperty('totalSalas');
      expect(res.body[0]).toHaveProperty('totalAlunos');
    });

    it('cria os polos do teste', async () => {
      const a = await auth(api().post('/api/polos'))
        .send({ nome: POLO_NOME, cidade: 'Brasília' })
        .expect(201);
      poloId = a.body.id;

      const b = await auth(api().post('/api/polos'))
        .send({ nome: OUTRO_POLO_NOME })
        .expect(201);
      outroPoloId = b.body.id;
    });

    it('recusa polo com nome repetido', async () => {
      await auth(api().post('/api/polos'))
        .send({ nome: POLO_NOME })
        .expect(409);
    });

    it('nao aceita renomear (nome e a chave de casamento com o CSV)', async () => {
      // forbidNonWhitelisted: `nome` nao existe no DTO de update
      await auth(api().patch(`/api/polos/${poloId}`))
        .send({ nome: 'Outro Nome' })
        .expect(400);
    });
  });

  /**
   * O ciclo real de um campus: entra na oferta, sai numa oferta seguinte, volta.
   * Sair NAO e apagar — o polo sustenta alunos importados e provas ja feitas.
   */
  describe('ciclo de vida do polo', () => {
    let cicloId: number;
    let salaDoCicloId: number;

    it('cria o polo do ciclo', async () => {
      const res = await auth(api().post('/api/polos'))
        .send({ nome: POLO_CICLO_NOME })
        .expect(201);

      cicloId = res.body.id;
      expect(res.body.ativo).toBe(true);
    });

    it('recusa apagar polo que ja tem sala', async () => {
      const sala = await auth(api().post('/api/salas'))
        .send({ poloId: cicloId, nome: 'SALA CICLO', capacidade: 10 })
        .expect(201);

      salaDoCicloId = sala.body.id;

      await auth(api().delete(`/api/polos/${cicloId}`)).expect(409);
    });

    it('desativado, nao recebe sala nem faixa nova', async () => {
      await auth(api().patch(`/api/polos/${cicloId}`))
        .send({ ativo: false })
        .expect(200);

      await auth(api().post('/api/salas'))
        .send({ poloId: cicloId, nome: 'SALA TARDIA', capacidade: 10 })
        .expect(409);

      await auth(api().post('/api/faixas'))
        .send({
          poloId: cicloId,
          data: '2030-08-20',
          horaInicio: '08:30',
          horaFim: '11:30',
          salas: [{ salaId: salaDoCicloId, modalidadeId: ead.id, vagas: 5 }],
        })
        .expect(409);
    });

    it('sai da lista de ativos, mas continua na lista completa', async () => {
      const ativos = await auth(
        api().get('/api/polos?apenasAtivos=true'),
      ).expect(200);
      expect(ativos.body.map((p: { id: number }) => p.id)).not.toContain(
        cicloId,
      );

      const todos = await auth(api().get('/api/polos')).expect(200);
      expect(todos.body.map((p: { id: number }) => p.id)).toContain(cicloId);
    });

    it('cadastrar de novo com o mesmo nome REATIVA o mesmo polo', async () => {
      const res = await auth(api().post('/api/polos'))
        .send({ nome: POLO_CICLO_NOME })
        .expect(201);

      // mesmo id: a sala cadastrada antes continua pendurada nele
      expect(res.body.id).toBe(cicloId);
      expect(res.body.ativo).toBe(true);

      const detalhe = await auth(api().get(`/api/polos/${cicloId}`)).expect(
        200,
      );
      expect(detalhe.body.totalSalas).toBe(1);
    });

    it('reativado, volta a aceitar faixa', async () => {
      await auth(api().post('/api/faixas'))
        .send({
          poloId: cicloId,
          data: '2030-08-20',
          horaInicio: '08:30',
          horaFim: '11:30',
          salas: [{ salaId: salaDoCicloId, modalidadeId: ead.id, vagas: 5 }],
        })
        .expect(201);
    });

    it('apaga o polo depois que ele fica sem sala e sem faixa', async () => {
      const faixas = await auth(
        api().get(`/api/faixas?poloId=${cicloId}`),
      ).expect(200);

      for (const faixa of faixas.body) {
        await auth(api().delete(`/api/faixas/${faixa.id}`)).expect(200);
      }

      await auth(api().delete(`/api/salas/${salaDoCicloId}`)).expect(200);
      await auth(api().delete(`/api/polos/${cicloId}`)).expect(200);
      await auth(api().get(`/api/polos/${cicloId}`)).expect(404);
    });
  });

  describe('salas', () => {
    it('cadastra salas no polo', async () => {
      const grande = await auth(api().post('/api/salas'))
        .send({ poloId, nome: 'M114', capacidade: 40 })
        .expect(201);
      salaGrandeId = grande.body.id;

      const pequena = await auth(api().post('/api/salas'))
        .send({ poloId, nome: 'LAB 203', capacidade: 10 })
        .expect(201);
      salaPequenaId = pequena.body.id;

      const outra = await auth(api().post('/api/salas'))
        .send({ poloId: outroPoloId, nome: 'B106', capacidade: 30 })
        .expect(201);
      salaDeOutroPoloId = outra.body.id;
    });

    it('recusa duas salas com o mesmo nome no mesmo polo', async () => {
      await auth(api().post('/api/salas'))
        .send({ poloId, nome: 'M114', capacidade: 20 })
        .expect(409);
    });

    it('aceita o mesmo nome em polos diferentes', async () => {
      const res = await auth(api().post('/api/salas'))
        .send({ poloId: outroPoloId, nome: 'M114', capacidade: 25 })
        .expect(201);

      await auth(api().delete(`/api/salas/${res.body.id}`)).expect(200);
    });

    it('recusa polo inexistente', async () => {
      await auth(api().post('/api/salas'))
        .send({ poloId: 999999, nome: 'X', capacidade: 10 })
        .expect(404);
    });

    it('filtra por polo', async () => {
      const res = await auth(api().get(`/api/salas?poloId=${poloId}`)).expect(
        200,
      );

      expect(res.body).toHaveLength(2);
      expect(
        res.body.every((s: { poloId: number }) => s.poloId === poloId),
      ).toBe(true);
    });
  });

  describe('criacao da faixa com oferta de vagas', () => {
    it('recusa faixa sem nenhuma sala', async () => {
      await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '08:30',
          horaFim: '11:30',
          salas: [],
        })
        .expect(400);
    });

    it('recusa horario invertido', async () => {
      await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '11:30',
          horaFim: '08:30',
          salas: [{ salaId: salaGrandeId, modalidadeId: ead.id }],
        })
        .expect(400);
    });

    it('recusa hora fora do formato HH:MM', async () => {
      await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '8:30',
          horaFim: '11:30',
          salas: [{ salaId: salaGrandeId, modalidadeId: ead.id }],
        })
        .expect(400);
    });

    it('RECUSA sala de outro polo', async () => {
      const res = await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '08:30',
          horaFim: '11:30',
          salas: [{ salaId: salaDeOutroPoloId, modalidadeId: ead.id }],
        })
        .expect(400);

      expect(res.body.message).toMatch(/outro polo/);
    });

    it('RECUSA prova que nao cabe na janela (EaD de 3h em faixa de 1h30)', async () => {
      const res = await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '14:00',
          horaFim: '15:30',
          salas: [{ salaId: salaGrandeId, modalidadeId: ead.id }],
        })
        .expect(400);

      expect(res.body.message).toMatch(/90 min.*180 min/s);
    });

    it('RECUSA vagas acima da capacidade da sala', async () => {
      const res = await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '08:30',
          horaFim: '11:30',
          salas: [{ salaId: salaPequenaId, modalidadeId: ead.id, vagas: 11 }],
        })
        .expect(400);

      expect(res.body.message).toMatch(/10 lugares/);
    });

    it('recusa a mesma sala duas vezes na faixa', async () => {
      await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '08:30',
          horaFim: '11:30',
          salas: [
            { salaId: salaGrandeId, modalidadeId: ead.id },
            { salaId: salaGrandeId, modalidadeId: modular.id },
          ],
        })
        .expect(400);
    });

    let faixaId: number;

    it('cria a faixa e numera a ordem por modalidade', async () => {
      const res = await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '08:30',
          horaFim: '11:30',
          salas: [
            { salaId: salaGrandeId, modalidadeId: ead.id },
            { salaId: salaPequenaId, modalidadeId: ead.id },
          ],
        })
        .expect(201);

      faixaId = res.body.id;

      expect(res.body.duracaoMinutos).toBe(180);
      expect(res.body.ofertas).toHaveLength(2);

      // vagas default = capacidade da sala; ordem segue a ordem da lista
      expect(res.body.ofertas[0]).toMatchObject({ vagas: 40, ordem: 1 });
      expect(res.body.ofertas[1]).toMatchObject({ vagas: 10, ordem: 2 });
      expect(res.body.ofertas[0].disponiveis).toBe(40);
    });

    it('recusa faixa identica no mesmo polo (duplo-clique)', async () => {
      await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '08:30',
          horaFim: '11:30',
          salas: [{ salaId: salaGrandeId, modalidadeId: ead.id }],
        })
        .expect(409);
    });

    it('a mesma sala pode ter OUTRA modalidade em outra faixa', async () => {
      const res = await auth(api().post('/api/faixas'))
        .send({
          poloId,
          data: '2026-09-10',
          horaInicio: '14:00',
          horaFim: '15:30',
          salas: [{ salaId: salaGrandeId, modalidadeId: modular.id }],
        })
        .expect(201);

      expect(res.body.ofertas[0].modalidade.codigo).toBe('MODULAR');

      await auth(api().delete(`/api/faixas/${res.body.id}`)).expect(200);
    });

    it('adiciona sala a uma faixa existente, continuando a numeracao', async () => {
      // libera a sala de outro polo movendo o teste para uma sala nova deste polo
      const nova = await auth(api().post('/api/salas'))
        .send({ poloId, nome: 'M115', capacidade: 30 })
        .expect(201);

      const res = await auth(api().post(`/api/faixas/${faixaId}/salas`))
        .send({ salaId: nova.body.id, modalidadeId: ead.id })
        .expect(201);

      const adicionada = res.body.ofertas.find(
        (o: { salaId: number }) => o.salaId === nova.body.id,
      );

      expect(adicionada.ordem).toBe(3);
    });

    it('recusa adicionar a mesma sala de novo', async () => {
      await auth(api().post(`/api/faixas/${faixaId}/salas`))
        .send({ salaId: salaGrandeId, modalidadeId: modular.id })
        .expect(409);
    });

    it('recusa encurtar a faixa abaixo da prova ja ofertada', async () => {
      const res = await auth(api().patch(`/api/faixas/${faixaId}`))
        .send({ horaFim: '10:00' }) // 90 min, mas ha oferta EaD de 180
        .expect(400);

      expect(res.body.message).toMatch(/EaD/);
    });

    it('aceita ampliar a faixa', async () => {
      const res = await auth(api().patch(`/api/faixas/${faixaId}`))
        .send({ horaFim: '12:00' })
        .expect(200);

      expect(res.body.duracaoMinutos).toBe(210);
    });
  });

  describe('ajuste da oferta (SalaFaixa)', () => {
    let ofertaId: number;

    beforeAll(async () => {
      const faixas = await auth(api().get(`/api/faixas?poloId=${poloId}`));
      ofertaId = faixas.body[0].ofertas[0].id;
    });

    it('recusa vagas acima da capacidade', async () => {
      await auth(api().patch(`/api/sala-faixas/${ofertaId}`))
        .send({ vagas: 999 })
        .expect(400);
    });

    it('aceita reduzir vagas quando ninguem agendou', async () => {
      const res = await auth(api().patch(`/api/sala-faixas/${ofertaId}`))
        .send({ vagas: 30 })
        .expect(200);

      expect(res.body).toMatchObject({
        vagas: 30,
        ocupadas: 0,
        disponiveis: 30,
      });
    });

    it('recusa ordem ja usada na mesma modalidade', async () => {
      await auth(api().patch(`/api/sala-faixas/${ofertaId}`))
        .send({ ordem: 2 })
        .expect(409);
    });

    it('nao aceita trocar a modalidade por aqui', async () => {
      await auth(api().patch(`/api/sala-faixas/${ofertaId}`))
        .send({ modalidadeId: 3 })
        .expect(400);
    });
  });

  describe('protecao das rotas', () => {
    it.each([
      ['GET', '/api/polos'],
      ['GET', '/api/salas'],
      ['GET', '/api/faixas'],
      ['GET', '/api/modalidades'],
    ])('%s %s exige token de admin', async (metodo, rota) => {
      await api()[metodo.toLowerCase() as 'get'](rota).expect(401);
    });
  });
});
