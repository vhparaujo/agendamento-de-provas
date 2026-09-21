import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { NivelAdmin } from './../src/generated/prisma/client';

/**
 * ============================================================================
 * OS TRES NIVEIS DE ADMIN, CONTRA A APLICACAO DE VERDADE
 * ============================================================================
 * `src/auth/jwt/niveis.spec.ts` prova a regra e `matriz-de-niveis.spec.ts` prova
 * que cada rota esta declarada para quem deve. O que SO este arquivo prova e que
 * o caminho inteiro funciona: login -> token com nivel -> guard -> 403.
 *
 * A regressao que ele existe para pegar e a mais cara de todas: alguem mexer no
 * `JwtAdminGuard` e o nivel deixar de ser conferido. As duas suites unitarias
 * continuariam verdes — a metadata estaria no lugar, e ninguem a leria.
 *
 * Requer: docker compose up -d mysql + migrations aplicadas.
 */
describe('Niveis de admin (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const SENHA = 'senha-de-teste-123';
  const SUFIXO = '@e2e-niveis.ucb.br';

  const CONTAS = {
    SUPERADMIN: `super${SUFIXO}`,
    ASSISTENTE_OPERACIONAL: `assistente${SUFIXO}`,
    VISUALIZADOR_EXECUTIVO: `executivo${SUFIXO}`,
  } as const;

  /** Um access token por nivel, obtido pelo login de verdade. */
  const token: Record<NivelAdmin, string> = {
    SUPERADMIN: '',
    ASSISTENTE_OPERACIONAL: '',
    VISUALIZADOR_EXECUTIVO: '',
  };

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

    await prisma.admin.deleteMany({ where: { email: { endsWith: SUFIXO } } });

    const senhaHash = await bcrypt.hash(SENHA, 10);

    for (const [nivel, email] of Object.entries(CONTAS)) {
      await prisma.admin.create({
        data: {
          email,
          nome: `E2E ${nivel}`,
          nivel: nivel as NivelAdmin,
          senhaHash,
          // false de proposito: senha provisoria pendente devolve 403 em tudo e
          // esconderia justamente a recusa por NIVEL que estas suites medem.
          mustChangePassword: false,
        },
      });

      const entrada = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email, senha: SENHA })
        .expect(200);

      token[nivel as NivelAdmin] = entrada.body.accessToken as string;
    }
  });

  afterAll(async () => {
    await prisma.admin.deleteMany({ where: { email: { endsWith: SUFIXO } } });
    await app.close();
  });

  const como = (nivel: NivelAdmin, metodo: 'get' | 'post', rota: string) =>
    request(app.getHttpServer())
      [metodo](rota)
      .set('Authorization', `Bearer ${token[nivel]}`);

  describe('o token carrega o nivel', () => {
    it.each(Object.keys(CONTAS) as NivelAdmin[])(
      '/auth/me devolve o nivel de %s',
      async (nivel) => {
        const res = await como(nivel, 'get', '/api/auth/me').expect(200);

        expect(res.body.nivel).toBe(nivel);
      },
    );
  });

  describe('Administrador Assistente Operacional', () => {
    it('VE a lista de agendamentos', async () => {
      await como('ASSISTENTE_OPERACIONAL', 'get', '/api/agendamentos').expect(
        200,
      );
    });

    it('VE a grade de senhas', async () => {
      await como(
        'ASSISTENTE_OPERACIONAL',
        'get',
        '/api/senhas-de-prova?de=2026-09-21&ate=2026-09-26',
      ).expect(200);
    });

    it('VE os alunos e as faixas', async () => {
      await como('ASSISTENTE_OPERACIONAL', 'get', '/api/alunos').expect(200);
      await como('ASSISTENTE_OPERACIONAL', 'get', '/api/faixas').expect(200);
    });

    /**
     * ⚠️ O nucleo da especificacao: em Agendamentos e Senhas ele SO LE. A tela
     * esconde os botoes; esta e a trava que vale mesmo com a tela burlada.
     */
    it('NAO cancela agendamento', async () => {
      await request(app.getHttpServer())
        .delete('/api/agendamentos/1')
        .set('Authorization', `Bearer ${token.ASSISTENTE_OPERACIONAL}`)
        .expect(403);
    });

    it('NAO remaneja agendamento', async () => {
      await request(app.getHttpServer())
        .patch('/api/agendamentos/1/remanejar')
        .set('Authorization', `Bearer ${token.ASSISTENTE_OPERACIONAL}`)
        .send({ faixaId: 1 })
        .expect(403);
    });

    it('NAO sorteia senha', async () => {
      await como('ASSISTENTE_OPERACIONAL', 'post', '/api/senhas-de-prova/gerar')
        .send({ de: '2026-09-21', ate: '2026-09-22' })
        .expect(403);
    });

    it('NAO abre a tela de administradores', async () => {
      await como('ASSISTENTE_OPERACIONAL', 'get', '/api/admins').expect(403);
    });
  });

  describe('Administrador Visualizador Executivo', () => {
    it('VE os numeros da tela inicial', async () => {
      await como(
        'VISUALIZADOR_EXECUTIVO',
        'get',
        '/api/agendamentos/estatisticas',
      ).expect(200);
    });

    it('NAO ve a lista de agendamentos', async () => {
      await como('VISUALIZADOR_EXECUTIVO', 'get', '/api/agendamentos').expect(
        403,
      );
    });

    it('NAO ve a grade de senhas', async () => {
      await como(
        'VISUALIZADOR_EXECUTIVO',
        'get',
        '/api/senhas-de-prova?de=2026-09-21&ate=2026-09-26',
      ).expect(403);
    });

    it('NAO ve os alunos', async () => {
      await como('VISUALIZADOR_EXECUTIVO', 'get', '/api/alunos').expect(403);
    });
  });

  describe('Superadministrador', () => {
    it('abre a tela de administradores', async () => {
      await como('SUPERADMIN', 'get', '/api/admins').expect(200);
    });

    it('abre o que os outros dois abrem', async () => {
      await como('SUPERADMIN', 'get', '/api/agendamentos').expect(200);
      await como('SUPERADMIN', 'get', '/api/agendamentos/estatisticas').expect(
        200,
      );
    });
  });

  describe('quem concede nivel', () => {
    const alvo = () =>
      prisma.admin.findUniqueOrThrow({
        where: { email: CONTAS.VISUALIZADOR_EXECUTIVO },
      });

    it('o superadmin promove e rebaixa outra conta', async () => {
      const { id } = await alvo();

      await request(app.getHttpServer())
        .patch(`/api/admins/${id}/nivel`)
        .set('Authorization', `Bearer ${token.SUPERADMIN}`)
        .send({ nivel: NivelAdmin.ASSISTENTE_OPERACIONAL })
        .expect(200);

      expect((await alvo()).nivel).toBe(NivelAdmin.ASSISTENTE_OPERACIONAL);

      await request(app.getHttpServer())
        .patch(`/api/admins/${id}/nivel`)
        .set('Authorization', `Bearer ${token.SUPERADMIN}`)
        .send({ nivel: NivelAdmin.VISUALIZADOR_EXECUTIVO })
        .expect(200);

      expect((await alvo()).nivel).toBe(NivelAdmin.VISUALIZADOR_EXECUTIVO);
    });

    /**
     * A trava que impede o tiro no proprio pe: um superadmin que se rebaixasse
     * por engano perderia, no mesmo clique, a unica tela capaz de desfazer isso.
     */
    it('ninguem altera o proprio nivel', async () => {
      const eu = await prisma.admin.findUniqueOrThrow({
        where: { email: CONTAS.SUPERADMIN },
      });

      await request(app.getHttpServer())
        .patch(`/api/admins/${eu.id}/nivel`)
        .set('Authorization', `Bearer ${token.SUPERADMIN}`)
        .send({ nivel: NivelAdmin.ASSISTENTE_OPERACIONAL })
        .expect(400);

      expect(
        (await prisma.admin.findUniqueOrThrow({ where: { id: eu.id } })).nivel,
      ).toBe(NivelAdmin.SUPERADMIN);
    });

    it('o assistente nao concede nivel a ninguem', async () => {
      const { id } = await alvo();

      await request(app.getHttpServer())
        .patch(`/api/admins/${id}/nivel`)
        .set('Authorization', `Bearer ${token.ASSISTENTE_OPERACIONAL}`)
        .send({ nivel: NivelAdmin.SUPERADMIN })
        .expect(403);

      expect((await alvo()).nivel).toBe(NivelAdmin.VISUALIZADOR_EXECUTIVO);
    });

    it('criar admin exige o nivel no corpo', async () => {
      await como('SUPERADMIN', 'post', '/api/admins')
        .send({ email: `sem-nivel${SUFIXO}` })
        .expect(400);
    });
  });
});
