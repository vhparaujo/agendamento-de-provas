import { INestApplication, ValidationPipe } from '@nestjs/common';
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

  it('LTI ainda nao configurado responde 503, nao 500', async () => {
    await request(app.getHttpServer())
      .post('/api/lti/login')
      .send({ iss: 'https://ucb.brightspace.com', login_hint: 'x' })
      .expect(503);
  });

  it('publica o JWKS da ferramenta', async () => {
    await request(app.getHttpServer())
      .get('/api/lti/jwks')
      .expect(200)
      .expect((res) => expect(Array.isArray(res.body.keys)).toBe(true));
  });
});
