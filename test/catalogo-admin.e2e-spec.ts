import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/service/auth.service';
import { PrismaService } from './../src/database/prisma.service';

/**
 * A consulta administrativa do que os CSVs trouxeram: alunos (vinculos) e
 * turmas/disciplinas.
 *
 * O que estas rotas precisam provar e que a busca do balcao funciona sem que
 * quem atende saiba de qual coluna do CSV o dado veio — e que os dois vinculos
 * do mesmo RA continuam visiveis como duas linhas, porque sao duas provas.
 */
describe('Catalogo administrativo: alunos e turmas importados (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: AuthService;
  let token: string;
  let alunoToken: string;

  const EMAIL = 'e2e-catalogo@ucb.br';
  const SENHA = 'senha-do-teste-123';
  const POLO_NOME = 'Polo E2E Catalogo';
  const RA_DUPLO = 'E2ECAT001';
  const RA_BLOQUEADO = 'E2ECAT002';
  const CURSO_EAD = 'PEDAGOGIA E2E CATALOGO';
  const CURSO_MODULAR = 'PSICOLOGIA E2E CATALOGO';
  const TURMA_COM_ID = 'E2ECAT-T1';
  const TURMA_SEM_ID = 'E2ECAT-T2';
  const ORG_UNIT = 'ou-e2ecat-1';

  let poloId: number;
  let vinculoEadId: number;
  let turmaComIdId: number;
  let turmaSemIdId: number;

  const api = () => request(app.getHttpServer());
  const comoAdmin = <T extends request.Test>(r: T) =>
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

    const ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });
    const modular = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'MODULAR' },
    });

    poloId = (await prisma.polo.create({ data: { nome: POLO_NOME } })).id;

    // O caso real: um RA em dois cursos, com formatos diferentes.
    vinculoEadId = (
      await prisma.alunoImportado.create({
        data: {
          matricula: RA_DUPLO,
          nome: 'MONICA E2E CATALOGO',
          email: 'monica.e2e@aluno.ucb.br',
          curso: CURSO_EAD,
          statusCurso: 'Ativo',
          ativo: true,
          modalidadeId: ead.id,
          poloId,
        },
      })
    ).id;

    await prisma.alunoImportado.create({
      data: {
        matricula: RA_DUPLO,
        nome: 'MONICA E2E CATALOGO',
        curso: CURSO_MODULAR,
        statusCurso: 'Ativo',
        ativo: true,
        modalidadeId: modular.id,
        poloId,
      },
    });

    // Matrícula Trancada: continua na base (e na busca), mas nao pode agendar.
    await prisma.alunoImportado.create({
      data: {
        matricula: RA_BLOQUEADO,
        nome: 'JOAO E2E TRANCADO',
        curso: CURSO_EAD,
        statusCurso: 'Matrícula Trancada',
        ativo: false,
        modalidadeId: ead.id,
        poloId,
      },
    });

    turmaComIdId = (
      await prisma.turmaImportada.create({
        data: {
          codigoTurma: TURMA_COM_ID,
          nomeDisciplina: 'SAUDE COLETIVA E2E',
          codigoEad: 'E2ECATEAD001',
          orgUnitId: ORG_UNIT,
        },
      })
    ).id;

    turmaSemIdId = (
      await prisma.turmaImportada.create({
        data: {
          codigoTurma: TURMA_SEM_ID,
          nomeDisciplina: 'DANCA E2E',
          codigoEad: 'E2ECATEAD002',
        },
      })
    ).id;

    alunoToken = (
      await auth.emitirTokenAluno({
        sub: RA_DUPLO,
        userIdD2L: '99999',
        vinculos: [
          {
            alunoId: vinculoEadId,
            curso: CURSO_EAD,
            modalidade: 'EAD',
            poloId,
            ativo: true,
          },
        ],
        contexto: {
          orgUnitId: ORG_UNIT,
          codigo: TURMA_COM_ID,
          titulo: 'SAUDE COLETIVA E2E',
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
    const polos = await prisma.polo.findMany({ where: { nome: POLO_NOME } });

    for (const polo of polos) {
      // O agendamento do teste de 409 segura sala, faixa e aluno: derrube na
      // ordem inversa da criacao, senao o delete do polo bate na FK.
      await prisma.agendamento.deleteMany({ where: { poloId: polo.id } });
      await prisma.salaFaixa.deleteMany({
        where: { faixa: { poloId: polo.id } },
      });
      await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
      await prisma.sala.deleteMany({ where: { poloId: polo.id } });
      await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
      await prisma.polo.delete({ where: { id: polo.id } });
    }

    await prisma.turmaImportada.deleteMany({
      where: { codigoTurma: { in: [TURMA_COM_ID, TURMA_SEM_ID] } },
    });
  }

  describe('GET /alunos — pesquisa dos vinculos importados', () => {
    it('acha pelo RA e devolve os DOIS vinculos como linhas separadas', async () => {
      const res = await comoAdmin(
        api().get(`/api/alunos?busca=${RA_DUPLO}`),
      ).expect(200);

      const itens = res.body.itens as { curso: string; modalidade: string }[];

      expect(res.body.total).toBe(2);
      expect(itens.map((i) => i.curso).sort()).toEqual(
        [CURSO_EAD, CURSO_MODULAR].sort(),
      );
      // Formatos diferentes: sao duas provas, com duracoes diferentes.
      expect(new Set(itens.map((i) => i.modalidade)).size).toBe(2);
    });

    it('acha por pedaco do nome, do e-mail e do curso — o mesmo campo de busca', async () => {
      for (const busca of ['MONICA E2E', 'monica.e2e@aluno', 'PEDAGOGIA E2E']) {
        const res = await comoAdmin(
          api().get(
            `/api/alunos?poloId=${poloId}&busca=${encodeURIComponent(busca)}`,
          ),
        ).expect(200);

        expect(res.body.total).toBeGreaterThan(0);
      }
    });

    it('`ativo=false` isola quem NAO pode agendar, sem esconde-lo da base', async () => {
      const res = await comoAdmin(
        api().get(`/api/alunos?poloId=${poloId}&ativo=false`),
      ).expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.itens[0]).toMatchObject({
        matricula: RA_BLOQUEADO,
        statusCurso: 'Matrícula Trancada',
        ativo: false,
      });
    });

    it('`agendado=false` responde "quem ainda nao marcou prova"', async () => {
      const res = await comoAdmin(
        api().get(`/api/alunos?poloId=${poloId}&agendado=false`),
      ).expect(200);

      expect(res.body.total).toBe(3);
      expect(
        res.body.itens.every(
          (i: { totalAgendamentos: number }) => i.totalAgendamentos === 0,
        ),
      ).toBe(true);
    });

    it('pagina, e o teto de porPagina segura pedido abusivo', async () => {
      const pagina1 = await comoAdmin(
        api().get(`/api/alunos?poloId=${poloId}&porPagina=2&pagina=1`),
      ).expect(200);

      expect(pagina1.body).toMatchObject({ total: 3, totalPaginas: 2 });
      expect(pagina1.body.itens).toHaveLength(2);

      const pagina2 = await comoAdmin(
        api().get(`/api/alunos?poloId=${poloId}&porPagina=2&pagina=2`),
      ).expect(200);

      expect(pagina2.body.itens).toHaveLength(1);

      const abusivo = await comoAdmin(
        api().get('/api/alunos?porPagina=100000'),
      ).expect(200);

      expect(abusivo.body.porPagina).toBe(200);
    });

    it('parametro desconhecido na URL nao derruba a busca', async () => {
      // URL de busca e coisa que se cola e edita — por isso os filtros sao lidos
      // a mao, sem DTO com forbidNonWhitelisted.
      await comoAdmin(
        api().get(`/api/alunos?poloId=${poloId}&ordenar=nome&utm_source=email`),
      ).expect(200);
    });

    it('lista os cursos distintos para o dropdown do filtro', async () => {
      const res = await comoAdmin(api().get('/api/alunos/cursos')).expect(200);

      expect(res.body).toContain(CURSO_EAD);
      expect(res.body).toContain(CURSO_MODULAR);
    });
  });

  describe('GET /alunos/:id — a tela de atendimento', () => {
    it('mostra o outro vinculo da mesma matricula', async () => {
      const res = await comoAdmin(
        api().get(`/api/alunos/${vinculoEadId}`),
      ).expect(200);

      expect(res.body).toMatchObject({
        matricula: RA_DUPLO,
        curso: CURSO_EAD,
        polo: POLO_NOME,
        agendamentos: [],
      });
      expect(res.body.outrosVinculos).toHaveLength(1);
      expect(res.body.outrosVinculos[0].curso).toBe(CURSO_MODULAR);
    });

    it('404 para vinculo inexistente', async () => {
      await comoAdmin(api().get('/api/alunos/99999999')).expect(404);
    });
  });

  describe('GET /turmas — o catalogo do que tem prova', () => {
    it('acha por nome, por codigo da turma e por codigo da disciplina', async () => {
      for (const busca of [
        'SAUDE COLETIVA E2E',
        TURMA_COM_ID,
        'E2ECATEAD001',
      ]) {
        const res = await comoAdmin(
          api().get(`/api/turmas?busca=${encodeURIComponent(busca)}`),
        ).expect(200);

        expect(res.body.total).toBe(1);
        expect(res.body.itens[0].id).toBe(turmaComIdId);
      }
    });

    it('`comOrgUnitId=false` mostra o que nenhum launch alcancou ainda', async () => {
      const res = await comoAdmin(
        api().get('/api/turmas?busca=E2ECAT-T&comOrgUnitId=false'),
      ).expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.itens[0]).toMatchObject({
        codigoTurma: TURMA_SEM_ID,
        orgUnitId: null,
      });
    });

    it('sem orgUnitId, o total de agendamentos vem NULL — nao zero', async () => {
      const semId = await comoAdmin(
        api().get(`/api/turmas/${turmaSemIdId}`),
      ).expect(200);

      // "0" faria parecer que ninguem marcou; a verdade e que nao da para contar.
      expect(semId.body.totalAgendamentos).toBeNull();

      const comId = await comoAdmin(
        api().get(`/api/turmas/${turmaComIdId}`),
      ).expect(200);

      expect(comId.body.totalAgendamentos).toBe(0);
    });

    it('404 para turma inexistente', async () => {
      await comoAdmin(api().get('/api/turmas/99999999')).expect(404);
    });
  });

  /**
   * O delete existe porque a importacao e upsert: turma que saiu da planilha
   * (ou que nunca deveria ter entrado) nao some sozinha no proximo upload.
   */
  describe('DELETE /turmas/:id — tirar do catalogo o que nao tem prova', () => {
    const TURMA_ERRADA = 'E2ECAT-T3';

    async function criarTurmaErrada() {
      return (
        await prisma.turmaImportada.create({
          data: {
            codigoTurma: TURMA_ERRADA,
            nomeDisciplina: 'DUPLICADA E2E',
            codigoEad: 'E2ECATEAD003',
          },
        })
      ).id;
    }

    afterEach(async () => {
      await prisma.turmaImportada.deleteMany({
        where: { codigoTurma: TURMA_ERRADA },
      });
    });

    it('apaga a turma e ela some da listagem', async () => {
      const id = await criarTurmaErrada();

      const res = await comoAdmin(api().delete(`/api/turmas/${id}`)).expect(
        200,
      );

      // A resposta avisa da planilha de proposito: sem isso a remocao volta.
      expect(res.body.mensagem).toContain('próximo envio do CSV');

      await comoAdmin(api().get(`/api/turmas/${id}`)).expect(404);

      const lista = await comoAdmin(
        api().get(`/api/turmas?busca=${TURMA_ERRADA}`),
      ).expect(200);

      expect(lista.body.total).toBe(0);
    });

    it('recusa (409) turma com agendamento confirmado', async () => {
      const ead = await prisma.modalidade.findUniqueOrThrow({
        where: { codigo: 'EAD' },
      });

      const sala = await prisma.sala.create({
        data: { poloId, nome: 'SALA E2E CATALOGO', capacidade: 10 },
      });
      const faixa = await prisma.faixa.create({
        data: {
          poloId,
          data: new Date('2026-11-10'),
          horaInicio: '08:30',
          horaFim: '11:30',
        },
      });
      const salaFaixa = await prisma.salaFaixa.create({
        data: {
          salaId: sala.id,
          faixaId: faixa.id,
          modalidadeId: ead.id,
          vagas: 10,
          ordem: 1,
        },
      });

      // O agendamento aponta para a disciplina pelo orgUnitId, sem FK — e por
      // isso que o delete precisa conferir a mao.
      const agendamento = await prisma.agendamento.create({
        data: {
          alunoId: vinculoEadId,
          salaFaixaId: salaFaixa.id,
          matricula: RA_DUPLO,
          userIdD2L: '99999',
          periodoLetivoId: 'e2e-catalogo-periodo',
          rodada: 'N2',
          modalidadeId: ead.id,
          poloId,
        },
      });

      await prisma.agendamentoDisciplina.create({
        data: {
          agendamentoId: agendamento.id,
          orgUnitId: ORG_UNIT,
          nomeDisciplina: 'SAUDE COLETIVA E2E',
        },
      });

      await comoAdmin(api().delete(`/api/turmas/${turmaComIdId}`)).expect(409);

      // A turma continua de pe: o 409 recusou, nao apagou pela metade.
      await comoAdmin(api().get(`/api/turmas/${turmaComIdId}`)).expect(200);

      await prisma.agendamento.delete({ where: { id: agendamento.id } });
      await prisma.salaFaixa.delete({ where: { id: salaFaixa.id } });
      await prisma.faixa.delete({ where: { id: faixa.id } });
      await prisma.sala.delete({ where: { id: sala.id } });
    });

    it('404 para turma inexistente', async () => {
      await comoAdmin(api().delete('/api/turmas/99999999')).expect(404);
    });
  });

  /**
   * Renomear existe porque reimportar com outro nome cria uma turma NOVA — sem
   * o orgUnitId aprendido e empatando com a antiga no cruzamento. O que precisa
   * ficar provado e que nada do que esta ligado a turma se perde.
   */
  describe('PATCH /turmas/:id — renomear sem perder as ligacoes', () => {
    const TURMA_RENOMEAR = 'E2ECAT-T4';
    const ORG_UNIT_RENOMEAR = 'ou-e2ecat-4';
    const NOME_PLANILHA = 'GESTAO E2E';
    const NOME_NOVO = 'GESTAO DE PESSOAS E2E';

    let turmaId: number;

    const csvDeTurmas = (linhas: string[]) =>
      Buffer.from(
        '\ufeffCódigo da Turma;Disciplina / Código EAD\n' +
          linhas.join('\n') +
          '\n',
        'utf8',
      );

    beforeEach(async () => {
      turmaId = (
        await prisma.turmaImportada.create({
          data: {
            codigoTurma: TURMA_RENOMEAR,
            nomeDisciplina: NOME_PLANILHA,
            codigoEad: 'E2ECATEAD004',
            orgUnitId: ORG_UNIT_RENOMEAR,
          },
        })
      ).id;
    });

    afterEach(async () => {
      await prisma.agendamento.deleteMany({
        where: { disciplinas: { some: { orgUnitId: ORG_UNIT_RENOMEAR } } },
      });
      await prisma.salaFaixa.deleteMany({
        where: { faixa: { poloId } },
      });
      await prisma.faixa.deleteMany({ where: { poloId } });
      await prisma.sala.deleteMany({ where: { poloId } });
      await prisma.turmaImportada.deleteMany({
        where: { codigoTurma: TURMA_RENOMEAR },
      });
    });

    async function agendar(status: 'CONFIRMADO' | 'CANCELADO') {
      const ead = await prisma.modalidade.findUniqueOrThrow({
        where: { codigo: 'EAD' },
      });

      const sala = await prisma.sala.create({
        data: { poloId, nome: `SALA E2E RENOMEAR ${status}`, capacidade: 10 },
      });
      const faixa = await prisma.faixa.create({
        data: {
          poloId,
          data: new Date('2026-11-11'),
          horaInicio: status === 'CONFIRMADO' ? '08:30' : '14:00',
          horaFim: status === 'CONFIRMADO' ? '11:30' : '17:00',
        },
      });
      const salaFaixa = await prisma.salaFaixa.create({
        data: {
          salaId: sala.id,
          faixaId: faixa.id,
          modalidadeId: ead.id,
          vagas: 10,
          ordem: 1,
        },
      });

      return prisma.agendamento.create({
        data: {
          alunoId: vinculoEadId,
          salaFaixaId: salaFaixa.id,
          matricula: RA_DUPLO,
          userIdD2L: '99999',
          periodoLetivoId: 'e2e-catalogo-periodo',
          rodada: status === 'CONFIRMADO' ? 'N2' : 'SUB',
          modalidadeId: ead.id,
          poloId,
          status,
          disciplinas: {
            create: {
              orgUnitId: ORG_UNIT_RENOMEAR,
              nomeDisciplina: NOME_PLANILHA,
            },
          },
        },
        include: { disciplinas: true },
      });
    }

    it('troca o nome e mantem id, codigos e orgUnitId', async () => {
      const res = await comoAdmin(
        api()
          .patch(`/api/turmas/${turmaId}`)
          .send({ nomeDisciplina: NOME_NOVO }),
      ).expect(200);

      expect(res.body.turma).toEqual({
        id: turmaId,
        codigoTurma: TURMA_RENOMEAR,
        nomeDisciplina: NOME_NOVO,
        codigoEad: 'E2ECATEAD004',
        orgUnitId: ORG_UNIT_RENOMEAR,
        nomeNaPlanilha: NOME_PLANILHA,
      });
      // O aviso do cruzamento faz parte da resposta de proposito.
      expect(res.body.mensagem).toContain('AVA');
    });

    it('atualiza o nome nos agendamentos CONFIRMADOS, e so neles', async () => {
      const confirmado = await agendar('CONFIRMADO');
      const cancelado = await agendar('CANCELADO');

      const res = await comoAdmin(
        api()
          .patch(`/api/turmas/${turmaId}`)
          .send({ nomeDisciplina: NOME_NOVO }),
      ).expect(200);

      expect(res.body.agendamentosAtualizados).toBe(1);

      const [doConfirmado, doCancelado] = await Promise.all(
        [confirmado, cancelado].map((a) =>
          prisma.agendamentoDisciplina.findUniqueOrThrow({
            where: { id: a.disciplinas[0].id },
          }),
        ),
      );

      expect(doConfirmado.nomeDisciplina).toBe(NOME_NOVO);
      // Cancelado e historico: continua dizendo o que dizia.
      expect(doCancelado.nomeDisciplina).toBe(NOME_PLANILHA);
    });

    it('renomear duas vezes guarda o PRIMEIRO nome da planilha, e voltar a ele limpa a marca', async () => {
      await comoAdmin(
        api()
          .patch(`/api/turmas/${turmaId}`)
          .send({ nomeDisciplina: NOME_NOVO }),
      ).expect(200);

      const segunda = await comoAdmin(
        api()
          .patch(`/api/turmas/${turmaId}`)
          .send({ nomeDisciplina: 'OUTRO NOME E2E' }),
      ).expect(200);

      expect(segunda.body.turma.nomeNaPlanilha).toBe(NOME_PLANILHA);

      const volta = await comoAdmin(
        api()
          .patch(`/api/turmas/${turmaId}`)
          .send({ nomeDisciplina: NOME_PLANILHA }),
      ).expect(200);

      expect(volta.body.turma.nomeNaPlanilha).toBeNull();
    });

    it('reimportar a planilha com o nome antigo NAO cria outra turma', async () => {
      await comoAdmin(
        api()
          .patch(`/api/turmas/${turmaId}`)
          .send({ nomeDisciplina: NOME_NOVO }),
      ).expect(200);

      const res = await comoAdmin(
        api()
          .post('/api/importacao/turmas')
          .attach(
            'arquivo',
            csvDeTurmas([
              `${TURMA_RENOMEAR};${NOME_PLANILHA} (1-E2ECATEAD004)`,
            ]),
            'turmas-renomear.csv',
          ),
      ).expect(201);

      expect(res.body.criadas).toBe(0);
      expect(res.body.atualizadas).toBe(1);

      const turmas = await prisma.turmaImportada.findMany({
        where: { codigoTurma: TURMA_RENOMEAR },
      });

      expect(turmas).toHaveLength(1);
      expect(turmas[0]).toMatchObject({
        id: turmaId,
        nomeDisciplina: NOME_NOVO,
        orgUnitId: ORG_UNIT_RENOMEAR,
      });
    });

    it('recusa (409) nome de outra turma com o mesmo codigo', async () => {
      await prisma.turmaImportada.create({
        data: { codigoTurma: TURMA_RENOMEAR, nomeDisciplina: NOME_NOVO },
      });

      await comoAdmin(
        api()
          .patch(`/api/turmas/${turmaId}`)
          .send({ nomeDisciplina: NOME_NOVO }),
      ).expect(409);
    });

    it('recusa (400) nome vazio', async () => {
      await comoAdmin(
        api().patch(`/api/turmas/${turmaId}`).send({ nomeDisciplina: '   ' }),
      ).expect(400);
    });

    it('404 para turma inexistente', async () => {
      await comoAdmin(
        api().patch('/api/turmas/99999999').send({ nomeDisciplina: NOME_NOVO }),
      ).expect(404);
    });
  });

  describe('protecao das rotas', () => {
    it.each([
      ['/api/alunos'],
      ['/api/alunos/cursos'],
      [`/api/alunos/${1}`],
      ['/api/turmas'],
      [`/api/turmas/${1}`],
    ])('GET %s exige token de admin', async (rota) => {
      await api().get(rota).expect(401);
    });

    it('DELETE /turmas/:id exige token de admin', async () => {
      await api().delete('/api/turmas/1').expect(401);
    });

    it('PATCH /turmas/:id exige token de admin', async () => {
      await api()
        .patch('/api/turmas/1')
        .send({ nomeDisciplina: 'X' })
        .expect(401);
    });

    it('o token do aluno nao abre a base de alunos', async () => {
      await api()
        .get('/api/alunos')
        .set('Authorization', `Bearer ${alunoToken}`)
        .expect(401);
    });
  });
});
