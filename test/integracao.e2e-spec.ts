import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/service/auth.service';
import { PrismaService } from './../src/database/prisma.service';
import { StatusAgendamento } from './../src/generated/prisma/client';

/**
 * GET /integracao/alunos/:matricula/agendamentos — o que o emissor da declaracao
 * assinada consulta. Os agendamentos sao gravados direto no banco: o que se
 * testa aqui e o recorte e a autenticacao da integracao, nao a alocacao (que
 * tem suite propria).
 *
 * Requer banco de pe, migrations e seed (formatos).
 */
describe('Integracao: dados de agendamento por matricula (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: AuthService;

  // A mesma chave de test/setup-e2e.ts, lida de la para nao existir em dois lugares.
  const CHAVE = process.env.INTEGRACAO_API_KEYS!.split(':')[1];

  const POLO_NOME = 'Polo E2E Integracao';
  const PERIODO_LETIVO = 'E2E-INTEG-103';
  const MATRICULA = 'E2EINTEG01';

  let vinculoA: number;
  let vinculoB: number;
  let janelaSubId: number;

  const api = () => request(app.getHttpServer());
  const rota = (matricula = MATRICULA) =>
    `/api/integracao/alunos/${matricula}/agendamentos`;
  const comChave = (r: request.Test) => r.set('X-API-Key', CHAVE);

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

    const ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });
    const polo = await prisma.polo.create({ data: { nome: POLO_NOME } });
    const sala = await prisma.sala.create({
      data: { poloId: polo.id, nome: 'I-1', capacidade: 10 },
    });

    // Dois cursos na mesma matricula. So o B tem nome no CSV: o nome da
    // resposta tem de sair de onde houver.
    vinculoA = (
      await prisma.alunoImportado.create({
        data: {
          matricula: MATRICULA,
          nome: 'ALUNO E2E INTEGRACAO',
          curso: 'CURSO E2E INTEG A',
          statusCurso: 'Ativo',
          modalidadeId: ead.id,
          poloId: polo.id,
        },
      })
    ).id;
    vinculoB = (
      await prisma.alunoImportado.create({
        data: {
          matricula: MATRICULA,
          nome: null,
          curso: 'CURSO E2E INTEG B',
          statusCurso: 'Trancado',
          ativo: false,
          modalidadeId: ead.id,
          poloId: polo.id,
        },
      })
    ).id;

    // A N2 e uma janela antiga, ja encerrada; a SUB e a vigente, com o prazo
    // aberto. `createdAt` explicito: vigente = a cadastrada por ultimo, e duas
    // linhas no mesmo milissegundo deixariam isso ao acaso.
    await prisma.periodoAgendamento.create({
      data: {
        periodoLetivoId: PERIODO_LETIVO,
        rodada: 'N2',
        descricao: 'e2e integracao N2',
        aberto: true,
        dataFechamento: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      },
    });
    janelaSubId = (
      await prisma.periodoAgendamento.create({
        data: {
          periodoLetivoId: PERIODO_LETIVO,
          rodada: 'SUB',
          descricao: 'e2e integracao SUB',
          aberto: true,
          dataFechamento: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      })
    ).id;

    const oferta = async (data: string, horaInicio: string, horaFim: string) =>
      (
        await prisma.faixa.create({
          data: {
            poloId: polo.id,
            data: new Date(`${data}T00:00:00.000Z`),
            horaInicio,
            horaFim,
            salaFaixas: {
              create: {
                salaId: sala.id,
                modalidadeId: ead.id,
                vagas: 10,
                ordem: 1,
              },
            },
          },
          include: { salaFaixas: true },
        })
      ).salaFaixas[0].id;

    const agendar = async (dados: {
      alunoId: number;
      salaFaixaId: number;
      rodada: string;
      disciplina: string;
      status?: StatusAgendamento;
      alocadoManual?: boolean;
    }) =>
      prisma.agendamento.create({
        data: {
          alunoId: dados.alunoId,
          salaFaixaId: dados.salaFaixaId,
          matricula: MATRICULA,
          userIdD2L: 'd2l-e2e-integ',
          periodoLetivoId: PERIODO_LETIVO,
          rodada: dados.rodada,
          modalidadeId: ead.id,
          poloId: polo.id,
          status: dados.status ?? StatusAgendamento.CONFIRMADO,
          alocadoManual: dados.alocadoManual ?? false,
          disciplinas: {
            create: {
              orgUnitId: `ou-${dados.disciplina}`,
              nomeDisciplina: dados.disciplina,
            },
          },
        },
      });

    await agendar({
      alunoId: vinculoA,
      salaFaixaId: await oferta('2026-06-12', '15:00', '18:00'),
      rodada: 'N2',
      disciplina: 'Disciplina Integ N2',
    });
    await agendar({
      alunoId: vinculoA,
      salaFaixaId: await oferta('2026-09-10', '08:30', '11:30'),
      rodada: 'SUB',
      disciplina: 'Disciplina Integ SUB',
      alocadoManual: true,
    });
    // Cancelada: nao reserva cadeira, nao pode virar declaracao.
    await agendar({
      alunoId: vinculoB,
      salaFaixaId: await oferta('2026-09-11', '08:30', '11:30'),
      rodada: 'N2',
      disciplina: 'Disciplina Integ Cancelada',
      status: StatusAgendamento.CANCELADO,
    });
  }, 60_000);

  afterAll(async () => {
    await limpar();
    await app.close();
  });

  async function limpar() {
    await prisma.agendamento.deleteMany({ where: { matricula: MATRICULA } });

    const polo = await prisma.polo.findUnique({ where: { nome: POLO_NOME } });

    if (polo) {
      await prisma.salaFaixa.deleteMany({
        where: { faixa: { poloId: polo.id } },
      });
      await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
      await prisma.sala.deleteMany({ where: { poloId: polo.id } });
      await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
      await prisma.polo.delete({ where: { id: polo.id } });
    }

    await prisma.periodoAgendamento.deleteMany({
      where: { periodoLetivoId: PERIODO_LETIVO },
    });
  }

  describe('autenticacao', () => {
    it('401 sem o header X-API-Key', async () => {
      await api().get(rota()).expect(401);
    });

    it('401 com chave errada', async () => {
      await api().get(rota()).set('X-API-Key', 'x'.repeat(45)).expect(401);
    });

    /**
     * O JWT do aluno so abre o PORTAL, e so para a propria matricula. Aceita-lo
     * aqui daria a qualquer aluno logado os dados de qualquer RA.
     */
    it('401 com JWT de aluno no lugar da chave', async () => {
      const { accessToken } = await auth.emitirTokenAluno({
        sub: MATRICULA,
        userIdD2L: 'd2l-e2e-integ',
        vinculos: [
          {
            alunoId: vinculoA,
            curso: 'CURSO E2E INTEG A',
            modalidade: 'EAD',
            poloId: 0,
            ativo: true,
          },
        ],
      });

      await api()
        .get(rota())
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
    });

    /** E o inverso: a chave de integracao nao abre rota de admin nem de aluno. */
    it('a chave nao abre as rotas do portal', async () => {
      await comChave(api().get('/api/portal/agendamentos')).expect(401);
    });
  });

  describe('validacao', () => {
    it('404 para matricula que nao foi importada', async () => {
      await comChave(api().get(rota('E2EINTEGNAOEXISTE'))).expect(404);
    });

    it('400 para matricula fora do formato', async () => {
      await comChave(api().get(rota('E2E-INTEG'))).expect(400);
    });

    it('400 para `periodo` diferente de `atual`', async () => {
      await comChave(api().get(`${rota()}?periodo=todos`)).expect(400);
    });
  });

  describe('historico completo', () => {
    it('devolve o aluno, os dois cursos e so as provas confirmadas', async () => {
      const res = await comChave(api().get(rota())).expect(200);

      expect(res.body).toMatchObject({
        matricula: MATRICULA,
        nome: 'ALUNO E2E INTEGRACAO',
        filtro: { periodo: null },
      });

      expect(res.body.vinculos).toEqual([
        expect.objectContaining({
          alunoId: vinculoA,
          curso: 'CURSO E2E INTEG A',
          ativo: true,
          modalidade: expect.objectContaining({ codigo: 'EAD' }),
          polo: expect.objectContaining({ nome: POLO_NOME }),
        }),
        expect.objectContaining({
          alunoId: vinculoB,
          statusCurso: 'Trancado',
          ativo: false,
        }),
      ]);

      // A cancelada (vinculo B) nao aparece.
      expect(
        res.body.agendamentos.map((a: { rodada: string }) => a.rodada),
      ).toEqual(['SUB', 'N2']);
    });

    it('traz tudo o que a declaracao e a tela do portal mostram', async () => {
      const res = await comChave(api().get(rota())).expect(200);
      const [sub] = res.body.agendamentos;

      expect(sub).toMatchObject({
        alunoId: vinculoA,
        curso: 'CURSO E2E INTEG A',
        status: 'CONFIRMADO',
        rodada: 'SUB',
        rodadaDescricao: 'Substitutiva (SUB)',
        periodoLetivoId: PERIODO_LETIVO,
        // String AAAA-MM-DD, e nao instante: o consumidor nao tem como ler o
        // dia no fuso errado.
        data: '2026-09-10',
        horaInicio: '08:30',
        horaFim: '11:30',
        formato: { codigo: 'EAD', duracaoMinutos: 180 },
        polo: { nome: POLO_NOME },
        sala: { nome: 'I-1' },
        disciplinas: [
          {
            orgUnitId: 'ou-Disciplina Integ SUB',
            nomeDisciplina: 'Disciplina Integ SUB',
          },
        ],
        alocadoManual: true,
      });
      expect(sub.agendadoEm).toEqual(expect.any(String));
    });

    /**
     * `prazoEncerrado` e a regra da declaracao entregue como dado: a N2 e de uma
     * janela passada (encerrada por definicao), a SUB e da vigente, com o prazo
     * ainda correndo — o aluno pode trocar de horario.
     */
    it('marca o prazo de cada prova pela sua janela', async () => {
      const res = await comChave(api().get(rota())).expect(200);
      const [sub, n2] = res.body.agendamentos;

      expect(sub.periodo).toMatchObject({
        descricao: 'e2e integracao SUB',
        prazoEncerrado: false,
      });
      expect(n2.periodo).toMatchObject({
        descricao: 'e2e integracao N2',
        prazoEncerrado: true,
      });
    });

    it('a prova da janela vigente passa a encerrada quando o prazo vence', async () => {
      const original = await prisma.periodoAgendamento.findUniqueOrThrow({
        where: { id: janelaSubId },
      });

      await prisma.periodoAgendamento.update({
        where: { id: janelaSubId },
        data: { dataFechamento: new Date(Date.now() - 60 * 60 * 1000) },
      });

      try {
        const res = await comChave(api().get(rota())).expect(200);

        expect(res.body.agendamentos[0].periodo.prazoEncerrado).toBe(true);
      } finally {
        await prisma.periodoAgendamento.update({
          where: { id: janelaSubId },
          data: { dataFechamento: original.dataFechamento },
        });
      }
    });
  });

  describe('?periodo=atual', () => {
    /**
     * "Atual" e a JANELA vigente, e nao o semestre: durante a SUB, a N2 do mesmo
     * periodo letivo fica de fora — mesmo recorte do portal do aluno.
     */
    it('traz so a prova da janela vigente', async () => {
      const res = await comChave(api().get(`${rota()}?periodo=atual`)).expect(
        200,
      );

      expect(res.body.filtro).toEqual({ periodo: 'atual' });
      expect(res.body.vinculos).toHaveLength(2);
      expect(
        res.body.agendamentos.map((a: { rodada: string }) => a.rodada),
      ).toEqual(['SUB']);
    });
  });
});
