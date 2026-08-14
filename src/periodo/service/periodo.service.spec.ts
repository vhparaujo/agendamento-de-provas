import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { PeriodoService } from './periodo.service';

interface Periodo {
  id: number;
  periodoLetivoId: string;
  descricao: string | null;
  createdAt: Date;
}

interface Reserva {
  periodoLetivoId: string;
  status: 'CONFIRMADO' | 'CANCELADO';
}

/**
 * Prisma duble em memoria. A transacao executa direto: cada caso monta o seu
 * estado, entao nao ha o que revirar.
 */
function montar(periodos: Periodo[], reservas: Reserva[] = []) {
  const eventos: { evento: string; detalhe?: string }[] = [];

  const servico = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(servico),
    periodoAgendamento: {
      findUnique: ({ where }: { where: { id: number } }) =>
        Promise.resolve(periodos.find((p) => p.id === where.id) ?? null),
      // O vigente e o mais recente — mesma ordenacao do service. O `select` e
      // reproduzido de proposito: sem ele o teste passaria com um objeto que o
      // Prisma real nunca devolveria.
      findFirst: () => {
        const vigente = [...periodos].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        )[0];

        return Promise.resolve(
          vigente
            ? {
                id: vigente.id,
                periodoLetivoId: vigente.periodoLetivoId,
                descricao: vigente.descricao,
              }
            : null,
        );
      },
      delete: ({ where }: { where: { id: number } }) => {
        const i = periodos.findIndex((p) => p.id === where.id);
        if (i >= 0) periodos.splice(i, 1);
        return Promise.resolve({});
      },
    },
    agendamento: {
      count: ({ where }: { where: { periodoLetivoId: string } }) =>
        Promise.resolve(
          reservas.filter((r) => r.periodoLetivoId === where.periodoLetivoId)
            .length,
        ),
    },
  } as unknown as PrismaService & Record<string, never>;

  const auditoria = {
    registrar: (evento: string, ctx: { detalhe?: string }) =>
      eventos.push({ evento, detalhe: ctx.detalhe }),
  } as unknown as AuditoriaService;

  return {
    service: new PeriodoService(servico, auditoria),
    periodos,
    eventos,
  };
}

const DOIS_MIL_E_VINTE_SEIS_UM: Periodo = {
  id: 80,
  periodoLetivoId: '132035',
  descricao: '2026/1',
  createdAt: new Date('2026-08-14T11:45:00Z'),
};

const DOIS_MIL_E_VINTE_SEIS_DOIS: Periodo = {
  id: 79,
  periodoLetivoId: '142286',
  descricao: '2026/2',
  createdAt: new Date('2026-08-14T11:00:00Z'),
};

describe('PeriodoService.remover', () => {
  it('apaga o periodo sem agendamento e devolve quem virou vigente', async () => {
    const { service, periodos } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM },
      { ...DOIS_MIL_E_VINTE_SEIS_DOIS },
    ]);

    const resultado = await service.remover(80, 'admin@ucb.br');

    expect(periodos.map((p) => p.id)).toEqual([79]);
    expect(resultado.vigenteAgora).toEqual({
      id: 79,
      periodoLetivoId: '142286',
      descricao: '2026/2',
    });
  });

  it('devolve vigenteAgora nulo quando nao sobra periodo nenhum', async () => {
    const { service } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    const resultado = await service.remover(80, 'admin@ucb.br');

    expect(resultado.vigenteAgora).toBeNull();
  });

  it('recusa apagar periodo letivo com agendamento confirmado', async () => {
    const { service, periodos } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }],
      [{ periodoLetivoId: '132035', status: 'CONFIRMADO' }],
    );

    await expect(service.remover(80, 'admin@ucb.br')).rejects.toThrow(
      ConflictException,
    );
    expect(periodos).toHaveLength(1);
  });

  /**
   * Cancelado tambem trava, ao contrario do `totalAgendamentos` da tela: a
   * pergunta aqui nao e "quantas vagas estao tomadas" e sim "alguem ja usou
   * este semestre" — e o cancelamento e justamente o registro que precisa
   * continuar explicavel no dia da prova.
   */
  it('recusa mesmo quando o unico agendamento foi cancelado', async () => {
    const { service } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }],
      [{ periodoLetivoId: '132035', status: 'CANCELADO' }],
    );

    await expect(service.remover(80, 'admin@ucb.br')).rejects.toThrow(
      ConflictException,
    );
  });

  it('404 em periodo inexistente', async () => {
    const { service } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    await expect(service.remover(999, 'admin@ucb.br')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('audita a remocao com o admin e o vigente que assumiu', async () => {
    const { service, eventos } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM },
      { ...DOIS_MIL_E_VINTE_SEIS_DOIS },
    ]);

    await service.remover(80, 'admin@ucb.br');

    expect(eventos).toHaveLength(1);
    expect(eventos[0].evento).toBe('PERIODO_REMOVIDO');
    expect(eventos[0].detalhe).toContain('vigente agora: 79');
  });
});
