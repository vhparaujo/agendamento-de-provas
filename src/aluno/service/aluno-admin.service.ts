import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';

export interface FiltroAlunos {
  /** Casa com matricula, nome, e-mail ou curso. */
  busca?: string;
  poloId?: number;
  modalidadeId?: number;
  curso?: string;
  /** `ativo` do vinculo = PODE AGENDAR (derivado de STATUS CURSO). */
  ativo?: boolean;
  /** So os vinculos que vieram de um upload especifico. */
  importacaoId?: number;
  /** true = so quem ja tem prova marcada; false = so quem ainda nao marcou. */
  agendado?: boolean;
  /** true = so quem e do NIOP; false = so quem nao e. */
  niop?: boolean;
  /** true = so quem saiu da planilha; false = so quem continua nela. */
  foraDaPlanilha?: boolean;
  pagina?: number;
  porPagina?: number;
}

export interface AlunoImportadoResumo {
  id: number;
  matricula: string;
  nome: string | null;
  email: string | null;
  curso: string;
  /** Valor bruto da coluna STATUS CURSO, como veio no CSV. */
  statusCurso: string;
  /** Se este vinculo pode agendar: status que permite E dentro da planilha. */
  ativo: boolean;
  /**
   * Quando uma importacao completa do formato o deixou de fora — o aluno saiu.
   * null = continua na planilha.
   */
  foraDaPlanilhaEm: Date | null;
  modalidade: string;
  polo: string;
  /** Agendamentos CONFIRMADOS deste vinculo — 0 significa "ainda nao marcou". */
  totalAgendamentos: number;
  /** A MATRICULA e do NIOP: o special access da uma hora a mais. */
  niop: boolean;
}

export interface PaginaDeAlunos {
  total: number;
  pagina: number;
  porPagina: number;
  totalPaginas: number;
  itens: AlunoImportadoResumo[];
}

export interface AgendamentoDoAluno {
  id: number;
  data: Date;
  horaInicio: string;
  horaFim: string;
  sala: string;
  polo: string;
  status: string;
  periodoLetivoId: string;
  /**
   * Qual prova do semestre. Sem ela, o balcao veria duas linhas com o mesmo
   * periodo letivo e nada dizendo qual e a regular e qual e a substitutiva.
   */
  rodada: string;
}

export interface AlunoImportadoDetalhe extends AlunoImportadoResumo {
  /** De qual upload este vinculo veio. Null nos registros criados antes da auditoria. */
  importacao: { id: number; nomeArquivo: string; createdAt: Date } | null;
  /**
   * Os OUTROS vinculos da mesma matricula. Um RA em dois cursos agenda duas
   * provas, e quem atende no balcao precisa ver isso sem fazer outra busca.
   */
  outrosVinculos: { id: number; curso: string; modalidade: string }[];
  agendamentos: AgendamentoDoAluno[];
  /** Quem marcou o NIOP, e quando. Nulos quando `niop` e false. */
  niopMarcadoPor: string | null;
  niopMarcadoEm: Date | null;
}

const PADRAO_POR_PAGINA = 50;
const MAXIMO_POR_PAGINA = 200;

/**
 * A consulta do admin sobre quem foi importado pelos CSVs.
 *
 * Somente leitura, de proposito: aluno nao se cadastra nem se edita aqui — a
 * fonte de verdade e a planilha, e um ajuste na mao seria apagado no proximo
 * upload sem ninguem perceber. Para corrigir, corrige-se o CSV e reimporta.
 */
@Injectable()
export class AlunoAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Listagem paginada com busca. A paginacao nao e enfeite: sao ~7.500 vinculos
   * na base real, e uma listagem sem limite derrubaria a tela do admin.
   */
  async listar(filtro: FiltroAlunos): Promise<PaginaDeAlunos> {
    const where = montarWhere(
      filtro,
      filtro.niop === undefined ? undefined : await this.matriculasNiop(),
    );

    const porPagina = Math.min(
      Math.max(filtro.porPagina ?? PADRAO_POR_PAGINA, 1),
      MAXIMO_POR_PAGINA,
    );
    const pagina = Math.max(filtro.pagina ?? 1, 1);

    const [total, registros] = await Promise.all([
      this.prisma.alunoImportado.count({ where }),
      this.prisma.alunoImportado.findMany({
        where,
        include: INCLUDE_RESUMO,
        // Nome primeiro porque a busca do balcao e por pessoa; matricula e curso
        // desempatam os homonimos e os dois vinculos do mesmo RA.
        orderBy: [{ nome: 'asc' }, { matricula: 'asc' }, { curso: 'asc' }],
        skip: (pagina - 1) * porPagina,
        take: porPagina,
      }),
    ]);

    const marcados = new Set(
      await this.matriculasNiop(registros.map((r) => r.matricula)),
    );

    return {
      total,
      pagina,
      porPagina,
      totalPaginas: Math.max(1, Math.ceil(total / porPagina)),
      itens: registros.map((r) => montarResumo(r, marcados.has(r.matricula))),
    };
  }

  /**
   * O vinculo inteiro: de qual upload veio, os outros vinculos do mesmo RA e as
   * provas ja marcadas. E a tela de atendimento — "o aluno esta na base? qual
   * polo? ja agendou?" respondida de uma vez.
   */
  async buscar(id: number): Promise<AlunoImportadoDetalhe> {
    const aluno = await this.prisma.alunoImportado.findUnique({
      where: { id },
      include: {
        ...INCLUDE_RESUMO,
        importacao: {
          select: { id: true, nomeArquivo: true, createdAt: true },
        },
        agendamentos: {
          include: {
            salaFaixa: {
              include: {
                sala: { select: { nome: true } },
                faixa: { include: { polo: { select: { nome: true } } } },
              },
            },
          },
          orderBy: [
            { salaFaixa: { faixa: { data: 'asc' } } },
            { salaFaixa: { faixa: { horaInicio: 'asc' } } },
          ],
        },
      },
    });

    if (!aluno)
      throw new NotFoundException(
        'Aluno não encontrado. Atualize a página e tente de novo.',
      );

    const niop = await this.prisma.alunoNiop.findUnique({
      where: { matricula: aluno.matricula },
    });

    const outros = await this.prisma.alunoImportado.findMany({
      where: { matricula: aluno.matricula, id: { not: aluno.id } },
      include: { modalidade: { select: { nome: true } } },
      orderBy: { curso: 'asc' },
    });

    return {
      ...montarResumo(aluno, niop !== null),
      importacao: aluno.importacao,
      niopMarcadoPor: niop?.marcadoPor ?? null,
      niopMarcadoEm: niop?.createdAt ?? null,
      outrosVinculos: outros.map((v) => ({
        id: v.id,
        curso: v.curso,
        modalidade: v.modalidade.nome,
      })),
      // Cancelados entram aqui de proposito (a listagem so conta os confirmados):
      // no atendimento, "cancelou dia 12" e uma resposta; sumir nao e.
      agendamentos: aluno.agendamentos.map((a) => ({
        id: a.id,
        data: a.salaFaixa.faixa.data,
        horaInicio: a.salaFaixa.faixa.horaInicio,
        horaFim: a.salaFaixa.faixa.horaFim,
        sala: a.salaFaixa.sala.nome,
        polo: a.salaFaixa.faixa.polo.nome,
        status: a.status,
        periodoLetivoId: a.periodoLetivoId,
        rodada: a.rodada,
      })),
    };
  }

  /**
   * Os cursos distintos que existem na base, para o dropdown do filtro. Sao
   * poucas dezenas de valores contra milhares de linhas — nao vale paginar.
   */
  async cursos(): Promise<string[]> {
    const linhas = await this.prisma.alunoImportado.findMany({
      distinct: ['curso'],
      select: { curso: true },
      orderBy: { curso: 'asc' },
    });

    return linhas.map((l) => l.curso);
  }

  /** As matriculas do NIOP — todas, ou so as de uma pagina da listagem. */
  private async matriculasNiop(entre?: string[]): Promise<string[]> {
    const linhas = await this.prisma.alunoNiop.findMany({
      where: entre ? { matricula: { in: entre } } : undefined,
      select: { matricula: true },
    });

    return linhas.map((l) => l.matricula);
  }
}

/**
 * `niop` e a lista de matriculas do NIOP, lida so quando o filtro existe. E um
 * `in`/`notIn` e nao uma relacao porque a marca e da MATRICULA, que nao e unica
 * em `aluno_importado` — sao poucas dezenas de linhas.
 */
function montarWhere(
  filtro: FiltroAlunos,
  niop?: string[],
): Prisma.AlunoImportadoWhereInput {
  const busca = filtro.busca?.trim();

  return {
    poloId: filtro.poloId,
    modalidadeId: filtro.modalidadeId,
    curso: filtro.curso,
    ativo: filtro.ativo,
    importacaoId: filtro.importacaoId,
    ...(filtro.foraDaPlanilha === undefined
      ? {}
      : {
          foraDaPlanilhaEm: filtro.foraDaPlanilha ? { not: null } : null,
        }),
    ...(filtro.agendado === undefined
      ? {}
      : {
          agendamentos: filtro.agendado
            ? { some: { status: StatusAgendamento.CONFIRMADO } }
            : { none: { status: StatusAgendamento.CONFIRMADO } },
        }),
    ...(niop === undefined
      ? {}
      : { matricula: filtro.niop ? { in: niop } : { notIn: niop } }),
    ...(busca
      ? {
          OR: [
            { matricula: { contains: busca } },
            { nome: { contains: busca } },
            { email: { contains: busca } },
            { curso: { contains: busca } },
          ],
        }
      : {}),
  };
}

const INCLUDE_RESUMO = {
  modalidade: { select: { nome: true } },
  polo: { select: { nome: true } },
  _count: {
    select: {
      agendamentos: { where: { status: StatusAgendamento.CONFIRMADO } },
    },
  },
} satisfies Prisma.AlunoImportadoInclude;

type RegistroResumo = {
  id: number;
  matricula: string;
  nome: string | null;
  email: string | null;
  curso: string;
  statusCurso: string;
  ativo: boolean;
  foraDaPlanilhaEm: Date | null;
  modalidade: { nome: string };
  polo: { nome: string };
  _count: { agendamentos: number };
};

function montarResumo(
  registro: RegistroResumo,
  niop: boolean,
): AlunoImportadoResumo {
  return {
    id: registro.id,
    matricula: registro.matricula,
    nome: registro.nome,
    email: registro.email,
    curso: registro.curso,
    statusCurso: registro.statusCurso,
    ativo: registro.ativo,
    foraDaPlanilhaEm: registro.foraDaPlanilhaEm,
    modalidade: registro.modalidade.nome,
    polo: registro.polo.nome,
    totalAgendamentos: registro._count.agendamentos,
    niop,
  };
}
