import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/auth/service/auth.service';
import { PrismaService } from './../src/database/prisma.service';
import { Turno } from './../src/generated/prisma/client';

/**
 * A grade de senhas de prova, pela porta HTTP.
 *
 * O que estas rotas precisam provar nao e que gravam e leem — isso o unitario ja
 * cobre. E que **a senha nao vaza**: nem na listagem, nem no corpo do upsert que
 * volta, nem para quem nao e admin. A grade fica aberta num monitor
 * compartilhado da administracao, e um campo a mais no JSON e a senha da prova de
 * toda a instituicao na aba do navegador de qualquer um que passe por ali.
 *
 * O lote em si nao roda aqui: `D2L_HABILITADO` fica `false` no e2e (setup-e2e),
 * entao a rota de execucao e exercitada no unico caminho que ela tem sem
 * Brightspace — a recusa. Os caminhos de 409 (lote vivo, senha ja aplicada)
 * vivem em `src/senha-quiz/service/senha-quiz.service.spec.ts`, onde da para
 * mockar a Valence.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ A CHAVE DA CELULA E A SESSAO, NAO O TURNO (21/09/2026)
 * ---------------------------------------------------------------------------
 * Esta suite descrevia a grade `dia x TURNO`, que deixou de existir: a celula
 * passou a ser `dia x JANELA DE PROVA` e os horarios do cron sairam de
 * `configuracao_senha_quiz` para o calendario de janelas. Em Semi/Modular sao
 * seis sessoes e tres turnos, e ate aqui duas sessoes seguidas DIVIDIAM a
 * senha — o aluno das 08:30 podia repassa-la ao das 10:30.
 *
 * O que mudou nos testes, e por que:
 *
 *   `PUT /senhas-de-prova` { data, turno }   -> { data, janelaDeProvaId }
 *   `GET /senhas-de-prova`  devolvia `turno` -> devolve `janelaDeProvaId`
 *   `GET/PUT /senhas-de-prova/horarios`      -> nao existe; virou `/janelas`
 *   `POST .../execucoes` { data, turno }     -> { data, janelaId }
 *
 * `Turno` sobrevive como ROTULO da janela (a tela agrupa as sessoes por ele), e
 * por isso o bloco de janelas continua mandando o campo.
 */
describe('Senhas de prova: a grade dia x sessao (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: AuthService;
  let token: string;
  let alunoToken: string;

  const EMAIL = 'e2e-senhas@ucb.br';
  const SENHA_ADMIN = 'senha-do-teste-123';
  const POLO_NOME = 'Polo E2E Senhas';
  const RA = 'E2ESENHA001';

  // Datas bem no futuro para nao esbarrar em nada que outra suite cadastre.
  const DIA = '2099-09-16';
  const OUTRO_DIA = '2099-09-17';
  const SENHA_DA_PROVA = '897325';
  /** Codigo improvavel: `Modalidade.codigo` e unico e o seed usa os reais. */
  const MODALIDADE_CODIGO = 'E2E_JANELA_GRUPO';
  const SENHA_NOVA = '441028';
  /** A senha da OUTRA sessao do mesmo dia — ver o teste das duas sessoes. */
  const SENHA_DA_TARDE = '305174';

  /**
   * As duas sessoes do formato de teste, criadas por `criarSessoes()`.
   *
   * Sao duas, e nao uma, de proposito: a grade passou a ser `dia x SESSAO` em
   * 21/09/2026 justamente porque duas sessoes do mesmo dia precisavam de senhas
   * diferentes. Com uma so, nada aqui provaria a mudanca.
   */
  let sessaoManha: number;
  let sessaoTarde: number;

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

    const ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });
    const polo = await prisma.polo.create({ data: { nome: POLO_NOME } });

    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula: RA,
        nome: 'ALUNO E2E SENHAS',
        curso: 'PEDAGOGIA E2E SENHAS',
        statusCurso: 'Ativo',
        ativo: true,
        modalidadeId: ead.id,
        poloId: polo.id,
      },
    });

    alunoToken = (
      await auth.emitirTokenAluno({
        sub: RA,
        userIdD2L: '99998',
        vinculos: [
          {
            alunoId: aluno.id,
            curso: 'PEDAGOGIA E2E SENHAS',
            modalidade: 'EAD',
            poloId: polo.id,
            ativo: true,
          },
        ],
        contexto: {
          orgUnitId: 'ou-e2e-senhas',
          codigo: 'E2ESENHA-T1',
          titulo: 'PEDAGOGIA E2E SENHAS',
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
    // As janelas primeiro: `JanelaDeProva.modalidadeId` e FK.
    const modalidades = await prisma.modalidade.findMany({
      where: { codigo: MODALIDADE_CODIGO },
    });

    for (const modalidade of modalidades) {
      await prisma.janelaDeProva.deleteMany({
        where: { modalidadeId: modalidade.id },
      });
      await prisma.modalidade.delete({ where: { id: modalidade.id } });
    }

    await prisma.senhaDeProva.deleteMany({
      where: { data: { in: [new Date(DIA), new Date(OUTRO_DIA)] } },
    });

    const polos = await prisma.polo.findMany({ where: { nome: POLO_NOME } });

    for (const polo of polos) {
      await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
      await prisma.polo.delete({ where: { id: polo.id } });
    }
  }

  /**
   * O calendario de janelas, e em especial a regra da VERSAO.
   *
   * A versao nao e enfeite: e ela que libera uma janela ja disparada para rodar
   * de novo HOJE. Sem ela, corrigir um nome de grupo errado as 12:43, depois do
   * disparo das 12:01, nao adianta nada ate o dia seguinte — o upsert preserva o
   * id da linha e a idempotencia do cron encontra a execucao concluida e pula EM
   * SILENCIO. Bug real de 25/08/2026 do lado do horario; o grupo entrou na mesma
   * regra em 26/08/2026.
   */
  describe('PUT /senhas-de-prova/janelas — o grupo que libera a prova', () => {
    /** Um formato so para este teste, para nao mexer no calendario real. */
    let modalidadeId: number;

    const janela = (extra: Record<string, unknown> = {}) => ({
      ordem: 1,
      horaDisparo: '12:01',
      horaInicio: '15:00',
      horaFim: '18:00',
      turno: Turno.TARDE,
      ...extra,
    });

    const salvar = (janelas: Record<string, unknown>[]) =>
      comoAdmin(
        api()
          .put('/api/senhas-de-prova/janelas')
          .send({ modalidadeId, janelas }),
      );

    /**
     * So as janelas DESTE formato: o GET devolve o calendario inteiro, e o
     * seed real tem EaD, Semi, Modular e Presencial junto.
     *
     * Recebe `unknown` porque `res.body` do supertest e `any` — anotar aqui e o
     * que devolve o corpo ao radar do compilador em vez de espalhar o `any`.
     */
    const daModalidade = (corpo: unknown) =>
      (corpo as { janelas: Record<string, unknown>[] }).janelas.filter(
        (j) => j.modalidadeId === modalidadeId,
      );

    beforeAll(async () => {
      const modalidade = await prisma.modalidade.create({
        data: {
          codigo: MODALIDADE_CODIGO,
          nome: 'E2E Janelas',
          duracaoMinutos: 180,
          tempoDeProvaMinutos: 180,
        },
      });

      modalidadeId = modalidade.id;
    });

    it('guarda o nome e a categoria do grupo', async () => {
      const res = await salvar([
        janela({ nomeGrupo: 'Prova 2', categoriaGrupo: 'Separacao' }),
      ]).expect(200);

      expect(daModalidade(res.body)[0]).toMatchObject({
        nomeGrupo: 'Prova 2',
        categoriaGrupo: 'Separacao',
        versao: 1,
      });
    });

    it('salvar o MESMO calendario nao sobe a versao', async () => {
      const res = await salvar([
        janela({ nomeGrupo: 'Prova 2', categoriaGrupo: 'Separacao' }),
      ]).expect(200);

      expect(daModalidade(res.body)[0].versao).toBe(1);
    });

    /** O assert central deste bloco — ver o comentario do `describe`. */
    it('trocar o NOME DO GRUPO sobe a versao', async () => {
      const res = await salvar([
        janela({ nomeGrupo: 'Prova 3', categoriaGrupo: 'Separacao' }),
      ]).expect(200);

      expect(daModalidade(res.body)[0]).toMatchObject({
        nomeGrupo: 'Prova 3',
        versao: 2,
      });
    });

    it('trocar a CATEGORIA tambem sobe a versao', async () => {
      const res = await salvar([
        janela({ nomeGrupo: 'Prova 3', categoriaGrupo: 'Outra' }),
      ]).expect(200);

      expect(daModalidade(res.body)[0].versao).toBe(3);
    });

    /**
     * Vazio vira NULO, e nao string vazia. Um `""` gravado passaria pela
     * checagem de "tem grupo?" e faria o lote procurar um grupo sem nome em cada
     * turma, produzindo uma pendencia por turma sem que nada estivesse
     * configurado.
     */
    it('nome so com espacos vira NULO, e leva a categoria junto', async () => {
      const res = await salvar([
        janela({ nomeGrupo: '   ', categoriaGrupo: 'Sobrou' }),
      ]).expect(200);

      expect(daModalidade(res.body)[0]).toMatchObject({
        nomeGrupo: null,
        categoriaGrupo: null,
      });
    });

    it('o campo e opcional — salvar sem ele nao quebra', async () => {
      const res = await salvar([janela()]).expect(200);

      expect(daModalidade(res.body)[0].nomeGrupo).toBeNull();
    });

    /** `forbidNonWhitelisted`: campo nao declarado no DTO derruba a request. */
    it('recusa um campo de grupo que nao existe', async () => {
      await comoAdmin(
        api()
          .put('/api/senhas-de-prova/janelas')
          .send({
            modalidadeId,
            janelas: [janela({ grupoDoAva: 'Prova 2' })],
          }),
      ).expect(400);
    });
  });

  /**
   * A grade dia x janela dos grupos (14/09/2026).
   *
   * Roda DEPOIS do bloco das janelas, e usa a janela que ele deixou no
   * formato de teste: a celula e FK da janela, e o `limpar` apaga as duas
   * juntas (cascade).
   */
  describe('GET/PUT /senhas-de-prova/grupos — a grade de grupos do dia', () => {
    let janelaId: number;

    const salvar = (celulas: Record<string, unknown>[]) =>
      comoAdmin(api().put('/api/senhas-de-prova/grupos').send({ celulas }));

    const daJanela = (corpo: unknown) =>
      (corpo as Record<string, unknown>[]).filter(
        (c) => c.janelaDeProvaId === janelaId,
      );

    beforeAll(async () => {
      const modalidade = await prisma.modalidade.findUniqueOrThrow({
        where: { codigo: MODALIDADE_CODIGO },
      });
      janelaId = (
        await prisma.janelaDeProva.findFirstOrThrow({
          where: { modalidadeId: modalidade.id },
        })
      ).id;
    });

    it('cria a celula e a devolve com versao 1', async () => {
      const res = await salvar([
        { data: DIA, janelaDeProvaId: janelaId, nomeGrupo: ' EaD 16/09 15h ' },
      ]).expect(200);

      expect(daJanela(res.body)).toEqual([
        expect.objectContaining({
          data: DIA,
          nomeGrupo: 'EaD 16/09 15h',
          categoriaGrupo: null,
          versao: 1,
          atualizadoPor: EMAIL,
        }),
      ]);
    });

    it('a listagem do intervalo traz a celula', async () => {
      const res = await comoAdmin(
        api()
          .get('/api/senhas-de-prova/grupos')
          .query({ de: DIA, ate: OUTRO_DIA }),
      ).expect(200);

      expect(daJanela(res.body)).toHaveLength(1);
    });

    /**
     * A versao so sobe quando o nome MUDA: e ela que libera um novo disparo
     * hoje, e salvar a semana de novo nao pode reprocessar a instituicao.
     */
    it('salvar o MESMO nome nao sobe a versao; trocar sobe', async () => {
      const igual = await salvar([
        { data: DIA, janelaDeProvaId: janelaId, nomeGrupo: 'EaD 16/09 15h' },
      ]).expect(200);
      expect(daJanela(igual.body)[0].versao).toBe(1);

      const trocado = await salvar([
        { data: DIA, janelaDeProvaId: janelaId, nomeGrupo: 'EaD 16/09 tarde' },
      ]).expect(200);
      expect(daJanela(trocado.body)[0]).toMatchObject({
        nomeGrupo: 'EaD 16/09 tarde',
        versao: 2,
      });
    });

    it('nome vazio APAGA a celula', async () => {
      await salvar([
        { data: DIA, janelaDeProvaId: janelaId, nomeGrupo: '   ' },
      ]).expect(200);

      expect(
        await prisma.grupoDaJanela.count({
          where: { janelaDeProvaId: janelaId },
        }),
      ).toBe(0);
    });

    it('recusa data com hora, janela inexistente e celula repetida', async () => {
      await salvar([
        {
          data: `${DIA}T10:00:00Z`,
          janelaDeProvaId: janelaId,
          nomeGrupo: 'X',
        },
      ]).expect(400);

      await salvar([
        { data: DIA, janelaDeProvaId: 999_999_999, nomeGrupo: 'X' },
      ]).expect(400);

      await salvar([
        { data: DIA, janelaDeProvaId: janelaId, nomeGrupo: 'X' },
        { data: DIA, janelaDeProvaId: janelaId, nomeGrupo: 'Y' },
      ]).expect(400);
    });

    it('listar sem intervalo e 400', async () => {
      await comoAdmin(api().get('/api/senhas-de-prova/grupos')).expect(400);
    });

    it('aluno nao acessa a grade de grupos', async () => {
      await api()
        .get('/api/senhas-de-prova/grupos')
        .query({ de: DIA, ate: DIA })
        .set('Authorization', `Bearer ${alunoToken}`)
        .expect(401);
    });
  });

  /**
   * Duas sessoes no formato de teste, para as celulas terem onde se pendurar.
   *
   * Criadas direto no Prisma, e nao pelo `PUT /senhas-de-prova/janelas`: aquele
   * SUBSTITUI o calendario inteiro do formato, e levaria junto a janela que os
   * dois blocos anteriores deixaram montada (com a grade de grupos pendurada
   * nela por FK). Aqui o que se quer e acrescentar, nao redefinir.
   */
  async function criarSessoes() {
    const modalidade = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: MODALIDADE_CODIGO },
    });

    const criar = async (
      ordem: number,
      disparo: string,
      inicio: string,
      fim: string,
      turno: Turno,
    ) =>
      (
        await prisma.janelaDeProva.create({
          data: {
            modalidadeId: modalidade.id,
            ordem,
            horaDisparo: disparo,
            horaInicio: inicio,
            horaFim: fim,
            turno,
            // Derivado de `horaDisparo > horaInicio` (`ehDoDiaSeguinte`). Quem o
            // calcula e `salvarJanelas`, que nao passa aqui — os dois disparos
            // abaixo sao ANTES da abertura, entao `false` e o valor correto.
            diaSeguinte: false,
          },
        })
      ).id;

    // Disparo ANTES da abertura, como no calendario real (a regra e "fim da
    // sessao anterior + 1 minuto"). Disparar depois de a prova abrir e o que
    // torna a janela do dia seguinte, e nao e o caso destas duas.
    sessaoManha = await criar(2, '08:01', '08:30', '10:00', Turno.MANHA);
    sessaoTarde = await criar(3, '10:01', '14:00', '15:30', Turno.TARDE);
  }

  /** A celula de uma sessao num dia, pelo banco — sem depender de id capturado. */
  const celulaDe = (data: string, janelaDeProvaId: number) =>
    prisma.senhaDeProva.findFirstOrThrow({
      where: { data: new Date(data), janelaDeProvaId },
    });

  /** Qual das duas sessoes de teste e um id — so para a mensagem do assert. */
  const nomeDaSessao = (id: number) =>
    id === sessaoManha ? 'manha' : id === sessaoTarde ? 'tarde' : String(id);

  describe('PUT /senhas-de-prova — cadastro da celula', () => {
    beforeAll(criarSessoes);

    it('cria a celula e NAO devolve a senha na resposta', async () => {
      const res = await comoAdmin(
        api().put('/api/senhas-de-prova').send({
          data: DIA,
          janelaDeProvaId: sessaoManha,
          senha: SENHA_DA_PROVA,
        }),
      ).expect(200);

      expect(res.body.temSenha).toBe(true);
      expect(res.body.versao).toBe(1);
      expect(res.body.situacao).toBe('SALVA');
      expect(res.body.janelaDeProvaId).toBe(sessaoManha);

      // O assert que importa: o valor nao pode estar em lugar NENHUM do corpo,
      // nem num campo que alguem acrescente sem pensar mais tarde.
      expect(JSON.stringify(res.body)).not.toContain(SENHA_DA_PROVA);
    });

    it.each([
      ['vazia', ''],
      ['so espacos', '   '],
      ['espaco na frente', ' 897325'],
      ['espaco no fim', '897325 '],
      ['com quebra de linha', '897\n325'],
    ])('recusa senha %s', async (_caso, senha) => {
      await comoAdmin(
        api()
          .put('/api/senhas-de-prova')
          .send({ data: OUTRO_DIA, janelaDeProvaId: sessaoTarde, senha }),
      ).expect(400);
    });

    /**
     * A sessao precisa existir. Aceitar um id solto gravaria uma celula que
     * disparo nenhum vai ler — a prova amanheceria com a senha da vespera, sem
     * erro em lugar nenhum.
     */
    it('recusa uma sessao que nao existe', async () => {
      await comoAdmin(
        api().put('/api/senhas-de-prova').send({
          data: DIA,
          janelaDeProvaId: 999_999_999,
          senha: SENHA_DA_PROVA,
        }),
      ).expect(400);
    });

    it('salvar a MESMA senha de novo nao sobe a versao', async () => {
      const res = await comoAdmin(
        api().put('/api/senhas-de-prova').send({
          data: DIA,
          janelaDeProvaId: sessaoManha,
          senha: SENHA_DA_PROVA,
        }),
      ).expect(200);

      // Se subisse, a tela passaria a alegar DESATUALIZADA sem nada ter mudado
      // no Brightspace — e o operador reaplicaria o lote inteiro a toa.
      expect(res.body.versao).toBe(1);
    });

    it('trocar o VALOR sobe a versao', async () => {
      const res = await comoAdmin(
        api()
          .put('/api/senhas-de-prova')
          .send({ data: DIA, janelaDeProvaId: sessaoManha, senha: SENHA_NOVA }),
      ).expect(200);

      expect(res.body.versao).toBe(2);
      expect(JSON.stringify(res.body)).not.toContain(SENHA_NOVA);
    });

    /**
     * ⚠️ O MOTIVO DE A GRADE TER DEIXADO DE SER POR TURNO (21/09/2026).
     *
     * Duas sessoes do MESMO dia e do MESMO formato sao duas celulas, com senhas
     * independentes. Enquanto a chave era o turno, as duas sessoes da manha de
     * Semi/Modular caiam na mesma linha e dividiam a senha — e o aluno das 08:30
     * podia repassa-la ao das 10:30. Se algum dia isto voltar a colapsar numa
     * celula so, e aqui que aparece.
     */
    it('duas sessoes do mesmo dia tem senhas independentes', async () => {
      const tarde = await comoAdmin(
        api().put('/api/senhas-de-prova').send({
          data: DIA,
          janelaDeProvaId: sessaoTarde,
          senha: SENHA_DA_TARDE,
        }),
      ).expect(200);

      const daManha = await celulaDe(DIA, sessaoManha);

      const manha = await comoAdmin(
        api().get(`/api/senhas-de-prova/${daManha.id}/revelar`),
      ).expect(200);

      expect(tarde.body.id).not.toBe(daManha.id);
      expect(tarde.body.versao).toBe(1);

      // A da manha continua a que era: gravar a da tarde nao a tocou.
      expect(manha.body.senha).toBe(SENHA_NOVA);

      const daTarde = await comoAdmin(
        api().get(`/api/senhas-de-prova/${tarde.body.id}/revelar`),
      ).expect(200);

      expect(daTarde.body.senha).toBe(SENHA_DA_TARDE);
    });
  });

  describe('GET /senhas-de-prova — a grade', () => {
    it('lista as celulas do intervalo sem nenhuma senha no corpo', async () => {
      await comoAdmin(
        api().put('/api/senhas-de-prova').send({
          data: OUTRO_DIA,
          janelaDeProvaId: sessaoTarde,
          senha: SENHA_DA_PROVA,
        }),
      ).expect(200);

      const res = await comoAdmin(
        api().get(`/api/senhas-de-prova?de=${DIA}&ate=${OUTRO_DIA}`),
      ).expect(200);

      const celulas = res.body as { data: string; janelaDeProvaId: number }[];

      // Tres: as duas sessoes de DIA (manha e tarde) e a tarde de OUTRO_DIA.
      const daSuite = celulas.filter((c) =>
        [sessaoManha, sessaoTarde].includes(c.janelaDeProvaId),
      );

      expect(
        daSuite
          .map((c) => `${c.data} ${nomeDaSessao(c.janelaDeProvaId)}`)
          .sort(),
      ).toEqual([`${DIA} manha`, `${DIA} tarde`, `${OUTRO_DIA} tarde`]);

      const corpo = JSON.stringify(res.body);
      expect(corpo).not.toContain(SENHA_DA_PROVA);
      expect(corpo).not.toContain(SENHA_NOVA);
      expect(corpo).not.toContain(SENHA_DA_TARDE);
    });

    it('exige o intervalo', async () => {
      await comoAdmin(api().get('/api/senhas-de-prova')).expect(400);
      await comoAdmin(api().get(`/api/senhas-de-prova?de=${DIA}`)).expect(400);
    });

    it('celula sem execucao nenhuma nao inventa ultimaExecucao', async () => {
      const res = await comoAdmin(
        api().get(`/api/senhas-de-prova?de=${DIA}&ate=${DIA}`),
      ).expect(200);

      const celulas = res.body as {
        janelaDeProvaId: number;
        ultimaExecucao: unknown;
        situacao: string;
      }[];

      const minha = celulas.find((c) => c.janelaDeProvaId === sessaoManha);

      expect(minha?.ultimaExecucao).toBeNull();
      expect(minha?.situacao).toBe('SALVA');
    });
  });

  describe('GET /senhas-de-prova/:id/revelar — a unica rota com o valor', () => {
    it('devolve a senha e registra o evento de auditoria', async () => {
      const auditoria = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      try {
        const celula = await celulaDe(DIA, sessaoManha);

        const res = await comoAdmin(
          api().get(`/api/senhas-de-prova/${celula.id}/revelar`),
        ).expect(200);

        expect(res.body.senha).toBe(SENHA_NOVA);

        const linhas = auditoria.mock.calls
          .map((args) => String(args[0]))
          .filter((linha) => linha.includes('SENHA_QUIZ_REVELADA'));

        expect(linhas).toHaveLength(1);
        expect(linhas[0]).toContain(EMAIL);
        // A auditoria diz QUEM viu QUAL celula — nunca o que ela viu.
        expect(linhas[0]).not.toContain(SENHA_NOVA);
      } finally {
        auditoria.mockRestore();
      }
    });

    it('404 para celula inexistente', async () => {
      await comoAdmin(
        api().get('/api/senhas-de-prova/99999999/revelar'),
      ).expect(404);
    });
  });

  describe('GET/PUT /senhas-de-prova/alvo — qual questionario o lote procura', () => {
    it('salvar passa a valer, e `configurado` acompanha', async () => {
      const salvo = await comoAdmin(
        api()
          .put('/api/senhas-de-prova/alvo')
          .send({ nomeQuiz: 'Prova E2E', matchQuiz: 'EXATO' }),
      ).expect(200);

      expect(salvo.body).toMatchObject({
        nomeQuiz: 'Prova E2E',
        matchQuiz: 'EXATO',
        configurado: true,
        atualizadoPor: EMAIL,
      });

      const lido = await comoAdmin(
        api().get('/api/senhas-de-prova/alvo'),
      ).expect(200);

      expect(lido.body.nomeQuiz).toBe('Prova E2E');
      expect(lido.body.configurado).toBe(true);
    });

    it.each([
      ['nome vazio', { nomeQuiz: '', matchQuiz: 'CONTEM' }],
      ['matchQuiz inexistente', { nomeQuiz: 'Prova', matchQuiz: 'PARECIDO' }],
    ])('recusa %s', async (_caso, corpo) => {
      await comoAdmin(
        api().put('/api/senhas-de-prova/alvo').send(corpo),
      ).expect(400);
    });
  });

  /**
   * ⚠️ ESTE BLOCO ERA `GET/PUT /senhas-de-prova/horarios`.
   *
   * Aquelas rotas nao existem mais: os tres horarios de turno viviam em
   * `configuracao_senha_quiz.horaManha/_Tarde/_Noite`, e as colunas foram
   * DROPADAS em 21/09/2026. Quando a senha passou a trocar no disparo da
   * propria sessao, o calendario virou um so — o das janelas —, e manter dois
   * lugares para responder "a que horas a senha troca?" era garantir que o
   * errado fosse o editado.
   *
   * O que aqueles testes protegiam continua protegido, em `/janelas`:
   *
   *   "recusa horario sem zero a esquerda"  -> `horaDisparo` invalido = 400
   *   "o estado do cron vem do servidor"    -> cronHabilitado/toleranciaMin
   *   "campo vazio DESLIGA o turno"         -> `ativo: false` na sessao
   *
   * O unico que nao tem sucessor e "o alvo e os horarios convivem na mesma
   * linha sem se apagar": com os horarios fora de `configuracao_senha_quiz`,
   * nao ha mais dois PUTs disputando a mesma linha.
   */
  describe('GET/PUT /senhas-de-prova/janelas — quando o cron dispara', () => {
    /**
     * Vem do `.env` e e SO LEITURA. Sem estes dois na resposta, a tela deixaria
     * o admin cadastrar 08:30 e esperar por um cron que esta desligado no
     * servidor — um calendario que PARECE armado e nao esta e pior que um
     * calendario vazio.
     */
    it('o estado do cron no servidor vem junto do calendario', async () => {
      const res = await comoAdmin(
        api().get('/api/senhas-de-prova/janelas'),
      ).expect(200);

      expect(typeof res.body.cronHabilitado).toBe('boolean');
      expect(typeof res.body.toleranciaMin).toBe('number');
    });

    it.each([
      ['sem zero a esquerda', '7:30'],
      ['hora inexistente', '25:00'],
      ['minuto inexistente', '07:75'],
      ['sem os minutos', '07'],
    ])('recusa horario de disparo %s', async (_caso, horaDisparo) => {
      // Aceitar calado seria uma sessao que NUNCA dispara, e ninguem
      // descobriria antes do dia da prova.
      const modalidade = await prisma.modalidade.findUniqueOrThrow({
        where: { codigo: MODALIDADE_CODIGO },
      });

      await comoAdmin(
        api()
          .put('/api/senhas-de-prova/janelas')
          .send({
            modalidadeId: modalidade.id,
            janelas: [
              {
                ordem: 1,
                horaDisparo,
                horaInicio: '15:00',
                horaFim: '18:00',
                turno: Turno.TARDE,
              },
            ],
          }),
      ).expect(400);
    });

    /**
     * `diaSeguinte` e DERIVADO (`horaDisparo > horaInicio`), nao configurado.
     * Foi um checkbox na tela por um dia, e nao havia resposta certa que o
     * admin pudesse dar: marcar "mesmo dia" produz uma prova que abre no
     * passado — a API aceita, e ela nasce fechada.
     */
    it('recusa `diaSeguinte` no corpo, porque ele e derivado', async () => {
      const modalidade = await prisma.modalidade.findUniqueOrThrow({
        where: { codigo: MODALIDADE_CODIGO },
      });

      await comoAdmin(
        api()
          .put('/api/senhas-de-prova/janelas')
          .send({
            modalidadeId: modalidade.id,
            janelas: [
              {
                ordem: 1,
                horaDisparo: '22:01',
                horaInicio: '09:00',
                horaFim: '12:00',
                turno: Turno.MANHA,
                diaSeguinte: true,
              },
            ],
          }),
      ).expect(400);
    });
  });

  describe('POST /senhas-de-prova/execucoes — o lote', () => {
    it('recusa com a integracao D2L desligada, dizendo o porque', async () => {
      const res = await comoAdmin(
        api()
          .post('/api/senhas-de-prova/execucoes')
          .send({ data: DIA, janelaId: sessaoManha }),
      ).expect(400);

      // A mensagem precisa ser acionavel: sem ela o operador procuraria o
      // problema no Brightspace, e nao na variavel de ambiente.
      expect(String(res.body.message)).toContain('D2L_HABILITADO');
    });

    it('"execucoes" nao e engolido pela rota /:id da grade', async () => {
      // O controller do lote e declarado ANTES do da grade justamente por isto.
      // Se a ordem inverter, este POST viraria 404 e o 400 acima sumiria.
      await comoAdmin(api().get('/api/senhas-de-prova/execucoes/99999999'))
        .expect(404)
        .expect((res) => {
          expect(String(res.body.message)).toContain('Execução');
        });
    });
  });

  describe('DELETE /senhas-de-prova/:id — retencao', () => {
    it('apaga a celula', async () => {
      const celula = await celulaDe(OUTRO_DIA, sessaoTarde);

      await comoAdmin(api().delete(`/api/senhas-de-prova/${celula.id}`)).expect(
        204,
      );

      expect(
        await prisma.senhaDeProva.findUnique({ where: { id: celula.id } }),
      ).toBeNull();
    });

    it('404 para celula inexistente', async () => {
      await comoAdmin(api().delete('/api/senhas-de-prova/99999999')).expect(
        404,
      );
    });
  });

  describe('protecao das rotas', () => {
    it.each([
      ['get', '/api/senhas-de-prova?de=2099-09-16&ate=2099-09-16'],
      ['get', '/api/senhas-de-prova/1/revelar'],
      ['get', '/api/senhas-de-prova/alvo'],
      ['get', '/api/senhas-de-prova/janelas'],
      ['get', '/api/senhas-de-prova/revelar?de=2099-09-16&ate=2099-09-16'],
      ['get', '/api/senhas-de-prova/turmas'],
      ['get', '/api/senhas-de-prova/execucoes/1'],
      ['delete', '/api/senhas-de-prova/1'],
    ])('%s %s exige token de admin', async (metodo, rota) => {
      await api()[metodo as 'get' | 'delete'](rota).expect(401);
    });

    it('o token do aluno nao chega perto da grade', async () => {
      await api()
        .get(`/api/senhas-de-prova?de=${DIA}&ate=${DIA}`)
        .set('Authorization', `Bearer ${alunoToken}`)
        .expect(401);
    });

    it('o token do aluno nao dispara o lote', async () => {
      await api()
        .post('/api/senhas-de-prova/execucoes')
        .set('Authorization', `Bearer ${alunoToken}`)
        .send({ data: DIA, janelaId: sessaoManha })
        .expect(401);
    });
  });
});
