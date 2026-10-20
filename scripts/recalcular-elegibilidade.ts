import 'dotenv/config';
import { createMariaDbAdapter } from '../src/database/mariadb-adapter';
import { permiteAgendar } from '../src/enums/status-curso.enum';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * ============================================================================
 * RECALCULA `AlunoImportado.ativo` A PARTIR DO `statusCurso` GRAVADO
 * ============================================================================
 * Existe por causa de uma armadilha concreta: a regra de elegibilidade mora em
 * `src/enums/status-curso.enum.ts`, mas o resultado dela e **derivado na
 * importacao e gravado** na coluna `ativo` — e e a coluna que o agendamento
 * consulta (`exigirVinculo`). Mudar a lista, sozinho, muda o comportamento
 * apenas de quem for importado DEPOIS. Quem ja esta no banco segue com a
 * classificacao antiga, em silencio.
 *
 * Como `statusCurso` e guardado CRU (o valor exato da planilha), da para
 * reclassificar a base inteira sem reimportar CSV nenhum. E o que este script
 * faz. Ele e idempotente: rodar duas vezes nao muda nada na segunda.
 *
 *   npm run alunos:recalcular            # mostra o que mudaria e NAO grava
 *   npm run alunos:recalcular -- --gravar
 *
 * ⚠️ Pode agendar = status que permite **E** dentro da planilha. Quem esta
 * marcado como fora da planilha (`foraDaPlanilhaEm`, 20/10/2026) continua
 * bloqueado qualquer que seja o status — senao este script desfaria, em
 * silencio, a saida que uma importacao completa marcou.
 *
 * O padrao ser simulacao e proposital: isto reescreve a elegibilidade de
 * milhares de vinculos, e a diferenca precisa ser lida antes de ser aplicada.
 *
 * ⚠️ Quem PERDE a elegibilidade e ja tem prova marcada **continua com a
 * reserva** — este script nao cancela nada. A lista sai no relatorio para a
 * administracao decidir; cancelar em massa por causa de uma mudanca de regra seria
 * uma decisao de negocio, nao de script.
 */
async function main(): Promise<void> {
  const gravar = process.argv.includes('--gravar');

  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() });

  try {
    const vinculos = await prisma.alunoImportado.findMany({
      select: {
        id: true,
        matricula: true,
        nome: true,
        curso: true,
        statusCurso: true,
        ativo: true,
        foraDaPlanilhaEm: true,
      },
      orderBy: { matricula: 'asc' },
    });

    const ganham = vinculos.filter((v) => !v.ativo && podeAgendar(v));
    const perdem = vinculos.filter((v) => v.ativo && !podeAgendar(v));

    console.log(`Vinculos na base: ${vinculos.length}`);
    console.log(`Passam a PODER agendar: ${ganham.length}`);
    console.log(`Passam a NAO poder agendar: ${perdem.length}`);

    resumirPorStatus('Ganham elegibilidade', ganham);
    resumirPorStatus('Perdem elegibilidade', perdem);

    // O caso que exige atendimento humano: perdeu o direito, mas a prova ja
    // esta marcada. O script nao mexe na reserva — so nomeia quem e.
    const perdemComProva = await comProvaMarcada(prisma, perdem);

    if (perdemComProva.length > 0) {
      console.log(
        `\n⚠️  ${perdemComProva.length} vinculo(s) perdem a elegibilidade e JA TEM prova marcada.` +
          '\n    A reserva NAO e cancelada por este script. Decida caso a caso:',
      );

      for (const v of perdemComProva) {
        console.log(
          `    ${v.matricula} · ${v.nome ?? 'sem nome'} · ${v.curso} · status "${v.statusCurso}"`,
        );
      }
    }

    if (!gravar) {
      console.log(
        '\nSIMULACAO — nada foi gravado. Repita com `-- --gravar` para aplicar.',
      );
      return;
    }

    // updateMany por grupo: sao duas consultas, nao uma por vinculo.
    const paraTrue = ganham.map((v) => v.id);
    const paraFalse = perdem.map((v) => v.id);

    if (paraTrue.length > 0) {
      await prisma.alunoImportado.updateMany({
        where: { id: { in: paraTrue } },
        data: { ativo: true },
      });
    }

    if (paraFalse.length > 0) {
      await prisma.alunoImportado.updateMany({
        where: { id: { in: paraFalse } },
        data: { ativo: false },
      });
    }

    console.log(
      `\nGravado: ${paraTrue.length} liberado(s), ${paraFalse.length} bloqueado(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

type Vinculo = {
  id: number;
  matricula: string;
  nome: string | null;
  curso: string;
  statusCurso: string;
  ativo: boolean;
  foraDaPlanilhaEm: Date | null;
};

function podeAgendar(v: Vinculo): boolean {
  return permiteAgendar(v.statusCurso) && v.foraDaPlanilhaEm === null;
}

/** Quantos por STATUS CURSO — e assim que se confere se a mudanca e a esperada. */
function resumirPorStatus(titulo: string, vinculos: Vinculo[]): void {
  if (vinculos.length === 0) return;

  const porStatus = new Map<string, number>();

  for (const v of vinculos) {
    porStatus.set(v.statusCurso, (porStatus.get(v.statusCurso) ?? 0) + 1);
  }

  console.log(`\n${titulo}:`);

  for (const [status, quantos] of [...porStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(24)} ${quantos}`);
  }
}

async function comProvaMarcada(
  prisma: PrismaClient,
  vinculos: Vinculo[],
): Promise<Vinculo[]> {
  if (vinculos.length === 0) return [];

  const comReserva = await prisma.agendamento.findMany({
    where: {
      alunoId: { in: vinculos.map((v) => v.id) },
      status: 'CONFIRMADO',
    },
    select: { alunoId: true },
    distinct: ['alunoId'],
  });

  const ids = new Set(comReserva.map((a) => a.alunoId));

  return vinculos.filter((v) => ids.has(v.id));
}

main().catch((erro) => {
  console.error(erro);
  process.exit(1);
});
