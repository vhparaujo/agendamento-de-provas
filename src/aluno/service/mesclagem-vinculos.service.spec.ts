import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { MesclagemVinculosService } from './mesclagem-vinculos.service';

interface Vinculo {
  id: number;
  matricula: string;
  curso: string;
  modalidadeId: number;
  poloId: number;
  modalidade: { nome: string };
  polo: { nome: string };
}

interface Reserva {
  alunoId: number;
  periodoLetivoId: string;
  /** Qual prova do semestre — a outra metade da chave do conflito. */
  rodada: string;
  status: 'CONFIRMADO' | 'CANCELADO';
}

const EAD = { modalidadeId: 1, modalidade: { nome: 'EaD' } };
const MODULAR = { modalidadeId: 3, modalidade: { nome: 'Modular' } };
const TAGUATINGA = { poloId: 6, polo: { nome: 'Taguatinga' } };
const ASA_NORTE = { poloId: 2, polo: { nome: 'Asa Norte' } };

/**
 * Prisma duble em memoria: guarda vinculos, agendamentos e excecoes, e executa
 * a transacao direto (o teste nao precisa de rollback — cada caso monta o seu).
 */
function prismaFalso(vinculos: Vinculo[], reservas: Reserva[] = []) {
  const excecoes: { alunoId: number }[] = [];
  const apagados: number[] = [];

  const servico = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(servico),
    alunoImportado: {
      findUnique: ({ where }: { where: { id: number } }) =>
        Promise.resolve(vinculos.find((v) => v.id === where.id) ?? null),
      delete: ({ where }: { where: { id: number } }) => {
        apagados.push(where.id);
        const i = vinculos.findIndex((v) => v.id === where.id);
        if (i >= 0) vinculos.splice(i, 1);
        return Promise.resolve({});
      },
    },
    agendamento: {
      findMany: ({
        where,
      }: {
        where: { alunoId: { in: number[] }; status: string };
      }) =>
        Promise.resolve(
          reservas.filter(
            (r) =>
              where.alunoId.in.includes(r.alunoId) && r.status === where.status,
          ),
        ),
      updateMany: ({
        where,
        data,
      }: {
        where: { alunoId: number };
        data: { alunoId: number };
      }) => {
        const alvos = reservas.filter((r) => r.alunoId === where.alunoId);
        alvos.forEach((r) => (r.alunoId = data.alunoId));
        return Promise.resolve({ count: alvos.length });
      },
    },
    excecaoCompulsorio: {
      updateMany: ({
        where,
        data,
      }: {
        where: { alunoId: number };
        data: { alunoId: number };
      }) => {
        const alvos = excecoes.filter((e) => e.alunoId === where.alunoId);
        alvos.forEach((e) => (e.alunoId = data.alunoId));
        return Promise.resolve({ count: alvos.length });
      },
    },
  } as unknown as PrismaService & Record<string, never>;

  return { servico, apagados, excecoes, reservas, vinculos };
}

function montar(vinculos: Vinculo[], reservas: Reserva[] = []) {
  const falso = prismaFalso(vinculos, reservas);
  const eventos: { evento: string; detalhe?: string }[] = [];

  const auditoria = {
    registrar: (evento: string, ctx: { detalhe?: string }) =>
      eventos.push({ evento, detalhe: ctx.detalhe }),
  } as unknown as AuditoriaService;

  // A janela vigente colapsa os periodos letivos das duas grades numa chave so
  // — ver `recusarSeAmbosTemProva`. Aqui ela cobre so '103', que e o periodo das
  // reservas destes cenarios.
  const periodo = {
    janelaVigente: jest.fn().mockResolvedValue({
      periodoLetivoIds: ['103'],
      principal: '103',
      rodada: 'N2',
      filtroDeNota: null,
    }),
  } as unknown as PeriodoService;

  return {
    service: new MesclagemVinculosService(falso.servico, auditoria, periodo),
    eventos,
    ...falso,
  };
}

const NOVO: Vinculo = {
  id: 91,
  matricula: 'UC25426847',
  curso: 'Psicologia — Bacharelado',
  ...EAD,
  ...TAGUATINGA,
};

const ANTIGO: Vinculo = {
  id: 48,
  matricula: 'UC25426847',
  curso: 'PSICOLOGIA',
  ...EAD,
  ...TAGUATINGA,
};

describe('MesclagemVinculosService', () => {
  it('move os agendamentos do vinculo antigo e apaga o antigo', async () => {
    const { service, apagados, reservas } = montar(
      [{ ...NOVO }, { ...ANTIGO }],
      [
        {
          alunoId: 48,
          periodoLetivoId: '103',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
      ],
    );

    const resultado = await service.mesclar(91, 48, 'admin@ucb.br');

    expect(resultado.agendamentosMovidos).toBe(1);
    expect(reservas[0].alunoId).toBe(91);
    expect(apagados).toEqual([48]);
    expect(resultado.avisos).toEqual([]);
  });

  it('registra a mesclagem na auditoria', async () => {
    const { service, eventos } = montar([{ ...NOVO }, { ...ANTIGO }]);

    await service.mesclar(91, 48, 'admin@ucb.br');

    expect(eventos).toHaveLength(1);
    expect(eventos[0].evento).toBe('VINCULOS_MESCLADOS');
    expect(eventos[0].detalhe).toContain('UC25426847');
  });

  it('RECUSA vinculos de matriculas diferentes', async () => {
    const outraPessoa = { ...ANTIGO, matricula: 'UC99999999' };
    const { service, apagados } = montar([{ ...NOVO }, outraPessoa]);

    await expect(service.mesclar(91, 48, 'admin@ucb.br')).rejects.toThrow(
      BadRequestException,
    );

    // A prova de outra pessoa nao pode ser movida NEM o vinculo apagado.
    expect(apagados).toEqual([]);
  });

  it('RECUSA quando os dois tem prova confirmada na mesma prova do semestre', async () => {
    const { service, apagados } = montar(
      [{ ...NOVO }, { ...ANTIGO }],
      [
        {
          alunoId: 91,
          periodoLetivoId: '103',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
        {
          alunoId: 48,
          periodoLetivoId: '103',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
      ],
    );

    await expect(service.mesclar(91, 48, 'admin@ucb.br')).rejects.toThrow(
      ConflictException,
    );
    expect(apagados).toEqual([]);
  });

  it('PERMITE quando as provas confirmadas sao de periodos diferentes', async () => {
    // O caso comum da renomeacao: a prova presa no vinculo antigo e a do
    // semestre passado, e a do novo e a deste semestre.
    const { service, reservas } = montar(
      [{ ...NOVO }, { ...ANTIGO }],
      [
        {
          alunoId: 91,
          periodoLetivoId: '104',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
        {
          alunoId: 48,
          periodoLetivoId: '103',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
      ],
    );

    const resultado = await service.mesclar(91, 48, 'admin@ucb.br');

    expect(resultado.agendamentosMovidos).toBe(1);
    expect(reservas.every((r) => r.alunoId === 91)).toBe(true);
  });

  /**
   * A chave do conflito e `periodoLetivoId + rodada`. Um vinculo com a regular e
   * o outro com a substitutiva sao duas provas diferentes, em dias e salas
   * diferentes — mescladas, viram exatamente o que se espera de quem fez as
   * duas. Comparar so o semestre travaria a mesclagem em todo RA que fez a SUB.
   */
  it('PERMITE quando um tem a N2 e o outro a SUB do mesmo semestre', async () => {
    const { service, reservas, apagados } = montar(
      [{ ...NOVO }, { ...ANTIGO }],
      [
        {
          alunoId: 91,
          periodoLetivoId: '103',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
        {
          alunoId: 48,
          periodoLetivoId: '103',
          rodada: 'SUB',
          status: 'CONFIRMADO',
        },
      ],
    );

    const resultado = await service.mesclar(91, 48, 'admin@ucb.br');

    expect(resultado.agendamentosMovidos).toBe(1);
    expect(reservas.every((r) => r.alunoId === 91)).toBe(true);
    expect(apagados).toEqual([48]);
  });

  /** E a mesma rodada nos dois continua sendo conflito, como sempre foi. */
  it('RECUSA quando os dois tem prova confirmada na MESMA rodada', async () => {
    const { service, apagados } = montar(
      [{ ...NOVO }, { ...ANTIGO }],
      [
        {
          alunoId: 91,
          periodoLetivoId: '103',
          rodada: 'SUB',
          status: 'CONFIRMADO',
        },
        {
          alunoId: 48,
          periodoLetivoId: '103',
          rodada: 'SUB',
          status: 'CONFIRMADO',
        },
      ],
    );

    await expect(service.mesclar(91, 48, 'admin@ucb.br')).rejects.toThrow(
      /rodada SUB/,
    );
    expect(apagados).toEqual([]);
  });

  it('prova CANCELADA nos dois lados nao impede a mesclagem', async () => {
    const { service, apagados } = montar(
      [{ ...NOVO }, { ...ANTIGO }],
      [
        {
          alunoId: 91,
          periodoLetivoId: '103',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
        {
          alunoId: 48,
          periodoLetivoId: '103',
          rodada: 'N2',
          status: 'CANCELADO',
        },
      ],
    );

    await service.mesclar(91, 48, 'admin@ucb.br');

    expect(apagados).toEqual([48]);
  });

  it('recusa mesclar um vinculo com ele mesmo', async () => {
    const { service } = montar([{ ...NOVO }]);

    await expect(service.mesclar(91, 91, 'admin@ucb.br')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('404 quando um dos vinculos nao existe', async () => {
    const { service } = montar([{ ...NOVO }]);

    await expect(service.mesclar(91, 48, 'admin@ucb.br')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('avisa quando as modalidades divergiam — a prova herdada tem outra duracao', async () => {
    const { service } = montar([{ ...NOVO }, { ...ANTIGO, ...MODULAR }]);

    const { avisos } = await service.mesclar(91, 48, 'admin@ucb.br');

    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('Modular');
    expect(avisos[0]).toContain('EaD');
  });

  it('avisa quando os polos divergiam — a prova herdada e em outro campus', async () => {
    const { service } = montar([{ ...NOVO }, { ...ANTIGO, ...ASA_NORTE }]);

    const { avisos } = await service.mesclar(91, 48, 'admin@ucb.br');

    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('Asa Norte');
  });

  it('avisa nos dois campos quando ambos divergiam', async () => {
    const { service } = montar([
      { ...NOVO },
      { ...ANTIGO, ...MODULAR, ...ASA_NORTE },
    ]);

    const { avisos } = await service.mesclar(91, 48, 'admin@ucb.br');

    expect(avisos).toHaveLength(2);
  });
});
