import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import { dataBr, dataDaProva, montarCsv } from './csv-relatorio';

export interface FiltroAgendamentos {
  poloId?: number;
  faixaId?: number;
  salaId?: number;
  modalidadeId?: number;
  periodoLetivoId?: string;
  /** Data da prova (AAAA-MM-DD). */
  de?: string;
  ate?: string;
  /** Busca por matricula, nome ou curso. */
  busca?: string;
  status?: StatusAgendamento;
  pagina?: number;
  porPagina?: number;
}

export interface AgendamentoAdmin {
  id: number;
  matricula: string;
  nome: string | null;
  email: string | null;
  curso: string;
  statusCurso: string;
  modalidade: string;
  polo: string;
  data: Date;
  horaInicio: string;
  horaFim: string;
  sala: string;
  status: string;
  alocadoManual: boolean;
  periodoLetivoId: string;
  disciplinas: { orgUnitId: string; nomeDisciplina: string | null }[];
  criadoEm: Date;
}

export interface PaginaDeAgendamentos {
  total: number;
  pagina: number;
  porPagina: number;
  totalPaginas: number;
  itens: AgendamentoAdmin[];
}

export interface LinhaDoResumo {
  poloId: number;
  polo: string;
  faixaId: number;
  data: Date;
  horaInicio: string;
  horaFim: string;
  salaId: number;
  sala: string;
  modalidade: string;
  vagas: number;
  ocupadas: number;
  disponiveis: number;
}

const PADRAO_POR_PAGINA = 50;
const MAXIMO_POR_PAGINA = 200;

@Injectable()
export class AgendamentoAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Consulta paginada. A paginacao nao e enfeite: sao ~7.500 vinculos, e uma
   * listagem sem limite derrubaria a tela do admin e a memoria do processo.
   */
  async listar(filtro: FiltroAgendamentos): Promise<PaginaDeAgendamentos> {
    const where = this.montarWhere(filtro);

    const porPagina = Math.min(
      Math.max(filtro.porPagina ?? PADRAO_POR_PAGINA, 1),
      MAXIMO_POR_PAGINA,
    );
    const pagina = Math.max(filtro.pagina ?? 1, 1);

    const [total, registros] = await Promise.all([
      this.prisma.agendamento.count({ where }),
      this.prisma.agendamento.findMany({
        where,
        include: INCLUDE_ADMIN,
        orderBy: [
          { salaFaixa: { faixa: { data: 'asc' } } },
          { salaFaixa: { faixa: { horaInicio: 'asc' } } },
          { salaFaixa: { ordem: 'asc' } },
          { matricula: 'asc' },
        ],
        skip: (pagina - 1) * porPagina,
        take: porPagina,
      }),
    ]);

    return {
      total,
      pagina,
      porPagina,
      totalPaginas: Math.max(1, Math.ceil(total / porPagina)),
      itens: registros.map(montarAdmin),
    };
  }

  async buscar(id: number): Promise<AgendamentoAdmin> {
    const agendamento = await this.prisma.agendamento.findUnique({
      where: { id },
      include: INCLUDE_ADMIN,
    });

    if (!agendamento) {
      throw new NotFoundException(`Agendamento ${id} nao encontrado`);
    }

    return montarAdmin(agendamento);
  }

  /**
   * Ocupacao por sala, que e a pergunta operacional do dia da prova: quantas
   * pessoas em cada sala, e quais salas nem precisam ser abertas.
   */
  async resumo(filtro: FiltroAgendamentos): Promise<LinhaDoResumo[]> {
    const ofertas = await this.prisma.salaFaixa.findMany({
      where: {
        faixa: {
          poloId: filtro.poloId,
          id: filtro.faixaId,
          data: janelaDeDatas(filtro),
        },
        salaId: filtro.salaId,
        modalidadeId: filtro.modalidadeId,
      },
      include: {
        sala: { select: { id: true, nome: true } },
        modalidade: { select: { nome: true } },
        faixa: {
          include: { polo: { select: { id: true, nome: true } } },
        },
        _count: {
          select: {
            agendamentos: { where: { status: StatusAgendamento.CONFIRMADO } },
          },
        },
      },
      orderBy: [
        { faixa: { data: 'asc' } },
        { faixa: { horaInicio: 'asc' } },
        { ordem: 'asc' },
      ],
    });

    return ofertas.map((o) => ({
      poloId: o.faixa.polo.id,
      polo: o.faixa.polo.nome,
      faixaId: o.faixaId,
      data: o.faixa.data,
      horaInicio: o.faixa.horaInicio,
      horaFim: o.faixa.horaFim,
      salaId: o.sala.id,
      sala: o.sala.nome,
      modalidade: o.modalidade.nome,
      vagas: o.vagas,
      ocupadas: o._count.agendamentos,
      disponiveis: Math.max(0, o.vagas - o._count.agendamentos),
    }));
  }

  /**
   * O relatorio completo, uma linha por agendamento.
   *
   * Sem paginacao de proposito — quem exporta quer o arquivo inteiro. O volume
   * e o de um semestre (milhares de linhas, nao milhoes), e a consulta e uma so.
   */
  async exportarCsv(filtro: FiltroAgendamentos): Promise<string> {
    const registros = await this.prisma.agendamento.findMany({
      where: this.montarWhere(filtro),
      include: INCLUDE_ADMIN,
      orderBy: [
        { salaFaixa: { faixa: { data: 'asc' } } },
        { salaFaixa: { faixa: { horaInicio: 'asc' } } },
        { salaFaixa: { ordem: 'asc' } },
        { matricula: 'asc' },
      ],
    });

    const linhas = registros
      .map(montarAdmin)
      .map((a) => [
        a.matricula,
        a.nome,
        a.email,
        a.curso,
        a.modalidade,
        a.statusCurso,
        a.polo,
        dataDaProva(a.data),
        a.horaInicio,
        a.horaFim,
        a.sala,
        a.disciplinas.map((d) => d.nomeDisciplina ?? d.orgUnitId).join(' | '),
        a.disciplinas.map((d) => d.orgUnitId).join(' | '),
        a.status,
        a.alocadoManual ? 'sim' : 'nao',
        a.periodoLetivoId,
        dataBr(a.criadoEm, true),
        a.id,
      ]);

    return montarCsv(CABECALHOS_EXPORTACAO, linhas);
  }

  /** Nome do arquivo com a data — dois relatorios do mesmo dia nao se confundem. */
  nomeDoArquivo(prefixo = 'agendamentos'): string {
    const agora = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

    return `${prefixo}-${agora}.csv`;
  }

  private montarWhere(
    filtro: FiltroAgendamentos,
  ): Prisma.AgendamentoWhereInput {
    const busca = filtro.busca?.trim();

    return {
      // Sem filtro explicito, mostra so os CONFIRMADOS: um cancelado na lista
      // do dia da prova faria alguem procurar um aluno que nao vem.
      status: filtro.status ?? StatusAgendamento.CONFIRMADO,
      periodoLetivoId: filtro.periodoLetivoId,
      salaFaixa: {
        salaId: filtro.salaId,
        modalidadeId: filtro.modalidadeId,
        faixaId: filtro.faixaId,
        faixa: {
          poloId: filtro.poloId,
          data: janelaDeDatas(filtro),
        },
      },
      ...(busca
        ? {
            OR: [
              { matricula: { contains: busca } },
              { aluno: { nome: { contains: busca } } },
              { aluno: { curso: { contains: busca } } },
            ],
          }
        : {}),
    };
  }
}

const CABECALHOS_EXPORTACAO = [
  'Matricula',
  'Aluno',
  'E-mail',
  'Curso',
  'Modalidade',
  'Status no curso',
  'Polo',
  'Data da prova',
  'Inicio',
  'Fim',
  'Sala',
  'Disciplinas',
  'orgUnitIds',
  'Status',
  'Alocado manualmente',
  'Periodo letivo',
  'Agendado em',
  'Id',
];

function janelaDeDatas(filtro: FiltroAgendamentos) {
  if (!filtro.de && !filtro.ate) return undefined;

  return {
    gte: filtro.de ? paraData(filtro.de) : undefined,
    lte: filtro.ate ? paraData(filtro.ate) : undefined,
  };
}

/** A coluna e @db.Date: meia-noite UTC, para nao deslizar um dia no fuso local. */
function paraData(data: string): Date {
  return new Date(`${data}T00:00:00.000Z`);
}

const INCLUDE_ADMIN = {
  aluno: {
    select: {
      nome: true,
      email: true,
      curso: true,
      statusCurso: true,
      modalidade: { select: { nome: true } },
    },
  },
  disciplinas: { select: { orgUnitId: true, nomeDisciplina: true } },
  salaFaixa: {
    include: {
      sala: { select: { nome: true } },
      faixa: { include: { polo: { select: { nome: true } } } },
    },
  },
} satisfies Prisma.AgendamentoInclude;

type RegistroAdmin = {
  id: number;
  matricula: string;
  status: string;
  alocadoManual: boolean;
  periodoLetivoId: string;
  createdAt: Date;
  aluno: {
    nome: string | null;
    email: string | null;
    curso: string;
    statusCurso: string;
    modalidade: { nome: string };
  };
  disciplinas: { orgUnitId: string; nomeDisciplina: string | null }[];
  salaFaixa: {
    sala: { nome: string };
    faixa: {
      data: Date;
      horaInicio: string;
      horaFim: string;
      polo: { nome: string };
    };
  };
};

function montarAdmin(registro: RegistroAdmin): AgendamentoAdmin {
  const { salaFaixa, aluno } = registro;

  return {
    id: registro.id,
    matricula: registro.matricula,
    nome: aluno.nome,
    email: aluno.email,
    curso: aluno.curso,
    statusCurso: aluno.statusCurso,
    modalidade: aluno.modalidade.nome,
    polo: salaFaixa.faixa.polo.nome,
    data: salaFaixa.faixa.data,
    horaInicio: salaFaixa.faixa.horaInicio,
    horaFim: salaFaixa.faixa.horaFim,
    sala: salaFaixa.sala.nome,
    status: registro.status,
    alocadoManual: registro.alocadoManual,
    periodoLetivoId: registro.periodoLetivoId,
    disciplinas: registro.disciplinas,
    criadoEm: registro.createdAt,
  };
}
