import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { TurmaService } from './turma.service';

type LinhaDeTurma = {
  id: number;
  codigoTurma: string;
  nomeDisciplina: string;
  codigoEad: string | null;
  orgUnitId: string | null;
  curso: string | null;
};

/** O `where` que o service monta: por codigos, por orgUnitIds, ou os dois. */
type FiltroDeTurma = {
  codigoTurma?: { in: string[] };
  orgUnitId?: { in: string[] };
  OR?: FiltroDeTurma[];
};

function casa(turma: LinhaDeTurma, filtro: FiltroDeTurma): boolean {
  if (filtro.OR) return filtro.OR.some((f) => casa(turma, f));
  if (filtro.codigoTurma)
    return filtro.codigoTurma.in.includes(turma.codigoTurma);
  if (filtro.orgUnitId)
    return !!turma.orgUnitId && filtro.orgUnitId.in.includes(turma.orgUnitId);

  return false;
}

/**
 * Prisma duble: guarda as turmas em memoria e registra os `update`, que e como
 * verificamos o aprendizado do orgUnitId sem subir banco.
 */
function prismaFalso(turmas: LinhaDeTurma[]) {
  const atualizacoes: { id: number; orgUnitId: string }[] = [];

  const servico = {
    turmaImportada: {
      findMany: ({ where }: { where: FiltroDeTurma }) =>
        Promise.resolve(turmas.filter((t) => casa(t, where))),
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: { orgUnitId: string };
      }) => {
        atualizacoes.push({ id: where.id, orgUnitId: data.orgUnitId });
        const alvo = turmas.find((t) => t.id === where.id);
        if (alvo) alvo.orgUnitId = data.orgUnitId;
        return Promise.resolve(alvo);
      },
      count: () => Promise.resolve(turmas.length),
    },
  } as unknown as PrismaService;

  return { atualizacoes, servico };
}

function montar(turmas: LinhaDeTurma[], filtroLigado = true) {
  const { servico, atualizacoes } = prismaFalso(turmas);

  const config = {
    get: (chave: string) =>
      chave === 'TURMAS_FILTER_ENABLED'
        ? filtroLigado
          ? 'true'
          : 'false'
        : undefined,
  } as unknown as ConfigService;

  return { service: new TurmaService(servico, config), atualizacoes };
}

/** Linhas reais do CSV Tabela_Disciplinas_Turmas. */
const HISTORIA: LinhaDeTurma = {
  id: 1,
  codigoTurma: 'GSPS0I10227',
  nomeDisciplina: 'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
  codigoEad: '1-GSPS02EAD003',
  orgUnitId: null,
  curso: 'EDUCAÇÃO FÍSICA',
};

const NUTRICAO: LinhaDeTurma = {
  id: 2,
  codigoTurma: 'GSPS0I10259',
  nomeDisciplina: 'PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO',
  codigoEad: '1-GSPS06EAD003',
  orgUnitId: null,
  curso: 'NUTRIÇÃO',
};

const LAUNCH = {
  orgUnitId: '6606',
  codigo: 'GSPS0I10227',
  titulo: 'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
};

/** Como a mesma turma chega pelos enrollments da Valence. */
const OFERTA_NUTRICAO = {
  orgUnitId: '6610',
  codigo: 'GSPS0I10259',
  titulo: 'PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO',
};

describe('filtrarAgendaveis', () => {
  it('libera a disciplina quando codigo e nome casam', async () => {
    const { service } = montar([{ ...HISTORIA }]);

    const r = await service.filtrarAgendaveis([LAUNCH]);

    expect(r.agendaveis).toEqual([
      {
        orgUnitId: '6606',
        nomeDisciplina: 'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
        curso: 'EDUCAÇÃO FÍSICA',
      },
    ]);
    expect(r.motivo).toBeUndefined();
  });

  describe('varias turmas de uma vez (enrollments)', () => {
    it('cruza cada turma e devolve todas as que tem prova', async () => {
      const { service } = montar([{ ...HISTORIA }, { ...NUTRICAO }]);

      const r = await service.filtrarAgendaveis([LAUNCH, OFERTA_NUTRICAO]);

      expect(r.agendaveis.map((d) => d.orgUnitId)).toEqual(['6606', '6610']);
      expect(r.agendaveis.map((d) => d.curso)).toEqual([
        'EDUCAÇÃO FÍSICA',
        'NUTRIÇÃO',
      ]);
    });

    it('uma turma inconclusiva NAO derruba as outras', async () => {
      // O aluno cursa 3 disciplinas e uma esta com grafia divergente no CSV:
      // ele agenda as duas que casaram em vez de ficar sem prova nenhuma.
      const { service } = montar([{ ...HISTORIA }, { ...NUTRICAO }]);

      const r = await service.filtrarAgendaveis([
        LAUNCH,
        { orgUnitId: '9', codigo: 'NAO-EXISTE', titulo: 'FANTASMA' },
        OFERTA_NUTRICAO,
      ]);

      expect(r.agendaveis.map((d) => d.orgUnitId)).toEqual(['6606', '6610']);
      // Com algo liberado, o motivo nao vai para a tela do aluno — so o log.
      expect(r.motivo).toBeUndefined();
    });

    it('so explica quando NADA passou', async () => {
      const { service } = montar([{ ...HISTORIA }]);

      const r = await service.filtrarAgendaveis([
        { orgUnitId: '9', codigo: 'NAO-EXISTE', titulo: 'FANTASMA' },
        { orgUnitId: '10', codigo: 'TAMBEM-NAO', titulo: 'OUTRO' },
      ]);

      expect(r.agendaveis).toEqual([]);
      expect(r.motivo).toMatch(/Nenhuma turma cadastrada/);
    });
  });

  it('NAO libera quando o codigo nao esta no CSV', async () => {
    const { service } = montar([{ ...HISTORIA }]);

    const r = await service.filtrarAgendaveis([
      { ...LAUNCH, codigo: 'NAO-EXISTE' },
    ]);

    expect(r.agendaveis).toEqual([]);
    expect(r.motivo).toMatch(/Nenhuma turma cadastrada/);
  });

  it('NAO libera quando o codigo bate mas o nome diverge', async () => {
    // A trava que impede liberar a prova da disciplina errada
    const { service } = montar([{ ...HISTORIA }]);

    const r = await service.filtrarAgendaveis([
      { ...LAUNCH, titulo: 'SAÚDE COLETIVA' },
    ]);

    expect(r.agendaveis).toEqual([]);
    expect(r.motivo).toMatch(/nome nao confere/);
  });

  it('desempata pelo nome quando o codigo se repete', async () => {
    const { service } = montar([
      { ...HISTORIA, id: 1, nomeDisciplina: 'SAÚDE COLETIVA', codigoEad: null },
      { ...HISTORIA, id: 2 },
    ]);

    const r = await service.filtrarAgendaveis([LAUNCH]);

    expect(r.agendaveis[0].nomeDisciplina).toBe(
      'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
    );
  });

  it('nao libera nada sem contexto de turma no launch', async () => {
    const { service } = montar([{ ...HISTORIA }]);

    const r = await service.filtrarAgendaveis(undefined);

    expect(r.agendaveis).toEqual([]);
    expect(r.motivo).toMatch(/identificar a disciplina/);
  });

  describe('tabela vazia', () => {
    it('com o filtro LIGADO (default), nada e agendavel', async () => {
      const { service } = montar([]);

      expect((await service.filtrarAgendaveis([LAUNCH])).agendaveis).toEqual(
        [],
      );
    });

    it('com o filtro DESLIGADO, a disciplina do launch passa', async () => {
      const { service } = montar([], false);

      expect((await service.filtrarAgendaveis([LAUNCH])).agendaveis).toEqual([
        {
          orgUnitId: '6606',
          nomeDisciplina: 'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
          // Sem CSV nao ha coluna Curso: a disciplina fica sem dono conhecido.
          curso: null,
        },
      ]);
    });
  });

  describe('aprendizado do orgUnitId', () => {
    it('grava o orgUnitId que o launch entregou', async () => {
      // O CSV nunca traz esse id; cada launch nos da o da turma dele de graca.
      const { service, atualizacoes } = montar([{ ...HISTORIA }]);

      await service.filtrarAgendaveis([LAUNCH]);

      expect(atualizacoes).toEqual([{ id: 1, orgUnitId: '6606' }]);
    });

    it('NAO sobrescreve um orgUnitId ja gravado', async () => {
      const { service, atualizacoes } = montar([
        { ...HISTORIA, orgUnitId: '9999' },
      ]);

      await service.filtrarAgendaveis([LAUNCH]);

      expect(atualizacoes).toEqual([]);
    });

    it('nao aprende quando o cruzamento nao foi conclusivo', async () => {
      const { service, atualizacoes } = montar([{ ...HISTORIA }]);

      await service.filtrarAgendaveis([{ ...LAUNCH, titulo: 'OUTRA COISA' }]);

      expect(atualizacoes).toEqual([]);
    });
  });
});
