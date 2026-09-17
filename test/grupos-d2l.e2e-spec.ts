import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

/**
 * A tela de grupos do Brightspace, na parte que NAO fala com a Valence: os
 * nomes por bloco e a pendencia de horario. Os lotes (criar e inscrever) sao
 * cobertos pelos testes puros de `plano.ts` e do cliente REST — aqui so se
 * confere que eles recusam com a integracao desligada, que e o estado do e2e.
 *
 * O que esta sob teste, e por que erra calado:
 *
 * - **Os nomes vao para a GRADE DE GRUPOS**, com a categoria do bloco. Se fossem
 *   para uma tabela propria, o disparo do quiz procuraria o grupo por outro nome.
 * - **Semi/Modular grava nos DOIS formatos.** Gravando so numa, o disparo da
 *   outra nao acharia grupo nenhum no dia.
 * - **Faixa sem janela identica vira pendencia**, e resolver "vale a janela"
 *   move a faixa — sem isso, os alunos dela ficam sem grupo, sem erro nenhum.
 *
 * As janelas sao as do seed (sao globais); o teste as le do banco em vez de
 * cravar horarios, e usa um ano que nenhuma prova real usa.
 */
describe('Grupos do Brightspace — nomes e horarios (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;

  const EMAIL = 'e2e-grupos-d2l@ucb.br';
  const SENHA = 'senha-do-teste-123';
  const POLO = 'Polo E2E Grupos D2L';
  const DIA = '2099-03-10';
  const OUTRO_DIA = '2099-03-11';
  const INTERVALO = { de: '2099-03-09', ate: '2099-03-12' };

  /** Um horario que nenhuma janela EaD usa, com as 3h que a prova EaD exige. */
  const FORA = { horaInicio: '05:00', horaFim: '08:30' };

  let eadId: number;
  let janelaEad: { id: number; horaInicio: string; horaFim: string };
  let sessaoSemiModular: {
    horaInicio: string;
    horaFim: string;
    janelaIds: number[];
  };
  let janelaDeOutraModalidadeId: number;
  let faixaForaId: number;

  const api = () => request(app.getHttpServer());
  const comoAdmin = <T extends request.Test>(r: T) =>
    r.set('Authorization', `Bearer ${token}`);

  const minutos = (hora: string) => {
    const [h, m] = hora.split(':').map(Number);
    return h * 60 + m;
  };

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

    token = (
      await api()
        .post('/api/auth/login')
        .send({ email: EMAIL, senha: SENHA })
        .expect(200)
    ).body.accessToken;

    const ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });
    eadId = ead.id;

    const janelas = await prisma.janelaDeProva.findMany({
      where: {
        ativo: true,
        modalidade: { codigo: { in: ['EAD', 'SEMI', 'MODULAR'] } },
      },
      include: { modalidade: true },
      orderBy: { horaInicio: 'asc' },
    });

    // A janela para onde a faixa vai ser movida precisa comportar a prova EaD,
    // senao o cadastro de faixas recusaria a mudanca por outro motivo.
    const eadQueCabe = janelas.find(
      (j) =>
        j.modalidade.codigo === 'EAD' &&
        minutos(j.horaFim) - minutos(j.horaInicio) >= ead.duracaoMinutos,
    );

    const semiOuModular = janelas.filter((j) =>
      ['SEMI', 'MODULAR'].includes(j.modalidade.codigo),
    );

    if (!eadQueCabe || semiOuModular.length === 0) {
      throw new Error(
        'O e2e de grupos precisa das janelas do seed (npm run seed:janelas).',
      );
    }

    janelaEad = eadQueCabe;
    janelaDeOutraModalidadeId = semiOuModular[0].id;

    // Prefere um horario que Semi E Modular tenham: e o caso normal, e o que
    // prova a gravacao nos dois formatos.
    const porHorario = new Map<string, number[]>();
    for (const j of semiOuModular) {
      const chave = `${j.horaInicio}-${j.horaFim}`;
      porHorario.set(chave, [...(porHorario.get(chave) ?? []), j.id]);
    }
    const [horario, janelaIds] = [...porHorario.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )[0];
    const [horaInicio, horaFim] = horario.split('-');
    sessaoSemiModular = { horaInicio, horaFim, janelaIds };

    if (
      janelas.some(
        (j) =>
          j.modalidade.codigo === 'EAD' &&
          j.horaInicio === FORA.horaInicio &&
          j.horaFim === FORA.horaFim,
      )
    ) {
      throw new Error(
        'O horario "fora de janela" do teste virou janela EaD no seed.',
      );
    }

    const polo = await prisma.polo.create({ data: { nome: POLO } });
    const sala = await prisma.sala.create({
      data: { poloId: polo.id, nome: 'GD2L-1', capacidade: 10 },
    });

    const faixa = await prisma.faixa.create({
      data: {
        poloId: polo.id,
        data: new Date(`${DIA}T00:00:00.000Z`),
        horaInicio: FORA.horaInicio,
        horaFim: FORA.horaFim,
      },
    });
    faixaForaId = faixa.id;

    await prisma.salaFaixa.create({
      data: {
        salaId: sala.id,
        faixaId: faixa.id,
        modalidadeId: ead.id,
        vagas: 10,
        ordem: 1,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await limpar();
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  async function limpar() {
    await prisma.grupoDaJanela.deleteMany({
      where: {
        data: {
          gte: new Date('2099-03-01T00:00:00.000Z'),
          lte: new Date('2099-04-30T00:00:00.000Z'),
        },
      },
    });

    const polo = await prisma.polo.findUnique({ where: { nome: POLO } });

    if (polo) {
      await prisma.salaFaixa.deleteMany({
        where: { faixa: { poloId: polo.id } },
      });
      await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
      await prisma.sala.deleteMany({ where: { poloId: polo.id } });
      await prisma.polo.delete({ where: { id: polo.id } });
    }
  }

  const salvarNomes = (corpo: Record<string, unknown>) =>
    comoAdmin(api().put('/api/grupos-d2l/nomes')).send({
      ...INTERVALO,
      ...corpo,
    });

  const painel = async () =>
    (
      await comoAdmin(api().get('/api/grupos-d2l/painel'))
        .query(INTERVALO)
        .expect(200)
    ).body;

  // ------------------------------------------------------------------ testes

  it('exige token de admin', async () => {
    await api().get('/api/grupos-d2l/painel').query(INTERVALO).expect(401);
  });

  describe('nomes dos grupos', () => {
    it('Semi/Modular grava a celula nos dois formatos, com a categoria do bloco', async () => {
      const res = await salvarNomes({
        bloco: 'SEMI_MODULAR',
        linhas: [
          {
            data: DIA,
            ...pick(sessaoSemiModular),
            nomeGrupo: 'E2E 10/03 - sessao A',
          },
        ],
      }).expect(200);

      const bloco = res.body.blocos.find(
        (b: any) => b.bloco === 'SEMI_MODULAR',
      );
      expect(bloco.linhas).toEqual([
        expect.objectContaining({
          data: DIA,
          nomeGrupo: 'E2E 10/03 - sessao A',
        }),
      ]);

      const celulas = await prisma.grupoDaJanela.findMany({
        where: { data: new Date(`${DIA}T00:00:00.000Z`) },
      });

      expect(celulas.map((c) => c.janelaDeProvaId).sort()).toEqual(
        [...sessaoSemiModular.janelaIds].sort(),
      );
      expect(new Set(celulas.map((c) => c.categoriaGrupo))).toEqual(
        new Set(['Provas Presenciais - Semi e Modular']),
      );
    });

    it('o que nao vem no corpo e apagado — so no bloco e no intervalo', async () => {
      await salvarNomes({ bloco: 'SEMI_MODULAR', linhas: [] }).expect(200);

      expect(
        await prisma.grupoDaJanela.count({
          where: {
            janelaDeProvaId: { in: sessaoSemiModular.janelaIds },
            data: new Date(`${DIA}T00:00:00.000Z`),
          },
        }),
      ).toBe(0);
    });

    it('recusa horario que nao e de janela nenhuma do bloco', async () => {
      const res = await salvarNomes({
        bloco: 'EAD',
        linhas: [{ data: DIA, ...FORA, nomeGrupo: 'E2E fora' }],
      }).expect(400);

      expect(res.body.message).toContain('janela');
    });

    /** Duas sessoes com o mesmo nome cairiam no MESMO grupo do Brightspace. */
    it('recusa o mesmo nome em duas sessoes', async () => {
      const sessao = pick(janelaEad);

      const res = await salvarNomes({
        bloco: 'EAD',
        linhas: [
          { data: DIA, ...sessao, nomeGrupo: 'E2E repetido' },
          { data: OUTRO_DIA, ...sessao, nomeGrupo: 'e2e  REPETIDO' },
        ],
      }).expect(400);

      expect(res.body.message).toContain('mesmo grupo');
    });

    it('recusa dia fora do intervalo', async () => {
      await salvarNomes({
        bloco: 'EAD',
        linhas: [
          {
            data: '2099-04-01',
            ...pick(janelaEad),
            nomeGrupo: 'E2E fora do intervalo',
          },
        ],
      }).expect(400);
    });
  });

  describe('pendencia de horario', () => {
    const pendenciaFora = (corpo: any) =>
      corpo.pendenciasDeHorario.find(
        (p: any) =>
          p.modalidadeCodigo === 'EAD' &&
          p.horaInicio === FORA.horaInicio &&
          p.horaFim === FORA.horaFim,
      );

    it('faixa sem janela identica aparece como pendencia', async () => {
      const p = pendenciaFora(await painel());

      expect(p).toMatchObject({ faixas: 1, dias: [DIA] });
      expect(p.janelas.map((j: any) => j.id)).toContain(janelaEad.id);
    });

    it('recusa janela de outro formato', async () => {
      await comoAdmin(api().post('/api/grupos-d2l/horarios/resolver'))
        .send({
          ...INTERVALO,
          modalidadeId: eadId,
          ...FORA,
          janelaDeProvaId: janelaDeOutraModalidadeId,
          vale: 'JANELA',
        })
        .expect(400);
    });

    it('"vale a janela" move a faixa, e a pendencia some', async () => {
      const res = await comoAdmin(
        api().post('/api/grupos-d2l/horarios/resolver'),
      )
        .send({
          ...INTERVALO,
          modalidadeId: eadId,
          ...FORA,
          janelaDeProvaId: janelaEad.id,
          vale: 'JANELA',
        })
        .expect(200);

      expect(res.body).toMatchObject({ faixasAtualizadas: 1, recusadas: [] });

      const faixa = await prisma.faixa.findUniqueOrThrow({
        where: { id: faixaForaId },
      });
      expect(pick(faixa)).toEqual(pick(janelaEad));

      expect(pendenciaFora(await painel())).toBeUndefined();
    });
  });

  it('os lotes recusam com a integracao D2L desligada', async () => {
    await comoAdmin(api().post('/api/grupos-d2l/execucoes'))
      .send({ tipo: 'CRIAR_GRUPOS', ...INTERVALO })
      .expect(400);
  });
});

function pick(h: { horaInicio: string; horaFim: string }) {
  return { horaInicio: h.horaInicio, horaFim: h.horaFim };
}
