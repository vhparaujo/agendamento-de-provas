import { INestApplication } from '@nestjs/common';
import { Controller, Get, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

// ANTES dos imports do app: o limitador fica desligado em NODE_ENV=test para nao
// derrubar os e2e que fazem varios logins de proposito (ver throttler.config.ts).
// Esta suite e a excecao — e a unica que testa o limitador em si, entao liga.
// ATENCAO: o Jest reaproveita worker entre arquivos, entao isto VAZA. O afterAll
// desta suite remove a variavel; nao troque isso por um set sem limpeza.
process.env.THROTTLE_NOS_TESTES = 'true';

import { AppModule } from './../src/app.module';
import { configurarHelmet } from './../src/config/helmet.config';

/**
 * ============================================================================
 * CONTROLES DE SEGURANCA — teste de comportamento, nao de configuracao
 * ============================================================================
 * Verificar que `helmet` esta no package.json ou que o guard esta no providers
 * nao prova nada: prova-se mandando request e olhando a resposta.
 *
 * Requer banco de pe (docker compose up -d mysql) e migrations aplicadas.
 */

/**
 * Controller que existe SO neste teste: simula o erro humano que o guard global
 * precisa pegar — alguem cria uma rota e esquece o decorator de acesso.
 * Sem ele, a inversao para deny-by-default ficaria sem prova.
 */
@Controller('rota-esquecida')
class RotaSemDecoratorController {
  @Get()
  vazando() {
    return { segredo: 'isto nunca pode chegar ao cliente' };
  }
}

@Module({ imports: [AppModule], controllers: [RotaSemDecoratorController] })
class AppDeTesteModule {}

describe('Controles de seguranca (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppDeTesteModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    configurarHelmet(app, 'api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();

    // O Jest REAPROVEITA processos entre arquivos de teste — a suposicao de que
    // cada suite tem processo proprio nao vale. Sem limpar isto aqui, o proximo
    // arquivo a rodar neste mesmo worker herda o limitador ligado e falha de
    // forma intermitente (o e2e de auth faz varios logins de proposito e leva 429).
    delete process.env.THROTTLE_NOS_TESTES;
  });

  describe('deny by default (OWASP A01)', () => {
    it('NEGA rota sem decorator de acesso, mesmo sem token', async () => {
      const res = await request(app.getHttpServer()).get('/api/rota-esquecida');

      expect(res.status).toBe(403);
      // o corpo do handler nao pode ter sido executado
      expect(JSON.stringify(res.body)).not.toContain('segredo');
    });

    it('libera rota marcada com @Publico()', async () => {
      await request(app.getHttpServer()).get('/api/health').expect(200);
    });

    it('exige token nas rotas de admin', async () => {
      await request(app.getHttpServer()).get('/api/admins').expect(401);
    });

    it('recusa token forjado com assinatura invalida', async () => {
      await request(app.getHttpServer())
        .get('/api/admins')
        .set('Authorization', 'Bearer nao.e.um.jwt')
        .expect(401);
    });
  });

  describe('cabecalhos de seguranca (helmet)', () => {
    it('aplica CSP restritiva e nega framing na API', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');

      expect(res.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // helmet 8 desliga o auditor de XSS de proposito — ligar e conselho antigo
      expect(res.headers['x-xss-protection']).toBe('0');
    });

    it('nao expoe a tecnologia do servidor', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');

      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('limite de requisicoes (ASVS 6.3.1)', () => {
    it('bloqueia forca bruta no login com 429 depois de 5 tentativas', async () => {
      const tentativa = () =>
        request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ email: 'forca@bruta.com', senha: 'chute-errado' });

      const status: number[] = [];

      // 5 permitidas + 2 alem do limite
      for (let i = 0; i < 7; i++) {
        status.push((await tentativa()).status);
      }

      expect(status.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
      // as primeiras precisam ter passado pela regra de negocio (401), nao 429
      expect(status[0]).toBe(401);
    });
  });
});
