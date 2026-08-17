import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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

// ============================================================================
// `encerrado` — O PRAZO ACABOU, QUE NAO E O MESMO QUE `!aberto`
// ============================================================================
// Ele existe para a DECLARACAO DE AGENDAMENTO, que so pode sair depois do
// fechamento: com o prazo aberto o aluno ainda troca de horario e cancela
// (regra 7), e o papel afirmaria uma data que ele mesmo pode mudar depois.
//
// Os testes abaixo cobrem os QUATRO estados que `aberto: false` esconde, porque
// so dois deles sao encerramento. Ler `!aberto` no lugar de `encerrado` — que e
// o atalho obvio — emitiria declaracao num semestre que ninguem configurou.

/** Uma linha completa de `periodo_agendamento`, como o Prisma a devolve. */
interface LinhaDePeriodo {
  id: number;
  periodoLetivoId: string;
  descricao: string | null;
  aberto: boolean;
  dataAbertura: Date | null;
  dataFechamento: Date;
  createdAt: Date;
}

/**
 * Double proprio, separado do `montar` de cima: aquele reproduz o `select` de
 * `remover`, que devolve tres colunas. `situacaoAtual` le a linha inteira, e um
 * duble com o objeto recortado passaria dizendo que o periodo nunca fecha.
 */
function comPeriodo(linha: LinhaDePeriodo | null) {
  const prisma = {
    periodoAgendamento: { findFirst: () => Promise.resolve(linha) },
  } as unknown as PrismaService;

  return new PeriodoService(prisma, {} as AuditoriaService);
}

const JANELA: LinhaDePeriodo = {
  id: 80,
  periodoLetivoId: '132035',
  descricao: '2026/2',
  aberto: true,
  dataAbertura: new Date('2026-08-01T03:00:00Z'),
  dataFechamento: new Date('2026-08-18T02:59:00Z'),
  createdAt: new Date('2026-07-20T12:00:00Z'),
};

const DENTRO_DO_PRAZO = new Date('2026-08-10T12:00:00Z');
const ANTES_DE_ABRIR = new Date('2026-07-25T12:00:00Z');
const DEPOIS_DO_PRAZO = new Date('2026-08-20T12:00:00Z');

describe('PeriodoService.situacaoAtual — encerrado', () => {
  it('prazo correndo: aberto, nao encerrado', async () => {
    const situacao = await comPeriodo(JANELA).situacaoAtual(DENTRO_DO_PRAZO);

    expect(situacao).toMatchObject({ aberto: true, encerrado: false });
  });

  it('prazo vencido: encerrado', async () => {
    const situacao = await comPeriodo(JANELA).situacaoAtual(DEPOIS_DO_PRAZO);

    expect(situacao).toMatchObject({ aberto: false, encerrado: true });
  });

  /**
   * Fechar a mao antes da data prevista e encerramento antecipado: a partir
   * dali ninguem mais escolhe horario, que e a condicao de que a declaracao
   * depende.
   */
  it('fechado pelo admin antes da data: encerrado', async () => {
    const situacao = await comPeriodo({
      ...JANELA,
      aberto: false,
    }).situacaoAtual(DENTRO_DO_PRAZO);

    expect(situacao).toMatchObject({ aberto: false, encerrado: true });
  });

  /** O unico `!aberto` que NAO e encerrado: o prazo ainda vai comecar. */
  it('ainda nao abriu: nem aberto nem encerrado', async () => {
    const situacao = await comPeriodo(JANELA).situacaoAtual(ANTES_DE_ABRIR);

    expect(situacao).toMatchObject({ aberto: false, encerrado: false });
  });

  /** Banco recem-migrado. Quem nunca abriu tambem nunca fechou. */
  it('sem periodo cadastrado: nem aberto nem encerrado', async () => {
    const situacao = await comPeriodo(null).situacaoAtual(DENTRO_DO_PRAZO);

    expect(situacao).toMatchObject({ aberto: false, encerrado: false });
  });
});

describe('PeriodoService.exigirEncerrado', () => {
  it('devolve o periodo letivo vigente depois do fechamento', async () => {
    await expect(
      comPeriodo(JANELA).exigirEncerrado(DEPOIS_DO_PRAZO),
    ).resolves.toMatchObject({ periodoLetivoId: '132035' });
  });

  it('recusa com o prazo aberto, dizendo quando ele encerra', async () => {
    const promessa = comPeriodo(JANELA).exigirEncerrado(DENTRO_DO_PRAZO);

    await expect(promessa).rejects.toThrow(ForbiddenException);
    await expect(promessa).rejects.toThrow(/quando o prazo de agendamento/);
  });

  it('recusa quando o prazo ainda nao comecou', async () => {
    await expect(
      comPeriodo(JANELA).exigirEncerrado(ANTES_DE_ABRIR),
    ).rejects.toThrow(ForbiddenException);
  });

  it('recusa quando nao ha periodo cadastrado', async () => {
    await expect(
      comPeriodo(null).exigirEncerrado(DENTRO_DO_PRAZO),
    ).rejects.toThrow(ForbiddenException);
  });
});
