import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { StatusAgendamento } from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';

export interface SituacaoPeriodo {
  aberto: boolean;
  /**
   * O prazo ACABOU — nao e o mesmo que `!aberto`.
   *
   * `aberto: false` cobre tres estados diferentes: ninguem configurou o
   * semestre, ele existe mas ainda nao abriu, e ele ja encerrou. So o terceiro
   * libera a declaracao de agendamento, e por isso ele precisa de um campo
   * proprio — a tela nao tem como distinguir os tres lendo o `motivo`, que e
   * texto para o aluno ler, nao para o codigo comparar.
   */
  encerrado: boolean;
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

/** Quem passou a ser o vigente depois de a linha sair do banco. */
export interface VigenteDepoisDaRemocao {
  id: number;
  periodoLetivoId: string;
  descricao: string | null;
}

export interface RemocaoPeriodo {
  mensagem: string;
  /** `null` quando nao sobrou periodo nenhum — o portal responde "fechado". */
  vigenteAgora: VigenteDepoisDaRemocao | null;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

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
        // Sem semestre configurado nao ha prazo NENHUM, entao nao ha prazo
        // encerrado: quem nunca abriu tambem nunca fechou. Marcar `encerrado`
        // aqui liberaria a declaracao num banco recem-migrado.
        encerrado: false,
        motivo:
          'O periodo de agendamento ainda nao foi configurado. Procure a secretaria academica.',
      };
    }

    const base: SituacaoPeriodo = {
      aberto: false,
      encerrado: false,
      periodoLetivoId: periodo.periodoLetivoId,
      descricao: periodo.descricao,
      dataAbertura: periodo.dataAbertura,
      dataFechamento: periodo.dataFechamento,
    };

    // Fechado a mao pelo admin ANTES da data prevista. Conta como encerrado: e
    // o encerramento antecipado, e a partir dali ninguem mais escolhe horario —
    // que e a condicao que a declaracao precisa.
    if (!periodo.aberto) {
      return {
        ...base,
        encerrado: true,
        motivo: 'O periodo de agendamento esta fechado.',
      };
    }

    // O unico `!aberto` que NAO e encerrado: o semestre existe, o prazo ainda
    // vai comecar. Declarar um agendamento que ninguem pode ter feito seria
    // declarar coisa nenhuma.
    if (periodo.dataAbertura && agora < periodo.dataAbertura) {
      return {
        ...base,
        motivo: `O agendamento abre em ${formatar(periodo.dataAbertura)}.`,
      };
    }

    if (agora > periodo.dataFechamento) {
      return {
        ...base,
        encerrado: true,
        motivo: `O prazo de agendamento encerrou em ${formatar(periodo.dataFechamento)}.`,
      };
    }

    return { ...base, aberto: true };
  }

  /**
   * O periodo letivo vigente, ABERTO OU NAO.
   *
   * A distincao importa: o portal do aluno usa isto para mostrar so a prova do
   * semestre atual, e ele precisa continuar enxergando onde e quando e a prova
   * dele mesmo depois de o prazo fechar. Fechar o agendamento tranca a ESCOLHA,
   * nao a consulta.
   *
   * `undefined` quando nao ha periodo cadastrado — nesse caso nao existe
   * "semestre atual", e o portal nao tem o que mostrar.
   */
  async periodoLetivoVigente(): Promise<string | undefined> {
    const periodo = await this.prisma.periodoAgendamento.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { periodoLetivoId: true },
    });

    return periodo?.periodoLetivoId;
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

  /**
   * O OPOSTO de `exigirAberto`: so passa depois que o prazo acabou.
   *
   * Existe para a DECLARACAO DE AGENDAMENTO. Enquanto o prazo corre, o aluno
   * ainda pode trocar de horario e cancelar (regra 7) — um papel assinado
   * dizendo "dia 12 as 15:00" pode estar desatualizado no minuto seguinte, e
   * quem o recebeu nao tem como saber. Depois do fechamento a escolha esta
   * travada para o aluno, e o que o documento afirma para de se mover.
   *
   * Fica aqui, e nao no service da declaracao, pela mesma razao que
   * `exigirAberto`: as duas portas do prazo tem que ler o MESMO estado. Duas
   * leituras separadas divergem na primeira vez que alguem mexer em uma delas.
   */
  async exigirEncerrado(agora: Date = new Date()): Promise<PeriodoVigente> {
    const situacao = await this.situacaoAtual(agora);

    if (!situacao.encerrado) {
      throw new ForbiddenException(
        situacao.aberto
          ? 'A declaracao fica disponivel quando o prazo de agendamento ' +
              `encerrar, em ${formatar(situacao.dataFechamento!)}. Ate la voce ` +
              'ainda pode trocar de horario, e o documento diria uma data que ' +
              'pode mudar.'
          : (situacao.motivo ??
              'O periodo de agendamento ainda nao encerrou. Procure a secretaria academica.'),
      );
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

  /**
   * Apaga um periodo que nunca foi usado — o mesmo criterio de `DELETE /polos`.
   *
   * POR QUE ELE EXISTE: vigente = o cadastrado mais recentemente, e nao ha como
   * marcar outro no lugar. Cadastrar o semestre seguinte com antecedencia, ou
   * criar uma linha errada, ROUBA o vigente do periodo em curso — e a unica
   * saida era mexer no banco a mao. Corrigir cadastro errado e o mesmo caso de
   * uso do `DELETE /polos/:id`.
   *
   * POR QUE E TAO TRAVADO: apagar a linha nao apaga agendamento nenhum
   * (`Agendamento.periodoLetivoId` e string, sem FK). As provas continuariam de
   * pe, orfas de janela: o portal deixaria de reconhecer aquele semestre, e o
   * aluno perderia de vista a prova que ja marcou — o oposto da regra 7, em que
   * fechar o prazo tranca a escolha e nunca a consulta.
   */
  async remover(id: number, porAdmin: string): Promise<RemocaoPeriodo> {
    return this.prisma.$transaction(async (tx) => {
      const periodo = await tx.periodoAgendamento.findUnique({ where: { id } });

      if (!periodo) throw new NotFoundException(`Periodo ${id} nao encontrado`);

      /**
       * Aqui a contagem inclui CANCELADO, ao contrario do `totalAgendamentos`
       * da listagem (so CONFIRMADO). Sao perguntas diferentes: a tela mostra
       * quantas vagas estao tomadas, e cancelado devolveu a vaga; esta responde
       * "alguem ja usou este semestre?", e cancelamento e justamente o registro
       * que precisa continuar explicavel — quem aparecer no dia sem estar na
       * lista se explica por ele.
       *
       * A conta e por `periodoLetivoId`, entao duas linhas do mesmo semestre
       * letivo travam uma a outra. E conservador de proposito: com o mesmo id
       * de periodo letivo nos dois, nao ha como dizer a qual linha a prova
       * pertence.
       */
      const agendamentos = await tx.agendamento.count({
        where: { periodoLetivoId: periodo.periodoLetivoId },
      });

      if (agendamentos > 0) {
        throw new ConflictException(
          `O periodo letivo ${periodo.periodoLetivoId} ja tem ${agendamentos} ` +
            'agendamento(s) (incluindo cancelados) e nao pode ser apagado — as ' +
            'provas ficariam sem a janela que as identifica, e sumiriam do portal ' +
            'do aluno. Para encerrar o prazo, use PATCH com dataFechamento no ' +
            'passado ou aberto=false; a linha continua no historico.',
        );
      }

      await tx.periodoAgendamento.delete({ where: { id } });

      // Lido DEPOIS do delete, na mesma transacao: quem chamou precisa saber a
      // quem o portal do aluno passou a responder. Apagar o mais recente
      // devolve o portal ao semestre anterior — provavelmente com o prazo ja
      // vencido —, e essa consequencia nao aparece em lugar nenhum se a
      // resposta for so "removido".
      const vigente = await tx.periodoAgendamento.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { id: true, periodoLetivoId: true, descricao: true },
      });

      this.auditoria.registrar('PERIODO_REMOVIDO', {
        ator: porAdmin,
        detalhe:
          `periodo ${id} (letivo ${periodo.periodoLetivoId}` +
          `${periodo.descricao ? `, "${periodo.descricao}"` : ''}) removido; ` +
          `vigente agora: ${vigente ? `${vigente.id} (letivo ${vigente.periodoLetivoId})` : 'nenhum'}`,
      });

      return {
        mensagem: `Periodo ${id} (${periodo.descricao || periodo.periodoLetivoId}) removido`,
        vigenteAgora: vigente,
      };
    });
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
