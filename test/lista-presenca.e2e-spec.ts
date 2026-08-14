import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Lista de presenca: o PDF que vai impresso para a sala e volta assinado.
 *
 * O que esta sob teste e o RECORTE. Ele e por SALA, e nao por horario nem por
 * turma, e essa e a diferenca que importa: uma folha com a faixa inteira nao
 * daria erro em lugar nenhum — ela imprimiria, e o fiscal da SALA 1 receberia
 * uma lista com gente que esta sentada na SALA 2, chamando nome de quem nao
 * esta ali e deixando de conferir quem esta.
 *
 * O conteudo visual do PDF (colunas, quebra de pagina, ordem alfabetica) tem
 * suite propria e rapida em `src/relatorio/service/lista-presenca.spec.ts`;
 * aqui a verificacao do arquivo para no cabecalho e no tamanho, porque abrir um
 * PDF para ler texto exigiria uma dependencia so para o teste.
 *
 * Os agendamentos sao criados direto no banco, e nao pelo portal: passar pelo
 * fluxo de agendar so acrescentaria motivos de falha que ja tem suite propria.
 */
describe('Lista de presenca (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;

  const EMAIL = 'e2e-presenca@ucb.br';
  const SENHA = 'senha-do-teste-123';
  const POLO_A = 'Polo E2E Presenca A';
  const POLO_B = 'Polo E2E Presenca B';
  const PERIODO_LETIVO = 'E2E-PRE-500';
  const OUTRO_PERIODO = 'E2E-PRE-499';
  const DATA_PROVA = '2026-11-13';
  const PREFIXO_MATRICULA = 'E2EPRE';

  let ead: { id: number };
  let salaCheiaId: number;
  let salaSegundaId: number;
  let salaVaziaId: number;
  let salaOutroPoloId: number;

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

    const poloA = await criarPolo(POLO_A);
    const poloB = await criarPolo(POLO_B);

    // Tres salas no MESMO horario e polo. E o desenho que separa este relatorio
    // do de grupos: la as tres virariam uma linha so.
    const [cheia, segunda, vazia] = (
      await criarFaixa(poloA, ['PRE-101', 'PRE-102', 'PRE-103'])
    ).salaFaixas;

    salaCheiaId = cheia;
    salaSegundaId = segunda;
    salaVaziaId = vazia;

    salaOutroPoloId = (await criarFaixa(poloB, ['PRE-201'])).salaFaixas[0];

    await agendar(poloA, salaCheiaId, '001', PERIODO_LETIVO);
    await agendar(poloA, salaCheiaId, '002', PERIODO_LETIVO);

    // O MESMO RA de novo, por um segundo vinculo (outro curso), NA MESMA SALA.
    // Desde 14/08/2026 o portal RECUSA isto (`exigirUmaProvaPorFaixa`), e por
    // isso a linha e criada direto no banco: e dado ANTIGO, gravado antes da
    // regra, e a folha precisa continuar legivel mesmo assim — uma linha so.
    await agendar(poloA, salaCheiaId, '001', PERIODO_LETIVO, {
      curso: 'SEGUNDO CURSO',
    });

    // Cancelado: devolveu a vaga, nao pode estar na folha.
    await agendar(poloA, salaCheiaId, '003', PERIODO_LETIVO, {
      cancelado: true,
    });

    // Prova do semestre passado, na mesma sala: fora do recorte.
    await agendar(poloA, salaCheiaId, '004', OUTRO_PERIODO);

    // A sala ao lado, no mesmo horario: e a folha que nao pode se misturar.
    await agendar(poloA, salaSegundaId, '005', PERIODO_LETIVO);

    await agendar(poloB, salaOutroPoloId, '006', PERIODO_LETIVO);
  }, 60_000);

  afterAll(async () => {
    await limpar();
    await prisma.admin.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  // --------------------------------------------------------------- fixtures

  async function criarPolo(nome: string): Promise<number> {
    return (await prisma.polo.create({ data: { nome } })).id;
  }

  async function criarFaixa(poloId: number, salas: string[]) {
    const faixa = await prisma.faixa.create({
      data: {
        poloId,
        data: new Date(`${DATA_PROVA}T00:00:00.000Z`),
        horaInicio: '09:00',
        horaFim: '12:00',
      },
    });

    const salaFaixas: number[] = [];

    for (const [indice, nome] of salas.entries()) {
      const sala = await prisma.sala.create({
        data: { poloId, nome, capacidade: 10 },
      });

      salaFaixas.push(
        (
          await prisma.salaFaixa.create({
            data: {
              salaId: sala.id,
              faixaId: faixa.id,
              modalidadeId: ead.id,
              vagas: 10,
              ordem: indice + 1,
            },
          })
        ).id,
      );
    }

    return { faixaId: faixa.id, salaFaixas };
  }

  async function agendar(
    poloId: number,
    salaFaixaId: number,
    sufixo: string,
    periodoLetivoId: string,
    opcoes: { curso?: string; cancelado?: boolean } = {},
  ) {
    const matricula = `${PREFIXO_MATRICULA}${sufixo}`;

    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula,
        nome: `ALUNO ${sufixo}`,
        curso: opcoes.curso ?? 'NUTRIÇÃO',
        statusCurso: 'Ativo',
        ativo: true,
        modalidadeId: ead.id,
        poloId,
      },
    });

    await prisma.agendamento.create({
      data: {
        alunoId: aluno.id,
        salaFaixaId,
        matricula,
        userIdD2L: '99999',
        periodoLetivoId,
        // Fotografia do vinculo, como o service grava.
        modalidadeId: ead.id,
        poloId,
        ...(opcoes.cancelado ? { status: 'CANCELADO' } : {}),
      },
    });
  }

  async function limpar() {
    await prisma.agendamento.deleteMany({
      where: { matricula: { startsWith: PREFIXO_MATRICULA } },
    });

    const polos = await prisma.polo.findMany({
      where: { nome: { in: [POLO_A, POLO_B] } },
    });

    for (const polo of polos) {
      await prisma.salaFaixa.deleteMany({
        where: { faixa: { poloId: polo.id } },
      });
      await prisma.faixa.deleteMany({ where: { poloId: polo.id } });
      await prisma.sala.deleteMany({ where: { poloId: polo.id } });
      await prisma.alunoImportado.deleteMany({ where: { poloId: polo.id } });
      await prisma.polo.delete({ where: { id: polo.id } });
    }
  }

  const recorte = {
    periodoLetivoId: PERIODO_LETIVO,
    de: DATA_PROVA,
    ate: DATA_PROVA,
  };

  async function listar(): Promise<any[]> {
    const res = await comoAdmin(api().get('/api/relatorios/listas-de-presenca'))
      .query(recorte)
      .expect(200);

    return res.body;
  }

  const daSala = (linhas: any[], salaFaixaId: number) =>
    linhas.find((l: any) => l.salaFaixaId === salaFaixaId);

  // ------------------------------------------------------------------ testes

  describe('listagem das salas com aplicacao', () => {
    it('exige token de admin', async () => {
      await api().get('/api/relatorios/listas-de-presenca').expect(401);
    });

    it('quebra o mesmo horario em uma linha por SALA', async () => {
      const linhas = await listar();

      // A sala vazia nao entra: nao havera aplicacao ali.
      expect(
        linhas
          .filter((l: any) => l.polo === POLO_A)
          .map((l: any) => l.sala)
          .sort(),
      ).toEqual(['PRE-101', 'PRE-102']);
    });

    it('conta PESSOAS: o RA de dois vinculos na mesma sala vira uma linha so', async () => {
      // 001 tem dois agendamentos nesta sala (dado anterior a regra de uma
      // prova por faixa) e assina UMA vez; 002 e a outra linha. O cancelado e o
      // do semestre passado ficam de fora.
      expect(daSala(await listar(), salaCheiaId).totalAlunos).toBe(2);
    });

    it('nao mistura a folha da sala ao lado', async () => {
      expect(daSala(await listar(), salaSegundaId).totalAlunos).toBe(1);
    });

    it('nao lista sala sem ninguem agendado', async () => {
      expect(daSala(await listar(), salaVaziaId)).toBeUndefined();
    });

    it('respeita o filtro de polo', async () => {
      const linhas = await listar();
      const poloB = daSala(linhas, salaOutroPoloId);

      expect(poloB.polo).toBe(POLO_B);

      const res = await comoAdmin(
        api().get('/api/relatorios/listas-de-presenca'),
      )
        .query({ ...recorte, poloId: poloB.poloId })
        .expect(200);

      expect(res.body.map((l: any) => l.polo)).toEqual([POLO_B]);
    });

    it('leva o polo no nome do arquivo — duas salas homonimas em campi diferentes', async () => {
      expect(daSala(await listar(), salaCheiaId).nomeArquivo).toBe(
        `Lista de presenca - 13-11-2026 09h00-12h00 - ${POLO_A} - PRE-101.pdf`,
      );
    });
  });

  describe('o PDF do recorte', () => {
    it('baixa como PDF, com o nome no Content-Disposition', async () => {
      const res = await comoAdmin(
        api().get('/api/relatorios/listas-de-presenca/pdf'),
      )
        .query(recorte)
        .buffer()
        .parse((r, cb) => {
          const pedacos: Buffer[] = [];
          r.on('data', (p: Buffer) => pedacos.push(p));
          r.on('end', () => cb(null, Buffer.concat(pedacos)));
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toContain(
        'Listas de presenca-',
      );
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('devolve 404 quando nenhuma sala do recorte tem gente', async () => {
      await comoAdmin(api().get('/api/relatorios/listas-de-presenca/pdf'))
        .query({ ...recorte, de: '2026-11-20', ate: '2026-11-20' })
        .expect(404);
    });
  });

  describe('a folha avulsa de uma sala', () => {
    it('baixa o PDF daquela sala', async () => {
      const res = await comoAdmin(
        api().get(`/api/relatorios/listas-de-presenca/${salaCheiaId}/pdf`),
      )
        .query({ periodoLetivoId: PERIODO_LETIVO })
        .buffer()
        .parse((r, cb) => {
          const pedacos: Buffer[] = [];
          r.on('data', (p: Buffer) => pedacos.push(p));
          r.on('end', () => cb(null, Buffer.concat(pedacos)));
        })
        .expect(200);

      expect(res.headers['content-disposition']).toContain('PRE-101.pdf');
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('ignora o recorte de data e polo — quem pediu a sala ja escolheu o horario', async () => {
      // Com `de`/`ate` valendo aqui, um filtro esquecido na URL devolveria 404
      // em vez do arquivo.
      await comoAdmin(
        api().get(`/api/relatorios/listas-de-presenca/${salaCheiaId}/pdf`),
      )
        .query({
          periodoLetivoId: PERIODO_LETIVO,
          de: '2026-11-20',
          ate: '2026-11-20',
          poloId: 999999,
        })
        .expect(200);
    });

    it('devolve 404 na sala sem ninguem confirmado', async () => {
      await comoAdmin(
        api().get(`/api/relatorios/listas-de-presenca/${salaVaziaId}/pdf`),
      )
        .query({ periodoLetivoId: PERIODO_LETIVO })
        .expect(404);
    });
  });
});
