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
 * compartilhado da secretaria, e um campo a mais no JSON e a senha da prova de
 * toda a instituicao na aba do navegador de qualquer um que passe por ali.
 *
 * O lote em si nao roda aqui: `D2L_HABILITADO` fica `false` no e2e (setup-e2e),
 * entao a rota de execucao e exercitada no unico caminho que ela tem sem
 * Brightspace — a recusa. Os caminhos de 409 (lote vivo, senha ja aplicada)
 * vivem em `src/senha-quiz/service/senha-quiz.service.spec.ts`, onde da para
 * mockar a Valence.
 */
describe('Senhas de prova: a grade dia x turno (e2e)', () => {
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
  const SENHA_NOVA = '441028';

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
    await prisma.senhaDeProva.deleteMany({
      where: { data: { in: [new Date(DIA), new Date(OUTRO_DIA)] } },
    });

    const polos = await prisma.polo.findMany({ where: { nome: POLO_NOME } });

    for (const polo of polos) {
      await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
      await prisma.polo.delete({ where: { id: polo.id } });
    }
  }

  describe('PUT /senhas-de-prova — cadastro da celula', () => {
    it('cria a celula e NAO devolve a senha na resposta', async () => {
      const res = await comoAdmin(
        api()
          .put('/api/senhas-de-prova')
          .send({ data: DIA, turno: Turno.MANHA, senha: SENHA_DA_PROVA }),
      ).expect(200);

      expect(res.body.temSenha).toBe(true);
      expect(res.body.versao).toBe(1);
      expect(res.body.situacao).toBe('SALVA');

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
          .send({ data: OUTRO_DIA, turno: Turno.NOITE, senha }),
      ).expect(400);
    });

    it('salvar a MESMA senha de novo nao sobe a versao', async () => {
      const res = await comoAdmin(
        api()
          .put('/api/senhas-de-prova')
          .send({ data: DIA, turno: Turno.MANHA, senha: SENHA_DA_PROVA }),
      ).expect(200);

      // Se subisse, a tela passaria a alegar DESATUALIZADA sem nada ter mudado
      // no Brightspace — e o operador reaplicaria o lote inteiro a toa.
      expect(res.body.versao).toBe(1);
    });

    it('trocar o VALOR sobe a versao', async () => {
      const res = await comoAdmin(
        api()
          .put('/api/senhas-de-prova')
          .send({ data: DIA, turno: Turno.MANHA, senha: SENHA_NOVA }),
      ).expect(200);

      expect(res.body.versao).toBe(2);
      expect(JSON.stringify(res.body)).not.toContain(SENHA_NOVA);
    });
  });

  describe('GET /senhas-de-prova — a grade', () => {
    it('lista as celulas do intervalo sem nenhuma senha no corpo', async () => {
      await comoAdmin(
        api()
          .put('/api/senhas-de-prova')
          .send({ data: OUTRO_DIA, turno: Turno.TARDE, senha: SENHA_DA_PROVA }),
      ).expect(200);

      const res = await comoAdmin(
        api().get(`/api/senhas-de-prova?de=${DIA}&ate=${OUTRO_DIA}`),
      ).expect(200);

      const celulas = res.body as { data: string; turno: Turno }[];

      expect(celulas).toHaveLength(2);
      expect(celulas.map((c) => `${c.data} ${c.turno}`).sort()).toEqual([
        `${DIA} ${Turno.MANHA}`,
        `${OUTRO_DIA} ${Turno.TARDE}`,
      ]);

      const corpo = JSON.stringify(res.body);
      expect(corpo).not.toContain(SENHA_DA_PROVA);
      expect(corpo).not.toContain(SENHA_NOVA);
    });

    it('exige o intervalo', async () => {
      await comoAdmin(api().get('/api/senhas-de-prova')).expect(400);
      await comoAdmin(api().get(`/api/senhas-de-prova?de=${DIA}`)).expect(400);
    });

    it('celula sem execucao nenhuma nao inventa ultimaExecucao', async () => {
      const res = await comoAdmin(
        api().get(`/api/senhas-de-prova?de=${DIA}&ate=${DIA}`),
      ).expect(200);

      expect(res.body[0].ultimaExecucao).toBeNull();
      expect(res.body[0].situacao).toBe('SALVA');
    });
  });

  describe('GET /senhas-de-prova/:id/revelar — a unica rota com o valor', () => {
    it('devolve a senha e registra o evento de auditoria', async () => {
      const auditoria = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      try {
        const celula = await prisma.senhaDeProva.findFirstOrThrow({
          where: { data: new Date(DIA), turno: Turno.MANHA },
        });

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

  describe('GET/PUT /senhas-de-prova/horarios — quando o cron dispara', () => {
    it('salva os horarios e devolve o estado do cron no servidor', async () => {
      const salvo = await comoAdmin(
        api()
          .put('/api/senhas-de-prova/horarios')
          .send({ horaManha: '07:30', horaTarde: '12:30', horaNoite: '18:00' }),
      ).expect(200);

      expect(salvo.body).toMatchObject({
        horaManha: '07:30',
        horaTarde: '12:30',
        horaNoite: '18:00',
        atualizadoPor: EMAIL,
      });

      // Vem do .env e e SO LEITURA. Sem estes dois, a tela deixaria o admin
      // cadastrar 07:30 e esperar por um cron que esta desligado no servidor.
      expect(typeof salvo.body.cronHabilitado).toBe('boolean');
      expect(typeof salvo.body.toleranciaMin).toBe('number');

      const lido = await comoAdmin(
        api().get('/api/senhas-de-prova/horarios'),
      ).expect(200);

      expect(lido.body.horaManha).toBe('07:30');
    });

    it('campo vazio DESLIGA o turno — e como sabado a noite fica de fora', async () => {
      const res = await comoAdmin(
        api()
          .put('/api/senhas-de-prova/horarios')
          .send({ horaManha: '08:00', horaTarde: '', horaNoite: '' }),
      ).expect(200);

      expect(res.body.horaManha).toBe('08:00');
      expect(res.body.horaTarde).toBeNull();
      expect(res.body.horaNoite).toBeNull();
    });

    it.each([
      ['sem zero a esquerda', '7:30'],
      ['hora inexistente', '25:00'],
      ['minuto inexistente', '07:75'],
      ['sem os minutos', '07'],
    ])('recusa horario %s', async (_caso, horaManha) => {
      // Aceitar calado seria um turno que NUNCA dispara, e ninguem descobriria
      // antes do dia da prova.
      await comoAdmin(
        api().put('/api/senhas-de-prova/horarios').send({ horaManha }),
      ).expect(400);
    });

    it('o alvo e os horarios convivem na mesma linha sem se apagar', async () => {
      await comoAdmin(
        api()
          .put('/api/senhas-de-prova/alvo')
          .send({ nomeQuiz: 'Prova E2E 2', matchQuiz: 'CONTEM' }),
      ).expect(200);

      const horarios = await comoAdmin(
        api().get('/api/senhas-de-prova/horarios'),
      ).expect(200);

      // Salvar o alvo nao pode zerar o horario: sao dois PUTs na MESMA linha.
      expect(horarios.body.horaManha).toBe('08:00');

      await comoAdmin(
        api().put('/api/senhas-de-prova/horarios').send({ horaManha: '09:00' }),
      ).expect(200);

      const alvo = await comoAdmin(
        api().get('/api/senhas-de-prova/alvo'),
      ).expect(200);

      expect(alvo.body.nomeQuiz).toBe('Prova E2E 2');
    });
  });

  describe('POST /senhas-de-prova/execucoes — o lote', () => {
    it('recusa com a integracao D2L desligada, dizendo o porque', async () => {
      const res = await comoAdmin(
        api()
          .post('/api/senhas-de-prova/execucoes')
          .send({ data: DIA, turno: Turno.MANHA }),
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
          expect(String(res.body.message)).toContain('Execucao');
        });
    });
  });

  describe('DELETE /senhas-de-prova/:id — retencao', () => {
    it('apaga a celula', async () => {
      const celula = await prisma.senhaDeProva.findFirstOrThrow({
        where: { data: new Date(OUTRO_DIA), turno: Turno.TARDE },
      });

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
      ['get', '/api/senhas-de-prova/horarios'],
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
        .send({ data: DIA, turno: Turno.MANHA })
        .expect(401);
    });
  });
});
