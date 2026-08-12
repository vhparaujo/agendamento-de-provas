import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import JSZip from 'jszip';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Exportacao dos grupos do Brightspace: um CSV por faixa, so com as matriculas
 * de quem tem prova confirmada.
 *
 * Os agendamentos sao criados direto no banco, e nao pelo portal: o que esta sob
 * teste e o RECORTE e o FORMATO do arquivo, e passar pelo fluxo de agendar so
 * acrescentaria motivos de falha que ja tem suite propria.
 */
describe('Relatorio de grupos para o D2L (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;

  const EMAIL = 'e2e-grupos@ucb.br';
  const SENHA = 'senha-do-teste-123';
  const POLO_A = 'Polo E2E Grupos A';
  const POLO_B = 'Polo E2E Grupos B';
  const PERIODO_LETIVO = 'E2E-GRP-500';
  const OUTRO_PERIODO = 'E2E-GRP-499';
  const DATA_PROVA = '2026-11-12';
  const PREFIXO_MATRICULA = 'E2EGRP';

  /** O nome que as duas faixas do mesmo horario disputam dentro do zip. */
  const NOME_ESPERADO = '12-11-2026 08h30-11h30.csv';

  let ead: { id: number };
  let faixaCheiaId: number;
  let faixaVaziaId: number;
  let faixaOutroPoloId: number;

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

    // Faixa cheia: duas salas, para provar que a lista junta as salas da faixa.
    const cheia = await criarFaixa(poloA, ['GRP-101', 'GRP-102']);
    faixaCheiaId = cheia.faixaId;

    // Mesma data e horario, OUTRO polo: e a colisao de nome dentro do zip.
    const outroPolo = await criarFaixa(poloB, ['GRP-201']);
    faixaOutroPoloId = outroPolo.faixaId;

    // Faixa em outro horario e sem ninguem.
    faixaVaziaId = (
      await prisma.faixa.create({
        data: {
          poloId: poloA,
          data: new Date(`${DATA_PROVA}T00:00:00.000Z`),
          horaInicio: '14:00',
          horaFim: '17:00',
        },
      })
    ).id;

    // Sala 1 da faixa cheia: dois alunos distintos...
    await agendar(poloA, cheia.salaFaixas[0], '001', PERIODO_LETIVO);
    await agendar(poloA, cheia.salaFaixas[0], '002', PERIODO_LETIVO);

    // ...e o MESMO RA de novo, por um segundo vinculo (outro curso), na outra
    // sala da mesma faixa. Tem que sair uma linha so no arquivo.
    await agendar(
      poloA,
      cheia.salaFaixas[1],
      '001',
      PERIODO_LETIVO,
      'SEGUNDO CURSO',
    );

    // Cancelado: nao pode receber acesso ao quiz.
    await agendar(
      poloA,
      cheia.salaFaixas[0],
      '003',
      PERIODO_LETIVO,
      undefined,
      {
        cancelado: true,
      },
    );

    // Prova do semestre passado, na mesma faixa: fora do recorte.
    await agendar(poloA, cheia.salaFaixas[0], '004', OUTRO_PERIODO);

    await agendar(poloB, outroPolo.salaFaixas[0], '005', PERIODO_LETIVO);
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
        horaInicio: '08:30',
        horaFim: '11:30',
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
    curso = 'NUTRIÇÃO',
    opcoes: { cancelado?: boolean } = {},
  ) {
    const matricula = `${PREFIXO_MATRICULA}${sufixo}`;

    const aluno = await prisma.alunoImportado.create({
      data: {
        matricula,
        nome: `ALUNO ${sufixo}`,
        curso,
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

  // ------------------------------------------------------------------ testes

  describe('listagem das faixas exportaveis', () => {
    it('exige token de admin', async () => {
      await api().get('/api/relatorios/grupos-d2l').expect(401);
    });

    it('conta matriculas DISTINTAS, somando as salas da faixa', async () => {
      const res = await comoAdmin(api().get('/api/relatorios/grupos-d2l'))
        .query(recorte)
        .expect(200);

      const cheia = res.body.find((f: any) => f.faixaId === faixaCheiaId);

      // 001 (duas vezes, dois vinculos) + 002. Fora: 003 cancelado e 004 de
      // outro periodo letivo.
      expect(cheia.totalAlunos).toBe(2);
      expect(cheia.polo).toBe(POLO_A);
    });

    it('mostra a faixa sem ninguem com zero — a informacao e util na tela', async () => {
      const res = await comoAdmin(api().get('/api/relatorios/grupos-d2l'))
        .query(recorte)
        .expect(200);

      const vazia = res.body.find((f: any) => f.faixaId === faixaVaziaId);

      expect(vazia.totalAlunos).toBe(0);
      expect(vazia.nomeArquivo).toBe('12-11-2026 14h00-17h00.csv');
    });

    it('nomeia o arquivo com dia e horario, sem polo e sem sala', async () => {
      const res = await comoAdmin(api().get('/api/relatorios/grupos-d2l'))
        .query(recorte)
        .expect(200);

      const cheia = res.body.find((f: any) => f.faixaId === faixaCheiaId);

      expect(cheia.nomeArquivo).toBe(NOME_ESPERADO);
    });

    it('filtra por polo', async () => {
      const res = await comoAdmin(api().get('/api/relatorios/grupos-d2l'))
        .query({ ...recorte, poloId: 0 })
        .expect(200);

      // poloId invalido e ignorado (lido a mao, sem DTO) — traz as tres faixas.
      expect(res.body.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('CSV de uma faixa', () => {
    it('sai como text/csv com o nome do arquivo no Content-Disposition', async () => {
      const res = await comoAdmin(
        api().get(`/api/relatorios/grupos-d2l/${faixaCheiaId}`),
      )
        .query(recorte)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="${NOME_ESPERADO}"`,
      );
    });

    it('NAO leva BOM e separa por virgula — quem le e o D2L, nao o Excel', async () => {
      const res = await comoAdmin(
        api().get(`/api/relatorios/grupos-d2l/${faixaCheiaId}`),
      )
        .query(recorte)
        .expect(200);

      const csv: string = res.text;

      expect(csv.charCodeAt(0)).not.toBe(0xfeff);
      expect(csv.startsWith('Nome de usuário,Código do Grupo\r\n')).toBe(true);
    });

    it('traz cada matricula uma vez, com o codigo do grupo vazio', async () => {
      const res = await comoAdmin(
        api().get(`/api/relatorios/grupos-d2l/${faixaCheiaId}`),
      )
        .query(recorte)
        .expect(200);

      const linhas = res.text.trim().split('\r\n').slice(1);

      expect(linhas).toEqual([
        `${PREFIXO_MATRICULA}001,`,
        `${PREFIXO_MATRICULA}002,`,
      ]);
    });

    it('deixa de fora cancelado e prova de outro periodo letivo', async () => {
      const res = await comoAdmin(
        api().get(`/api/relatorios/grupos-d2l/${faixaCheiaId}`),
      )
        .query(recorte)
        .expect(200);

      expect(res.text).not.toContain(`${PREFIXO_MATRICULA}003`);
      expect(res.text).not.toContain(`${PREFIXO_MATRICULA}004`);
    });

    it('faixa sem ninguem sai so com o cabecalho', async () => {
      const res = await comoAdmin(
        api().get(`/api/relatorios/grupos-d2l/${faixaVaziaId}`),
      )
        .query(recorte)
        .expect(200);

      expect(res.text).toBe('Nome de usuário,Código do Grupo\r\n');
    });

    it('404 em faixa inexistente', async () => {
      await comoAdmin(api().get('/api/relatorios/grupos-d2l/99999999'))
        .query(recorte)
        .expect(404);
    });
  });

  describe('zip com todas as faixas', () => {
    async function baixarZip() {
      const res = await comoAdmin(api().get('/api/relatorios/grupos-d2l/zip'))
        .query(recorte)
        .responseType('blob')
        .expect(200);

      return { res, zip: await JSZip.loadAsync(res.body as Buffer) };
    }

    it('sai como application/zip', async () => {
      const { res } = await baixarZip();

      expect(res.headers['content-type']).toContain('application/zip');
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename="Grupos D2L-.*\.zip"/,
      );
    });

    it('nao inclui a faixa vazia — arquivo so de cabecalho nao importa nada', async () => {
      const { zip } = await baixarZip();
      const nomes = Object.keys(zip.files);

      expect(nomes).not.toContain('12-11-2026 14h00-17h00.csv');
    });

    it('desempata pelo id quando duas faixas disputam o mesmo nome', async () => {
      // As duas faixas sao do mesmo dia e horario em polos diferentes; sem o
      // desempate, a segunda sobrescreveria a primeira em silencio.
      const { zip } = await baixarZip();
      const nomes = Object.keys(zip.files);

      const disputando = nomes.filter((n) =>
        n.startsWith('12-11-2026 08h30-11h30'),
      );

      expect(disputando).toHaveLength(2);
      expect(disputando).toContain(NOME_ESPERADO);
      expect(
        disputando.some((n) =>
          [faixaCheiaId, faixaOutroPoloId].some((id) => n.includes(`#${id}`)),
        ),
      ).toBe(true);
    });

    it('o conteudo de cada arquivo e o mesmo CSV da rota individual', async () => {
      const { zip } = await baixarZip();
      const conteudo = await zip.file(NOME_ESPERADO)!.async('string');

      const individual = await comoAdmin(
        api().get(`/api/relatorios/grupos-d2l/${faixaCheiaId}`),
      )
        .query(recorte)
        .expect(200);

      expect(conteudo).toBe(individual.text);
    });
  });
});
