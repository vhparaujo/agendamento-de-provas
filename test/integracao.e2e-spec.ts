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
  const CODIGO_TURMA = 'E2EINTEGT01';

  let vinculoA: number;
  let vinculoB: number;
  let janelaN2Id: number;
  let janelaSubId: number;

  const api = () => request(app.getHttpServer());
  const rota = (matricula = MATRICULA) =>
    `/api/integracao/alunos/${matricula}/agendamentos`;
  const comChave = (r: request.Test) => r.set('X-API-Key', CHAVE);
  // A prova nao repete a rodada: ela vem da janela, em `periodos[]`. Vale
  // para as duas rotas — `itens` na lista, `agendamentos` na consulta por RA.
  const rodadas = (resposta: unknown) => {
    const body = resposta as {
      periodos: { id: number; rodada: string }[];
      itens?: { periodoId: number }[];
      agendamentos?: { periodoId: number }[];
    };

    return (body.itens ?? body.agendamentos ?? []).map(
      (item) => body.periodos.find((p) => p.id === item.periodoId)?.rodada,
    );
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
          statusCurso: 'Matrícula Trancada',
          ativo: false,
          modalidadeId: ead.id,
          poloId: polo.id,
        },
      })
    ).id;

    // A N2 e uma janela antiga, ja encerrada; a SUB e a vigente, com o prazo
    // aberto. `createdAt` explicito: vigente = a cadastrada por ultimo, e duas
    // linhas no mesmo milissegundo deixariam isso ao acaso.
    janelaN2Id = (
      await prisma.periodoAgendamento.create({
        data: {
          periodoLetivoId: PERIODO_LETIVO,
          rodada: 'N2',
          descricao: 'e2e integracao N2',
          aberto: true,
          dataFechamento: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        },
      })
    ).id;
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

    // So a disciplina da SUB esta no CSV de turmas: a da N2 testa o `null`.
    await prisma.turmaImportada.create({
      data: {
        codigoTurma: CODIGO_TURMA,
        nomeDisciplina: 'Disciplina Integ SUB',
        codigoEad: 'E2EINTEGD01',
        idTurmaDisc: 'E2E-TD-01',
        orgUnitId: 'ou-Disciplina Integ SUB',
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
    await prisma.turmaImportada.deleteMany({
      where: { codigoTurma: CODIGO_TURMA },
    });

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
          statusCurso: 'Matrícula Trancada',
          ativo: false,
        }),
      ]);

      // A cancelada (vinculo B) nao aparece.
      expect(rodadas(res.body)).toEqual(['SUB', 'N2']);
    });

    it('traz tudo o que a declaracao e a tela do portal mostram', async () => {
      const res = await comChave(api().get(rota())).expect(200);
      const [sub] = res.body.agendamentos;

      expect(sub).toMatchObject({
        alunoId: vinculoA,
        curso: 'CURSO E2E INTEG A',
        status: 'CONFIRMADO',
        periodoId: janelaSubId,
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
            codigoTurma: CODIGO_TURMA,
            codigoDisciplina: 'E2EINTEGD01',
            idTurmaDisc: 'E2E-TD-01',
          },
        ],
        alocadoManual: true,
      });
      expect(sub.agendadoEm).toEqual(expect.any(String));
      // Disciplina fora do CSV de turmas: os codigos vem `null`, nao somem.
      expect(res.body.agendamentos[1].disciplinas).toEqual([
        {
          orgUnitId: 'ou-Disciplina Integ N2',
          nomeDisciplina: 'Disciplina Integ N2',
          codigoTurma: null,
          codigoDisciplina: null,
          idTurmaDisc: null,
        },
      ]);
      // Nada da janela repetido na prova: fica em `periodos[]`.
      expect(sub).not.toHaveProperty('periodo');
      expect(sub).not.toHaveProperty('rodada');
    });

    /**
     * `prazoEncerrado` e a regra da declaracao entregue como dado: a N2 e de uma
     * janela passada (encerrada por definicao), a SUB e da vigente, com o prazo
     * ainda correndo — o aluno pode trocar de horario.
     */
    it('poe cada janela uma vez no topo, com o seu prazo', async () => {
      const res = await comChave(api().get(rota())).expect(200);

      expect(res.body.periodos).toEqual([
        {
          id: janelaSubId,
          rodada: 'SUB',
          rodadaDescricao: 'Substitutiva (SUB)',
          descricao: 'e2e integracao SUB',
          periodoLetivoIds: [PERIODO_LETIVO],
          dataAbertura: null,
          dataFechamento: expect.any(String),
          prazoEncerrado: false,
        },
        expect.objectContaining({
          id: janelaN2Id,
          rodada: 'N2',
          descricao: 'e2e integracao N2',
          prazoEncerrado: true,
        }),
      ]);
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

        expect(res.body.periodos[0]).toMatchObject({
          id: janelaSubId,
          prazoEncerrado: true,
        });
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
      expect(rodadas(res.body)).toEqual(['SUB']);
      // So a janela que tem prova no recorte.
      expect(res.body.periodos).toEqual([
        expect.objectContaining({ id: janelaSubId }),
      ]);
    });
  });

  /**
   * GET /integracao/agendamentos — a lista geral, sem matricula. O banco do e2e
   * pode ter provas de outras suites, entao as asserções olham so as desta
   * matricula — exceto onde o periodo letivo, que e so deste arquivo, ja isola.
   */
  describe('lista geral', () => {
    const lista = (query: string) =>
      comChave(api().get(`/api/integracao/agendamentos?${query}`));

    it('401 sem o header X-API-Key', async () => {
      await api().get('/api/integracao/agendamentos?periodo=atual').expect(401);
    });

    it.each([
      ['sem recorte', ''],
      [
        'com os dois recortes',
        `periodo=atual&periodoLetivoId=${PERIODO_LETIVO}`,
      ],
      ['`rodada` com `periodo=atual`', 'periodo=atual&rodada=N2'],
      ['`periodo` diferente de `atual`', 'periodo=todos'],
      ['`periodoLetivoId` fora do formato', 'periodoLetivoId=a;b'],
      ['`pagina` zero', `periodoLetivoId=${PERIODO_LETIVO}&pagina=0`],
      [
        '`porPagina` nao numerico',
        `periodoLetivoId=${PERIODO_LETIVO}&porPagina=x`,
      ],
    ])('400 %s', async (_caso, query) => {
      await lista(query).expect(400);
    });

    it('`periodo=atual` traz so a janela vigente, uma vez, no topo', async () => {
      const res = await lista('periodo=atual&porPagina=500').expect(200);

      expect(res.body.filtro).toEqual({
        periodo: 'atual',
        periodoLetivoIds: [PERIODO_LETIVO],
        rodada: 'SUB',
      });
      expect(res.body.periodos).toEqual([
        {
          id: janelaSubId,
          rodada: 'SUB',
          rodadaDescricao: 'Substitutiva (SUB)',
          descricao: 'e2e integracao SUB',
          periodoLetivoIds: [PERIODO_LETIVO],
          dataAbertura: null,
          dataFechamento: expect.any(String),
          prazoEncerrado: false,
        },
      ]);

      const daqui = res.body.itens.filter(
        (a: { matricula: string }) => a.matricula === MATRICULA,
      );

      expect(daqui).toEqual([
        expect.objectContaining({
          periodoId: janelaSubId,
          matricula: MATRICULA,
          nome: 'ALUNO E2E INTEGRACAO',
          alunoId: vinculoA,
          periodoLetivoId: PERIODO_LETIVO,
          data: '2026-09-10',
          disciplinas: [
            expect.objectContaining({
              codigoTurma: CODIGO_TURMA,
              codigoDisciplina: 'E2EINTEGD01',
              idTurmaDisc: 'E2E-TD-01',
            }),
          ],
        }),
      ]);
      // Nada da janela repetido no item.
      expect(daqui[0]).not.toHaveProperty('periodo');
      expect(daqui[0]).not.toHaveProperty('rodada');
    });

    it('pelo periodo letivo vem a N2 e a SUB, sem a cancelada, por data', async () => {
      const res = await lista(`periodoLetivoId=${PERIODO_LETIVO}`).expect(200);

      expect(res.body).toMatchObject({
        filtro: {
          periodo: null,
          periodoLetivoIds: [PERIODO_LETIVO],
          rodada: null,
        },
        total: 2,
        pagina: 1,
        totalPaginas: 1,
      });
      expect(rodadas(res.body)).toEqual(['N2', 'SUB']);
      // As duas janelas no topo, cada uma com o seu prazo.
      expect(
        res.body.periodos.map((p: { id: number; prazoEncerrado: boolean }) => [
          p.id,
          p.prazoEncerrado,
        ]),
      ).toEqual([
        [janelaSubId, false],
        [janelaN2Id, true],
      ]);
    });

    it('`rodada` estreita para uma prova so', async () => {
      const res = await lista(
        `periodoLetivoId=${PERIODO_LETIVO}&rodada=N2`,
      ).expect(200);

      expect(res.body.filtro.rodada).toBe('N2');
      expect(res.body.periodos).toEqual([
        expect.objectContaining({ id: janelaN2Id, rodada: 'N2' }),
      ]);
      expect(rodadas(res.body)).toEqual(['N2']);
    });

    it('periodo letivo sem prova nenhuma responde 200 com lista vazia', async () => {
      const res = await lista('periodoLetivoId=E2E-INTEG-INEXISTENTE').expect(
        200,
      );

      expect(res.body).toMatchObject({
        periodos: [],
        total: 0,
        totalPaginas: 1,
        itens: [],
      });
    });

    it('pagina em ordem estavel', async () => {
      const base = `periodoLetivoId=${PERIODO_LETIVO}&porPagina=1`;
      const [p1, p2, p3] = await Promise.all(
        [1, 2, 3].map((n) => lista(`${base}&pagina=${n}`).expect(200)),
      );

      expect(p1.body).toMatchObject({
        total: 2,
        porPagina: 1,
        totalPaginas: 2,
      });
      expect(rodadas(p1.body)).toEqual(['N2']);
      expect(rodadas(p2.body)).toEqual(['SUB']);
      expect(p3.body.itens).toEqual([]);
      // O topo nao depende da pagina: a pagina vazia ainda diz os prazos.
      expect(p3.body.periodos).toEqual(p1.body.periodos);
    });

    it('`porPagina` acima do maximo e limitado, nao recusado', async () => {
      const res = await lista(
        `periodoLetivoId=${PERIODO_LETIVO}&porPagina=9999`,
      ).expect(200);

      expect(res.body.porPagina).toBe(500);
    });
  });
});
