import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { StatusAgendamento } from '../../generated/prisma/client';

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

/** A resposta para UMA turma. */
export type ModalidadeDaTurma =
  | {
      situacao: 'ENCONTRADA';
      modalidadeId: number;
      codigo: string;
      nome: string;
      reservas: number;
    }
  | {
      situacao: 'SEM_MODALIDADE';
      motivo: MotivoSemModalidade;
      /** Vazio em `SEM_AGENDAMENTO`; 2+ entradas em `AMBIGUA`. */
      candidatas: ContagemPorModalidade[];
      /** Frase pronta para o relatorio. */
      detalhe: string;
    };

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

  constructor(private readonly prisma: PrismaService) {}

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
   * `status = CONFIRMADO` pelo mesmo motivo de toda contagem do projeto: quem
   * cancelou devolveu a vaga e nao vai fazer a prova, entao a modalidade dele
   * nao diz nada sobre esta turma.
   */
  async resolver(
    periodoLetivoId: string,
    rodada: string,
  ): Promise<MapaDeModalidades> {
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
         AND a.periodoLetivoId = ${periodoLetivoId}
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

    this.logger.log(
      `Modalidade por turma: ${porTurma.size} turma(s) com agendamento confirmado ` +
        `em ${periodoLetivoId}/${rodada}; ${ambiguas} com mais de uma modalidade.`,
    );

    return {
      totalComAgendamento: porTurma.size,
      de: (orgUnitId) => this.decidir(porTurma.get(orgUnitId)),
    };
  }

  /** A regra, isolada: uma modalidade resolve; zero ou duas, nao. */
  private decidir(
    contagens: ContagemPorModalidade[] | undefined,
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
        detalhe:
          `Alunos de ${contagens.length} modalidades tem prova nesta turma: ` +
          `${detalhado}. O questionario tem uma janela so, entao nenhuma foi ` +
          'escolhida.',
      };
    }

    const unica = contagens[0];

    return {
      situacao: 'ENCONTRADA',
      modalidadeId: unica.modalidadeId,
      codigo: unica.codigo,
      nome: unica.nome,
      reservas: unica.reservas,
    };
  }
}
