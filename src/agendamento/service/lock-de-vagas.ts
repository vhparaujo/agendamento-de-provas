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
 * Trava a PESSOA — todos os vinculos daquela matricula, nao so um.
 *
 * Serializa o mesmo aluno consigo mesmo: duplo clique, duas abas, ou agendar e
 * trocar ao mesmo tempo, inclusive quando as requisicoes apontam para faixas
 * diferentes — caso que o lock das salas nao pegaria.
 *
 * ⚠️ **Trava por `matricula`, e nao por `id` do vinculo (14/08/2026).** Um RA com
 * dois cursos tem DUAS linhas em `aluno_importado`, e travar so a dele deixaria
 * as duas transacoes correrem em paralelo — cada uma conferindo
 * `exigirUmaProvaPorFaixa` antes de a outra gravar, e as duas passando. O aluno
 * sairia com os dois cursos marcados no mesmo horario, que e exatamente o que
 * aquela regra existe para impedir. Travar a matricula inteira e o que torna a
 * checagem confiavel.
 *
 * SEMPRE o primeiro lock da transacao. A ordem e sempre
 * `aluno -> sala_faixa -> agendamento`, e e isso que impede ciclo de deadlock.
 * Como as linhas vem pelo indice de `matricula`, duas transacoes concorrentes da
 * mesma pessoa as pegam na mesma ordem — nao ha ciclo entre elas tampouco.
 */
export async function travarAluno(
  tx: Transacao,
  matricula: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM aluno_importado WHERE matricula = ${matricula} FOR UPDATE`;
}

/**
 * ============================================================================
 * UMA PROVA POR PESSOA EM CADA HORARIO — nao por vinculo
 * ============================================================================
 * O RA com dois cursos faz DUAS provas, uma por vinculo, e ate aqui nada o
 * impedia de marcar as duas na MESMA faixa. Ele nao pode fazer as duas ao mesmo
 * tempo: sao provas diferentes, de disciplinas diferentes. Na pratica ele
 * ocupava duas cadeiras, aparecia duas vezes na lista de presenca e so faria uma
 * das provas — a outra cadeira ficava vazia com o nome dele.
 *
 * A regra e por **matricula + faixa**, deliberadamente:
 *
 * - **matricula, e nao vinculo.** O limite por vinculo ja existe e responde
 *   outra pergunta ("uma prova por curso em cada rodada"); este responde "uma
 *   prova por PESSOA naquele horario". Os dois convivem.
 * - **faixa, e nao sobreposicao de horario** (decisao do cliente, 14/08/2026).
 *   Duas faixas que se cruzam no relogio (09:00-12:00 e 10:00-11:30) continuam
 *   permitidas. Se um dia isso virar problema, o lugar de mudar e aqui — e so
 *   aqui, porque as quatro portas de entrada passam por esta funcao.
 * - **`periodoLetivoId` entra na conta, mas a `rodada` NAO.** Sem o periodo
 *   letivo, a prova do semestre passado na mesma faixa bloquearia a deste. Ja a
 *   rodada fica de fora de proposito: quem fez a N2 as 08:30 nao faz a SUB as
 *   08:30 tambem — sao duas provas diferentes no mesmo momento, e a trava aqui e
 *   por PESSOA, nao por prova. `faixasBloqueadasParaOVinculo` (o
 *   `conflitaComOutraProva` do portal) espelha exatamente este recorte.
 * - **Sao os periodos letivos da JANELA INTEIRA, no plural, e nao o do vinculo
 *   que esta agendando.** E a consequencia direta de a mesma janela cobrir duas
 *   grades: um mesmo RA pode ter um vinculo EaD (modulo 2026/4) e um Presencial
 *   (semestre 2026/2), e as duas reservas dele ficam gravadas sob org units
 *   DIFERENTES. Recortar pelo periodo de um vinculo so faria esta trava nao
 *   enxergar a reserva do outro — e a pessoa marcaria as duas provas no mesmo
 *   horario, em duas salas. E exatamente o que a trava existe para impedir, e
 *   falharia calada.
 *
 * `exceto` existe para a troca e o remanejo: o agendamento que esta sendo movido
 * nao pode conflitar consigo mesmo.
 */
export async function exigirUmaProvaPorFaixa(
  tx: Transacao,
  dados: {
    matricula: string;
    faixaId: number;
    /** Os periodos letivos da JANELA — ver a nota acima sobre o plural. */
    periodoLetivoIds: string[];
    exceto?: number;
  },
): Promise<void> {
  const outra = await tx.agendamento.findFirst({
    where: {
      matricula: dados.matricula,
      periodoLetivoId: { in: dados.periodoLetivoIds },
      salaFaixa: { faixaId: dados.faixaId },
      ...CONFIRMADO,
      ...(dados.exceto ? { id: { not: dados.exceto } } : {}),
    },
    select: { id: true, aluno: { select: { curso: true } } },
  });

  if (!outra) return;

  throw new ConflictException(
    `Voce ja tem prova marcada neste horario para o curso ` +
      `${outra.aluno.curso} (agendamento ${outra.id}). Sao duas provas ` +
      'diferentes e nao da para fazer as duas ao mesmo tempo — escolha outro ' +
      'horario para esta.',
  );
}

/**
 * O portao: trava as ofertas da faixa+formato e devolve a que a alocacao
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
      'Este horario nao atende o formato deste curso.',
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
