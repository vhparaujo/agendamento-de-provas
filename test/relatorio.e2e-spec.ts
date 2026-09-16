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
  /** Existe so para provar que quem NAO agendou sai na exportacao. */
  const SEM_PROVA = 'E2EREL002';
  const PERIODO_LETIVO = 'E2E-REL-500';
  /** O semestre seguinte cadastrado cedo demais, que o DELETE desfaz. */
  const PERIODO_LETIVO_ENGANO = 'E2E-REL-501';
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

    // O colega que nunca vai entrar no portal: e ele que a exportacao precisa
    // listar como "nao agendado".
    await prisma.alunoImportado.create({
      data: {
        matricula: SEM_PROVA,
        nome: 'FULANO SEM PROVA',
        email: 'fulano@aluno.ucb.br',
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
    await prisma.agendamento.deleteMany({
      where: { matricula: { in: [MATRICULA, SEM_PROVA] } },
    });

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
      where: {
        periodoLetivoId: { in: [PERIODO_LETIVO, PERIODO_LETIVO_ENGANO] },
      },
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

    /**
     * O caso que a rota existe para resolver: o semestre seguinte cadastrado
     * cedo demais rouba o vigente do periodo em curso, e nao ha flag para
     * marcar outro no lugar. Apagar devolve o portal a quem estava valendo — e
     * `vigenteAgora` e o que prova isso para quem chamou.
     */
    it('apagar o periodo cadastrado por engano devolve o vigente ao anterior', async () => {
      const novo = await comoAdmin(api().post('/api/periodos'))
        .send({
          periodoLetivoId: PERIODO_LETIVO_ENGANO,
          descricao: 'semestre seguinte, cedo demais',
          dataFechamento: '2027-03-01T23:59:00-03:00',
        })
        .expect(201);

      expect(novo.body.vigente).toBe(true);

      const anterior = await comoAdmin(
        api().get(`/api/periodos/${periodoId}`),
      ).expect(200);
      expect(anterior.body.vigente).toBe(false);

      const remocao = await comoAdmin(
        api().delete(`/api/periodos/${novo.body.id}`),
      ).expect(200);

      expect(remocao.body.vigenteAgora).toMatchObject({ id: periodoId });

      const devolvido = await comoAdmin(
        api().get(`/api/periodos/${periodoId}`),
      ).expect(200);
      expect(devolvido.body.vigente).toBe(true);
    });

    it('404 ao apagar periodo inexistente', async () => {
      await comoAdmin(api().delete('/api/periodos/99999999')).expect(404);
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

    /**
     * A linha some, as provas nao — `Agendamento.periodoLetivoId` e string, sem
     * FK. Elas ficariam orfas da janela que as identifica e sumiriam do portal
     * do aluno, que so enxerga o vigente.
     */
    it('recusa apagar o periodo depois que alguem agendou', async () => {
      const res = await comoAdmin(
        api().delete(`/api/periodos/${periodoId}`),
      ).expect(409);

      expect(res.body.message).toMatch(/agendamento/i);
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
    const linhaDe = (csv: string, matricula: string) =>
      csv.split('\r\n').find((l) => l.includes(matricula)) as string;

    it('devolve um arquivo para download', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
      ).expect(200);

      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename="Lista Agendamento-.*\.csv"/,
      );
    });

    it('comeca com BOM UTF-8, separa por ponto e virgula e so tem as colunas combinadas', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
      ).expect(200);

      // Sem o BOM, o Excel em Windows le "Câmpus" como "CÃ¢mpus".
      expect(res.text.charCodeAt(0)).toBe(0xfeff);
      expect(res.text.split('\r\n')[0]).toBe(
        '﻿Matricula;Aluno;E-mail;Curso;Situação do Curso;Modalidade;Polo;' +
          'Rodada;Data da prova;Inicio;Fim;Sala;Status;Agendado em;Agendado por',
      );
    });

    it('traz a linha do aluno com todos os dados', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
      ).expect(200);

      const linha = linhaDe(res.text, MATRICULA);

      expect(linha).toBeDefined();
      expect(linha).toContain('NUTRIÇÃO');
      expect(linha).toContain('REL-101');
      // Qual prova do semestre — a coluna que separa a regular da substitutiva.
      expect(linha).toContain(';N2;');
      expect(linha).toContain('12/11/2026'); // data da prova, no fuso certo
      expect(linha).toContain('08:30');
      expect(linha).toContain(';Agendado;');
      expect(linha).toContain('NUTRIÇÃO;Ativo;');
      // A reserva saiu do portal, pelo proprio aluno.
      expect(linha.endsWith(';Aluno')).toBe(true);
    });

    /**
     * A origem vem do evento CRIADO do historico, e nao de `alocadoManual` —
     * que o remanejo tambem liga. Aqui a identificacao e trocada direto no
     * banco para simular os dois caminhos do admin sem montar o lote inteiro.
     */
    it('"Agendado por" separa o compulsorio do admin de balcao', async () => {
      const agendamento = await prisma.agendamento.findFirstOrThrow({
        where: { matricula: MATRICULA, status: 'CONFIRMADO' },
      });
      const criado = await prisma.historicoAgendamento.findFirstOrThrow({
        where: { agendamentoId: agendamento.id, evento: 'CRIADO' },
      });

      const linhaCom = async (autor: string) => {
        await prisma.historicoAgendamento.update({
          where: { id: criado.id },
          data: { autorTipo: 'ADMIN', autor },
        });

        return linhaDe(
          (
            await comoAdmin(
              api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
            ).expect(200)
          ).text,
          MATRICULA,
        );
      };

      try {
        expect((await linhaCom('compulsorio')).endsWith(';Compulsório')).toBe(
          true,
        );
        expect((await linhaCom(EMAIL)).endsWith(';Admin')).toBe(true);
      } finally {
        await prisma.historicoAgendamento.update({
          where: { id: criado.id },
          data: { autorTipo: criado.autorTipo, autor: criado.autor },
        });
      }
    });

    it('"Situação do Curso" traz o STATUS CURSO importado, qualquer que seja', async () => {
      await prisma.alunoImportado.updateMany({
        where: { matricula: SEM_PROVA },
        data: { statusCurso: 'Trancado', ativo: false },
      });

      try {
        const linha = linhaDe(
          (
            await comoAdmin(
              api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
            ).expect(200)
          ).text,
          SEM_PROVA,
        );

        expect(linha).toContain('NUTRIÇÃO;Trancado;');
      } finally {
        await prisma.alunoImportado.updateMany({
          where: { matricula: SEM_PROVA },
          data: { statusCurso: 'Ativo', ativo: true },
        });
      }
    });

    // O motivo de o relatorio existir: a secretaria liga para quem falta.
    it('traz TAMBEM quem nunca agendou, como "Não Agendado"', async () => {
      const res = await comoAdmin(
        api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
      ).expect(200);

      const linha = linhaDe(res.text, SEM_PROVA);

      expect(linha).toBeDefined();
      // As colunas da prova ficam vazias — nao ha o que preencher. "Agendado
      // por" tambem: ninguem agendou por ele.
      expect(linha).toContain(`${SEM_PROVA};FULANO SEM PROVA;`);
      expect(linha.endsWith(';Não Agendado;;')).toBe(true);
    });

    /**
     * A modalidade e o polo da linha saem do AGENDAMENTO, nao do vinculo.
     *
     * `aluno_importado` guarda so o estado atual e a importacao o sobrescreve.
     * Lendo de la, uma prova feita como EaD passava a ser exibida como "Modular"
     * assim que o aluno mudasse de curso — na mesma linha da data e da sala
     * corretas, que continuam sendo as da prova de verdade.
     */
    it('mostra a modalidade DA EPOCA da prova, nao a de hoje', async () => {
      const modular = await prisma.modalidade.findUniqueOrThrow({
        where: { codigo: 'MODULAR' },
      });

      const antes = linhaDe(
        (
          await comoAdmin(
            api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
          ).expect(200)
        ).text,
        MATRICULA,
      );

      expect(antes).toContain(';EaD;');

      // O aluno muda de curso: e exatamente o que uma reimportacao faz.
      await prisma.alunoImportado.updateMany({
        where: { matricula: MATRICULA },
        data: { modalidadeId: modular.id },
      });

      const depois = linhaDe(
        (
          await comoAdmin(
            api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
          ).expect(200)
        ).text,
        MATRICULA,
      );

      // A prova continua sendo a mesma prova.
      expect(depois).toContain(';EaD;');
      expect(depois).toContain('12/11/2026');

      // Quem NAO tem prova nao tem fotografia, e ai o estado atual e a resposta
      // certa: vai agendar pela modalidade que tem hoje.
      await prisma.alunoImportado.updateMany({
        where: { matricula: SEM_PROVA },
        data: { modalidadeId: modular.id },
      });

      const semProva = linhaDe(
        (
          await comoAdmin(
            api().get(`/api/agendamentos/exportacao?poloId=${poloId}`),
          ).expect(200)
        ).text,
        SEM_PROVA,
      );

      expect(semProva).toContain(`;${modular.nome};`);

      await prisma.alunoImportado.updateMany({
        where: { matricula: { in: [MATRICULA, SEM_PROVA] } },
        data: { modalidadeId: ead.id },
      });
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

    it('filtro de PROVA (faixa) deixa de fora quem nao tem prova ali', async () => {
      const res = await comoAdmin(
        api().get(
          `/api/agendamentos/exportacao?poloId=${poloId}&faixaId=${faixaId}`,
        ),
      ).expect(200);

      expect(res.text).toContain(MATRICULA);
      expect(res.text).not.toContain(SEM_PROVA);
    });

    it('respeita o filtro (polo sem aluno sai so com cabecalho)', async () => {
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
