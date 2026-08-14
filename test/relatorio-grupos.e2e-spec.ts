import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import JSZip from 'jszip';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

/**
 * Exportacao dos grupos do Brightspace: um CSV por HORARIO E TURMA, so com as
 * matriculas de quem tem prova confirmada naquela disciplina.
 *
 * O par (faixa, turma) e o que esta sob teste aqui. Um arquivo com a faixa
 * inteira nao daria erro em lugar nenhum — ele importaria, e colocaria no grupo
 * de HISTORIA gente que so faz NUTRICAO, liberando a prova de HISTORIA para
 * essas pessoas. So se descobre no dia da prova.
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

  /** As duas turmas do teste. A segunda so existe no CSV; a terceira, nem la. */
  const HISTORIA = {
    orgUnitId: 'E2E-OU-1001',
    codigoTurma: 'E2EGRP0I10227',
    nomeDisciplina: 'HISTÓRIA E CULTURA DO CORPO',
  };
  const NUTRICAO = {
    orgUnitId: 'E2E-OU-1002',
    codigoTurma: 'E2EGRP0N10257',
    nomeDisciplina: 'PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO',
  };
  /** Sem linha no CSV de turmas: o nome do arquivo tem que cair no orgUnitId. */
  const SEM_CSV = {
    orgUnitId: 'E2E-OU-9999',
    nomeDisciplina: 'DISCIPLINA FORA DO CSV',
  };

  const PASTA_HISTORIA = 'E2EGRP0I10227 - HISTORIA E CULTURA DO CORPO';
  const NOME_HISTORIA = `12-11-2026 08h30-11h30 - ${PASTA_HISTORIA}.csv`;

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

    // As turmas do CSV, com o orgUnitId ja aprendido (e o que o launch faz).
    for (const turma of [HISTORIA, NUTRICAO]) {
      await prisma.turmaImportada.create({ data: turma });
    }

    const poloA = await criarPolo(POLO_A);
    const poloB = await criarPolo(POLO_B);

    // Faixa cheia: duas salas, para provar que a lista junta as salas da faixa.
    const cheia = await criarFaixa(poloA, ['GRP-101', 'GRP-102']);
    faixaCheiaId = cheia.faixaId;

    // Mesma data e horario, OUTRO polo: e a colisao de caminho dentro do zip.
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

    // 001 faz as DUAS disciplinas: entra nos dois arquivos da mesma faixa.
    await agendar(poloA, cheia.salaFaixas[0], '001', PERIODO_LETIVO, {
      disciplinas: [HISTORIA, NUTRICAO],
    });

    // 002 so faz NUTRICAO — nao pode aparecer no arquivo de HISTORIA.
    await agendar(poloA, cheia.salaFaixas[0], '002', PERIODO_LETIVO, {
      disciplinas: [NUTRICAO],
    });

    // O MESMO RA de novo, por um segundo vinculo (outro curso), na outra sala da
    // mesma faixa e cobrindo HISTORIA de novo. Tem que sair uma linha so.
    await agendar(poloA, cheia.salaFaixas[1], '001', PERIODO_LETIVO, {
      curso: 'SEGUNDO CURSO',
      disciplinas: [HISTORIA],
    });

    // Cancelado: nao pode receber acesso ao quiz.
    await agendar(poloA, cheia.salaFaixas[0], '003', PERIODO_LETIVO, {
      cancelado: true,
      disciplinas: [HISTORIA],
    });

    // Prova do semestre passado, na mesma faixa e turma: fora do recorte.
    await agendar(poloA, cheia.salaFaixas[0], '004', OUTRO_PERIODO, {
      disciplinas: [HISTORIA],
    });

    // Turma que nunca entrou no CSV de turmas: so tem o orgUnitId para se
    // identificar.
    await agendar(poloA, cheia.salaFaixas[0], '006', PERIODO_LETIVO, {
      disciplinas: [SEM_CSV],
    });

    // Outro polo, mesmo dia e horario, MESMA turma: a colisao do zip.
    await agendar(poloB, outroPolo.salaFaixas[0], '005', PERIODO_LETIVO, {
      disciplinas: [HISTORIA],
    });
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
    opcoes: {
      curso?: string;
      cancelado?: boolean;
      disciplinas: { orgUnitId: string; nomeDisciplina: string }[];
    },
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
        disciplinas: {
          create: opcoes.disciplinas.map((d) => ({
            orgUnitId: d.orgUnitId,
            nomeDisciplina: d.nomeDisciplina,
          })),
        },
      },
    });
  }

  async function limpar() {
    // As disciplinas do agendamento saem em cascata com ele.
    await prisma.agendamento.deleteMany({
      where: { matricula: { startsWith: PREFIXO_MATRICULA } },
    });

    await prisma.turmaImportada.deleteMany({
      where: { codigoTurma: { startsWith: PREFIXO_MATRICULA } },
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
    const res = await comoAdmin(api().get('/api/relatorios/grupos-d2l'))
      .query(recorte)
      .expect(200);

    return res.body;
  }

  const naFaixaCheia = (linhas: any[], orgUnitId: string) =>
    linhas.find(
      (l: any) => l.faixaId === faixaCheiaId && l.orgUnitId === orgUnitId,
    );

  // ------------------------------------------------------------------ testes

  describe('listagem dos grupos exportaveis', () => {
    it('exige token de admin', async () => {
      await api().get('/api/relatorios/grupos-d2l').expect(401);
    });

    it('quebra a mesma faixa em uma linha por turma', async () => {
      const linhas = await listar();

      const daFaixa = linhas.filter((l: any) => l.faixaId === faixaCheiaId);

      // HISTORIA, NUTRICAO e a turma fora do CSV.
      expect(daFaixa.map((l: any) => l.orgUnitId).sort()).toEqual([
        HISTORIA.orgUnitId,
        NUTRICAO.orgUnitId,
        SEM_CSV.orgUnitId,
      ]);
    });

    it('conta so quem cursa aquela disciplina', async () => {
      const linhas = await listar();

      // HISTORIA: 001 (dois vinculos, uma linha so). Fora: 002 (nao cursa),
      // 003 (cancelado) e 004 (outro periodo letivo).
      expect(naFaixaCheia(linhas, HISTORIA.orgUnitId).totalAlunos).toBe(1);

      // NUTRICAO: 001 e 002.
      expect(naFaixaCheia(linhas, NUTRICAO.orgUnitId).totalAlunos).toBe(2);
    });

    it('traz codigo e disciplina do CSV de turmas', async () => {
      const linha = naFaixaCheia(await listar(), HISTORIA.orgUnitId);

      expect(linha.codigoTurma).toBe(HISTORIA.codigoTurma);
      expect(linha.nomeDisciplina).toBe(HISTORIA.nomeDisciplina);
      expect(linha.polo).toBe(POLO_A);
    });

    it('cai no orgUnitId quando a turma nao esta no CSV', async () => {
      const linha = naFaixaCheia(await listar(), SEM_CSV.orgUnitId);

      expect(linha.codigoTurma).toBeNull();
      expect(linha.nomeArquivo).toContain(`orgUnit ${SEM_CSV.orgUnitId}`);
    });

    it('nomeia o arquivo com horario, turma e disciplina, sem acento', async () => {
      const linha = naFaixaCheia(await listar(), HISTORIA.orgUnitId);

      expect(linha.nomeArquivo).toBe(NOME_HISTORIA);
      // ASCII puro: e o que dispensa o `filename*=UTF-8''` do RFC 5987.
      expect(linha.nomeArquivo).toMatch(/^[\x20-\x7e]+$/);
    });

    it('nao lista horario sem ninguem agendado', async () => {
      // Sem agendamento nao ha turma nenhuma para exportar: uma faixa nao "tem"
      // disciplinas, sao os alunos que as trazem.
      const linhas = await listar();

      expect(linhas.some((l: any) => l.faixaId === faixaVaziaId)).toBe(false);
    });

    it('nao devolve as matriculas — a tela so precisa da contagem', async () => {
      const linha = naFaixaCheia(await listar(), HISTORIA.orgUnitId);

      expect(linha.matriculas).toBeUndefined();
    });
  });

  describe('CSV de um grupo', () => {
    const baixar = (faixaId: number, orgUnitId: string) =>
      comoAdmin(
        api().get(
          `/api/relatorios/grupos-d2l/${faixaId}/${encodeURIComponent(orgUnitId)}`,
        ),
      ).query(recorte);

    it('sai como text/csv com o nome do arquivo no Content-Disposition', async () => {
      const res = await baixar(faixaCheiaId, HISTORIA.orgUnitId).expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="${NOME_HISTORIA}"`,
      );
    });

    it('NAO leva BOM e separa por virgula — quem le e o D2L, nao o Excel', async () => {
      const res = await baixar(faixaCheiaId, HISTORIA.orgUnitId).expect(200);

      expect(res.text.charCodeAt(0)).not.toBe(0xfeff);
      expect(res.text.startsWith('Nome de usuário,Código do Grupo\r\n')).toBe(
        true,
      );
    });

    it('leva so quem cursa a disciplina, uma linha por matricula', async () => {
      const res = await baixar(faixaCheiaId, HISTORIA.orgUnitId).expect(200);

      const linhas = res.text.trim().split('\r\n').slice(1);

      // 001 tem DOIS agendamentos nesta faixa cobrindo HISTORIA (dois vinculos)
      // e mesmo assim sai uma vez: o grupo no D2L e por usuario.
      expect(linhas).toEqual([`${PREFIXO_MATRICULA}001,`]);
    });

    it('quem faz outra disciplina no mesmo horario nao entra', async () => {
      const historia = await baixar(faixaCheiaId, HISTORIA.orgUnitId).expect(
        200,
      );
      const nutricao = await baixar(faixaCheiaId, NUTRICAO.orgUnitId).expect(
        200,
      );

      // 002 so cursa NUTRICAO. No arquivo de HISTORIA ele liberaria a prova de
      // uma materia que nem faz.
      expect(historia.text).not.toContain(`${PREFIXO_MATRICULA}002`);
      expect(nutricao.text).toContain(`${PREFIXO_MATRICULA}002`);
    });

    it('deixa de fora cancelado e prova de outro periodo letivo', async () => {
      const res = await baixar(faixaCheiaId, HISTORIA.orgUnitId).expect(200);

      expect(res.text).not.toContain(`${PREFIXO_MATRICULA}003`);
      expect(res.text).not.toContain(`${PREFIXO_MATRICULA}004`);
    });

    it('404 no par que nao tem ninguem confirmado', async () => {
      // A faixa existe e a turma existe — o que nao existe e o cruzamento.
      await baixar(faixaVaziaId, HISTORIA.orgUnitId).expect(404);
    });

    it('404 em faixa inexistente', async () => {
      await baixar(99999999, HISTORIA.orgUnitId).expect(404);
    });
  });

  describe('zip com todos os grupos', () => {
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

    it('organiza em uma pasta por turma, com o horario no arquivo', async () => {
      const { zip } = await baixarZip();

      expect(Object.keys(zip.files)).toContain(
        `${PASTA_HISTORIA}/12-11-2026 08h30-11h30.csv`,
      );
    });

    it('desempata pelo id quando duas faixas caem no mesmo caminho', async () => {
      // As duas faixas sao do mesmo dia e horario, mesma turma, polos
      // diferentes; sem o desempate a segunda sobrescreveria a primeira em
      // silencio.
      const { zip } = await baixarZip();

      // `.endsWith('.csv')` porque o zip tambem lista a propria pasta.
      const daTurma = Object.keys(zip.files).filter(
        (n) => n.startsWith(`${PASTA_HISTORIA}/`) && n.endsWith('.csv'),
      );

      expect(daTurma).toHaveLength(2);
      expect(
        daTurma.some((n) =>
          [faixaCheiaId, faixaOutroPoloId].some((id) => n.includes(`#${id}`)),
        ),
      ).toBe(true);
    });

    it('o conteudo de cada arquivo e o mesmo CSV da rota individual', async () => {
      const { zip } = await baixarZip();

      const conteudo = await zip
        .file(`${PASTA_HISTORIA}/12-11-2026 08h30-11h30.csv`)!
        .async('string');

      const individual = await comoAdmin(
        api().get(
          `/api/relatorios/grupos-d2l/${faixaCheiaId}/${HISTORIA.orgUnitId}`,
        ),
      )
        .query(recorte)
        .expect(200);

      expect(conteudo).toBe(individual.text);
    });
  });
});
