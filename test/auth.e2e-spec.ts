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
