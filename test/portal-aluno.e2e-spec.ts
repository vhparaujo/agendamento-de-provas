import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/service/auth.service';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Fluxo do aluno: ver horarios -> confirmar -> alocacao sequencial.
 *
 * Os tokens sao emitidos pelo proprio AuthService (o mesmo caminho do launch
 * LTI), so pulando a assinatura do Brightspace, que nao da para reproduzir aqui.
 *
 * Requer banco de pe, migrations e seed (formatos).
 */
describe('Portal do aluno: listar e agendar (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: AuthService;

  const POLO_NOME = 'Polo E2E Portal';
  const OUTRO_POLO_NOME = 'Polo E2E Portal Distante';
  const TURMA = 'E2E-PORTAL-TURMA-1';
  const PREFIXO_RA = 'E2EP';

  let poloId: number;
  let outroPoloId: number;
  let ead: { id: number };
  let faixaId: number;
  let faixaDisputadaId: number;
  let faixaPassadaId: number;
  let salaPrimeiraNome: string;
  let salaSegundaNome: string;
  let periodoId: number;

  const PERIODO_LETIVO = 'E2E-PORTAL-103';

  const api = () => request(app.getHttpServer());

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

    ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });

    poloId = (await prisma.polo.create({ data: { nome: POLO_NOME } })).id;
    outroPoloId = (
      await prisma.polo.create({ data: { nome: OUTRO_POLO_NOME } })
    ).id;

    // A turma precisa estar importada: com TURMAS_FILTER_ENABLED=true (default),
    // disciplina fora do CSV de turmas nao e agendavel.
    await prisma.turmaImportada.create({
      data: { codigoTurma: TURMA, nomeDisciplina: 'Disciplina E2E' },
    });

    periodoId = (
      await prisma.periodoAgendamento.create({
        data: {
          periodoLetivoId: PERIODO_LETIVO,
          descricao: 'e2e portal',
          aberto: true,
          dataFechamento: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      })
    ).id;

    // Salas propositalmente minusculas: encher uma sala de 40 lugares no teste
    // custaria 40 requisicoes para provar a mesma regra.
    const primeira = await criarSala('P-A', 2, poloId);
    const segunda = await criarSala('P-B', 1, poloId);
    const disputada = await criarSala('P-C', 1, poloId);

    salaPrimeiraNome = primeira.nome;
    salaSegundaNome = segunda.nome;

    faixaId = await criarFaixa('2026-12-15', [
      { salaId: primeira.id, vagas: 2, ordem: 1 },
      { salaId: segunda.id, vagas: 1, ordem: 2 },
    ]);

    faixaDisputadaId = await criarFaixa('2026-12-16', [
      { salaId: disputada.id, vagas: 1, ordem: 1 },
    ]);

    // Data no passado: criada direto no banco porque o cadastro do admin nao
    // tem por que aceitar marcar prova para ontem.
    faixaPassadaId = (
      await prisma.faixa.create({
        data: {
          poloId,
          data: new Date('2026-01-10T00:00:00.000Z'),
          horaInicio: '08:30',
          horaFim: '11:30',
          salaFaixas: {
            create: {
              salaId: primeira.id,
              modalidadeId: ead.id,
              vagas: 10,
              ordem: 1,
            },
          },
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await limpar();
    await app.close();
  });

  async function criarSala(nome: string, capacidade: number, polo: number) {
    return prisma.sala.create({
      data: { poloId: polo, nome, capacidade },
    });
  }

  async function criarFaixa(
    data: string,
    salas: { salaId: number; vagas: number; ordem: number }[],
  ): Promise<number> {
    const faixa = await prisma.faixa.create({
      data: {
        poloId,
        data: new Date(`${data}T00:00:00.000Z`),
        horaInicio: '08:30',
        horaFim: '11:30',
        salaFaixas: {
          create: salas.map((s) => ({ ...s, modalidadeId: ead.id })),
        },
      },
    });

    return faixa.id;
  }

  /** Cria um vinculo e devolve o token que o launch LTI emitiria para ele. */
  async function criarAluno(opcoes: {
    sufixo: string;
    curso?: string;
    polo?: number;
    statusCurso?: string;
    ativo?: boolean;
    /** Sem turma = launch sem contexto: nao ha disciplina para agendar. */
    turma?: string | null;
  }): Promise<{ token: string; alunoId: number; matricula: string }> {
    const matricula = `${PREFIXO_RA}${opcoes.sufixo}`;

    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula,
        nome: `Aluno ${opcoes.sufixo}`,
        curso: opcoes.curso ?? 'CURSO E2E',
        statusCurso: opcoes.statusCurso ?? 'Ativo',
        ativo: opcoes.ativo ?? true,
        modalidadeId: ead.id,
        poloId: opcoes.polo ?? poloId,
      },
    });

    const { accessToken } = await auth.emitirTokenAluno({
      sub: matricula,
      userIdD2L: `d2l-${opcoes.sufixo}`,
      vinculos: [
        {
          alunoId: aluno.id,
          curso: aluno.curso,
          modalidade: 'EAD',
          poloId: aluno.poloId,
          ativo: aluno.ativo,
        },
      ],
      contexto:
        opcoes.turma === null
          ? undefined
          : {
              orgUnitId: `ou-${opcoes.turma ?? TURMA}`,
              codigo: opcoes.turma ?? TURMA,
              titulo: 'Disciplina E2E',
            },
    });

    return { token: accessToken, alunoId: aluno.id, matricula };
  }

  const comoAluno = <T extends request.Test>(r: T, token: string) =>
    r.set('Authorization', `Bearer ${token}`);

  async function limpar() {
    await prisma.agendamento.deleteMany({
      where: { matricula: { startsWith: PREFIXO_RA } },
    });

    const polos = await prisma.polo.findMany({
      where: { nome: { in: [POLO_NOME, OUTRO_POLO_NOME] } },
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

  describe('o que o aluno enxerga', () => {
    let token: string;

    beforeAll(async () => {
      ({ token } = await criarAluno({ sufixo: 'VER' }));
    });

    it('informa que o agendamento esta aberto', async () => {
      const res = await comoAluno(
        api().get('/api/portal/periodo'),
        token,
      ).expect(200);

      expect(res.body).toMatchObject({ aberto: true });
      expect(res.body.motivo).toBeUndefined();
    });

    it('lista as disciplinas que a prova vai cobrir', async () => {
      const res = await comoAluno(
        api().get('/api/portal/disciplinas'),
        token,
      ).expect(200);

      expect(res.body.podeAgendar).toBe(true);
      // orgUnitId vem do launch (context.id); o NOME vem do CSV de turmas
      expect(res.body.disciplinas).toEqual([
        { orgUnitId: `ou-${TURMA}`, nomeDisciplina: 'Disciplina E2E' },
      ]);
    });

    it('lista as faixas do polo dele com o total de vagas livres', async () => {
      const res = await comoAluno(
        api().get('/api/portal/faixas'),
        token,
      ).expect(200);

      const faixa = res.body.find(
        (f: { faixaId: number }) => f.faixaId === faixaId,
      );

      // 2 vagas na sala de ordem 1 + 1 na de ordem 2
      expect(faixa).toMatchObject({ vagas: 3, disponiveis: 3, temVaga: true });
    });

    it('NAO revela as salas — a sala e resultado da alocacao', async () => {
      const res = await comoAluno(
        api().get('/api/portal/faixas'),
        token,
      ).expect(200);

      expect(res.body[0]).not.toHaveProperty('sala');
      expect(res.body[0]).not.toHaveProperty('ofertas');
      expect(res.body[0]).not.toHaveProperty('salaFaixas');
    });

    it('nao mostra faixa cuja data ja passou', async () => {
      const res = await comoAluno(
        api().get('/api/portal/faixas'),
        token,
      ).expect(200);

      expect(
        res.body.some((f: { faixaId: number }) => f.faixaId === faixaPassadaId),
      ).toBe(false);
    });

    it('nao mostra faixa de outro polo', async () => {
      const outro = await criarAluno({ sufixo: 'OUTRO', polo: outroPoloId });

      const res = await comoAluno(
        api().get('/api/portal/faixas'),
        outro.token,
      ).expect(200);

      expect(res.body).toEqual([]);
    });
  });

  describe('ALOCACAO SEQUENCIAL: enche uma sala antes de abrir a proxima', () => {
    it('o 1o e o 2o aluno caem na sala de ordem 1', async () => {
      for (const sufixo of ['A1', 'A2']) {
        const { token } = await criarAluno({ sufixo });

        const res = await comoAluno(
          api().post('/api/portal/agendamentos'),
          token,
        )
          .send({ faixaId })
          .expect(201);

        expect(res.body.sala.nome).toBe(salaPrimeiraNome);
      }
    });

    it('o 3o aluno vai para a sala de ordem 2, porque a 1a lotou', async () => {
      const { token } = await criarAluno({ sufixo: 'A3' });

      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId })
        .expect(201);

      expect(res.body.sala.nome).toBe(salaSegundaNome);
    });

    it('o 4o aluno recebe 409 de vagas esgotadas', async () => {
      const { token } = await criarAluno({ sufixo: 'A4' });

      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId })
        .expect(409);

      expect(res.body.message).toMatch(/vagas/i);
    });

    it('a faixa passa a aparecer como lotada, sem sumir da lista', async () => {
      const { token } = await criarAluno({ sufixo: 'VER2' });

      const res = await comoAluno(
        api().get('/api/portal/faixas'),
        token,
      ).expect(200);

      const faixa = res.body.find(
        (f: { faixaId: number }) => f.faixaId === faixaId,
      );

      expect(faixa).toMatchObject({ disponiveis: 0, temVaga: false });
    });
  });

  describe('CONCORRENCIA: uma vaga, varios alunos ao mesmo tempo', () => {
    it('exatamente um confirma; os outros recebem 409', async () => {
      const alunos = await Promise.all(
        ['C1', 'C2', 'C3', 'C4', 'C5'].map((sufixo) => criarAluno({ sufixo })),
      );

      const respostas = await Promise.all(
        alunos.map(({ token }) =>
          comoAluno(api().post('/api/portal/agendamentos'), token).send({
            faixaId: faixaDisputadaId,
          }),
        ),
      );

      const status = respostas.map((r) => r.status);

      expect(status.filter((s) => s === 201)).toHaveLength(1);
      expect(status.filter((s) => s === 409)).toHaveLength(4);

      // A prova real do teste: overbooking apareceria no banco, nao no HTTP.
      const gravados = await prisma.agendamento.count({
        where: { salaFaixa: { faixaId: faixaDisputadaId } },
      });

      expect(gravados).toBe(1);
    }, 30_000);
  });

  describe('o que o agendamento recusa', () => {
    it('403 para quem tem a matricula bloqueada no curso', async () => {
      const { token } = await criarAluno({
        sufixo: 'BLOQ',
        statusCurso: 'Cancelado',
        ativo: false,
      });

      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId })
        .expect(403);

      expect(res.body.message).toMatch(/Cancelado/);
    });

    it('403 quando o launch nao trouxe disciplina', async () => {
      const { token } = await criarAluno({ sufixo: 'SEMCTX', turma: null });

      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: faixaDisputadaId })
        .expect(403);

      expect(res.body.message).toMatch(/disciplina/i);
    });

    it('403 quando a disciplina nao esta no CSV de turmas', async () => {
      const { token } = await criarAluno({
        sufixo: 'TURMAX',
        turma: 'TURMA-QUE-NAO-TEM-PROVA',
      });

      await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: faixaDisputadaId })
        .expect(403);
    });

    it('403 ao tentar um horario de outro polo', async () => {
      const outro = await criarAluno({ sufixo: 'POLOX', polo: outroPoloId });

      const res = await comoAluno(
        api().post('/api/portal/agendamentos'),
        outro.token,
      )
        .send({ faixaId })
        .expect(403);

      expect(res.body.message).toMatch(/polo/i);
    });

    it('409 ao agendar duas vezes o mesmo curso', async () => {
      const { token } = await criarAluno({ sufixo: 'DUPLO' });

      const livre = await criarFaixa('2026-12-20', [
        { salaId: (await criarSala('P-D', 5, poloId)).id, vagas: 5, ordem: 1 },
      ]);

      await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: livre })
        .expect(201);

      // Mesmo com vaga sobrando: uma prova por vinculo, no mesmo periodo.
      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: livre })
        .expect(409);

      expect(res.body.message).toMatch(/ja tem prova marcada/i);
    });

    it('409 para faixa cuja data ja passou', async () => {
      const { token } = await criarAluno({ sufixo: 'PASSADA' });

      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: faixaPassadaId })
        .expect(409);

      expect(res.body.message).toMatch(/passou/i);
    });

    it('404 para horario inexistente', async () => {
      const { token } = await criarAluno({ sufixo: 'NF' });

      await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: 99999999 })
        .expect(404);
    });

    it('403 ao mandar o alunoId de outra pessoa', async () => {
      const vitima = await criarAluno({ sufixo: 'VITIMA' });
      const atacante = await criarAluno({ sufixo: 'ATACANTE' });

      const res = await comoAluno(
        api().post('/api/portal/agendamentos'),
        atacante.token,
      )
        .send({ faixaId, alunoId: vitima.alunoId })
        .expect(403);

      expect(res.body.message).toMatch(/nao pertence a sua matricula/i);
    });

    it('400 para campo fora do DTO', async () => {
      const { token } = await criarAluno({ sufixo: 'EXTRA' });

      await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId, salaId: 1 })
        .expect(400);
    });
  });

  describe('aluno com dois cursos', () => {
    let token: string;
    let pedagogia: number;
    let psicologia: number;

    beforeAll(async () => {
      const matricula = `${PREFIXO_RA}DOIS`;

      const criar = (curso: string) =>
        prisma.alunoImportado.create({
          data: {
            matricula,
            nome: 'Aluna com dois cursos',
            curso,
            statusCurso: 'Ativo',
            ativo: true,
            modalidadeId: ead.id,
            poloId,
          },
        });

      pedagogia = (await criar('PEDAGOGIA')).id;
      psicologia = (await criar('PSICOLOGIA')).id;

      ({ accessToken: token } = await auth.emitirTokenAluno({
        sub: matricula,
        userIdD2L: 'd2l-dois',
        vinculos: [pedagogia, psicologia].map((alunoId) => ({
          alunoId,
          curso: alunoId === pedagogia ? 'PEDAGOGIA' : 'PSICOLOGIA',
          modalidade: 'EAD',
          poloId,
          ativo: true,
        })),
        contexto: {
          orgUnitId: 'ou-' + TURMA,
          codigo: TURMA,
          titulo: 'Disciplina E2E',
        },
      }));
    });

    it('400 quando nao diz de qual curso e a prova', async () => {
      const res = await comoAluno(
        api().get('/api/portal/disciplinas'),
        token,
      ).expect(400);

      expect(res.body.message).toMatch(/mais de um curso/i);
    });

    /**
     * ⚠️ Ate 14/08/2026 este teste afirmava o CONTRARIO: os dois cursos no
     * MESMO horario, e 201 nos dois. O cliente corrigiu a regra — sao duas
     * provas diferentes e ninguem faz as duas ao mesmo tempo. Na pratica o
     * aluno ocupava duas cadeiras, aparecia duas vezes na lista de presenca e
     * so fazia uma das provas.
     */
    it('agenda um curso e depois o outro, cada um em SEU horario', async () => {
      const faixaA = await criarFaixa('2026-12-21', [
        { salaId: (await criarSala('P-E', 5, poloId)).id, vagas: 5, ordem: 1 },
      ]);
      const faixaB = await criarFaixa('2026-12-22', [
        { salaId: (await criarSala('P-F', 5, poloId)).id, vagas: 5, ordem: 1 },
      ]);

      await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: faixaA, alunoId: pedagogia })
        .expect(201);

      // Mesma pessoa, outro curso, MESMO horario: recusado mesmo com 4 vagas
      // livres na sala. A recusa e sobre o aluno, nao sobre a sala.
      const conflito = await comoAluno(
        api().post('/api/portal/agendamentos'),
        token,
      )
        .send({ faixaId: faixaA, alunoId: psicologia })
        .expect(409);

      expect(conflito.body.message).toMatch(
        /ja tem prova marcada neste horario/i,
      );

      await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: faixaB, alunoId: psicologia })
        .expect(201);

      const res = await comoAluno(
        api().get('/api/portal/agendamentos'),
        token,
      ).expect(200);

      expect(res.body).toHaveLength(2);
      expect(res.body.map((a: { curso: string }) => a.curso).sort()).toEqual([
        'PEDAGOGIA',
        'PSICOLOGIA',
      ]);
    });

    it('marca o horario ja tomado pelo outro curso em GET /portal/faixas', async () => {
      // A tela precisa dizer POR QUE aquele horario nao serve, em vez de deixar
      // o aluno descobrir no clique de confirmar.
      const res = await comoAluno(api().get('/api/portal/faixas'), token)
        .query({ alunoId: psicologia })
        .expect(200);

      const daPedagogia = res.body.find(
        (f: { conflitaComOutraProva: boolean }) => f.conflitaComOutraProva,
      );

      expect(daPedagogia).toBeDefined();
      // Tem vaga de sobra — o que falta e o aluno, nao a cadeira.
      expect(daPedagogia.temVaga).toBe(true);

      // O horario da prova DELE mesmo nao conta como conflito: para este
      // vinculo, ele nao e impedimento nenhum.
      const doPsicologia = res.body.filter(
        (f: { conflitaComOutraProva: boolean }) => f.conflitaComOutraProva,
      );

      expect(doPsicologia).toHaveLength(1);
    });
  });

  /**
   * ==========================================================================
   * DUAS PROVAS NO MESMO SEMESTRE: a regular e a substitutiva
   * ==========================================================================
   * As duas caem no MESMO `periodoLetivoId` do Brightspace, e e a `rodada` que
   * as separa. Antes dela, quem agendou a N2 batia em "voce ja tem prova
   * marcada" ao tentar a SUB — a trava era `alunoId + periodoLetivoId`, e o
   * semestre nao distinguia uma prova da outra.
   *
   * O bloco abre uma janela `SUB` do mesmo semestre (ela vira a vigente, porque
   * vigente = a cadastrada mais recentemente) e a apaga no fim, para os
   * describes seguintes voltarem a enxergar a janela original.
   */
  describe('rodada: a substitutiva do mesmo periodo letivo', () => {
    let token: string;
    let alunoId: number;
    let faixaDaN2: number;
    let faixaDaSub: number;
    let periodoSubId: number;

    beforeAll(async () => {
      ({ token, alunoId } = await criarAluno({ sufixo: 'SUB1' }));

      faixaDaN2 = await criarFaixa('2026-12-27', [
        { salaId: (await criarSala('P-G', 5, poloId)).id, vagas: 5, ordem: 1 },
      ]);
      faixaDaSub = await criarFaixa('2026-12-28', [
        { salaId: (await criarSala('P-H', 5, poloId)).id, vagas: 5, ordem: 1 },
      ]);

      // A prova regular, com a janela original (rodada N2) ainda vigente.
      await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: faixaDaN2 })
        .expect(201);

      // Agora a secretaria abre a substitutiva do MESMO semestre.
      periodoSubId = (
        await prisma.periodoAgendamento.create({
          data: {
            periodoLetivoId: PERIODO_LETIVO,
            rodada: 'SUB',
            descricao: 'e2e portal — substitutiva',
            aberto: true,
            dataFechamento: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        })
      ).id;
    }, 60_000);

    afterAll(async () => {
      await prisma.periodoAgendamento.delete({ where: { id: periodoSubId } });
    });

    it('o MESMO vinculo que agendou a N2 consegue agendar a SUB', async () => {
      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: faixaDaSub })
        .expect(201);

      expect(res.body).toMatchObject({ alunoId, rodada: 'SUB' });
    });

    /** A trava por vinculo continua de pe — ela so passou a contar a rodada. */
    it('mas nao consegue agendar a SUB duas vezes', async () => {
      const outraDaSub = await criarFaixa('2026-12-29', [
        { salaId: (await criarSala('P-I', 5, poloId)).id, vagas: 5, ordem: 1 },
      ]);

      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId: outraDaSub })
        .expect(409);

      expect(res.body.message).toMatch(/ja tem prova marcada/i);
      expect(res.body.message).toMatch(/SUB/);
    });

    /**
     * A trava por PESSOA (`exigirUmaProvaPorFaixa`) NAO olha a rodada, e este
     * teste e o que prova: quem fez a N2 as 08:30 do dia 27 nao faz a SUB no
     * mesmo horario — sao duas provas e ninguem esta em dois lugares ao mesmo
     * tempo. A sala tem 4 vagas livres; quem nao pode e o aluno.
     */
    it('recusa a SUB na MESMA faixa em que ele ja tem a N2', async () => {
      // Um aluno com a prova da N2 e SEM a da SUB: assim a recusa vem da trava
      // por PESSOA, e nao da trava por vinculo, que ja pegaria o caso antes.
      // A reserva da N2 vai direto ao banco porque a janela vigente e a da SUB,
      // e pelo portal so se agenda na rodada aberta.
      const { token: outro, alunoId: outroId } = await criarAluno({
        sufixo: 'SUB2',
      });

      const ofertaDaN2 = await prisma.salaFaixa.findFirstOrThrow({
        where: { faixaId: faixaDaN2 },
        select: { id: true },
      });

      await prisma.agendamento.create({
        data: {
          alunoId: outroId,
          salaFaixaId: ofertaDaN2.id,
          matricula: `${PREFIXO_RA}SUB2`,
          userIdD2L: 'd2l-SUB2',
          periodoLetivoId: PERIODO_LETIVO,
          rodada: 'N2',
          modalidadeId: ead.id,
          poloId,
        },
      });

      // A sala tem 5 lugares e nem 3 estao ocupados: a recusa abaixo e sobre o
      // aluno, nao sobre a cadeira.
      const res = await comoAluno(api().post('/api/portal/agendamentos'), outro)
        .send({ faixaId: faixaDaN2 })
        .expect(409);

      expect(res.body.message).toMatch(/neste horario/i);
    });

    /** E a tela avisa antes do clique, como no caso dos dois cursos. */
    it('marca a faixa da N2 como conflito em GET /portal/faixas', async () => {
      const res = await comoAluno(
        api().get('/api/portal/faixas'),
        token,
      ).expect(200);

      const daN2 = res.body.find(
        (f: { faixaId: number }) => f.faixaId === faixaDaN2,
      );

      expect(daN2).toMatchObject({
        temVaga: true,
        conflitaComOutraProva: true,
      });

      // A propria reserva da SUB nao se marca como conflito.
      const daSub = res.body.find(
        (f: { faixaId: number }) => f.faixaId === faixaDaSub,
      );

      expect(daSub.conflitaComOutraProva).toBe(false);
    });

    /**
     * `GET /portal/agendamentos` mostra a prova da RODADA vigente, e so ela. A
     * N2 do mesmo semestre ja aconteceu; lista-las juntas mandaria o aluno para
     * a data errada — o mesmo motivo pelo qual o semestre passado nao aparece.
     */
    it('meusAgendamentos mostra so a prova da rodada vigente', async () => {
      const res = await comoAluno(
        api().get('/api/portal/agendamentos'),
        token,
      ).expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ rodada: 'SUB' });
    });

    it('GET /portal/periodo diz de qual prova do semestre e a janela', async () => {
      const res = await comoAluno(
        api().get('/api/portal/periodo'),
        token,
      ).expect(200);

      expect(res.body).toMatchObject({
        aberto: true,
        periodoLetivoId: PERIODO_LETIVO,
        rodada: 'SUB',
      });
    });

    /** A prova da rodada anterior fica congelada: nem trocar de horario. */
    it('recusa trocar o horario da prova da N2 depois de a SUB abrir', async () => {
      const daN2 = await prisma.agendamento.findFirstOrThrow({
        where: { alunoId, rodada: 'N2' },
        select: { id: true },
      });

      await comoAluno(api().patch(`/api/portal/agendamentos/${daN2.id}`), token)
        .send({ faixaId: faixaDaSub })
        .expect(404);
    });
  });

  describe('o agendamento ja deixa a liberacao no D2L enfileirada', () => {
    it('cria um SyncD2L PENDENTE por disciplina', async () => {
      const agendamento = await prisma.agendamento.findFirstOrThrow({
        where: { matricula: `${PREFIXO_RA}A1` },
        include: { syncs: true, disciplinas: true },
      });

      expect(agendamento.disciplinas).toHaveLength(1);
      expect(agendamento.syncs).toHaveLength(1);
      expect(agendamento.syncs[0]).toMatchObject({
        orgUnitId: `ou-${TURMA}`,
        status: 'PENDENTE',
        tentativas: 0,
      });
    });
  });

  describe('periodo fechado', () => {
    afterAll(async () => {
      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: true },
      });
    });

    it('403 com o motivo, mesmo havendo vaga', async () => {
      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: false },
      });

      const { token } = await criarAluno({ sufixo: 'FECHADO' });

      const situacao = await comoAluno(
        api().get('/api/portal/periodo'),
        token,
      ).expect(200);

      expect(situacao.body.aberto).toBe(false);

      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId })
        .expect(403);

      expect(res.body.message).toMatch(/fechado/i);
    });

    it('403 tambem quando o prazo ja venceu', async () => {
      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: {
          aberto: true,
          dataFechamento: new Date(Date.now() - 60 * 60 * 1000),
        },
      });

      const { token } = await criarAluno({ sufixo: 'VENCIDO' });

      const res = await comoAluno(api().post('/api/portal/agendamentos'), token)
        .send({ faixaId })
        .expect(403);

      expect(res.body.message).toMatch(/encerrou/i);

      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: {
          dataFechamento: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
    });
  });

  /**
   * ==========================================================================
   * A DECLARACAO DE AGENDAMENTO
   * ==========================================================================
   * Regra do cliente: ela so existe DEPOIS de o prazo encerrar. Com o prazo
   * aberto o aluno ainda troca de horario e cancela (regra 7), e o papel
   * afirmaria uma data que ele mesmo pode mudar cinco minutos depois — quem o
   * recebeu (empregador, escola) nao teria como conferir.
   *
   * Este bloco mexe na `dataFechamento` do periodo e a devolve no fim: ele roda
   * depois dos que dependem do prazo aberto, mas o `afterAll` existe para nao
   * criar ordem implicita com o que vier a ser escrito abaixo.
   */
  describe('declaracao de agendamento', () => {
    let declaranteToken: string;
    let agendamentoId: number;
    let faixaDeclaracaoId: number;

    const PRAZO_ORIGINAL = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    beforeAll(async () => {
      // Faixa e sala proprias: as do topo ja foram lotadas pelos testes de
      // alocacao sequencial, e um 409 de vaga aqui pareceria falha da
      // declaracao.
      const sala = await criarSala('P-DECL', 2, poloId);

      faixaDeclaracaoId = await criarFaixa('2026-12-20', [
        { salaId: sala.id, vagas: 2, ordem: 1 },
      ]);

      const aluno = await criarAluno({ sufixo: 'DECL' });

      declaranteToken = aluno.token;

      const confirmado = await comoAluno(
        api().post('/api/portal/agendamentos'),
        declaranteToken,
      )
        .send({ faixaId: faixaDeclaracaoId })
        .expect(201);

      agendamentoId = confirmado.body.id;
    });

    afterAll(async () => {
      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: true, dataFechamento: PRAZO_ORIGINAL },
      });
    });

    const declaracao = () =>
      comoAluno(
        api().get(`/api/portal/agendamentos/${agendamentoId}/declaracao`),
        declaranteToken,
      );

    async function encerrarPrazo() {
      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: {
          aberto: true,
          dataFechamento: new Date(Date.now() - 60 * 60 * 1000),
        },
      });
    }

    async function reabrirPrazo() {
      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { aberto: true, dataFechamento: PRAZO_ORIGINAL },
      });
    }

    it('403 enquanto o prazo de agendamento esta aberto', async () => {
      await reabrirPrazo();

      const res = await declaracao().expect(403);

      expect(res.body.message).toMatch(/prazo de agendamento/i);
    });

    /**
     * `encerrado` NAO e `!aberto`: "ainda nao abriu" tambem responde
     * `aberto: false`, e ali nao ha agendamento nenhum a declarar. Se a tela (ou
     * o service) lesse a negacao de `aberto`, este caso passaria a emitir
     * declaracao antes de o agendamento sequer comecar.
     */
    it('nao considera encerrado o prazo que ainda nem abriu', async () => {
      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: {
          aberto: true,
          dataAbertura: new Date(Date.now() + 24 * 60 * 60 * 1000),
          dataFechamento: PRAZO_ORIGINAL,
        },
      });

      const situacao = await comoAluno(
        api().get('/api/portal/periodo'),
        declaranteToken,
      ).expect(200);

      expect(situacao.body).toMatchObject({ aberto: false, encerrado: false });

      await declaracao().expect(403);

      await prisma.periodoAgendamento.update({
        where: { id: periodoId },
        data: { dataAbertura: null },
      });
    });

    it('devolve o PDF depois de o prazo encerrar', async () => {
      await encerrarPrazo();

      const situacao = await comoAluno(
        api().get('/api/portal/periodo'),
        declaranteToken,
      ).expect(200);

      expect(situacao.body).toMatchObject({ aberto: false, encerrado: true });

      const res = await declaracao()
        .buffer()
        .parse((r, cb) => {
          const pedacos: Buffer[] = [];
          r.on('data', (p: Buffer) => pedacos.push(p));
          r.on('end', () => cb(null, Buffer.concat(pedacos)));
        })
        .expect(200)
        .expect('Content-Type', /application\/pdf/);

      expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe(
        '%PDF-',
      );
      expect(res.headers['content-disposition']).toContain(
        'Declaracao de agendamento - E2EPDECL.pdf',
      );
    });

    /**
     * Sem o filtro por matricula, trocar o numero na URL imprimiria a prova de
     * outra pessoa COM O NOME DELA — o vazamento mais direto que esta rota
     * poderia ter.
     */
    it('404 na prova de outra pessoa', async () => {
      await encerrarPrazo();

      const intruso = await criarAluno({ sufixo: 'DECLX' });

      await comoAluno(
        api().get(`/api/portal/agendamentos/${agendamentoId}/declaracao`),
        intruso.token,
      ).expect(404);
    });

    /**
     * Cancelado nao reserva cadeira nenhuma no dia, entao nao ha o que
     * declarar. Cancelar exige o prazo ABERTO (regra 7), dai a reabertura no
     * meio do caso.
     */
    /**
     * Cancelado nao reserva cadeira nenhuma no dia, entao nao ha o que
     * declarar — e o papel afirmaria uma prova que a pessoa nao vai fazer.
     *
     * O cancelamento e feito direto no banco porque o aluno nao cancela mais
     * pelo portal (decisao de 17/08/2026): quem desmarca e a secretaria, por
     * `DELETE /agendamentos/:id`. O que este caso prova e o filtro `CONFIRMADO`
     * do service, e nao a rota que gravou o status.
     */
    it('404 depois de a prova ser cancelada', async () => {
      await reabrirPrazo();

      const aluno = await criarAluno({ sufixo: 'DECLC' });

      const confirmado = await comoAluno(
        api().post('/api/portal/agendamentos'),
        aluno.token,
      )
        .send({ faixaId: faixaDeclaracaoId })
        .expect(201);

      await prisma.agendamento.update({
        where: { id: confirmado.body.id },
        data: { status: 'CANCELADO' },
      });

      await encerrarPrazo();

      await comoAluno(
        api().get(`/api/portal/agendamentos/${confirmado.body.id}/declaracao`),
        aluno.token,
      ).expect(404);
    });

    it('recusa sem token', async () => {
      await encerrarPrazo();

      await api()
        .get(`/api/portal/agendamentos/${agendamentoId}/declaracao`)
        .expect(401);
    });
  });

  describe('o admin ve a ocupacao que a alocacao produziu', () => {
    it('a faixa aparece com as salas cheias e nao pode ser apagada', async () => {
      const faixa = await prisma.faixa.findUniqueOrThrow({
        where: { id: faixaId },
        include: {
          salaFaixas: {
            orderBy: { ordem: 'asc' },
            include: { _count: { select: { agendamentos: true } } },
          },
        },
      });

      expect(faixa.salaFaixas[0]._count.agendamentos).toBe(2);
      expect(faixa.salaFaixas[1]._count.agendamentos).toBe(1);
    });
  });

  describe('protecao das rotas', () => {
    it.each([
      ['/api/portal/periodo'],
      ['/api/portal/faixas'],
      ['/api/portal/disciplinas'],
      ['/api/portal/agendamentos'],
    ])('GET %s exige token de aluno', async (rota) => {
      await api().get(rota).expect(401);
    });

    it('recusa token forjado', async () => {
      await api()
        .get('/api/portal/faixas')
        .set('Authorization', 'Bearer token-forjado')
        .expect(401);
    });
  });
});
