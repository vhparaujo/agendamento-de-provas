import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

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
}

function formatar(data: Date): string {
  return data.toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  });
}
