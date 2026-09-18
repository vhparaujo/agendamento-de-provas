import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { FaixaService } from './faixa.service';

/**
 * A desativacao em lote e a virada de periodo: um corte de data tira de uma vez
 * todas as faixas do periodo que esta saindo. O que estes testes travam e o que
 * distingue esse corte de um `PATCH ativo=false` repetido — a simulacao por
 * padrao, o que conta como "desativada" e, sobretudo, o fato de NENHUM
 * agendamento ser tocado.
 */

interface FaixaFixture {
  id: number;
  data: string;
  ativo: boolean;
  /** Agendamentos CONFIRMADOS, somados das SalaFaixa dela. */
  confirmados: number;
  poloId?: number;
}

const POLO = { id: 6, nome: 'Polo Águas Lindas' };

function montarPrisma(fixtures: FaixaFixture[]) {
  const linhas = fixtures.map((f) => ({
    id: f.id,
    data: new Date(`${f.data}T00:00:00.000Z`),
    horaInicio: '08:30',
    horaFim: '10:00',
    ativo: f.ativo,
    poloId: f.poloId ?? POLO.id,
    polo: POLO,
    // Uma SalaFaixa so: o que importa aqui e a SOMA, e o service ja a faz.
    salaFaixas: [{ _count: { agendamentos: f.confirmados } }],
  }));

  const updateMany = jest.fn(
    ({ where }: { where: { id: { in: number[] } } }) => {
      for (const linha of linhas) {
        if (where.id.in.includes(linha.id)) linha.ativo = false;
      }

      return Promise.resolve({ count: where.id.in.length });
    },
  );

  const findMany = jest.fn(
    ({ where }: { where: { data: { lte: Date }; poloId?: number } }) =>
      Promise.resolve(
        linhas
          .filter((l) => l.data <= where.data.lte)
          .filter(
            (l) => where.poloId === undefined || l.poloId === where.poloId,
          )
          .sort((a, b) => a.data.getTime() - b.data.getTime()),
      ),
  );

  const prisma = {
    polo: {
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(where.id === POLO.id ? POLO : null),
      ),
    },
    faixa: { findMany, updateMany },
  };

  return { prisma, linhas, findMany, updateMany };
}

function montarServico(fixtures: FaixaFixture[]) {
  const { prisma, ...resto } = montarPrisma(fixtures);
  const auditoria = { registrar: jest.fn() };

  const servico = new FaixaService(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
  );

  return { servico, auditoria, prisma, ...resto };
}

/** Duas datas passadas, uma futura — o recorte tipico de uma virada. */
const PERIODO_ANTERIOR: FaixaFixture[] = [
  { id: 1, data: '2026-08-17', ativo: true, confirmados: 29 },
  { id: 2, data: '2026-08-31', ativo: true, confirmados: 15 },
  { id: 3, data: '2026-11-10', ativo: true, confirmados: 0 },
];

describe('desativarEmLote', () => {
  it('simula por padrao: devolve o corte e nao grava nada', async () => {
    const { servico, updateMany, auditoria } = montarServico(PERIODO_ANTERIOR);

    const r = await servico.desativarEmLote({ ate: '2026-08-31' });

    expect(r.simulacao).toBe(true);
    expect(r.desativadas).toBe(2);
    expect(r.faixas.map((f) => f.id)).toEqual([1, 2]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
    expect(r.mensagem).toContain('Nada foi gravado');
  });

  it('o corte INCLUI o dia informado', async () => {
    const { servico } = montarServico(PERIODO_ANTERIOR);

    const r = await servico.desativarEmLote({ ate: '2026-08-17' });

    expect(r.faixas.map((f) => f.id)).toEqual([1]);
  });

  it('nao desativa a faixa do periodo novo, que esta depois do corte', async () => {
    const { servico } = montarServico(PERIODO_ANTERIOR);

    const r = await servico.desativarEmLote({
      ate: '2026-08-31',
      simulacao: false,
    });

    expect(r.faixas.some((f) => f.id === 3)).toBe(false);
  });

  it('aplica so nas faixas contadas, e audita', async () => {
    const { servico, updateMany, auditoria, linhas } =
      montarServico(PERIODO_ANTERIOR);

    const r = await servico.desativarEmLote(
      { ate: '2026-08-31', simulacao: false },
      'admin@ucb.br',
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2] } },
      data: { ativo: false },
    });
    expect(linhas.find((l) => l.id === 3)!.ativo).toBe(true);
    expect(r.mensagem).not.toContain('Nada foi gravado');

    expect(auditoria.registrar).toHaveBeenCalledWith(
      'FAIXAS_DESATIVADAS_EM_LOTE',
      expect.objectContaining({ ator: 'admin@ucb.br' }),
    );
    // Os ids vao no detalhe porque sao o unico caminho de volta.
    expect(auditoria.registrar.mock.calls[0][1].detalhe).toContain('ids: 1,2');
  });

  it('faixa ja inativa entra no corte, mas nao conta como desativada', async () => {
    const { servico, updateMany } = montarServico([
      { id: 1, data: '2026-08-17', ativo: false, confirmados: 29 },
      { id: 2, data: '2026-08-31', ativo: true, confirmados: 15 },
    ]);

    const r = await servico.desativarEmLote({
      ate: '2026-08-31',
      simulacao: false,
    });

    expect(r.desativadas).toBe(1);
    expect(r.jaInativas).toBe(1);
    // Os 29 da faixa que ja estava inativa nao sao impacto DESTA execucao.
    expect(r.agendamentosMantidos).toBe(15);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: [2] } },
      data: { ativo: false },
    });
  });

  it('conta os agendamentos confirmados e diz que eles permanecem', async () => {
    const { servico } = montarServico(PERIODO_ANTERIOR);

    const r = await servico.desativarEmLote({ ate: '2026-08-31' });

    expect(r.agendamentosMantidos).toBe(44);
    expect(r.mensagem).toContain('não desmarca a prova de ninguém');
  });

  it('separa as faixas FUTURAS: sao as unicas que mudam o que o aluno ve', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-18T12:00:00.000Z'));

    try {
      const { servico } = montarServico(PERIODO_ANTERIOR);

      const r = await servico.desativarEmLote({ ate: '2026-11-30' });

      expect(r.desativadas).toBe(3);
      // As de agosto ja tinham sumido do portal sozinhas (`data >= hoje`).
      expect(r.futuras).toBe(1);
      expect(r.faixas.find((f) => f.id === 3)!.futura).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('nenhuma faixa a desativar nao e erro — e uma mensagem', async () => {
    const { servico, updateMany } = montarServico(PERIODO_ANTERIOR);

    const r = await servico.desativarEmLote({
      ate: '2026-01-01',
      simulacao: false,
    });

    expect(r.desativadas).toBe(0);
    expect(r.faixas).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(r.mensagem).toContain('Nenhuma faixa');
  });

  it('restringe ao polo quando ele vem, e recusa polo inexistente', async () => {
    const { servico, findMany } = montarServico([
      { id: 1, data: '2026-08-17', ativo: true, confirmados: 1 },
      { id: 2, data: '2026-08-17', ativo: true, confirmados: 1, poloId: 99 },
    ]);

    const r = await servico.desativarEmLote({ ate: '2026-08-31', poloId: 6 });

    expect(r.faixas.map((f) => f.id)).toEqual([1]);
    expect(findMany.mock.calls[0][0].where.poloId).toBe(6);
    expect(r.mensagem).toContain('neste polo');

    await expect(
      servico.desativarEmLote({ ate: '2026-08-31', poloId: 404 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
