import 'dotenv/config';
import { createMariaDbAdapter } from '../src/database/mariadb-adapter';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';

/**
 * ============================================================================
 * QUAL A MODALIDADE DE CADA TURMA — o diagnostico antes do primeiro dia
 * ============================================================================
 * O lote de DATAS aplica uma janela de horario por MODALIDADE (EaD abre a prova
 * em 3 sessoes de 3h; Semi/Modular em 6 de 1h30), e o questionario tem UMA
 * janela. Mas `turma_importada` nao guarda modalidade, e nao deve guardar: uma
 * turma tem alunos de varios cursos, e foi por isso que a coluna `curso` saiu em
 * 10/08/2026.
 *
 * A modalidade e DERIVADA dos agendamentos confirmados da rodada vigente. Este
 * script mostra o resultado dessa derivacao **antes** de alguem depender dela:
 *
 *   npm run turmas:modalidades
 *
 * O que procurar, em ordem de gravidade:
 *
 *   AMBIGUA          alunos de DUAS modalidades na mesma turma. O lote NAO
 *                    escolhe a maioria (a minoria ficaria sem abrir a prova),
 *                    entao a turma fica com a data antiga ate alguem DECIDIR.
 *                    A decisao se toma na tela — Senhas e datas > Conferir —, e
 *                    este script mostra as que ja foram decididas separadas das
 *                    que ainda esperam (10/09/2026).
 *
 *   SEM_AGENDAMENTO  ninguem agendou naquela turma nesta rodada. Se o periodo
 *                    ainda esta aberto, e esperado — rode de novo depois do
 *                    fechamento. Se ja fechou, a turma do CSV nao tem prova.
 *
 * SO LEITURA: nao grava nada, em nenhuma circunstancia.
 */

interface Linha {
  orgUnitId: string;
  codigoTurma: string | null;
  nomeDisciplina: string | null;
  modalidades: string;
  quantas: bigint | number;
  reservas: bigint | number;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() });

  try {
    // O mesmo recorte de `janelaVigente()`: a janela cadastrada mais
    // recentemente. Ler daqui, e nao de um argumento, e o que faz o diagnostico
    // falar da MESMA rodada que o lote vai usar.
    //
    // O mapa por modalidade vem junto porque a janela cobre as duas grades ao
    // mesmo tempo: as reservas dos presenciais estao gravadas sob o org unit do
    // semestre e as dos modulares sob o do modulo. Recortar por um so faria o
    // diagnostico dizer que metade das turmas nao tem agendamento nenhum.
    const periodo = await prisma.periodoAgendamento.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        periodoLetivoId: true,
        rodada: true,
        letivosPorModalidade: { select: { periodoLetivoId: true } },
      },
    });

    if (!periodo) {
      console.error(
        '[turmas:modalidades] Nenhum periodo de agendamento cadastrado. ' +
          'Sem ele nao ha rodada para recortar os agendamentos.',
      );
      process.exitCode = 1;
      return;
    }

    const { rodada } = periodo;

    const periodosLetivos = [
      ...new Set([
        periodo.periodoLetivoId,
        ...periodo.letivosPorModalidade.map((l) => l.periodoLetivoId),
      ]),
    ];

    console.log(
      `[turmas:modalidades] periodos letivos ${periodosLetivos.join(', ')}, ` +
        `rodada ${rodada}\n`,
    );

    // A MESMA agregacao de `ModalidadeDaTurmaService`, mais o join com o CSV de
    // turmas para o relatorio sair com nome legivel.
    const linhas = await prisma.$queryRaw<Linha[]>`
      SELECT ad.orgUnitId                              AS orgUnitId,
             MAX(t.codigoTurma)                        AS codigoTurma,
             MAX(t.nomeDisciplina)                     AS nomeDisciplina,
             GROUP_CONCAT(DISTINCT m.codigo ORDER BY m.codigo SEPARATOR ', ')
                                                       AS modalidades,
             COUNT(DISTINCT a.modalidadeId)            AS quantas,
             COUNT(*)                                  AS reservas
        FROM agendamento a
        JOIN agendamento_disciplina ad ON ad.agendamentoId = a.id
        JOIN modalidade m              ON m.id = a.modalidadeId
        LEFT JOIN turma_importada t    ON t.orgUnitId = ad.orgUnitId
       WHERE a.status          = 'CONFIRMADO'
         AND a.periodoLetivoId IN (${Prisma.join(periodosLetivos)})
         AND a.rodada          = ${rodada}
       GROUP BY ad.orgUnitId
       ORDER BY quantas DESC, reservas DESC
    `;

    // As decisoes manuais desta rodada. Sem elas o diagnostico choraria lobo:
    // uma turma ja decidida na tela sairia como pendencia, e o script sairia com
    // codigo 1 as vesperas da prova sem haver nada a fazer.
    //
    // ⚠️ A regra do servidor e reproduzida aqui, e nao importada: a escolha so
    // vale se a modalidade escolhida AINDA tem reserva na turma. Ver
    // `decidir()`, em modalidade-da-turma.service.ts.
    const escolhas = new Map(
      (
        await prisma.modalidadeEscolhidaDaTurma.findMany({
          where: { rodada },
          include: { modalidade: { select: { codigo: true } } },
        })
      ).map((e) => [
        e.orgUnitId,
        { codigo: e.modalidade.codigo, por: e.escolhidaPor },
      ]),
    );

    const emDisputa = linhas.filter((l) => Number(l.quantas) > 1);

    /** A escolha vale nesta turma? So se a modalidade dela tem reserva aqui. */
    const decidida = (l: Linha) => {
      const escolha = escolhas.get(l.orgUnitId);

      return escolha &&
        l.modalidades.split(', ').includes(escolha.codigo)
        ? escolha
        : undefined;
    };

    const ambiguas = emDisputa.filter((l) => !decidida(l));
    const desempatadas = emDisputa.filter((l) => decidida(l));
    const resolvidas = linhas.filter((l) => Number(l.quantas) === 1);

    // Turmas do CSV que o cruzamento NAO alcancou: elas nao aparecem na
    // agregacao acima, porque a base dela sao os agendamentos.
    const totalNoCsv = await prisma.turmaImportada.count();
    const comOrgUnitId = await prisma.turmaImportada.count({
      where: { orgUnitId: { not: null } },
    });

    const alcancadas = new Set(linhas.map((l) => l.orgUnitId));
    const semAgendamento = await prisma.turmaImportada.findMany({
      where: { orgUnitId: { not: null } },
      select: { codigoTurma: true, nomeDisciplina: true, orgUnitId: true },
      orderBy: [{ codigoTurma: 'asc' }],
    });
    const orfas = semAgendamento.filter((t) => !alcancadas.has(t.orgUnitId!));

    console.log('RESUMO');
    console.log(`  turmas no CSV .......................... ${totalNoCsv}`);
    console.log(`  com orgUnitId ja aprendido ............. ${comOrgUnitId}`);
    console.log(
      `  com modalidade UNICA (entram no lote) .. ${resolvidas.length}`,
    );
    console.log(
      `  ambiguas DECIDIDAS a mao (entram) ...... ${desempatadas.length}`,
    );
    console.log(
      `  AMBIGUAS sem decisao (ficam de fora) ... ${ambiguas.length}`,
    );
    console.log(`  SEM_AGENDAMENTO (ficam de fora) ........ ${orfas.length}\n`);

    if (resolvidas.length > 0) {
      const porModalidade = new Map<string, number>();
      for (const l of resolvidas) {
        porModalidade.set(
          l.modalidades,
          (porModalidade.get(l.modalidades) ?? 0) + 1,
        );
      }

      console.log('TURMAS POR MODALIDADE');
      for (const [codigo, quantas] of [...porModalidade].sort()) {
        console.log(`  ${codigo.padEnd(12)} ${quantas}`);
      }
      console.log();
    }

    if (desempatadas.length > 0) {
      console.log('DECIDIDAS A MAO — entram no lote da modalidade escolhida');
      for (const l of desempatadas) {
        const escolha = decidida(l)!;
        console.log(
          `  ${(l.codigoTurma ?? '?').padEnd(14)} ` +
            `${(l.nomeDisciplina ?? `orgUnit ${l.orgUnitId}`).slice(0, 40).padEnd(42)} ` +
            `${escolha.codigo}  (de ${l.modalidades}; por ${escolha.por})`,
        );
      }
      console.log();
    }

    if (ambiguas.length > 0) {
      console.log(
        '⚠️  AMBIGUAS — decisao humana, nenhuma janela sera aplicada',
      );
      for (const l of ambiguas) {
        console.log(
          `  ${(l.codigoTurma ?? '?').padEnd(14)} ` +
            `${(l.nomeDisciplina ?? `orgUnit ${l.orgUnitId}`).slice(0, 40).padEnd(42)} ` +
            `${l.modalidades}  (${l.reservas} reserva(s))`,
        );
      }
      console.log();
    }

    if (orfas.length > 0) {
      console.log(
        `SEM_AGENDAMENTO — ${orfas.length} turma(s); as 20 primeiras:`,
      );
      for (const t of orfas.slice(0, 20)) {
        console.log(
          `  ${t.codigoTurma.padEnd(14)} ${t.nomeDisciplina.slice(0, 50)}`,
        );
      }
      console.log();
    }

    if (ambiguas.length === 0) {
      console.log(
        desempatadas.length > 0
          ? '✅ Nenhuma turma ambigua em aberto: as que estavam ja foram decididas na tela.'
          : '✅ Nenhuma turma ambigua: a derivacao por agendamento resolve sozinha.',
      );
    } else {
      console.log(
        `❌ ${ambiguas.length} turma(s) ambigua(s) sem decisao. Elas ficariam ` +
          'com a data antiga, e os alunos nao abririam a prova. Decida em ' +
          'Senhas e datas > Conferir antes do primeiro dia.',
      );
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((erro: unknown) => {
  console.error('[turmas:modalidades] falhou:', erro);
  process.exit(1);
});
