import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';

/**
 * ============================================================================
 * QUAL E A MODALIDADE DE UMA TURMA — e por que a pergunta nao tem coluna
 * ============================================================================
 *
 * O lote de DATAS precisa de uma modalidade por turma: EaD abre a prova em 3
 * sessoes de 3h, Semi/Modular em 6 de 1h30, e o questionario tem UMA janela.
 *
 * ⚠️ **`TurmaImportada` NAO tem modalidade, e isso e deliberado.** A coluna
 * `curso` foi REMOVIDA em 10/08/2026 (migration `turma_sem_curso`) com a razao
 * escrita no schema: "uma turma tem alunos de VARIOS cursos — disciplina
 * compartilhada, eletiva, equivalencia —, entao dizer que ela 'e do curso X' e
 * falso". Como a modalidade vem do curso, o mesmo argumento a alcanca. Nao ha
 * coluna a acrescentar aqui: haveria uma afirmacao a inventar.
 *
 * O que existe de verdade e a modalidade do ALUNO, e ela chega ate a turma pelo
 * unico caminho que o modelo oferece:
 *
 *     agendamento (CONFIRMADO, periodo + rodada vigentes)
 *       -> agendamento_disciplina.orgUnitId
 *            -> turma_importada.orgUnitId
 *                 => agendamento.modalidadeId
 *
 * `Agendamento.modalidadeId` e FOTOGRAFIA da modalidade do aluno no momento da
 * reserva (migration `snapshot_modalidade_polo_agendamento`, 13/08/2026) — e nao
 * o estado atual do vinculo. E o que se quer: a prova acontece na duracao com
 * que foi marcada, mesmo que o aluno tenha trocado de curso desde entao. Ler de
 * `aluno_importado` faria a janela mudar por baixo de uma reserva confirmada,
 * exatamente o problema que aquela migration existe para resolver.
 *
 * O TIMING FUNCIONA, e nao por sorte: o cron de datas roda NOS DIAS DE PROVA,
 * com o periodo de agendamento ja fechado. Os agendamentos existem. E o oposto
 * do lote de senhas, que ignora agendamentos de proposito porque roda sobre
 * todas as turmas do CSV (`resolucao-orgunit.service.ts`).
 *
 * **NADA E CHUTADO** — a regra do projeto. Duas modalidades na mesma turma nao
 * viram voto de maioria: o questionario tem uma janela so, e a minoria ficaria
 * sem conseguir abrir a prova. Vira linha de relatorio, como `ORGUNIT_AMBIGUO`.
 *
 * ============================================================================
 * O DESEMPATE MANUAL (10/09/2026) — e por que ele NAO afrouxa a regra acima
 * ============================================================================
 *
 * "Nada e chutado" resolvia metade do problema. A outra metade apareceu numa
 * turma real de PROBABILIDADE E ESTATISTICA: EAD (583) e MODULAR (1). Sem
 * modalidade, a turma inteira fica fora do lote de datas e a prova permanece com
 * a DATA ANTIGA — para os 583 tanto quanto para o 1. A conferencia mostrava o
 * problema e nao oferecia saida nenhuma.
 *
 * Agora oferece: o admin ESCOLHE a modalidade da turma, e a escolha fica em
 * `modalidade_escolhida_turma` com quem decidiu e quando. O sistema continua sem
 * escolher — o que mudou e que existe um lugar para a decisao de uma pessoa.
 *
 * ⚠️ **A escolha so vale enquanto a turma for AMBIGUA, e isso e verificado em
 * toda LEITURA** (`decidir`), nunca na gravacao. Sao dois casos, e os dois
 * derrubam a linha gravada:
 *
 * 1. **Voltou a ter uma modalidade so** (o unico MODULAR cancelou). A derivacao
 *    vence. O dado de agora vale mais que uma decisao de dias atras, e manter a
 *    escolha faria uma turma 100% EaD receber a janela MODULAR porque alguem
 *    desempatou na terca.
 * 2. **A modalidade escolhida ficou sem NENHUMA reserva** (escolheram MODULAR, e
 *    depois o unico MODULAR trocou por SEMI). A turma volta a aparecer como
 *    ambigua, com o aviso no `detalhe`. Aplicar a janela de uma modalidade que
 *    ninguem ali cursa e pior que nao aplicar nada: em vez de quase todos
 *    abrirem a prova no horario antigo, NINGUEM abre no horario novo.
 *
 * Como a checagem esta aqui dentro, ela vale de graca para os tres leitores —
 * a conferencia da tela, o lote manual e o cron. Nenhum deles sabe que a tabela
 * existe.
 */

/** Por que uma turma nao recebeu modalidade. */
export type MotivoSemModalidade = 'SEM_AGENDAMENTO' | 'AMBIGUA';

/** Quantas reservas cada modalidade tem numa turma. */
export interface ContagemPorModalidade {
  modalidadeId: number;
  codigo: string;
  nome: string;
  reservas: number;
}

/** A decisao de um humano, quando houve uma. */
export interface EscolhaDoAdmin {
  modalidadeId: number;
  codigo: string;
  nome: string;
  /** E-mail de quem decidiu. */
  escolhidaPor: string;
  escolhidaEm: Date;
}

/** A resposta para UMA turma. */
export type ModalidadeDaTurma =
  | {
      situacao: 'ENCONTRADA';
      modalidadeId: number;
      codigo: string;
      nome: string;
      reservas: number;
      /**
       * Preenchido SO quando a modalidade veio de uma decisao do admin. Nulo na
       * derivacao normal — a tela e o relatorio precisam distinguir "a turma so
       * tem EaD" de "alguem decidiu que ela vale como EaD".
       */
      escolha: EscolhaDoAdmin | null;
      /**
       * As modalidades em disputa. Vazio quando a derivacao foi unanime; com 2+
       * entradas quando a turma e ambigua e uma escolha a desempatou — e e daqui
       * que a tela monta o seletor para TROCAR a escolha.
       */
      candidatas: ContagemPorModalidade[];
    }
  | {
      situacao: 'SEM_MODALIDADE';
      motivo: MotivoSemModalidade;
      /** Vazio em `SEM_AGENDAMENTO`; 2+ entradas em `AMBIGUA`. */
      candidatas: ContagemPorModalidade[];
      /** Frase pronta para o relatorio. */
      detalhe: string;
    };

/**
 * A turma sobre a qual o desempate age, ja com o `orgUnitId` resolvido.
 *
 * Sai das rotas de escrita junto com a decisao para que a tela consiga
 * redesenhar a linha sem refazer a conferencia inteira — que custa uma volta na
 * Valence por turma do CSV.
 */
export interface TurmaDoDesempate {
  turmaId: number;
  orgUnitId: string;
  codigoTurma: string;
  nomeDisciplina: string;
}

/** O que as rotas de escrita devolvem: a turma e como ela ficou. */
export interface TurmaDesempatada extends TurmaDoDesempate {
  decisao: ModalidadeDaTurma;
}

/** O mapa `orgUnitId -> modalidade`, resolvido de uma vez. */
export interface MapaDeModalidades {
  /** Consulta por `orgUnitId`. Turma ausente do mapa = sem agendamento nenhum. */
  de(orgUnitId: string): ModalidadeDaTurma;
  /** Quantas turmas o cruzamento alcancou. Metrica para o log. */
  totalComAgendamento: number;
}

/** Uma linha da agregacao — o formato que a consulta crua devolve. */
interface LinhaAgregada {
  orgUnitId: string;
  modalidadeId: number;
  codigo: string;
  nome: string;
  reservas: bigint | number;
}

@Injectable()
export class ModalidadeDaTurmaService {
  private readonly logger = new Logger(ModalidadeDaTurmaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Mapa sem nenhuma turma — toda consulta responde `SEM_AGENDAMENTO`.
   *
   * Reusa `decidir(undefined)` para nao existir uma segunda versao da frase que
   * o relatorio mostra: duas acabariam divergindo.
   */
  private vazio(): MapaDeModalidades {
    return {
      de: () => this.decidir(undefined, undefined),
      totalComAgendamento: 0,
    };
  }

  /**
   * Resolve a modalidade de TODAS as turmas de uma vez.
   *
   * Uma consulta agregada, e nao uma por turma: sao ~300 turmas por semestre, e
   * o lote ja gasta o tempo dele em rede contra a Valence. O mesmo motivo pelo
   * qual o compulsorio pre-carrega as notas por turma antes de comecar.
   *
   * ⚠️ **O recorte e `periodoLetivoId` + `rodada`, os dois.** Sem o semestre, a
   * prova do semestre passado decidiria a janela de hoje. Sem a rodada, quem fez
   * a N2 entraria na conta da substitutiva — e as duas rodadas tem o MESMO
   * `periodoLetivoId` no Brightspace, que e a armadilha que a `rodada` existe
   * para desfazer.
   *
   * Os periodos letivos vao no plural (`IN`) porque a janela cobre as duas
   * grades: uma turma presencial so tem reserva sob o org unit do semestre, e
   * consultar so o do modulo a devolveria como SEM_AGENDAMENTO — turma sem
   * modalidade fica de fora do lote de datas, e a prova nao abre.
   *
   * `status = CONFIRMADO` pelo mesmo motivo de toda contagem do projeto: quem
   * cancelou devolveu a vaga e nao vai fazer a prova, entao a modalidade dele
   * nao diz nada sobre esta turma.
   */
  async resolver(
    periodoLetivoIds: string[],
    rodada: string,
  ): Promise<MapaDeModalidades> {
    // `IN` com lista vazia e sempre falso no MySQL e devolveria mapa vazio —
    // toda turma sairia como SEM_AGENDAMENTO. Nao acontece hoje (a janela
    // sempre tem ao menos o principal), mas a consulta e crua e nao tem tipo
    // que segure isso.
    if (periodoLetivoIds.length === 0) return this.vazio();

    const linhas = await this.prisma.$queryRaw<LinhaAgregada[]>`
      SELECT ad.orgUnitId    AS orgUnitId,
             a.modalidadeId  AS modalidadeId,
             m.codigo        AS codigo,
             m.nome          AS nome,
             COUNT(*)        AS reservas
        FROM agendamento a
        JOIN agendamento_disciplina ad ON ad.agendamentoId = a.id
        JOIN modalidade m              ON m.id = a.modalidadeId
       WHERE a.status          = ${StatusAgendamento.CONFIRMADO}
         AND a.periodoLetivoId IN (${Prisma.join(periodoLetivoIds)})
         AND a.rodada          = ${rodada}
       GROUP BY ad.orgUnitId, a.modalidadeId, m.codigo, m.nome
    `;

    /** orgUnitId -> contagens, ja ordenadas. */
    const porTurma = new Map<string, ContagemPorModalidade[]>();

    for (const linha of linhas) {
      const atual = porTurma.get(linha.orgUnitId) ?? [];
      atual.push({
        modalidadeId: Number(linha.modalidadeId),
        codigo: linha.codigo,
        nome: linha.nome,
        // `COUNT(*)` volta BigInt no driver; JSON.stringify de BigInt LANCA.
        // Converter aqui e o que impede o relatorio de morrer na serializacao.
        reservas: Number(linha.reservas),
      });
      porTurma.set(linha.orgUnitId, atual);
    }

    // Ordem estavel: a mais reservas primeiro, e o codigo desempata. Duas
    // execucoes com os mesmos dados precisam produzir o mesmo relatorio.
    for (const contagens of porTurma.values()) {
      contagens.sort(
        (a, b) => b.reservas - a.reservas || a.codigo.localeCompare(b.codigo),
      );
    }

    const ambiguas = [...porTurma.values()].filter((c) => c.length > 1).length;

    // As decisoes manuais desta rodada, numa consulta so — mesmo argumento da
    // agregacao acima. O `IN` e limitado as turmas que TEM agendamento porque
    // uma escolha so pode valer onde ha ambiguidade, e ambiguidade exige duas
    // contagens: fora dessa lista a linha seria carregada para ser ignorada.
    const escolhas = await this.escolhasDaRodada([...porTurma.keys()], rodada);

    this.logger.log(
      `Modalidade por turma: ${porTurma.size} turma(s) com agendamento confirmado ` +
        `em ${periodoLetivoIds.join('+')}/${rodada}; ${ambiguas} com mais de ` +
        `uma modalidade; ${escolhas.size} com desempate manual gravado.`,
    );

    return {
      totalComAgendamento: porTurma.size,
      de: (orgUnitId) =>
        this.decidir(porTurma.get(orgUnitId), escolhas.get(orgUnitId)),
    };
  }

  /**
   * ==========================================================================
   * O ADMIN DESEMPATA — a unica escrita desta tabela
   * ==========================================================================
   *
   * ⚠️ **So aceita turma que esta AMBIGUA AGORA, e so uma das modalidades que
   * de fato tem reserva ali.** As duas checagens sao a razao de a rota existir
   * do jeito que existe: sem a primeira, isto viraria "definir a modalidade de
   * qualquer turma" — uma coluna de cadastro por outro nome, que e exatamente o
   * que a decisao de 10/08/2026 recusou. Sem a segunda, um clique errado (ou um
   * `modalidadeId` chutado por um cliente qualquer) aplicaria a janela de uma
   * modalidade que ninguem cursa, e a prova nao abriria para NINGUEM.
   *
   * Trocar uma escolha ja gravada continua valendo: a turma segue ambigua por
   * baixo, e `decidir` a devolve com `candidatas` preenchidas justamente para
   * que a tela possa oferecer a troca sem exigir um "desfazer" antes.
   */
  async escolher(
    turmaId: number,
    modalidadeId: number,
    periodoLetivoIds: string[],
    rodada: string,
    admin: string,
  ): Promise<TurmaDesempatada> {
    const turma = await this.turmaResolvida(turmaId);
    const candidatas = await this.candidatasDe(
      turma.orgUnitId,
      periodoLetivoIds,
      rodada,
    );

    const eleita = candidatas.find((c) => c.modalidadeId === modalidadeId);

    if (!eleita) {
      throw new BadRequestException(
        `Nenhum aluno de prova nesta turma esta na modalidade informada. As ` +
          `modalidades em disputa sao: ${candidatas
            .map((c) => `${c.codigo} (${c.reservas})`)
            .join(', ')}. Escolher outra aplicaria uma janela de horario que ` +
          'nenhum aluno da turma usa, e ai a prova nao abriria para ninguem.',
      );
    }

    await this.prisma.modalidadeEscolhidaDaTurma.upsert({
      where: { orgUnitId_rodada: { orgUnitId: turma.orgUnitId, rodada } },
      create: {
        orgUnitId: turma.orgUnitId,
        rodada,
        modalidadeId,
        codigoTurma: turma.codigoTurma,
        escolhidaPor: admin,
      },
      update: { modalidadeId, escolhidaPor: admin },
    });

    // A decisao e do mesmo peso das outras da aba: ela muda EM QUE HORARIO uma
    // turma inteira abre a prova, e a pergunta "quem decidiu isto?" vai
    // aparecer. Nenhum dado sensivel — turma, modalidade e quem escolheu.
    this.auditoria.registrar('DATA_QUIZ_MODALIDADE_ESCOLHIDA', {
      ator: admin,
      detalhe:
        `turma ${turma.codigoTurma} (orgUnit ${turma.orgUnitId}), rodada ` +
        `${rodada}: ${eleita.codigo}. Em disputa: ${candidatas
          .map((c) => `${c.codigo} (${c.reservas})`)
          .join(', ')}.`,
    });

    return {
      ...turma,
      decisao: this.decidir(candidatas, {
        modalidadeId: eleita.modalidadeId,
        codigo: eleita.codigo,
        nome: eleita.nome,
        escolhidaPor: admin,
        escolhidaEm: new Date(),
      }),
    };
  }

  /**
   * Desfaz o desempate: a turma volta a aparecer como ambigua na conferencia.
   *
   * Nao exige que a turma continue ambigua — ao contrario de `escolher`. Apagar
   * uma decisao nunca aplica nada em prova nenhuma, e exigir a ambiguidade
   * deixaria a linha presa no banco justamente quando ela ja nao vale.
   */
  async esquecer(
    turmaId: number,
    periodoLetivoIds: string[],
    rodada: string,
    admin: string,
  ): Promise<TurmaDesempatada> {
    const turma = await this.turmaResolvida(turmaId);

    // `deleteMany` e nao `delete` para nao lancar quando nao havia nada: dois
    // cliques no mesmo botao nao sao erro, e a tela ja mostra o estado final.
    const { count } = await this.prisma.modalidadeEscolhidaDaTurma.deleteMany({
      where: { orgUnitId: turma.orgUnitId, rodada },
    });

    if (count > 0) {
      this.auditoria.registrar('DATA_QUIZ_MODALIDADE_ESCOLHA_REMOVIDA', {
        ator: admin,
        detalhe:
          `turma ${turma.codigoTurma} (orgUnit ${turma.orgUnitId}), rodada ` +
          `${rodada}. Ela volta a ficar com a data antiga ate alguem decidir.`,
      });
    }

    // Relido DEPOIS de apagar: a linha que a tela redesenha precisa ser o
    // estado de agora, com o aviso de ambiguidade de volta.
    const mapa = await this.resolver(periodoLetivoIds, rodada);

    return { ...turma, decisao: mapa.de(turma.orgUnitId) };
  }

  /** A turma do CSV, com o `orgUnitId` que o desempate exige. */
  private async turmaResolvida(turmaId: number): Promise<TurmaDoDesempate> {
    const turma = await this.prisma.turmaImportada.findUnique({
      where: { id: turmaId },
      select: { orgUnitId: true, codigoTurma: true, nomeDisciplina: true },
    });

    if (!turma) throw new NotFoundException('Turma nao encontrada.');

    // Turma sem orgUnitId nem chega ao lote: ela e uma das `naoResolvidas`, que
    // ficam sem senha e sem data. Desempatar a modalidade dela nao resolveria
    // nada, e a decisao gravada nunca seria lida (o mapa e por orgUnitId).
    if (!turma.orgUnitId) {
      throw new BadRequestException(
        'Esta turma do CSV ainda nao casou com nenhuma oferta do semestre, ' +
          'entao ela fica de fora do lote inteiro — nem senha ela recebe. ' +
          'Resolva isso antes: escolher a modalidade aqui nao teria efeito.',
      );
    }

    return {
      turmaId,
      orgUnitId: turma.orgUnitId,
      codigoTurma: turma.codigoTurma,
      nomeDisciplina: turma.nomeDisciplina,
    };
  }

  /**
   * As modalidades em disputa numa turma, exigindo que haja disputa.
   *
   * Reusa `resolver` de proposito, em vez de uma consulta enxuta so desta
   * turma: e a MESMA pergunta que a conferencia e o lote fazem, e duas
   * implementacoes acabariam discordando sobre o que e "ambigua" — justamente
   * na hora de gravar uma decisao que so vale sob essa condicao.
   */
  private async candidatasDe(
    orgUnitId: string,
    periodoLetivoIds: string[],
    rodada: string,
  ): Promise<ContagemPorModalidade[]> {
    const mapa = await this.resolver(periodoLetivoIds, rodada);
    const decisao = mapa.de(orgUnitId);

    if (decisao.candidatas.length > 1) return decisao.candidatas;

    if (decisao.situacao === 'ENCONTRADA') {
      throw new BadRequestException(
        `Esta turma nao esta ambigua: todos os alunos com prova nela sao ` +
          `${decisao.codigo}, e a modalidade ja foi derivada sozinha. So ha o ` +
          'que escolher quando alunos de modalidades diferentes tem prova na ' +
          'mesma turma.',
      );
    }

    throw new BadRequestException(
      'Nenhum agendamento confirmado aponta para esta turma nesta rodada, ' +
        'entao nao ha modalidade nenhuma para escolher — nao e ambiguidade, e ' +
        'ausencia. Se o prazo de agendamento ainda esta aberto, confira de ' +
        'novo depois do fechamento.',
    );
  }

  /** `orgUnitId -> decisao do admin`, para as turmas informadas. */
  private async escolhasDaRodada(
    orgUnitIds: string[],
    rodada: string,
  ): Promise<Map<string, EscolhaDoAdmin>> {
    if (orgUnitIds.length === 0) return new Map();

    const linhas = await this.prisma.modalidadeEscolhidaDaTurma.findMany({
      where: { rodada, orgUnitId: { in: orgUnitIds } },
      include: { modalidade: true },
    });

    return new Map(
      linhas.map((l) => [
        l.orgUnitId,
        {
          modalidadeId: l.modalidadeId,
          codigo: l.modalidade.codigo,
          nome: l.modalidade.nome,
          escolhidaPor: l.escolhidaPor,
          escolhidaEm: l.updatedAt,
        },
      ]),
    );
  }

  /**
   * A regra, isolada: uma modalidade resolve; zero ou duas, nao — a menos que
   * um humano tenha desempatado as duas.
   *
   * ⚠️ **A `escolha` so e consultada no ramo ambiguo.** Nao e economia de
   * codigo: e a regra. Nos outros dois ramos ela seria uma afirmacao pior que a
   * do banco — em `SEM_AGENDAMENTO` nao ha nenhuma reserva para sustenta-la, e
   * na derivacao unanime o dado de agora contradiz a decisao de dias atras.
   */
  private decidir(
    contagens: ContagemPorModalidade[] | undefined,
    escolha: EscolhaDoAdmin | undefined,
  ): ModalidadeDaTurma {
    if (!contagens || contagens.length === 0) {
      return {
        situacao: 'SEM_MODALIDADE',
        motivo: 'SEM_AGENDAMENTO',
        candidatas: [],
        detalhe:
          'Nenhum agendamento confirmado aponta para esta turma na rodada ' +
          'vigente, entao nao ha de onde derivar a modalidade. Ou ninguem ' +
          'agendou ainda, ou a turma do CSV nao tem prova nesta rodada.',
      };
    }

    if (contagens.length > 1) {
      // A escolha so vale se a modalidade escolhida AINDA tem reserva aqui. Uma
      // janela aplicada em nome de quem ninguem cursa fecharia a prova para a
      // turma inteira, e nao so para a minoria.
      const eleita = escolha
        ? contagens.find((c) => c.modalidadeId === escolha.modalidadeId)
        : undefined;

      if (eleita) {
        return {
          situacao: 'ENCONTRADA',
          modalidadeId: eleita.modalidadeId,
          codigo: eleita.codigo,
          nome: eleita.nome,
          reservas: eleita.reservas,
          // `eleita` so existe quando `escolha` existe — o `??` e para o
          // compilador, nao para o runtime.
          escolha: escolha ?? null,
          // A tela precisa das candidatas para poder TROCAR a escolha sem
          // desfaze-la antes.
          candidatas: contagens,
        };
      }

      const detalhado = contagens
        .map((c) => `${c.codigo} (${c.reservas})`)
        .join(', ');

      return {
        situacao: 'SEM_MODALIDADE',
        motivo: 'AMBIGUA',
        candidatas: contagens,
        // NAO escolhe a maioria de proposito. O questionario tem UMA janela, e a
        // minoria ficaria sem conseguir abrir a prova — erro que so apareceria
        // no dia. Mesma regra de ORGUNIT_AMBIGUO.
        //
        // Quando havia uma escolha e ela caducou, dizer isso e o ponto: a turma
        // ja apareceu resolvida na conferencia de ontem, e sumir do painel sem
        // explicacao seria a pior versao deste aviso.
        detalhe:
          `Alunos de ${contagens.length} modalidades tem prova nesta turma: ` +
          `${detalhado}. O questionario tem uma janela so, entao nenhuma foi ` +
          'escolhida.' +
          (escolha
            ? ` A escolha anterior (${escolha.codigo}, de ${escolha.escolhidaPor}) ` +
              'nao vale mais: nenhum aluno dessa modalidade tem prova aqui. ' +
              'Escolha de novo.'
            : ''),
      };
    }

    const unica = contagens[0];

    return {
      situacao: 'ENCONTRADA',
      modalidadeId: unica.modalidadeId,
      codigo: unica.codigo,
      nome: unica.nome,
      reservas: unica.reservas,
      // A derivacao foi unanime: nao houve empate, entao nao ha escolha a
      // exibir nem candidatas a oferecer — mesmo que exista linha gravada.
      escolha: null,
      candidatas: [],
    };
  }
}
