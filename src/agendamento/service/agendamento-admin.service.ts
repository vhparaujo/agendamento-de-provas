import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  EventoAgendamento,
  Prisma,
  StatusAgendamento,
} from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { dataBr, dataDaProva, montarCsv } from './csv-relatorio';
import { AUTOR_ADMIN, descreverOferta, registrarHistorico } from './historico';
import {
  escolherOfertaComLock,
  exigirVagaNaOferta,
  OPCOES_DA_TRANSACAO,
  travarVinculo,
} from './lock-de-vagas';

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

export interface EventoDoHistorico {
  id: number;
  evento: string;
  /** ALUNO ou ADMIN — quem fez a alteracao. */
  autorTipo: string;
  /** Matricula do aluno ou e-mail do administrador. */
  autor: string;
  de: string | null;
  para: string | null;
  quando: Date;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * ==========================================================================
   * REMANEJO — a valvula de escape do sistema
   * ==========================================================================
   * A alocacao automatica e so o padrao. Quando a realidade nao cabe nela (sala
   * interditada, aluno com necessidade especifica, prazo perdido), o admin move
   * a mao — e o registro passa a dizer `alocadoManual: true`, para ninguem
   * depois achar que a regra sequencial produziu aquilo.
   *
   * Ao contrario do aluno, o admin NAO depende do periodo estar aberto: consertar
   * depois do fechamento e justamente o caso de uso.
   *
   * Duas formas:
   * - `salaFaixaId` — o admin escolhe a sala exata;
   * - `faixaId` — muda de horario e deixa a alocacao sequencial escolher a sala.
   *
   * O que NAO se pode remanejar, em nenhuma das duas: outro polo (o aluno
   * viajaria para o campus errado) e outra modalidade (a prova tem outra
   * duracao). Sao os dois erros que o remanejo poderia esconder.
   */
  async remanejar(
    id: number,
    destino: { salaFaixaId?: number; faixaId?: number },
    ator?: string,
  ): Promise<AgendamentoAdmin> {
    if (!destino.salaFaixaId === !destino.faixaId) {
      throw new BadRequestException(
        'Informe `salaFaixaId` (sala exata) OU `faixaId` (deixa a alocacao escolher) — um dos dois.',
      );
    }

    const atual = await this.prisma.agendamento.findUnique({
      where: { id },
      include: {
        aluno: { select: { id: true, modalidadeId: true, poloId: true } },
        salaFaixa: { select: { id: true, faixaId: true } },
      },
    });

    if (!atual) throw new NotFoundException(`Agendamento ${id} nao encontrado`);

    if (atual.status !== StatusAgendamento.CONFIRMADO) {
      throw new ConflictException(
        'Agendamento cancelado nao pode ser remanejado.',
      );
    }

    const alvo = await this.resolverDestino(destino, atual.aluno);

    if (alvo.salaFaixaId === atual.salaFaixa.id) {
      throw new ConflictException('O agendamento ja esta nesta sala.');
    }

    await this.prisma.$transaction(async (tx) => {
      await travarVinculo(tx, atual.aluno.id);

      const de = await descreverOferta(tx, atual.salaFaixa.id);

      const salaFaixaId =
        alvo.salaFaixaId ??
        (
          await escolherOfertaComLock(
            tx,
            alvo.faixaId,
            atual.aluno.modalidadeId,
            id,
          )
        ).id;

      if (alvo.salaFaixaId) {
        await exigirVagaNaOferta(tx, alvo.salaFaixaId, id);
      }

      await tx.agendamento.update({
        where: { id },
        data: { salaFaixaId, alocadoManual: true },
      });

      // O horario pode ter mudado: o que ja tiver sido liberado precisa ser
      // reescrito quando a integracao com o D2L existir.
      await tx.syncD2L.updateMany({
        where: { agendamentoId: id },
        data: { status: 'PENDENTE', tentativas: 0, ultimoErro: null },
      });

      // FOI O ADMINISTRADOR, e fica gravado com o e-mail dele. E o outro lado da
      // mesma prova: se o aluno reclamar que nao foi ele, isto responde.
      await registrarHistorico(tx, {
        agendamentoId: id,
        evento: EventoAgendamento.REMANEJADO,
        autor: AUTOR_ADMIN(ator),
        de,
        para: await descreverOferta(tx, salaFaixaId),
      });
    }, OPCOES_DA_TRANSACAO);

    this.auditoria.registrar('AGENDAMENTO_REMANEJADO', {
      ator,
      detalhe: `agendamento ${id}: oferta ${atual.salaFaixa.id} -> ${alvo.salaFaixaId ?? `faixa ${alvo.faixaId}`} (remanejo administrativo)`,
    });

    return this.buscar(id);
  }

  /**
   * Cancela pelo lado administrativo. Vira CANCELADO, nunca some: quem aparecer
   * no dia sem estar na lista precisa ser explicavel.
   */
  async cancelar(id: number, ator?: string): Promise<{ mensagem: string }> {
    const atual = await this.prisma.agendamento.findUnique({
      where: { id },
      select: { id: true, matricula: true, status: true, salaFaixaId: true },
    });

    if (!atual) throw new NotFoundException(`Agendamento ${id} nao encontrado`);

    if (atual.status !== StatusAgendamento.CONFIRMADO) {
      throw new ConflictException('Este agendamento ja esta cancelado.');
    }

    await this.prisma.$transaction(async (tx) => {
      const de = await descreverOferta(tx, atual.salaFaixaId);

      await tx.agendamento.update({
        where: { id },
        data: { status: StatusAgendamento.CANCELADO },
      });

      await tx.syncD2L.deleteMany({ where: { agendamentoId: id } });

      await registrarHistorico(tx, {
        agendamentoId: id,
        evento: EventoAgendamento.CANCELADO,
        autor: AUTOR_ADMIN(ator),
        de,
      });
    });

    this.auditoria.registrar('AGENDAMENTO_CANCELADO', {
      ator,
      detalhe: `agendamento ${id} (${atual.matricula}) cancelado pelo administrador`,
    });

    return { mensagem: `Agendamento ${id} cancelado. A vaga foi liberada.` };
  }

  /**
   * Quem mexeu neste agendamento, do mais recente para o mais antigo.
   *
   * E a tela que a secretaria abre quando o aluno reclama que mudaram a prova
   * dele: cada linha diz o que aconteceu, QUEM fez (o proprio aluno ou qual
   * administrador) e de que horario para qual.
   */
  async historico(id: number): Promise<EventoDoHistorico[]> {
    const existe = await this.prisma.agendamento.count({ where: { id } });

    if (existe === 0) {
      throw new NotFoundException(`Agendamento ${id} nao encontrado`);
    }

    const linhas = await this.prisma.historicoAgendamento.findMany({
      where: { agendamentoId: id },
      orderBy: { createdAt: 'desc' },
    });

    return linhas.map((l) => ({
      id: l.id,
      evento: l.evento,
      autorTipo: l.autorTipo,
      autor: l.autor,
      de: l.de,
      para: l.para,
      quando: l.createdAt,
    }));
  }

  /**
   * Valida o destino contra o vinculo do aluno ANTES da transacao, para a
   * mensagem de erro poder explicar o problema em vez de so recusar.
   */
  private async resolverDestino(
    destino: { salaFaixaId?: number; faixaId?: number },
    aluno: { modalidadeId: number; poloId: number },
  ): Promise<{ salaFaixaId?: number; faixaId: number }> {
    if (destino.salaFaixaId) {
      const oferta = await this.prisma.salaFaixa.findUnique({
        where: { id: destino.salaFaixaId },
        include: {
          modalidade: { select: { nome: true } },
          faixa: { include: { polo: { select: { nome: true } } } },
        },
      });

      if (!oferta) {
        throw new NotFoundException(
          `Oferta ${destino.salaFaixaId} nao encontrada`,
        );
      }

      this.exigirCompativel(
        { poloId: oferta.faixa.poloId, poloNome: oferta.faixa.polo.nome },
        { modalidadeId: oferta.modalidadeId, nome: oferta.modalidade.nome },
        aluno,
      );

      return { salaFaixaId: oferta.id, faixaId: oferta.faixaId };
    }

    const faixa = await this.prisma.faixa.findUnique({
      where: { id: destino.faixaId },
      include: { polo: { select: { nome: true } } },
    });

    if (!faixa) {
      throw new NotFoundException(`Faixa ${destino.faixaId} nao encontrada`);
    }

    this.exigirCompativel(
      { poloId: faixa.poloId, poloNome: faixa.polo.nome },
      undefined,
      aluno,
    );

    return { faixaId: faixa.id };
  }

  private exigirCompativel(
    local: { poloId: number; poloNome: string },
    modalidade: { modalidadeId: number; nome: string } | undefined,
    aluno: { modalidadeId: number; poloId: number },
  ): void {
    if (local.poloId !== aluno.poloId) {
      throw new BadRequestException(
        `O destino e do polo "${local.poloNome}", que nao e o polo do aluno. ` +
          'Remanejar entre polos mandaria o aluno para o campus errado.',
      );
    }

    if (modalidade && modalidade.modalidadeId !== aluno.modalidadeId) {
      throw new BadRequestException(
        `Esta sala esta ofertada como "${modalidade.nome}", que nao e a modalidade ` +
          'do aluno. A duracao da prova seria outra.',
      );
    }
  }

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
