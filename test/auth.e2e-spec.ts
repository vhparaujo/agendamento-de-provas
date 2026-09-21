import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Fluxo real de autenticacao do admin contra o banco.
 * Requer: docker compose up -d mysql + migrations aplicadas.
 */
describe('Auth admin (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const EMAIL = 'e2e-admin@ucb.br';
  const SENHA_PROVISORIA = 'provisoria-123';
  const SENHA_NOVA = 'senha-definitiva-456';

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

    // admin dedicado ao teste, no mesmo estado do seed (senha provisoria)
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await prisma.admin.create({
      data: {
        email: EMAIL,
        nome: 'Admin E2E',
        senhaHash: await bcrypt.hash(SENHA_PROVISORIA, 10),
        mustChangePassword: true,
      },
    });
  });

  afterAll(async () => {
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  const login = (senha: string) =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: EMAIL, senha });

  it('recusa credenciais invalidas', async () => {
    await login('chute-errado').expect(401);
  });

  it('valida o corpo do login (DTO)', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'nao-e-email', senha: '' })
      .expect(400);
  });

  it('rejeita campos nao previstos no DTO', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: EMAIL, senha: SENHA_PROVISORIA, admin: true })
      .expect(400);
  });

  it('exige token nas rotas protegidas', async () => {
    await request(app.getHttpServer()).get('/api/admins').expect(401);
  });

  it('faz o ciclo: login provisorio -> bloqueio -> troca -> acesso liberado', async () => {
    // 1. login funciona e sinaliza a troca obrigatoria
    const entrada = await login(SENHA_PROVISORIA).expect(200);
    expect(entrada.body.mustChangePassword).toBe(true);
    const tokenProvisorio: string = entrada.body.accessToken;

    // 2. com senha provisoria pendente, o resto do sistema fica bloqueado
    await request(app.getHttpServer())
      .get('/api/admins')
      .set('Authorization', `Bearer ${tokenProvisorio}`)
      .expect(403);

    // 3. ... mas a propria troca de senha e permitida
    await request(app.getHttpServer())
      .post('/api/auth/trocar-senha')
      .set('Authorization', `Bearer ${tokenProvisorio}`)
      .send({ senhaAtual: SENHA_PROVISORIA, novaSenha: SENHA_NOVA })
      .expect(200);

    // 4. a senha antiga nao vale mais
    await login(SENHA_PROVISORIA).expect(401);

    // 5. novo login ja vem sem pendencia e destrava as rotas
    const definitivo = await login(SENHA_NOVA).expect(200);
    expect(definitivo.body.mustChangePassword).toBe(false);

    await request(app.getHttpServer())
      .get('/api/admins')
      .set('Authorization', `Bearer ${definitivo.body.accessToken}`)
      .expect(200);

    // 6. o refresh token gera um par novo
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: definitivo.body.refreshToken })
      .expect(200)
      .expect((res) => expect(res.body.accessToken).toBeDefined());

    // 7. access token nao serve como refresh
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: definitivo.body.accessToken })
      .expect(401);
  });

  it('/auth/me devolve o nome do cadastro, para a tela chamar o admin pelo nome', async () => {
    // Roda depois do ciclo acima, que ja trocou a senha provisoria.
    const { accessToken } = (await login(SENHA_NOVA).expect(200)).body;

    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body).toMatchObject({ email: EMAIL, nome: 'Admin E2E' });
  });

  /**
   * ==========================================================================
   * PATCH /auth/perfil — o admin edita a PROPRIA conta (21/09/2026)
   * ==========================================================================
   * O que estes testes protegem nao e o UPDATE (isso o Prisma faz), e sim a
   * RE-AUTENTICACAO: o e-mail e metade da credencial de login, e trocar o dele
   * sem conferir a senha deixaria um access token roubado (15 min de vida)
   * mudar por qual endereco a conta entra — sem reset por e-mail neste sistema
   * para desfazer.
   */
  describe('PATCH /auth/perfil', () => {
    /** Devolvido ao estado original no fim, para nao afetar os outros testes. */
    const EMAIL_NOVO = 'e2e-admin-renomeado@ucb.br';

    /**
     * O token e sempre explicito: depois da troca de e-mail o login passa a ser
     * por OUTRO endereco, e um helper que entrasse sozinho pelo e-mail antigo
     * falharia justamente nos testes que vem depois dela.
     */
    const entrar = async (email: string) =>
      (
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ email, senha: SENHA_NOVA })
          .expect(200)
      ).body.accessToken as string;

    const perfil = (token: string, corpo: Record<string, unknown>) =>
      request(app.getHttpServer())
        .patch('/api/auth/perfil')
        .set('Authorization', `Bearer ${token}`)
        .send(corpo);

    afterAll(async () => {
      // O e-mail volta ao original: os testes seguintes fazem login com ele.
      await prisma.admin.updateMany({
        where: { email: EMAIL_NOVO },
        data: { email: EMAIL, nome: 'Admin E2E' },
      });
    });

    it('troca o nome SEM pedir senha', async () => {
      const res = await perfil(await entrar(EMAIL), {
        nome: '  Maria da Silva  ',
      }).expect(200);

      expect(res.body).toMatchObject({ nome: 'Maria da Silva', email: EMAIL });
    });

    it('nome vazio APAGA o nome, em vez de gravar string vazia', async () => {
      const token = await entrar(EMAIL);

      const res = await perfil(token, { nome: '   ' }).expect(200);
      expect(res.body.nome).toBeNull();

      await perfil(token, { nome: 'Admin E2E' }).expect(200);
    });

    /**
     * `forbidNonWhitelisted`: o perfil nao e a porta para se promover. Sem esta
     * trava, um `nivel` no corpo seria a escalada de privilegio mais barata do
     * sistema — e ela viria do proprio dono da sessao.
     */
    it.each([
      ['nivel', { nivel: 'SUPERADMIN' }],
      ['ativo', { ativo: true }],
      ['mustChangePassword', { mustChangePassword: false }],
      ['senhaHash', { senhaHash: 'x' }],
    ])('recusa %s no corpo', async (_campo, corpo) => {
      await perfil(await entrar(EMAIL), corpo).expect(400);
    });

    /** ⚠️ O assert central: sem senha, o e-mail nao se move. */
    it('RECUSA a troca de e-mail sem a senha atual', async () => {
      await perfil(await entrar(EMAIL), { email: EMAIL_NOVO }).expect(400);

      expect(
        await prisma.admin.findUnique({ where: { email: EMAIL } }),
      ).not.toBeNull();
    });

    it('RECUSA a troca de e-mail com a senha errada', async () => {
      await perfil(await entrar(EMAIL), {
        email: EMAIL_NOVO,
        senhaAtual: 'chute-errado',
      }).expect(401);

      expect(
        await prisma.admin.findUnique({ where: { email: EMAIL } }),
      ).not.toBeNull();
    });

    it('recusa e-mail ja usado por outro administrador', async () => {
      const OUTRO = 'e2e-admin-ocupado@ucb.br';

      await prisma.admin.deleteMany({ where: { email: OUTRO } });
      await prisma.admin.create({
        data: {
          email: OUTRO,
          senhaHash: await bcrypt.hash('outra-senha-123', 10),
          mustChangePassword: false,
        },
      });

      try {
        await perfil(await entrar(EMAIL), {
          email: OUTRO,
          senhaAtual: SENHA_NOVA,
        }).expect(409);
      } finally {
        await prisma.admin.deleteMany({ where: { email: OUTRO } });
      }
    });

    /** ⚠️ POR ULTIMO: daqui em diante o login e por EMAIL_NOVO. */
    it('troca o e-mail com a senha certa, e o login passa a ser por ele', async () => {
      const res = await perfil(await entrar(EMAIL), {
        email: EMAIL_NOVO,
        senhaAtual: SENHA_NOVA,
      }).expect(200);

      expect(res.body.email).toBe(EMAIL_NOVO);

      // A prova de que trocou de verdade: o e-mail antigo deixa de autenticar.
      await login(SENHA_NOVA).expect(401);
      await entrar(EMAIL_NOVO);
    });

    it('exige token de admin', async () => {
      await request(app.getHttpServer())
        .patch('/api/auth/perfil')
        .send({ nome: 'Anonimo' })
        .expect(401);
    });
  });

  it('nao devolve o hash da senha ao listar admins', async () => {
    const { body } = await login(SENHA_NOVA).expect(200);

    const lista = await request(app.getHttpServer())
      .get('/api/admins')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);

    expect(JSON.stringify(lista.body)).not.toContain('senhaHash');
    expect(JSON.stringify(lista.body)).not.toContain('$2b$');
  });

  /**
   * ==========================================================================
   * INICIACAO OIDC DO LTI — os dois casos NAO dependem do .env da maquina
   * ==========================================================================
   * Estes testes ja falharam por confiar no ambiente: enquanto o `.env` nao
   * tinha credenciais de LTI, "sem configuracao" era o estado natural e o 503
   * vinha de graca. No dia em que as credenciais reais entraram, a rota passou
   * a responder 401 (issuer nao confere) e o teste quebrou sem que uma linha de
   * codigo de producao tivesse mudado.
   *
   * Por isso cada caso IMPOE a configuracao que quer testar. `carregarLtiConfig`
   * le o ConfigService a cada request, entao trocar o `get` durante a chamada
   * basta — e o `finally` devolve o original para nao vazar para os vizinhos.
   */
  const comLtiConfigurado = (valores: Record<string, string | undefined>) => {
    const config = app.get(ConfigService);
    const original = config.get.bind(config) as (chave: string) => unknown;

    return jest
      .spyOn(config, 'get')
      .mockImplementation((chave: string) =>
        chave.startsWith('LTI_') ? valores[chave] : original(chave),
      );
  };

  const LTI_COMPLETO = {
    LTI_ISSUER: 'https://ava.exemplo.test',
    LTI_CLIENT_ID: 'client-de-teste',
    LTI_AUTH_LOGIN_URL: 'https://ava.exemplo.test/d2l/lti/authenticate',
    LTI_JWKS_URL: 'https://ava.exemplo.test/d2l/.well-known/jwks',
    LTI_REDIRECT_URI: 'https://ferramenta.exemplo.test/api/lti/launch',
  };

  it('LTI sem configuracao responde 503 dizendo o que falta, nao 500', async () => {
    // Nenhuma LTI_* definida: e o estado de quem subiu a API sem preencher o .env.
    const spy = comLtiConfigurado({});

    try {
      const res = await request(app.getHttpServer())
        .post('/api/lti/login')
        .send({ iss: 'https://ucb.brightspace.com', login_hint: 'x' })
        .expect(503);

      // O 503 so serve se disser QUAL variavel falta — senao vira "tente de novo".
      expect(res.body.message).toContain('LTI_ISSUER');
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * O outro lado da moeda, e o que faltava: com o LTI configurado, uma iniciacao
   * vinda de outro issuer e recusada. Sem este caso, apagar a checagem de issuer
   * do `iniciarLogin` nao quebraria teste nenhum.
   */
  it('recusa iniciacao OIDC de issuer diferente do configurado', async () => {
    const spy = comLtiConfigurado(LTI_COMPLETO);

    try {
      await request(app.getHttpServer())
        .post('/api/lti/login')
        .send({ iss: 'https://impostor.example.com', login_hint: 'x' })
        .expect(401);
    } finally {
      spy.mockRestore();
    }
  });

  /** E o caminho feliz: issuer certo redireciona para a autorizacao do Brightspace. */
  it('aceita a iniciacao do issuer configurado e redireciona para a autorizacao', async () => {
    const spy = comLtiConfigurado(LTI_COMPLETO);

    try {
      const res = await request(app.getHttpServer())
        .post('/api/lti/login')
        .send({ iss: LTI_COMPLETO.LTI_ISSUER, login_hint: 'x' })
        .expect(302);

      expect(res.headers.location).toContain(LTI_COMPLETO.LTI_AUTH_LOGIN_URL);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * ==========================================================================
   * O LAUNCH QUE NAO PASSA TERMINA EM TELA, NAO EM JSON
   * ==========================================================================
   * Quem clica no link e um aluno dentro do AVA, nao um cliente de API: um 403
   * com JSON cru na tela nao diz a ele o que fazer. Com `PORTAL_ALUNO_URL`
   * preenchida, o erro vira redirect para o portal com `?erro=<codigo>` — e o
   * portal escreve o recado (`erros-de-entrada.ts`, no front).
   *
   * O par de casos existe junto de proposito: o segundo prova que o JSON de erro
   * continua de pe sem portal configurado, que e como se testa o launch sem front.
   */
  const comPortal = (portal?: string) => {
    const config = app.get(ConfigService);
    const original = config.get.bind(config) as (chave: string) => unknown;

    return jest
      .spyOn(config, 'get')
      .mockImplementation((chave: string) =>
        chave === 'PORTAL_ALUNO_URL'
          ? portal
          : chave.startsWith('LTI_')
            ? LTI_COMPLETO[chave as keyof typeof LTI_COMPLETO]
            : original(chave),
      );
  };

  it('launch invalido com portal configurado redireciona com ?erro=', async () => {
    const spy = comPortal('https://portal.exemplo.test/aluno');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/lti/launch')
        .send({}) // sem id_token nem state
        .expect(303);

      const destino = new URL(res.headers.location);

      expect(destino.origin + destino.pathname).toBe(
        'https://portal.exemplo.test/aluno',
      );
      expect(destino.searchParams.get('erro')).toBe('dados-incompletos');

      // O detalhe tecnico fica no log, nao na URL: ela vai para historico do
      // navegador, log de proxy e header `Referer`.
      expect(destino.searchParams.get('message')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('launch invalido sem portal configurado continua respondendo o JSON de erro', async () => {
    const spy = comPortal(undefined);

    try {
      await request(app.getHttpServer())
        .post('/api/lti/launch')
        .send({})
        .expect(400);
    } finally {
      spy.mockRestore();
    }
  });

  it('publica o JWKS da ferramenta', async () => {
    await request(app.getHttpServer())
      .get('/api/lti/jwks')
      .expect(200)
      .expect((res) => expect(Array.isArray(res.body.keys)).toBe(true));
  });
});
