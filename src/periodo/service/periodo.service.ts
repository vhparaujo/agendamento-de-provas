import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { StatusAgendamento } from '../../generated/prisma/client';

export interface SituacaoPeriodo {
  aberto: boolean;
  /** Id do periodo letivo no Brightspace. Vai gravado em cada agendamento. */
  periodoLetivoId?: string;
  descricao?: string | null;
  dataAbertura?: Date | null;
  dataFechamento?: Date;
  /** Por que esta fechado. Ausente quando aberto. E o texto mostrado ao aluno. */
  motivo?: string;
}

export interface PeriodoVigente {
  periodoLetivoId: string;
  dataFechamento: Date;
}

/** Um periodo como o admin o ve, com o que ja foi agendado nele. */
export interface PeriodoAdmin {
  id: number;
  periodoLetivoId: string;
  descricao: string | null;
  aberto: boolean;
  dataAbertura: Date | null;
  dataFechamento: Date;
  vigente: boolean;
  /** Situacao efetiva agora — `aberto` sozinho nao conta a data. */
  aceitandoAgendamento: boolean;
  totalAgendamentos: number;
  criadoEm: Date;
}

/**
 * ============================================================================
 * A JANELA EM QUE SE PODE AGENDAR
 * ============================================================================
 * Nao confundir com as datas das provas: sao duas linhas do tempo independentes.
 * As faixas dizem QUANDO a prova acontece; o periodo diz ATE QUANDO da para
 * escolher uma delas.
 *
 * O periodo fecha SO por data/hora — nunca por esgotamento de vagas. Vaga
 * acabando e problema de capacidade (o admin abre mais salas); nao e motivo para
 * encerrar o agendamento de quem ainda nao escolheu.
 *
 * O CRUD administrativo do periodo e da etapa 7; aqui existe apenas a LEITURA,
 * porque sem ela o portal do aluno nao teria como saber se pode agendar.
 */
@Injectable()
export class PeriodoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * O periodo vigente e o cadastrado mais recentemente. Nao ha "o periodo ativo"
   * marcado no banco de proposito: cada semestre vira uma linha nova, e o
   * historico dos anteriores continua de pe para consulta e exportacao.
   */
  async situacaoAtual(agora: Date = new Date()): Promise<SituacaoPeriodo> {
    const periodo = await this.prisma.periodoAgendamento.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    // SEM PERIODO CADASTRADO = FECHADO. Mesma escolha do filtro de turmas: na
    // duvida, o sistema nao libera. Liberar por padrao significaria que um banco
    // recem-migrado aceita agendamento para um semestre que ninguem configurou.
    if (!periodo) {
      return {
        aberto: false,
        motivo:
          'O periodo de agendamento ainda nao foi configurado. Procure a secretaria academica.',
      };
    }

    const base: SituacaoPeriodo = {
      aberto: false,
      periodoLetivoId: periodo.periodoLetivoId,
      descricao: periodo.descricao,
      dataAbertura: periodo.dataAbertura,
      dataFechamento: periodo.dataFechamento,
    };

    if (!periodo.aberto) {
      return { ...base, motivo: 'O periodo de agendamento esta fechado.' };
    }

    if (periodo.dataAbertura && agora < periodo.dataAbertura) {
      return {
        ...base,
        motivo: `O agendamento abre em ${formatar(periodo.dataAbertura)}.`,
      };
    }

    if (agora > periodo.dataFechamento) {
      return {
        ...base,
        motivo: `O prazo de agendamento encerrou em ${formatar(periodo.dataFechamento)}.`,
      };
    }

    return { ...base, aberto: true };
  }

  /**
   * Devolve o periodo vigente ou recusa a operacao com o motivo exato — o aluno
   * precisa saber se ainda nao abriu, se ja fechou, ou se ninguem configurou.
   */
  async exigirAberto(agora: Date = new Date()): Promise<PeriodoVigente> {
    const situacao = await this.situacaoAtual(agora);

    if (!situacao.aberto) {
      throw new ForbiddenException(situacao.motivo);
    }

    return {
      periodoLetivoId: situacao.periodoLetivoId!,
      dataFechamento: situacao.dataFechamento!,
    };
  }

  // ==========================================================================
  // LADO ADMINISTRATIVO
  // ==========================================================================

  async listar(): Promise<PeriodoAdmin[]> {
    const periodos = await this.prisma.periodoAgendamento.findMany({
      orderBy: { createdAt: 'desc' },
    });

    if (periodos.length === 0) return [];

    // Uma consulta agrupada em vez de uma por periodo.
    const contagens = await this.prisma.agendamento.groupBy({
      by: ['periodoLetivoId'],
      where: { status: StatusAgendamento.CONFIRMADO },
      _count: { _all: true },
    });

    const porPeriodoLetivo = new Map(
      contagens.map((c) => [c.periodoLetivoId, c._count._all]),
    );

    const agora = new Date();

    // O vigente e o mais recente — o mesmo criterio que `situacaoAtual` usa.
    return periodos.map((p, indice) => ({
      id: p.id,
      periodoLetivoId: p.periodoLetivoId,
      descricao: p.descricao,
      aberto: p.aberto,
      dataAbertura: p.dataAbertura,
      dataFechamento: p.dataFechamento,
      vigente: indice === 0,
      aceitandoAgendamento:
        indice === 0 &&
        p.aberto &&
        (!p.dataAbertura || agora >= p.dataAbertura) &&
        agora <= p.dataFechamento,
      totalAgendamentos: porPeriodoLetivo.get(p.periodoLetivoId) ?? 0,
      criadoEm: p.createdAt,
    }));
  }

  async criar(dados: {
    periodoLetivoId: string;
    descricao?: string;
    aberto?: boolean;
    dataAbertura?: string;
    dataFechamento: string;
  }): Promise<PeriodoAdmin> {
    const abertura = dados.dataAbertura
      ? exigirData(dados.dataAbertura, 'dataAbertura')
      : null;
    const fechamento = exigirData(dados.dataFechamento, 'dataFechamento');

    validarJanela(abertura, fechamento);

    // Criar um periodo novo TROCA o vigente, porque vigente = mais recente.
    // Sem este aviso, o admin poderia cadastrar o semestre seguinte com semanas
    // de antecedencia e, sem perceber, fechar o agendamento que esta em curso.
    const atual = await this.prisma.periodoAgendamento.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (atual && atual.periodoLetivoId === dados.periodoLetivoId) {
      throw new ConflictException(
        `Ja existe um periodo vigente para o periodo letivo ${dados.periodoLetivoId} ` +
          `(id ${atual.id}). Ajuste aquele em vez de criar outro.`,
      );
    }

    const criado = await this.prisma.periodoAgendamento.create({
      data: {
        periodoLetivoId: dados.periodoLetivoId.trim(),
        descricao: dados.descricao?.trim() || null,
        aberto: dados.aberto ?? false,
        dataAbertura: abertura,
        dataFechamento: fechamento,
      },
    });

    return this.buscar(criado.id);
  }

  async atualizar(
    id: number,
    dados: {
      descricao?: string | null;
      aberto?: boolean;
      dataAbertura?: string | null;
      dataFechamento?: string;
    },
  ): Promise<PeriodoAdmin> {
    const periodo = await this.prisma.periodoAgendamento.findUnique({
      where: { id },
    });

    if (!periodo) throw new NotFoundException(`Periodo ${id} nao encontrado`);

    const abertura =
      dados.dataAbertura === undefined
        ? periodo.dataAbertura
        : dados.dataAbertura === null
          ? null
          : exigirData(dados.dataAbertura, 'dataAbertura');

    const fechamento = dados.dataFechamento
      ? exigirData(dados.dataFechamento, 'dataFechamento')
      : periodo.dataFechamento;

    validarJanela(abertura, fechamento);

    // Antecipar o fechamento para tras de agora e legitimo (encerrar antes do
    // previsto), mas quem ja agendou nao perde a vaga: o periodo so barra quem
    // ainda nao escolheu. Por isso nao ha checagem de agendamentos aqui.
    await this.prisma.periodoAgendamento.update({
      where: { id },
      data: {
        descricao:
          dados.descricao === undefined
            ? undefined
            : (dados.descricao?.trim() ?? null) || null,
        aberto: dados.aberto,
        dataAbertura: abertura,
        dataFechamento: fechamento,
      },
    });

    return this.buscar(id);
  }

  async buscar(id: number): Promise<PeriodoAdmin> {
    const todos = await this.listar();
    const periodo = todos.find((p) => p.id === id);

    if (!periodo) throw new NotFoundException(`Periodo ${id} nao encontrado`);

    return periodo;
  }
}

function exigirData(valor: string, campo: string): Date {
  const data = new Date(valor);

  if (Number.isNaN(data.getTime())) {
    throw new BadRequestException(
      `${campo} invalida: "${valor}". Use ISO 8601 (ex: 2026-08-18T23:59:00-03:00).`,
    );
  }

  return data;
}

function validarJanela(abertura: Date | null, fechamento: Date): void {
  if (abertura && abertura >= fechamento) {
    throw new BadRequestException(
      'dataAbertura precisa ser antes de dataFechamento.',
    );
  }
}

function formatar(data: Date): string {
  return data.toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  });
}
