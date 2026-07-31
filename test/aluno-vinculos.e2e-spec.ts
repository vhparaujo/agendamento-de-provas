import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from './../src/app.module';
import { AlunoService } from './../src/aluno/service/aluno.service';
import { AuthService } from './../src/auth/service/auth.service';
import { AlunoJwtPayload } from './../src/auth/jwt/jwt.types';
import { PrismaService } from './../src/database/prisma.service';
import { permiteAgendar } from './../src/enums/status-curso.enum';

/**
 * Caso real do CSV: RA UC24424289 (Monica) esta ativa em DOIS cursos, com
 * modalidades diferentes — Pedagogia/EaD (180min) e Psicologia/Hibrido (90min).
 * Ela precisa conseguir agendar as duas provas.
 */
describe('Aluno com dois cursos (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let alunoService: AlunoService;
  let authService: AuthService;
  let jwt: JwtService;

  const MATRICULA = 'UC24424289';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    alunoService = app.get(AlunoService);
    authService = app.get(AuthService);
    jwt = app.get(JwtService);

    const polo = await prisma.polo.findUniqueOrThrow({
      where: { nome: 'Câmpus Ceilândia' },
    });
    const ead = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'EAD' },
    });
    const modular = await prisma.modalidade.findUniqueOrThrow({
      where: { codigo: 'MODULAR' },
    });

    await prisma.alunoImportado.deleteMany({ where: { matricula: MATRICULA } });
    await prisma.alunoImportado.createMany({
      data: [
        {
          matricula: MATRICULA,
          nome: 'MONICA RIBEIRO MARQUES',
          curso: 'PEDAGOGIA',
          statusCurso: 'Ativo',
          ativo: permiteAgendar('Ativo'),
          modalidadeId: ead.id,
          poloId: polo.id,
        },
        {
          matricula: MATRICULA,
          nome: 'MONICA RIBEIRO MARQUES',
          curso: 'PSICOLOGIA',
          statusCurso: 'Ativo',
          ativo: permiteAgendar('Ativo'),
          modalidadeId: modular.id,
          poloId: polo.id,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.alunoImportado.deleteMany({ where: { matricula: MATRICULA } });
    await app.close();
  });

  it('guarda os dois vinculos sob a mesma matricula', async () => {
    const vinculos = await alunoService.buscarVinculos(MATRICULA);

    expect(vinculos).toHaveLength(2);
    expect(vinculos.map((v) => v.curso).sort()).toEqual([
      'PEDAGOGIA',
      'PSICOLOGIA',
    ]);
  });

  it('cada vinculo carrega a duracao de prova do seu curso', async () => {
    const vinculos = await alunoService.buscarVinculos(MATRICULA);

    const porCurso = Object.fromEntries(
      vinculos.map((v) => [v.curso, v.modalidade.duracaoMinutos]),
    );

    expect(porCurso.PEDAGOGIA).toBe(180); // EaD, 3h
    expect(porCurso.PSICOLOGIA).toBe(90); // Hibrido/Modular, 1h30
  });

  it('normaliza a matricula na busca (espacos e caixa)', async () => {
    await expect(
      alunoService.buscarVinculos('  uc24424289 '),
    ).resolves.toHaveLength(2);
  });

  it('o token do aluno leva os dois vinculos', async () => {
    const vinculos = await alunoService.buscarVinculos(MATRICULA);

    const { accessToken } = await authService.emitirTokenAluno({
      sub: MATRICULA,
      userIdD2L: '76629',
      vinculos: vinculos.map((v) => ({
        alunoId: v.id,
        curso: v.curso,
        modalidade: v.modalidade.codigo,
        poloId: v.poloId,
        ativo: v.ativo,
      })),
    });

    const payload = jwt.verify<AlunoJwtPayload>(accessToken, {
      secret: process.env.JWT_SECRET,
    });

    expect(payload.sub).toBe(MATRICULA);
    expect(payload.vinculos).toHaveLength(2);
    expect(payload.vinculos.map((v) => v.modalidade).sort()).toEqual([
      'EAD',
      'MODULAR',
    ]);
  });

  it('a mesma dupla matricula+curso nao pode ser inserida duas vezes', async () => {
    const existente = await prisma.alunoImportado.findFirstOrThrow({
      where: { matricula: MATRICULA, curso: 'PEDAGOGIA' },
    });

    await expect(
      prisma.alunoImportado.create({
        data: {
          matricula: MATRICULA,
          curso: 'PEDAGOGIA',
          statusCurso: 'Ativo',
          modalidadeId: existente.modalidadeId,
          poloId: existente.poloId,
        },
      }),
    ).rejects.toThrow();
  });
});
