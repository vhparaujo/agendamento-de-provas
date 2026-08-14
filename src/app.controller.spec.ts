import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './database/prisma.service';
import { D2lEnrollmentsService } from './d2l/service/d2l-enrollments.service';
import { D2lOauthService } from './d2l/service/d2l-oauth.service';

/**
 * O `/health` responde duas perguntas independentes, e o teste protege
 * justamente a independencia: o banco decide `status`, o D2L decide `d2l`.
 *
 * Misturar os dois marcaria o container como unhealthy por causa de uma
 * integracao opcional — e `nao_autorizado`, o estado que precisa ser visto,
 * ficaria escondido atras de um `degraded` generico.
 */
describe('AppController (health)', () => {
  const montar = async (opcoes: {
    bancoDePe?: boolean;
    d2lHabilitado?: boolean;
    d2lAutorizado?: boolean;
  }) => {
    const bancoDePe = opcoes.bancoDePe ?? true;

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: bancoDePe
              ? jest.fn().mockResolvedValue([{ '1': 1 }])
              : jest.fn().mockRejectedValue(new Error('sem conexao')),
          },
        },
        {
          provide: D2lEnrollmentsService,
          useValue: { habilitado: () => opcoes.d2lHabilitado ?? false },
        },
        {
          provide: D2lOauthService,
          useValue: {
            autorizado: jest
              .fn()
              .mockResolvedValue(opcoes.d2lAutorizado ?? false),
          },
        },
      ],
    }).compile();

    return app.get<AppController>(AppController);
  };

  it('reporta o banco de pe', async () => {
    const controller = await montar({});

    await expect(controller.health()).resolves.toMatchObject({
      status: 'ok',
      database: 'up',
    });
  });

  it('banco fora derruba `status` para degraded', async () => {
    const controller = await montar({ bancoDePe: false });

    await expect(controller.health()).resolves.toMatchObject({
      status: 'degraded',
      database: 'down',
    });
  });

  it('integracao desligada e estado normal, nao alerta', async () => {
    const controller = await montar({ d2lHabilitado: false });

    await expect(controller.health()).resolves.toMatchObject({
      d2l: 'desligado',
    });
  });

  /**
   * O caso que motivou o campo: `habilitado()` so le o .env e responde `true`
   * num ambiente que nunca foi autorizado — onde TODA leitura de disciplina
   * falha. Antes disto, so um aluno tentando agendar revelava o problema.
   */
  it('ligada no .env e sem refresh token gravado vira nao_autorizado', async () => {
    const controller = await montar({
      d2lHabilitado: true,
      d2lAutorizado: false,
    });

    await expect(controller.health()).resolves.toMatchObject({
      d2l: 'nao_autorizado',
    });
  });

  it('ligada e autorizada vira ok', async () => {
    const controller = await montar({
      d2lHabilitado: true,
      d2lAutorizado: true,
    });

    await expect(controller.health()).resolves.toMatchObject({ d2l: 'ok' });
  });

  /**
   * O refresh token mora no banco. Com ele fora, `nao_autorizado` seria um
   * palpite — o token pode estar gravado e intacto — e o palpite mandaria
   * alguem refazer uma autorizacao que nao precisava ser refeita.
   */
  it('banco fora nao vira palpite sobre o D2L', async () => {
    const controller = await montar({ bancoDePe: false, d2lHabilitado: true });

    await expect(controller.health()).resolves.toMatchObject({
      database: 'down',
      d2l: 'desconhecido',
    });
  });

  /**
   * `status` NAO pode seguir o D2L: o healthcheck do compose testa
   * `status === 'ok'`, e o container seria marcado unhealthy por uma integracao
   * opcional enquanto a API serve tudo normalmente.
   */
  it('D2L quebrado nao contamina o `status` da API', async () => {
    const controller = await montar({
      d2lHabilitado: true,
      d2lAutorizado: false,
    });

    await expect(controller.health()).resolves.toMatchObject({
      status: 'ok',
      d2l: 'nao_autorizado',
    });
  });
});
