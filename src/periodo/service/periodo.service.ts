import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';

/**
 * A FAIXA DE NOTA QUE HABILITA A RODADA — a regra da substitutiva.
 *
 * `null` = sem filtro, que e o caso da N2 e o de toda janela cadastrada antes
 * desta regra existir: a prova cobre as disciplinas do semestre sem olhar nota
 * nenhuma, e nenhuma chamada de nota sai para a Valence.
 *
 * Preenchido = so entra na prova a disciplina em que a nota final do aluno esta
 * em `[minima, maxima)` — `>=` na minima e `<` na maxima, assimetrico de
 * proposito: quem tirou o piso ainda tem chance, quem alcancou o teto ja passou.
 *
 * ⚠️ **E um objeto, e nao dois campos soltos**, pela mesma razao que
 * `periodoLetivoVigente()` devolve o par: quem desestrutura tem de dizer se o
 * filtro importa para ele. Dois numeros nulaveis lado a lado seriam esquecidos
 * em silencio, e o sintoma seria a substitutiva liberada para o curso inteiro.
 */
export interface FiltroDeNota {
  minima: number;
  maxima: number;
}

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
  /**
   * Id do periodo letivo no Brightspace. Vai gravado em cada agendamento.
   *
   * ⚠️ E o do ALUNO quando `situacaoAtual` recebeu uma modalidade, e o
   * PRINCIPAL da janela quando nao recebeu. A mesma janela cobre mais de um
   * periodo letivo ao mesmo tempo (modulos e semestres correm em paralelo), e
   * quem precisa dos dois usa `periodoLetivoIds`.
   */
  periodoLetivoId?: string;
  /**
   * TODOS os periodos letivos que esta janela cobre — o principal mais os do
   * mapa por modalidade, sem repetir.
   *
   * Existe porque as travas por PESSOA (uma prova por matricula em cada faixa)
   * nao podem recortar pelo periodo de UM vinculo: um mesmo RA pode ter um
   * vinculo EaD (modulo 2026/4) e um Presencial (semestre 2026/2), e olhar so
   * um dos dois deixaria a pessoa marcar duas provas no mesmo horario.
   */
  periodoLetivoIds?: string[];
  /**
   * QUAL prova do semestre e esta janela ("N2", "SUB"...).
   *
   * Anda sempre junto do `periodoLetivoId`: o par e que identifica o periodo, e
   * a tela do aluno precisa dele para dizer de qual prova esta falando — dois
   * periodos do mesmo semestre tem o mesmo `periodoLetivoId`.
   */
  rodada?: string;
  /**
   * A faixa de nota desta janela, ou `null` quando ela nao filtra por nota.
   *
   * Vai para a TELA do aluno: sem ela, quem tem tres disciplinas e ve uma so na
   * substitutiva nao tem como saber que a lista foi filtrada, e a hipotese
   * natural e que o sistema errou.
   */
  filtroDeNota?: FiltroDeNota | null;
  descricao?: string | null;
  dataAbertura?: Date | null;
  dataFechamento?: Date;
  /** Por que esta fechado. Ausente quando aberto. E o texto mostrado ao aluno. */
  motivo?: string;
}

export interface PeriodoVigente {
  /**
   * O periodo letivo DESTE ALUNO — resolvido pela modalidade do vinculo. E o
   * que vai gravado na reserva como fotografia.
   */
  periodoLetivoId: string;
  /**
   * A janela inteira. Anda junto do `periodoLetivoId` de proposito: quem agenda
   * precisa dos DOIS na mesma operacao — o primeiro para gravar a reserva, o
   * segundo para as travas por pessoa (ver `exigirUmaProvaPorFaixa`). Duas
   * leituras separadas poderiam divergir no meio da confirmacao.
   */
  periodoLetivoIds: string[];
  /** A rodada da janela vigente. Vai gravada como fotografia em cada reserva. */
  rodada: string;
  /** Ver `FiltroDeNota`. `null` quando a janela nao filtra por nota. */
  filtroDeNota: FiltroDeNota | null;
  dataFechamento: Date;
}

/**
 * Uma linha do mapa `modalidade -> periodo letivo` de uma janela.
 *
 * O `modalidadeNome` vem junto porque este objeto vai para a TELA do admin, e
 * "PRESENCIAL" e o codigo, nao o rotulo.
 */
export interface LetivoDaModalidade {
  modalidadeId: number;
  modalidadeCodigo: string;
  modalidadeNome: string;
  periodoLetivoId: string;
  /**
   * `true` quando esta modalidade NAO tem linha propria no mapa e caiu no
   * periodo letivo principal da janela. A tela destaca; o log avisa. Nao e erro
   * — e o que segura o sistema de pe quando uma modalidade nova e semeada
   * depois de a janela ja estar cadastrada.
   */
  herdadoDoPrincipal: boolean;
}

/** Um periodo como o admin o ve, com o que ja foi agendado nele. */
export interface PeriodoAdmin {
  id: number;
  /** O periodo letivo PRINCIPAL — ver a coluna homonima no schema. */
  periodoLetivoId: string;
  /**
   * O mapa `modalidade -> periodo letivo` desta janela, uma linha por
   * modalidade cadastrada. Vai INTEIRO para a tela: e o unico jeito de um id
   * errado deixar de ser invisivel — o id que nao bate nao da erro, so devolve
   * lista vazia de disciplina para a modalidade inteira.
   */
  letivosPorModalidade: LetivoDaModalidade[];
  rodada: string;
  /** Ver `FiltroDeNota`. `null` quando a janela nao filtra por nota. */
  filtroDeNota: FiltroDeNota | null;
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
  rodada: string;
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
  private readonly logger = new Logger(PeriodoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * O periodo vigente e o cadastrado mais recentemente. Nao ha "o periodo ativo"
   * marcado no banco de proposito: cada semestre vira uma linha nova, e o
   * historico dos anteriores continua de pe para consulta e exportacao.
   */
  async situacaoAtual(
    agora: Date = new Date(),
    modalidadeCodigo?: string,
  ): Promise<SituacaoPeriodo> {
    const periodo = await this.prisma.periodoAgendamento.findFirst({
      orderBy: { createdAt: 'desc' },
      include: MAPA_DA_JANELA,
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
      // Com modalidade, o periodo letivo DELA; sem modalidade, o principal —
      // e o caso de `GET /portal/periodo`, que so informa o prazo.
      periodoLetivoId: modalidadeCodigo
        ? this.resolverPorModalidade(periodo, modalidadeCodigo)
        : periodo.periodoLetivoId,
      periodoLetivoIds: idsDaJanela(periodo),
      rodada: periodo.rodada,
      filtroDeNota: lerFiltroDeNota(periodo),
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
        motivo: 'O período de agendamento está fechado.',
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
   * ==========================================================================
   * O PERIODO LETIVO DE UM ALUNO — resolvido pela MODALIDADE do vinculo
   * ==========================================================================
   * Vigente, ABERTO OU NAO. A distincao importa: o portal usa isto para mostrar
   * so a prova atual, e o aluno precisa continuar enxergando onde e quando e a
   * prova dele depois de o prazo fechar. Fechar tranca a ESCOLHA, nao a consulta.
   *
   * ⚠️ **A modalidade e obrigatoria, e e a metade nova da pergunta.** A UCB
   * corre duas grades em paralelo: EaD/Semi/Modular andam por MODULO (2026/4) e
   * Presencial anda por SEMESTRE (2026/2) — dois org units vivos ao mesmo tempo
   * no Brightspace. Sem a modalidade nao ha resposta certa, so um chute que
   * deixa metade da universidade sem disciplina agendavel. E deixa em silencio:
   * o org unit errado devolve 200 com lista vazia, nunca um erro.
   *
   * Devolve tambem a `rodada`, pela razao de sempre: os dois periodos do mesmo
   * semestre (a N2 e a SUB) compartilham o `periodoLetivoId`, e quem filtrar so
   * por ele mistura as duas provas. Voltar um objeto obriga cada chamador a
   * dizer, na desestruturacao, o que importa para ele.
   *
   * `undefined` quando nao ha periodo cadastrado.
   *
   * Para quem CONTA, LISTA, EXPORTA ou trava por PESSOA, o metodo e o outro:
   * `janelaVigente()`. Ver a nota la.
   */
  async periodoLetivoDaModalidade(modalidadeCodigo: string): Promise<
    | {
        periodoLetivoId: string;
        rodada: string;
        filtroDeNota: FiltroDeNota | null;
      }
    | undefined
  > {
    const periodo = await this.prisma.periodoAgendamento.findFirst({
      orderBy: { createdAt: 'desc' },
      include: MAPA_DA_JANELA,
    });

    if (!periodo) return undefined;

    return {
      periodoLetivoId: this.resolverPorModalidade(periodo, modalidadeCodigo),
      rodada: periodo.rodada,
      filtroDeNota: lerFiltroDeNota(periodo),
    };
  }

  /**
   * ==========================================================================
   * A JANELA INTEIRA — todos os periodos letivos que ela cobre
   * ==========================================================================
   * O complemento de `periodoLetivoDaModalidade`. Sao dois metodos com nomes
   * diferentes, e nao um com parametro opcional, de proposito: a escolha entre
   * "o periodo DESTE aluno" e "todos os periodos DESTA janela" precisa ser
   * explicita em cada chamada. Um parametro opcional seria esquecido, e o
   * sintoma — aluno com duas provas no mesmo horario, presencial sem disciplina
   * — aparece longe da causa.
   *
   * A regra de bolso:
   *
   * | Quem pergunta | Usa |
   * |---|---|
   * | age sobre UM aluno (disciplinas, agendar, trocar) | `periodoLetivoDaModalidade(modalidade)` |
   * | conta, lista, exporta, relata | `janelaVigente()` + `{ in: periodoLetivoIds }` |
   * | trava por PESSOA (uma prova por matricula em cada faixa) | `janelaVigente()` — **obrigatoriamente** |
   *
   * A ultima linha e a que nao pode errar: um mesmo RA pode ter um vinculo EaD
   * (modulo) e um Presencial (semestre), com `periodoLetivoId` DIFERENTES na
   * mesma janela. Recortar pelo periodo de um vinculo so faria a trava nao
   * enxergar a reserva do outro — e a pessoa marcaria duas provas no mesmo
   * horario, em duas salas.
   */
  async janelaVigente(): Promise<
    | {
        /** Todos os org units cobertos, sem repetir. Para `{ in: ... }`. */
        periodoLetivoIds: string[];
        /** O principal — o rotulo da janela, nao o de nenhum aluno especifico. */
        principal: string;
        rodada: string;
        filtroDeNota: FiltroDeNota | null;
      }
    | undefined
  > {
    const periodo = await this.prisma.periodoAgendamento.findFirst({
      orderBy: { createdAt: 'desc' },
      include: MAPA_DA_JANELA,
    });

    if (!periodo) return undefined;

    return {
      periodoLetivoIds: idsDaJanela(periodo),
      principal: periodo.periodoLetivoId,
      rodada: periodo.rodada,
      filtroDeNota: lerFiltroDeNota(periodo),
    };
  }

  /**
   * O periodo letivo de uma modalidade dentro de UMA janela ja carregada.
   *
   * O fallback para o principal e deliberado e ruidoso: uma modalidade semeada
   * depois de a janela ser cadastrada nao pode derrubar o agendamento das
   * outras, mas tambem nao pode passar despercebida — o aluno dela vai buscar
   * disciplina na arvore errada e receber lista vazia. Por isso o `warn` diz
   * exatamente o que fazer.
   */
  private resolverPorModalidade(
    periodo: JanelaComMapa,
    modalidadeCodigo: string,
  ): string {
    const codigo = modalidadeCodigo.trim().toUpperCase();

    const linha = periodo.letivosPorModalidade.find(
      (l) => l.modalidade.codigo.toUpperCase() === codigo,
    );

    if (linha) return linha.periodoLetivoId;

    this.logger.warn(
      `A modalidade ${codigo} nao tem periodo letivo proprio na janela ` +
        `${periodo.id} e caiu no principal (${periodo.periodoLetivoId}). Se ela ` +
        'nao segue a mesma grade, os alunos dela vao receber "nenhuma disciplina ' +
        'sua aparece no periodo letivo vigente". Cadastre o mapa em /periodos.',
    );

    return periodo.periodoLetivoId;
  }

  /**
   * Devolve o periodo vigente ou recusa a operacao com o motivo exato — o aluno
   * precisa saber se ainda nao abriu, se ja fechou, ou se ninguem configurou.
   *
   * Recebe a modalidade do VINCULO e devolve os dois recortes de uma leitura so:
   * `periodoLetivoId` (o do aluno, que vai gravado na reserva) e
   * `periodoLetivoIds` (a janela inteira, que as travas por pessoa usam). Ler os
   * dois separadamente abriria a janela para eles divergirem no meio da
   * confirmacao — o mesmo motivo pelo qual a `rodada` e o `filtroDeNota` saem
   * daqui juntos.
   */
  async exigirAberto(
    modalidadeCodigo: string,
    agora: Date = new Date(),
  ): Promise<PeriodoVigente> {
    const situacao = await this.situacaoAtual(agora, modalidadeCodigo);

    if (!situacao.aberto) {
      throw new ForbiddenException(situacao.motivo);
    }

    return {
      periodoLetivoId: situacao.periodoLetivoId!,
      periodoLetivoIds: situacao.periodoLetivoIds!,
      rodada: situacao.rodada!,
      filtroDeNota: situacao.filtroDeNota ?? null,
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
      // Sem modalidade: aqui e o PRINCIPAL. A declaracao filtra pela janela
      // inteira (`periodoLetivoIds`), porque o aluno pode ter dois vinculos em
      // grades diferentes e as duas provas sao dele.
      periodoLetivoId: situacao.periodoLetivoId!,
      periodoLetivoIds: situacao.periodoLetivoIds!,
      rodada: situacao.rodada!,
      filtroDeNota: situacao.filtroDeNota ?? null,
      dataFechamento: situacao.dataFechamento!,
    };
  }

  // ==========================================================================
  // LADO ADMINISTRATIVO
  // ==========================================================================

  async listar(): Promise<PeriodoAdmin[]> {
    const periodos = await this.prisma.periodoAgendamento.findMany({
      orderBy: { createdAt: 'desc' },
      include: MAPA_DA_JANELA,
    });

    if (periodos.length === 0) return [];

    // O mapa vai para a tela com TODAS as modalidades, inclusive as que nao tem
    // linha propria — sao justamente as que o admin precisa ver para saber que
    // caem no principal.
    const modalidades = await this.prisma.modalidade.findMany({
      orderBy: { id: 'asc' },
    });

    // Uma consulta agrupada em vez de uma por periodo. O agrupamento e pelo PAR
    // `periodoLetivoId + rodada`: agrupar so pelo semestre faria a linha da SUB
    // exibir as provas da N2 como se fossem dela, e o admin leria "412
    // agendamentos" numa janela que ninguem usou ainda.
    const contagens = await this.prisma.agendamento.groupBy({
      by: ['periodoLetivoId', 'rodada'],
      where: { status: StatusAgendamento.CONFIRMADO },
      _count: { _all: true },
    });

    const porPeriodoLetivo = new Map(
      contagens.map((c) => [
        chaveDaRodada(c.periodoLetivoId, c.rodada),
        c._count._all,
      ]),
    );

    /**
     * O total de uma JANELA e a soma dos periodos letivos que ela cobre.
     *
     * Sem a soma, a tela mostraria so as provas dos modulares e o admin leria
     * "1.200 agendamentos" numa janela com 1.900 — os 700 presenciais estariam
     * gravados sob o outro org unit, invisiveis. A `rodada` continua separando
     * a N2 da SUB dentro da mesma janela.
     */
    const totalDaJanela = (periodo: JanelaComMapa): number =>
      idsDaJanela(periodo).reduce(
        (soma, letivo) =>
          soma +
          (porPeriodoLetivo.get(chaveDaRodada(letivo, periodo.rodada)) ?? 0),
        0,
      );

    const agora = new Date();

    // O vigente e o mais recente — o mesmo criterio que `situacaoAtual` usa.
    return periodos.map((p, indice) => ({
      id: p.id,
      periodoLetivoId: p.periodoLetivoId,
      letivosPorModalidade: montarMapa(p, modalidades),
      rodada: p.rodada,
      filtroDeNota: lerFiltroDeNota(p),
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
      totalAgendamentos: totalDaJanela(p),
      criadoEm: p.createdAt,
    }));
  }

  async criar(dados: {
    periodoLetivoId: string;
    /**
     * O mapa `modalidade -> periodo letivo` desta janela.
     *
     * OMITIDO = todas as modalidades ficam no `periodoLetivoId` principal. E o
     * comportamento de antes do mapa, e continua sendo o caso legitimo de quem
     * tem uma grade so.
     *
     * INFORMADO = tem de cobrir TODAS as modalidades cadastradas. Cobrir
     * parcialmente seria pior que nao cobrir: a modalidade esquecida cairia no
     * principal em silencio, que e exatamente o erro que o mapa existe para
     * impedir. Recusar aqui custa uma correcao de formulario; deixar passar
     * custa uma modalidade inteira sem disciplina no dia da abertura.
     */
    letivosPorModalidade?: {
      modalidadeCodigo: string;
      periodoLetivoId: string;
    }[];
    rodada?: string;
    notaMinima?: number | null;
    notaMaxima?: number | null;
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

    const rodada = dados.rodada?.trim() || RODADA_PADRAO;
    const filtro = exigirFiltroDeNotaValido(dados.notaMinima, dados.notaMaxima);

    const principal = dados.periodoLetivoId.trim();

    // O mapa e validado ANTES da checagem de duplicata: um payload malformado e
    // problema dele mesmo, e um 409 dizendo "ja existe janela para este periodo"
    // manda o admin corrigir a coisa errada — ele reenviaria com outra rodada e
    // continuaria com o mapa incompleto.
    const mapa = await this.exigirMapaCompleto(
      principal,
      dados.letivosPorModalidade,
    );

    // Criar um periodo novo TROCA o vigente, porque vigente = mais recente.
    // Sem este aviso, o admin poderia cadastrar o semestre seguinte com semanas
    // de antecedencia e, sem perceber, fechar o agendamento que esta em curso.
    const atual = await this.prisma.periodoAgendamento.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    // A duplicata e do PAR `periodoLetivoId + rodada`, e nao do semestre
    // sozinho: `2026/3 + N2` e `2026/3 + SUB` sao duas janelas legitimas do
    // mesmo periodo letivo, com faixas e prazos proprios. Comparar so o
    // `periodoLetivoId` — como era antes da rodada — recusaria justamente o
    // cadastro da substitutiva, que e o caso que esta coluna existe para servir.
    if (
      atual &&
      atual.periodoLetivoId === dados.periodoLetivoId &&
      atual.rodada === rodada
    ) {
      throw new ConflictException(
        `Ja existe um periodo vigente para o periodo letivo ${dados.periodoLetivoId} ` +
          `na rodada ${rodada} (id ${atual.id}). Ajuste aquele em vez de criar ` +
          'outro — ou informe outra `rodada` se esta e a proxima prova do mesmo semestre.',
      );
    }

    // A janela e o mapa nascem juntos: uma janela sem mapa e uma janela que
    // manda todo mundo para o mesmo org unit sem ninguem ter decidido isso.
    const criado = await this.prisma.periodoAgendamento.create({
      data: {
        periodoLetivoId: principal,
        rodada,
        notaMinima: filtro?.minima ?? null,
        notaMaxima: filtro?.maxima ?? null,
        descricao: dados.descricao?.trim() || null,
        aberto: dados.aberto ?? false,
        dataAbertura: abertura,
        dataFechamento: fechamento,
        letivosPorModalidade: { create: mapa },
      },
    });

    return this.buscar(criado.id);
  }

  /**
   * ==========================================================================
   * O MAPA VALIDADO — traduz codigos de modalidade em linhas gravaveis
   * ==========================================================================
   * Tres recusas, todas pelo mesmo motivo: o `periodoLetivoId` errado NAO da
   * erro em lugar nenhum. A busca de ofertas responde 200 com lista vazia, a
   * intersecao com as matriculas do aluno da vazia, e a modalidade inteira
   * recebe "nenhuma disciplina sua aparece no periodo letivo vigente". Toda
   * conferencia que nao acontecer aqui vira suporte no dia da abertura.
   *
   * 1. codigo de modalidade que nao existe → 400 dizendo quais existem;
   * 2. modalidade cadastrada que ficou de fora → 400 nomeando as que faltam;
   * 3. `periodoLetivoId` vazio → 400.
   */
  private async exigirMapaCompleto(
    principal: string,
    informado?: { modalidadeCodigo: string; periodoLetivoId: string }[],
  ): Promise<{ modalidadeId: number; periodoLetivoId: string }[]> {
    const modalidades = await this.prisma.modalidade.findMany({
      orderBy: { id: 'asc' },
    });

    // Sem modalidade cadastrada nao ha mapa a montar — banco recem-migrado,
    // antes do seed. A janela nasce so com o principal e o seed seguinte nao
    // quebra nada: `resolverPorModalidade` cai no principal e avisa.
    if (modalidades.length === 0) return [];

    if (!informado || informado.length === 0) {
      return modalidades.map((m) => ({
        modalidadeId: m.id,
        periodoLetivoId: principal,
      }));
    }

    const porCodigo = new Map(
      modalidades.map((m) => [m.codigo.toUpperCase(), m]),
    );

    const escolhido = new Map<number, string>();

    for (const linha of informado) {
      const codigo = linha.modalidadeCodigo?.trim().toUpperCase() ?? '';
      const modalidade = porCodigo.get(codigo);

      if (!modalidade) {
        throw new BadRequestException(
          `Modalidade "${linha.modalidadeCodigo}" nao existe. As cadastradas sao: ` +
            `${modalidades.map((m) => m.codigo).join(', ')}.`,
        );
      }

      const letivo = linha.periodoLetivoId?.trim() ?? '';

      if (!letivo) {
        throw new BadRequestException(
          `Informe o periodo letivo da modalidade ${modalidade.codigo}. Sem ele, ` +
            'os alunos dela nao teriam disciplina nenhuma para agendar.',
        );
      }

      escolhido.set(modalidade.id, letivo);
    }

    const faltando = modalidades.filter((m) => !escolhido.has(m.id));

    if (faltando.length > 0) {
      throw new BadRequestException(
        `Falta o periodo letivo de: ${faltando.map((m) => m.codigo).join(', ')}. ` +
          'O mapa tem de cobrir todas as modalidades — a que ficar de fora cai no ' +
          'periodo letivo principal em silencio, e os alunos dela recebem "nenhuma ' +
          'disciplina sua aparece no periodo letivo vigente" sem nada indicando a causa.',
      );
    }

    return modalidades.map((m) => ({
      modalidadeId: m.id,
      periodoLetivoId: escolhido.get(m.id)!,
    }));
  }

  /**
   * ⚠️ `periodoLetivoId` (o principal) NAO se edita. `rodada` e o MAPA por
   * modalidade so enquanto a janela esta VAZIA — ver `exigirJanelaVazia`.
   */
  async atualizar(
    id: number,
    dados: {
      rodada?: string;
      /**
       * O mapa novo, INTEIRO. Nao ha edicao de uma linha so: o mapa e validado
       * como conjunto (toda modalidade coberta), e aceitar um pedaco deixaria o
       * resto no estado anterior sem ninguem conferir se os dois ainda fazem
       * sentido juntos.
       */
      letivosPorModalidade?: {
        modalidadeCodigo: string;
        periodoLetivoId: string;
      }[];
      notaMinima?: number | null;
      notaMaxima?: number | null;
      descricao?: string | null;
      aberto?: boolean;
      dataAbertura?: string | null;
      dataFechamento?: string;
    },
    porAdmin: string,
  ): Promise<PeriodoAdmin> {
    const periodo = await this.prisma.periodoAgendamento.findUnique({
      where: { id },
      include: MAPA_DA_JANELA,
    });

    if (!periodo) throw new NotFoundException(`Periodo ${id} nao encontrado`);

    const rodada = dados.rodada?.trim() || undefined;

    const mapaNovo = dados.letivosPorModalidade
      ? await this.exigirMapaCompleto(
          periodo.periodoLetivoId,
          dados.letivosPorModalidade,
        )
      : undefined;

    // O par de nota e revalidado INTEIRO, mesmo quando so um dos dois campos
    // vem: mandar `notaMaxima` sozinha para uma janela sem filtro deixaria meio
    // filtro no banco, e meio filtro nao e regra nenhuma — seria lido como
    // "sem filtro" e a substitutiva abriria para todos.
    const mexeuNaNota =
      dados.notaMinima !== undefined || dados.notaMaxima !== undefined;

    const filtro = mexeuNaNota
      ? exigirFiltroDeNotaValido(
          dados.notaMinima === undefined
            ? numeroOuNulo(periodo.notaMinima)
            : dados.notaMinima,
          dados.notaMaxima === undefined
            ? numeroOuNulo(periodo.notaMaxima)
            : dados.notaMaxima,
        )
      : undefined;

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
    // ainda nao escolheu. Por isso nao ha checagem de agendamentos aqui —
    // a unica que existe e a da rodada, logo abaixo, e por outro motivo.
    await this.prisma.$transaction(async (tx) => {
      if (rodada && rodada !== periodo.rodada) {
        await this.exigirJanelaVazia(tx, periodo, 'a rodada');
      }

      // O mapa e travado pelo MESMO motivo que a rodada, e nao por simetria:
      // `Agendamento.periodoLetivoId` e fotografia. Trocar o mapa com reservas
      // gravadas faria a janela apontar para um org unit e as provas dela para
      // outro — e dali em diante toda consulta pelo par para de casar, do
      // portal do aluno a exportacao.
      if (mapaNovo && mudouOMapa(periodo, mapaNovo)) {
        await this.exigirJanelaVazia(
          tx,
          periodo,
          'o periodo letivo por modalidade',
        );

        await tx.periodoLetivoModalidade.deleteMany({
          where: { periodoAgendamentoId: id },
        });

        await tx.periodoLetivoModalidade.createMany({
          data: mapaNovo.map((l) => ({ ...l, periodoAgendamentoId: id })),
        });
      }

      await tx.periodoAgendamento.update({
        where: { id },
        data: {
          rodada,
          // `undefined` = nao mexeu; `null` = desligou o filtro. A distincao
          // e o que permite editar so a descricao sem apagar a faixa de nota.
          notaMinima: mexeuNaNota ? (filtro?.minima ?? null) : undefined,
          notaMaxima: mexeuNaNota ? (filtro?.maxima ?? null) : undefined,
          descricao:
            dados.descricao === undefined
              ? undefined
              : (dados.descricao?.trim() ?? null) || null,
          aberto: dados.aberto,
          dataAbertura: abertura,
          dataFechamento: fechamento,
        },
      });
    });

    if (mexeuNaNota) {
      await this.avisarSeAJanelaJaTemReserva(periodo, filtro ?? null, porAdmin);
    }

    return this.buscar(id);
  }

  /**
   * ==========================================================================
   * MEXER NA FAIXA DE NOTA COM A JANELA JA EM USO — avisa e NAO bloqueia
   * ==========================================================================
   * Ao contrario da `rodada` (`exigirRodadaAindaTrocavel`), que so muda com a
   * janela vazia. Sao coisas diferentes:
   *
   * - `rodada` e FOTOGRAFIA: cada reserva grava a sua, e trocar a da janela
   *   desalinha o par que TODA consulta usa — o portal passa a dizer ao aluno
   *   que ele nao tem prova, e a exportacao o lista como nao agendado.
   * - a faixa de nota nao e gravada em lugar nenhum. Mexer nela nao desfaz nem
   *   renomeia reserva alguma: so muda quem consegue agendar daqui para a
   *   frente. E bloquear seria pior que o problema — a correcao mais provavel e
   *   justamente ter cadastrado a faixa errada e perceber com a janela ja aberta.
   *
   * O que ela FAZ e deixar rastro, porque a consequencia e invisivel na tela:
   * quem estava elegivel ontem pode nao estar hoje, e quem ja agendou continua
   * com a prova marcada — inclusive quem, pela faixa nova, nao poderia te-la.
   * Essa lista e trabalho da secretaria, e ela precisa saber que existe.
   */
  private async avisarSeAJanelaJaTemReserva(
    periodo: JanelaComMapa,
    filtro: FiltroDeNota | null,
    porAdmin: string,
  ): Promise<void> {
    // A janela inteira, e nao so o principal: as reservas dos presenciais estao
    // gravadas sob o outro org unit, e conta-las de fora faria o aviso dizer
    // "0 reserva" numa janela cheia — calando justamente quando importa.
    const reservas = await this.prisma.agendamento.count({
      where: {
        periodoLetivoId: { in: idsDaJanela(periodo) },
        rodada: periodo.rodada,
      },
    });

    const faixa = filtro
      ? `[${filtro.minima}; ${filtro.maxima})`
      : 'sem filtro de nota';

    this.auditoria.registrar('PERIODO_FILTRO_DE_NOTA_ALTERADO', {
      ator: porAdmin,
      detalhe:
        `periodo ${periodo.id} (letivo ${periodo.periodoLetivoId}, rodada ` +
        `${periodo.rodada}) passou a ${faixa}; ${reservas} reserva(s) ja existem`,
    });

    if (reservas === 0) return;

    this.logger.warn(
      `A faixa de nota do periodo ${periodo.id} mudou para ${faixa} com ` +
        `${reservas} reserva(s) ja marcada(s). As provas existentes NAO sao ` +
        'revistas: quem agendou pela faixa anterior continua com o horario. ' +
        'Confira a lista se a mudanca foi correcao de cadastro.',
    );
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
      const periodo = await tx.periodoAgendamento.findUnique({
        where: { id },
        include: MAPA_DA_JANELA,
      });

      if (!periodo) throw new NotFoundException(`Periodo ${id} nao encontrado`);

      /**
       * Aqui a contagem inclui CANCELADO, ao contrario do `totalAgendamentos`
       * da listagem (so CONFIRMADO). Sao perguntas diferentes: a tela mostra
       * quantas vagas estao tomadas, e cancelado devolveu a vaga; esta responde
       * "alguem ja usou este semestre?", e cancelamento e justamente o registro
       * que precisa continuar explicavel — quem aparecer no dia sem estar na
       * lista se explica por ele.
       *
       * A conta e pela JANELA INTEIRA (todos os periodos letivos do mapa) mais
       * a `rodada` — a mesma chave que identifica a janela. Contar so o
       * principal deixaria as provas dos presenciais de fora e permitiria apagar
       * uma janela cheia. Duas linhas com o mesmo par continuam travando uma a
       * outra, e e conservador de proposito: nao ha como dizer a qual delas a
       * prova pertence. Mas a N2 e a SUB do mesmo semestre nao se travam — o
       * cadastro errado de uma janela vazia da SUB precisa poder ser desfeito, e
       * as provas ja marcadas na N2 nao dizem nada sobre ela.
       */
      const agendamentos = await tx.agendamento.count({
        where: {
          periodoLetivoId: { in: idsDaJanela(periodo) },
          rodada: periodo.rodada,
        },
      });

      if (agendamentos > 0) {
        throw new ConflictException(
          `O periodo letivo ${periodo.periodoLetivoId} (rodada ${periodo.rodada}) ` +
            `ja tem ${agendamentos} agendamento(s) (incluindo cancelados) e nao ` +
            'pode ser apagado — as provas ficariam sem a janela que as identifica, ' +
            'e sumiriam do portal do aluno. Para encerrar o prazo, use PATCH com ' +
            'dataFechamento no passado ou aberto=false; a linha continua no historico.',
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
        select: {
          id: true,
          periodoLetivoId: true,
          rodada: true,
          descricao: true,
        },
      });

      this.auditoria.registrar('PERIODO_REMOVIDO', {
        ator: porAdmin,
        detalhe:
          `periodo ${id} (letivo ${periodo.periodoLetivoId}, rodada ${periodo.rodada}` +
          `${periodo.descricao ? `, "${periodo.descricao}"` : ''}) removido; ` +
          `vigente agora: ${vigente ? `${vigente.id} (letivo ${vigente.periodoLetivoId}, rodada ${vigente.rodada})` : 'nenhum'}`,
      });

      return {
        mensagem: `Periodo ${id} (${periodo.descricao || periodo.periodoLetivoId}) removido`,
        vigenteAgora: vigente,
      };
    });
  }

  /**
   * ==========================================================================
   * MEXER NA CHAVE DA JANELA: so enquanto ela nao tiver prova nenhuma
   * ==========================================================================
   * Vale para a `rodada` E para o mapa por modalidade — as duas metades da
   * chave que liga esta janela as reservas, e as duas gravadas em cada
   * `Agendamento` como FOTOGRAFIA, no instante da reserva.
   *
   * Trocar qualquer uma delas com provas dentro nao mexe em prova nenhuma: a
   * janela passaria a dizer "SUB" (ou a apontar para 2026/2) enquanto as 20
   * provas dela continuam dizendo "N2" (ou 2026/4), e a partir dali TODA
   * consulta pelo par para de casar. O portal diria ao aluno que ele nao tem
   * prova marcada, a exportacao o listaria como "Nao Agendado", e o compulsorio
   * o alocaria de novo — tres sintomas longe da causa.
   *
   * Com a janela vazia nao ha nada a desalinhar, e e ai que a troca resolve o
   * caso real: cadastrou como N2 o que era a substitutiva, ou apontou o
   * Presencial para a grade dos modulos, e percebeu antes de abrir. A
   * alternativa seria apagar e recriar — pior, porque `vigente` = o cadastrado
   * mais recentemente, e recriar embaralha essa ordem.
   *
   * A contagem inclui CANCELADO, pelo mesmo motivo do `remover`: a pergunta e
   * "alguem ja usou esta janela?", e o cancelamento e justamente o registro que
   * precisa continuar explicavel no dia da prova.
   */
  private async exigirJanelaVazia(
    tx: Prisma.TransactionClient,
    periodo: JanelaComMapa,
    oQueMudou: string,
  ): Promise<void> {
    // A contagem cobre a janela INTEIRA. Contar so o principal deixaria as
    // provas dos presenciais (gravadas sob o outro org unit) invisiveis, e a
    // trava liberaria a edicao que ela existe para impedir.
    const agendamentos = await tx.agendamento.count({
      where: {
        periodoLetivoId: { in: idsDaJanela(periodo) },
        rodada: periodo.rodada,
      },
    });

    if (agendamentos === 0) return;

    throw new ConflictException(
      `Esta janela ja tem ${agendamentos} agendamento(s) gravado(s) na rodada ` +
        `"${periodo.rodada}" (incluindo cancelados), e o que a reserva grava e uma ` +
        `fotografia: mudar ${oQueMudou} agora nao mexeria em nenhuma delas. As ` +
        'provas ficariam orfas — sumiriam do portal do aluno e voltariam a contar ' +
        'como "nao agendado". So da para corrigir enquanto a janela estiver vazia.',
    );
  }

  async buscar(id: number): Promise<PeriodoAdmin> {
    const todos = await this.listar();
    const periodo = todos.find((p) => p.id === id);

    if (!periodo) throw new NotFoundException(`Periodo ${id} nao encontrado`);

    return periodo;
  }
}

/**
 * ============================================================================
 * O MAPA DA JANELA — helpers compartilhados
 * ============================================================================
 */

/**
 * O `include` que carrega o mapa junto da janela. Uma constante, e nao um
 * objeto solto em cada consulta: se uma delas esquecesse o `include`,
 * `idsDaJanela` devolveria so o principal e a diferenca seria invisivel —
 * tudo continuaria funcionando, so que ignorando a metade presencial.
 */
const MAPA_DA_JANELA = {
  letivosPorModalidade: { include: { modalidade: true } },
} as const;

/** Uma janela com o mapa carregado — o que `MAPA_DA_JANELA` produz. */
type JanelaComMapa = {
  id: number;
  periodoLetivoId: string;
  rodada: string;
  letivosPorModalidade: {
    modalidadeId: number;
    periodoLetivoId: string;
    modalidade: { id: number; codigo: string; nome: string };
  }[];
};

/**
 * Todos os periodos letivos que a janela cobre, sem repetir.
 *
 * O PRINCIPAL entra sempre, mesmo quando ja esta no mapa: ele e o destino do
 * fallback de uma modalidade sem linha propria, entao uma reserva pode ter sido
 * gravada com ele. Deixa-lo de fora faria essa prova sumir de toda consulta pela
 * janela — e ela existe.
 */
function idsDaJanela(periodo: {
  periodoLetivoId: string;
  letivosPorModalidade: { periodoLetivoId: string }[];
}): string[] {
  return [
    ...new Set([
      periodo.periodoLetivoId,
      ...periodo.letivosPorModalidade.map((l) => l.periodoLetivoId),
    ]),
  ];
}

/**
 * O mapa como a TELA do admin precisa ver: uma linha por modalidade cadastrada,
 * inclusive as que nao tem entrada propria e caem no principal — sao justamente
 * as que ele precisa enxergar para decidir se aquilo esta certo.
 */
function montarMapa(
  periodo: JanelaComMapa,
  modalidades: { id: number; codigo: string; nome: string }[],
): LetivoDaModalidade[] {
  const porModalidade = new Map(
    periodo.letivosPorModalidade.map((l) => [
      l.modalidadeId,
      l.periodoLetivoId,
    ]),
  );

  return modalidades.map((m) => ({
    modalidadeId: m.id,
    modalidadeCodigo: m.codigo,
    modalidadeNome: m.nome,
    periodoLetivoId: porModalidade.get(m.id) ?? periodo.periodoLetivoId,
    herdadoDoPrincipal: !porModalidade.has(m.id),
  }));
}

/**
 * O mapa novo diz algo diferente do que ja esta gravado?
 *
 * Existe para que reenviar o formulario sem mexer no mapa NAO caia na trava de
 * janela vazia. Editar so a data de fechamento de uma janela cheia e a operacao
 * mais comum da tela, e ela manda o mapa junto — recusar ali seria travar o uso
 * normal por causa de uma mudanca que nao houve.
 */
function mudouOMapa(
  periodo: JanelaComMapa,
  novo: { modalidadeId: number; periodoLetivoId: string }[],
): boolean {
  const atual = new Map(
    periodo.letivosPorModalidade.map((l) => [
      l.modalidadeId,
      l.periodoLetivoId,
    ]),
  );

  if (atual.size !== novo.length) return true;

  return novo.some((l) => atual.get(l.modalidadeId) !== l.periodoLetivoId);
}

/**
 * A rodada de quem nao informou nenhuma. Igual ao default da coluna: os periodos
 * ja cadastrados sao todos da prova regular, e quem so tem uma prova por
 * semestre continua criando periodo como antes, sem saber que a rodada existe.
 */
const RODADA_PADRAO = 'N2';

/** Chave do par que identifica uma janela — nunca so o `periodoLetivoId`. */
function chaveDaRodada(periodoLetivoId: string, rodada: string): string {
  return `${periodoLetivoId}\u0000${rodada}`;
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

/**
 * A NOTA MAXIMA que uma prova vale nesta instituicao.
 *
 * Serve so para recusar digitacao impossivel no cadastro (um "67,5" digitado no
 * lugar de "6,75" viraria uma janela que libera o curso inteiro). A comparacao
 * com a nota do aluno e feita em PONTOS, contra o que a Valence devolver.
 */
const NOTA_MAXIMA_POSSIVEL = 10;

/**
 * O par de colunas virando `FiltroDeNota`.
 *
 * Exige os DOIS: meio filtro no banco nao e regra nenhuma — seria lido como
 * "sem filtro", e a substitutiva abriria para todo mundo sem nada no log
 * denunciando. A validacao do cadastro (`exigirFiltroDeNotaValido`) ja impede
 * que essa metade chegue la, e este `null` e a segunda trava.
 */
function lerFiltroDeNota(periodo: {
  notaMinima: Prisma.Decimal | null;
  notaMaxima: Prisma.Decimal | null;
}): FiltroDeNota | null {
  const minima = numeroOuNulo(periodo.notaMinima);
  const maxima = numeroOuNulo(periodo.notaMaxima);

  if (minima === null || maxima === null) return null;

  return { minima, maxima };
}

/**
 * `Decimal` do Prisma virando `number`.
 *
 * A coluna e DECIMAL de propósito (nota e dinheiro nao vivem em ponto
 * flutuante binario no banco), mas a comparacao com a nota da Valence e feita
 * em `number` — que e como a API a devolve. A conversao acontece AQUI, uma vez,
 * em vez de espalhar `.toNumber()` por quem le o filtro.
 */
function numeroOuNulo(valor: Prisma.Decimal | null): number | null {
  if (valor === null || valor === undefined) return null;

  const numero = Number(valor);

  return Number.isFinite(numero) ? numero : null;
}

/**
 * Valida o par informado no cadastro. `null` quando a janela nao filtra.
 *
 * As tres recusas, e por que cada uma existe:
 *
 * - **um sem o outro**: metade de um intervalo nao delimita nada, e o banco
 *   leria a linha como "sem filtro" — a substitutiva aberta para o curso todo,
 *   sem erro nenhum aparecendo.
 * - **minima >= maxima**: intervalo vazio. NINGUEM seria elegivel, e o sintoma
 *   ("nenhuma disciplina sua...") apontaria para o CSV de turmas, nao para o
 *   cadastro que o causou.
 * - **fora de 0..10**: digitacao trocada. "67,5" no lugar de "6,75" libera todo
 *   mundo; "0,675", ninguem.
 */
function exigirFiltroDeNotaValido(
  minima: number | null | undefined,
  maxima: number | null | undefined,
): FiltroDeNota | null {
  const temMinima = minima !== null && minima !== undefined;
  const temMaxima = maxima !== null && maxima !== undefined;

  if (!temMinima && !temMaxima) return null;

  if (!temMinima || !temMaxima) {
    throw new BadRequestException(
      'notaMinima e notaMaxima andam juntas: informe as duas para filtrar por ' +
        'nota (a substitutiva), ou nenhuma para a janela cobrir todas as ' +
        'disciplinas do semestre. Metade do intervalo seria lida como "sem filtro".',
    );
  }

  for (const [campo, valor] of [
    ['notaMinima', minima],
    ['notaMaxima', maxima],
  ] as const) {
    if (!Number.isFinite(valor) || valor < 0 || valor > NOTA_MAXIMA_POSSIVEL) {
      throw new BadRequestException(
        `${campo} precisa ser um numero entre 0 e ${NOTA_MAXIMA_POSSIVEL} ` +
          `(recebido: ${String(valor)}).`,
      );
    }
  }

  if (minima >= maxima) {
    throw new BadRequestException(
      `notaMinima (${minima}) precisa ser MENOR que notaMaxima (${maxima}). ` +
        'Do jeito informado nenhum aluno ficaria elegivel, e a tela diria a ' +
        'todos que eles nao tem disciplina para agendar.',
    );
  }

  return { minima: minima, maxima: maxima };
}
