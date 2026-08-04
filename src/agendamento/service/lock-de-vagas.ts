import { ConflictException } from '@nestjs/common';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import { escolherOferta, OfertaParaAlocar } from './alocacao';

/**
 * Cliente dentro de uma transacao interativa. Nao aceita `$transaction`, que e
 * exatamente o que queremos: estas funcoes so rodam DENTRO de uma.
 */
export type Transacao = Prisma.TransactionClient;

export const CONFIRMADO = {
  status: StatusAgendamento.CONFIRMADO,
} as const;

/**
 * Opcoes da transacao de alocacao. READ COMMITTED e escolha deliberada:
 *
 * - garante que a contagem feita DEPOIS do lock enxerga o que foi commitado ate
 *   agora. Em REPEATABLE READ o snapshot pode ser anterior ao lock, e a contagem
 *   viria velha — que e exatamente o bug de overbooking que estamos evitando;
 * - nao usa gap lock, entao operacoes em faixas diferentes nao travam uma na
 *   outra nem correm risco de deadlock.
 */
export const OPCOES_DA_TRANSACAO = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  timeout: 15_000,
  maxWait: 10_000,
} as const;

/**
 * Trava o VINCULO. Serializa o mesmo aluno consigo mesmo — duplo clique, duas
 * abas, ou agendar e trocar ao mesmo tempo — inclusive quando as requisicoes
 * apontam para faixas diferentes, caso que o lock das salas nao pegaria.
 *
 * SEMPRE o primeiro lock da transacao. A ordem e sempre
 * `vinculo -> sala_faixa -> agendamento`, e e isso que impede ciclo de deadlock.
 */
export async function travarVinculo(
  tx: Transacao,
  vinculoId: number,
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM aluno_importado WHERE id = ${vinculoId} FOR UPDATE`;
}

/**
 * O portao: trava as ofertas da faixa+modalidade e devolve a que a alocacao
 * sequencial escolheu. Toda gravacao de vaga naquelas salas passa por aqui, uma
 * de cada vez — e a contagem so acontece DEPOIS do lock.
 *
 * `exceto` existe para a troca de horario: o agendamento que esta sendo movido
 * nao pode contar como ocupando lugar, senao trocar de sala dentro da mesma
 * faixa esbarraria na propria reserva do aluno.
 */
export async function escolherOfertaComLock(
  tx: Transacao,
  faixaId: number,
  modalidadeId: number,
  exceto?: number,
): Promise<OfertaParaAlocar> {
  const travadas = await tx.$queryRaw<
    { id: number; ordem: number; vagas: number }[]
  >`
    SELECT id, ordem, vagas
      FROM sala_faixa
     WHERE faixaId = ${faixaId}
       AND modalidadeId = ${modalidadeId}
     ORDER BY ordem ASC
     FOR UPDATE`;

  if (travadas.length === 0) {
    throw new ConflictException(
      'Este horario nao atende a modalidade deste curso.',
    );
  }

  const ids = travadas.map((o) => Number(o.id));

  const ocupacao = await tx.agendamento.groupBy({
    by: ['salaFaixaId'],
    where: {
      salaFaixaId: { in: ids },
      ...CONFIRMADO,
      ...(exceto ? { id: { not: exceto } } : {}),
    },
    _count: { _all: true },
  });

  const ocupadasPor = new Map(
    ocupacao.map((o) => [o.salaFaixaId, o._count._all]),
  );

  const escolhida = escolherOferta(
    travadas.map((o) => ({
      id: Number(o.id),
      ordem: Number(o.ordem),
      vagas: Number(o.vagas),
      ocupadas: ocupadasPor.get(Number(o.id)) ?? 0,
    })),
  );

  if (!escolhida) {
    throw new ConflictException(
      'As vagas deste horario acabaram de se esgotar. Escolha outro horario.',
    );
  }

  return escolhida;
}

/**
 * Confere se UMA oferta especifica ainda cabe mais um — o caminho do remanejo,
 * em que o admin escolhe a sala em vez de deixar a alocacao decidir.
 */
export async function exigirVagaNaOferta(
  tx: Transacao,
  salaFaixaId: number,
  exceto?: number,
): Promise<void> {
  const [travada] = await tx.$queryRaw<{ id: number; vagas: number }[]>`
    SELECT id, vagas FROM sala_faixa WHERE id = ${salaFaixaId} FOR UPDATE`;

  if (!travada) {
    throw new ConflictException(`Oferta ${salaFaixaId} nao existe mais.`);
  }

  const ocupadas = await tx.agendamento.count({
    where: {
      salaFaixaId,
      ...CONFIRMADO,
      ...(exceto ? { id: { not: exceto } } : {}),
    },
  });

  if (ocupadas >= Number(travada.vagas)) {
    throw new ConflictException(
      `Esta sala ja esta com ${ocupadas} de ${travada.vagas} lugares ocupados. ` +
        'Aumente as vagas da oferta ou escolha outra sala.',
    );
  }
}
