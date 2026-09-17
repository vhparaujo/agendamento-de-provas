import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';

export interface FiltroTurmas {
  /** Casa com codigo da turma, nome da disciplina, codigo EAD ou orgUnitId. */
  busca?: string;
  /** So as turmas que vieram de um upload especifico. */
  importacaoId?: number;
  /**
   * true = so as que ja tiveram o orgUnitId aprendido num launch;
   * false = as que ainda nao apareceram em nenhum launch.
   */
  comOrgUnitId?: boolean;
  pagina?: number;
  porPagina?: number;
}

export interface TurmaImportadaResumo {
  id: number;
  codigoTurma: string;
  nomeDisciplina: string;
  /** O outro token do `Code` composto do Brightspace. */
  codigoEad: string | null;
  /** Id no D2L. Null enquanto nenhum launch tiver vindo desta turma. */
  orgUnitId: string | null;
}

export interface PaginaDeTurmas {
  total: number;
  pagina: number;
  porPagina: number;
  totalPaginas: number;
  itens: TurmaImportadaResumo[];
}

export interface TurmaImportadaDetalhe extends TurmaImportadaResumo {
  /** De qual upload esta turma veio. Null nos registros anteriores a auditoria. */
  importacao: { id: number; nomeArquivo: string; createdAt: Date } | null;
  /**
   * Agendamentos CONFIRMADOS que cobrem esta disciplina. Null — nao zero —
   * enquanto o orgUnitId nao tiver sido aprendido: sem ele nao ha como contar,
   * e "0" faria parecer que ninguem marcou.
   */
  totalAgendamentos: number | null;
}

const PADRAO_POR_PAGINA = 50;
const MAXIMO_POR_PAGINA = 200;

/**
 * A consulta do admin sobre o CSV de turmas — o catalogo do que TEM prova. O que
 * esta tela responde e "esta disciplina esta liberada para agendamento?", que
 * antes so se descobria abrindo o banco.
 *
 * Leitura, mais UM delete. Nada aqui EDITA turma pelo mesmo motivo dos alunos —
 * a planilha e a fonte de verdade e o proximo upload desfaria a correcao —, mas
 * apagar e outro caso: a importacao e upsert e nunca remove o que saiu do CSV,
 * entao sem este delete uma linha errada ficaria agendavel para sempre.
 */
@Injectable()
export class TurmaAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(filtro: FiltroTurmas): Promise<PaginaDeTurmas> {
    const where = montarWhere(filtro);

    const porPagina = Math.min(
      Math.max(filtro.porPagina ?? PADRAO_POR_PAGINA, 1),
      MAXIMO_POR_PAGINA,
    );
    const pagina = Math.max(filtro.pagina ?? 1, 1);

    const [total, itens] = await Promise.all([
      this.prisma.turmaImportada.count({ where }),
      this.prisma.turmaImportada.findMany({
        where,
        select: SELECT_RESUMO,
        // Pelo nome primeiro: o admin procura "SAUDE COLETIVA", nao "GSPS0I10227".
        orderBy: [{ nomeDisciplina: 'asc' }, { codigoTurma: 'asc' }],
        skip: (pagina - 1) * porPagina,
        take: porPagina,
      }),
    ]);

    return {
      total,
      pagina,
      porPagina,
      totalPaginas: Math.max(1, Math.ceil(total / porPagina)),
      itens,
    };
  }

  async buscar(id: number): Promise<TurmaImportadaDetalhe> {
    const turma = await this.prisma.turmaImportada.findUnique({
      where: { id },
      select: {
        ...SELECT_RESUMO,
        importacao: {
          select: { id: true, nomeArquivo: true, createdAt: true },
        },
      },
    });

    if (!turma)
      throw new NotFoundException(
        'Turma não encontrada. Atualize a página e tente de novo.',
      );

    // AgendamentoDisciplina guarda o orgUnitId, nao a turma: a ligacao entre os
    // dois so existe depois que algum launch ensinou o id desta turma.
    const totalAgendamentos = turma.orgUnitId
      ? await this.prisma.agendamentoDisciplina.count({
          where: {
            orgUnitId: turma.orgUnitId,
            agendamento: { status: StatusAgendamento.CONFIRMADO },
          },
        })
      : null;

    return { ...turma, totalAgendamentos };
  }

  /**
   * Tira uma turma do catalogo. Serve para desfazer carga errada — linha
   * duplicada, turma que entrou na planilha sem ter prova — e o efeito e
   * imediato: a disciplina deixa de ser agendavel para todo mundo (com
   * `TURMAS_FILTER_ENABLED=true`, o default).
   *
   * ⚠️ **Nao e definitivo sozinho.** A fonte de verdade continua sendo a
   * planilha, e a importacao e upsert: se a linha seguir la, o proximo upload
   * traz a turma de volta — com id novo e sem o `orgUnitId` que os launches ja
   * tinham aprendido. Apagar aqui conserta agora; tirar da planilha conserta.
   *
   * Turma com prova marcada nao se apaga. O agendamento aponta para a disciplina
   * pelo `orgUnitId`, sem chave estrangeira, entao o delete passaria limpo e
   * quebraria calado o que le o catalogo depois: o relatorio nomeia o arquivo de
   * cada turma por esta tabela (`turmasPorOrgUnit`) e cairia no numero cru do
   * D2L, e a resolucao de senhas perderia a linha que casa com a oferta.
   */
  async remover(id: number): Promise<{ mensagem: string }> {
    const turma = await this.buscar(id);

    if (turma.totalAgendamentos !== null && turma.totalAgendamentos > 0) {
      throw new ConflictException(
        `A turma "${turma.codigoTurma} — ${turma.nomeDisciplina}" já tem ` +
          `${turma.totalAgendamentos} agendamento(s) confirmado(s) e não pode ser ` +
          'apagada. Apagar aqui não desmarcaria prova nenhuma — só tiraria o nome ' +
          'da turma do relatório. Se as provas não deviam existir, cancele os ' +
          'agendamentos na tela de Agendamentos antes.',
      );
    }

    await this.prisma.turmaImportada.delete({ where: { id } });

    return {
      mensagem:
        `Turma "${turma.codigoTurma} — ${turma.nomeDisciplina}" removida do ` +
        'catálogo. Tire a linha da planilha também: o próximo envio do CSV a ' +
        'traria de volta.',
    };
  }
}

function montarWhere(filtro: FiltroTurmas): Prisma.TurmaImportadaWhereInput {
  const busca = filtro.busca?.trim();

  return {
    importacaoId: filtro.importacaoId,
    ...(filtro.comOrgUnitId === undefined
      ? {}
      : { orgUnitId: filtro.comOrgUnitId ? { not: null } : null }),
    ...(busca
      ? {
          OR: [
            { codigoTurma: { contains: busca } },
            { nomeDisciplina: { contains: busca } },
            { codigoEad: { contains: busca } },
            { orgUnitId: { contains: busca } },
          ],
        }
      : {}),
  };
}

const SELECT_RESUMO = {
  id: true,
  codigoTurma: true,
  nomeDisciplina: true,
  codigoEad: true,
  orgUnitId: true,
} satisfies Prisma.TurmaImportadaSelect;
