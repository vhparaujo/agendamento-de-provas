import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import {
  D2lGradesService,
  NotaFinalD2L,
} from '../../d2l/service/d2l-grades.service';
import type { FiltroDeNota } from '../../periodo/service/periodo.service';
import type { DisciplinaAgendavel } from '../../turma/service/turma.service';

/**
 * ============================================================================
 * QUEM PODE FAZER A SUBSTITUTIVA
 * ============================================================================
 * A `rodada` deu ao semestre duas janelas — a regular e a substitutiva —, mas as
 * duas ofereciam ao aluno EXATAMENTE as mesmas disciplinas: o cruzamento de
 * `disciplinas-do-aluno` filtra so pelo `periodoLetivoId`, porque "as duas
 * rodadas cobrem as mesmas materias". Este arquivo e a diferenca entre elas.
 *
 * A regra do cliente e **por DISCIPLINA, nao por aluno**: ele agenda a
 * substitutiva das materias em que a nota final esta na faixa da janela. Um
 * aluno com tres materias pode ter uma elegivel e duas nao — e a prova dele
 * cobre so a elegivel.
 *
 * Isso NAO quebra a regra 4 ("um agendamento cobre todas as disciplinas"): a
 * lista encolhe antes de chegar ao aluno, e ele continua sem escolher disciplina
 * por disciplina.
 *
 * ⚠️ **O gatilho e o `FiltroDeNota` da janela, e nunca `rodada === 'SUB'`.**
 * `rodada` e texto livre — quem a nomeia e a secretaria —, entao comparar a
 * string faria a regra parar de valer em silencio no dia em que alguem
 * cadastrasse "Substitutiva" ou "sub". Sem filtro, este servico nao faz uma
 * unica chamada de rede: o caminho da N2 continua custando zero.
 *
 * Ele NAO sabe falar com a Valence (isso e o `D2lGradesService`) e NAO sabe de
 * onde vieram as disciplinas (isso e o `DisciplinasDoAlunoService`). A regra
 * mora aqui, sozinha, e e por isso que ela cabe num teste sem rede.
 */

/** Por que uma disciplina ficou de fora. Vira texto para a secretaria. */
export type MotivoDaRecusa =
  /** Tem nota, mas fora da faixa: ja passou, ou ja reprovou por nota. */
  | 'FORA_DA_FAIXA'
  /** A turma nao lancou nota final para este aluno. */
  | 'SEM_NOTA';

export interface DisciplinaRecusada {
  orgUnitId: string;
  nomeDisciplina: string | null;
  /** A nota lida. `null` quando o motivo e `SEM_NOTA`. */
  nota: number | null;
  motivo: MotivoDaRecusa;
}

export interface DisciplinaComNota extends DisciplinaAgendavel {
  /** `null` quando a janela nao filtra por nota (a N2): nada foi consultado. */
  notaFinal: number | null;
}

export interface ResultadoDaElegibilidade {
  /**
   * As que passaram, com a nota que decidiu — ela vai gravada em
   * `AgendamentoDisciplina.notaFinal` como fotografia.
   */
  elegiveis: DisciplinaComNota[];
  recusadas: DisciplinaRecusada[];
}

/**
 * Por quanto tempo a nota lida fica em memoria.
 *
 * O portal pergunta as disciplinas (`GET /portal/disciplinas`) e, segundos
 * depois, confirma o agendamento (`POST /portal/agendamentos`) — que refaz o
 * cruzamento inteiro, de proposito, para nao confiar no que a tela mandou. Sem
 * cache, cada prova marcada custa o DOBRO das chamadas de nota, e o aluno espera
 * duas vezes.
 *
 * Curto porque nota muda: o professor lanca uma pendencia e o aluno que estava
 * fora entra. Cinco minutos e menos que o tempo de um atendimento na secretaria.
 */
const CACHE_MS = 5 * 60_000;

/**
 * A Valence caiu e a janela filtra por nota. Mensagem PROPRIA de proposito: a de
 * "nenhuma disciplina sua aparece no periodo letivo" mandaria o aluno cobrar a
 * secretaria por um problema que e nosso, e ela procuraria defeito no CSV.
 */
export const NOTAS_INDISPONIVEIS =
  'Nao foi possivel confirmar suas notas no Brightspace agora, e a prova ' +
  'substitutiva depende delas. Tente de novo em alguns minutos; se continuar, ' +
  'procure a secretaria academica.';

@Injectable()
export class ElegibilidadeDeNotaService {
  private readonly logger = new Logger(ElegibilidadeDeNotaService.name);

  /** Nota por `orgUnitId + userId`. Ver `CACHE_MS`. */
  private cache = new Map<string, { nota: NotaFinalD2L; expiraEmMs: number }>();

  constructor(private readonly grades: D2lGradesService) {}

  /**
   * ==========================================================================
   * O FILTRO
   * ==========================================================================
   * `filtro === null` devolve tudo intacto e **sem uma unica chamada de rede** —
   * e o caminho da N2, e ele precisa continuar custando zero. As disciplinas
   * saem com `notaFinal: null`, que e a verdade: nada foi consultado.
   *
   * **Erro da Valence SOBE.** Nao ha degradacao possivel aqui: liberar sem
   * conferir nota e exatamente o que esta regra existe para impedir, e devolver
   * lista vazia mandaria o aluno a secretaria por um problema de rede. Quem
   * traduz o erro para o aluno e o `DisciplinasDoAlunoService`; quem o registra
   * como reprocessavel e o compulsorio.
   */
  async filtrar(
    userIdD2L: string,
    disciplinas: DisciplinaAgendavel[],
    filtro: FiltroDeNota | null,
  ): Promise<ResultadoDaElegibilidade> {
    if (!filtro) {
      return {
        elegiveis: disciplinas.map((d) => ({ ...d, notaFinal: null })),
        recusadas: [],
      };
    }

    const elegiveis: DisciplinaComNota[] = [];
    const recusadas: DisciplinaRecusada[] = [];

    for (const disciplina of disciplinas) {
      const nota = await this.notaDe(disciplina.orgUnitId, userIdD2L);

      if (nota.situacao === 'SEM_NOTA') {
        recusadas.push({
          orgUnitId: disciplina.orgUnitId,
          nomeDisciplina: disciplina.nomeDisciplina,
          nota: null,
          motivo: 'SEM_NOTA',
        });
        continue;
      }

      if (!dentroDaFaixa(nota.pontos, filtro)) {
        recusadas.push({
          orgUnitId: disciplina.orgUnitId,
          nomeDisciplina: disciplina.nomeDisciplina,
          nota: nota.pontos,
          motivo: 'FORA_DA_FAIXA',
        });
        continue;
      }

      elegiveis.push({ ...disciplina, notaFinal: nota.pontos });
    }

    this.logger.debug(
      `Aluno ${userIdD2L}: ${elegiveis.length} de ${disciplinas.length} ` +
        `disciplina(s) na faixa [${filtro.minima}; ${filtro.maxima}).`,
    );

    return { elegiveis, recusadas };
  }

  /**
   * ==========================================================================
   * O LOTE LE A TURMA INTEIRA ANTES DE COMECAR
   * ==========================================================================
   * Com uma chamada por (aluno x disciplina), o compulsorio de uma substitutiva
   * faria dezenas de milhares de requisicoes para ler dados que se repetem — a
   * mesma turma aparece para todos os alunos dela. Aqui e UMA por turma, e o
   * `filtrar` de cada aluno passa a ser leitura de memoria.
   *
   * **Falha de UMA turma nao derruba o pre-aquecimento.** Ela fica de fora do
   * cache e volta a ser consultada aluno a aluno em `notaDe` — mais lento, mas
   * correto. Deixar o erro subir aqui pararia o lote inteiro por causa de uma
   * turma, e lote parado e o que o compulsorio mais evita.
   *
   * NAO e chamado pelo portal: baixar a turma inteira para responder a um aluno
   * poria centenas de alunos na frente dele na primeira consulta do dia.
   */
  async preAquecer(
    orgUnitIds: string[],
    ritmo: { atrasoMs?: number; timeoutMs?: number } = {},
  ): Promise<{ turmas: number; falhas: number }> {
    let turmas = 0;
    let falhas = 0;

    for (const orgUnitId of [...new Set(orgUnitIds)]) {
      try {
        const notas = await this.grades.notasFinaisDaTurma(orgUnitId, ritmo);

        for (const [userId, nota] of notas) {
          this.guardar(orgUnitId, userId, nota);
        }

        turmas += 1;
      } catch (erro) {
        falhas += 1;

        this.logger.warn(
          `Nao foi possivel ler as notas da turma ${orgUnitId} de uma vez; ` +
            'os alunos dela serao consultados um a um. Causa: ' +
            (erro instanceof Error ? erro.message : String(erro)),
        );
      }
    }

    this.logger.log(
      `Notas pre-carregadas: ${turmas} turma(s), ${falhas} falha(s).`,
    );

    return { turmas, falhas };
  }

  /** Esvazia o cache. Existe para um lote nao herdar notas de outra execucao. */
  esquecer(): void {
    this.cache.clear();
  }

  /** Enquanto `false`, nenhuma janela deveria ter filtro de nota configurado. */
  habilitado(): boolean {
    return this.grades.habilitado();
  }

  /** A nota de um aluno numa turma, do cache ou da Valence. */
  private async notaDe(
    orgUnitId: string,
    userIdD2L: string,
  ): Promise<NotaFinalD2L> {
    const chave = chaveDaNota(orgUnitId, userIdD2L);
    const emCache = this.cache.get(chave);

    if (emCache && emCache.expiraEmMs > Date.now()) return emCache.nota;

    const nota = await this.grades.notaFinal(orgUnitId, userIdD2L);

    this.guardar(orgUnitId, userIdD2L, nota);

    return nota;
  }

  private guardar(
    orgUnitId: string,
    userIdD2L: string,
    nota: NotaFinalD2L,
  ): void {
    this.cache.set(chaveDaNota(orgUnitId, userIdD2L), {
      nota,
      expiraEmMs: Date.now() + CACHE_MS,
    });
  }
}

/**
 * A faixa e FECHADA no piso e ABERTA no teto: `>= minima` e `< maxima`.
 *
 * A assimetria e a regra, nao um detalhe de implementacao. Com 1,5 e 6,75: quem
 * tirou exatamente 1,50 ainda tem chance e ENTRA; quem tirou exatamente 6,75 ja
 * alcancou a media e FICA DE FORA. Trocar um dos dois operadores muda a vida de
 * quem esta na fronteira, e ninguem perceberia lendo o resultado.
 */
function dentroDaFaixa(nota: number, filtro: FiltroDeNota): boolean {
  return nota >= filtro.minima && nota < filtro.maxima;
}

/**
 * A chave do cache.
 *
 * O separador e um caractere que nao aparece em id nenhum (os dois sao
 * numericos): sem ele, `("1", "23")` e `("12", "3")` colidiriam — e a colisao
 * daria a nota de um aluno a outro, sem erro nenhum.
 */
function chaveDaNota(orgUnitId: string, userIdD2L: string): string {
  return `${orgUnitId}|${userIdD2L}`;
}

/**
 * A frase que o aluno le quando NENHUMA disciplina dele passou pela faixa.
 *
 * Ela existe porque o motivo generico do cruzamento ("nenhuma disciplina sua
 * aparece no periodo letivo") mandaria a secretaria conferir o CSV de turmas — e
 * aqui nao ha nada para conferir: o aluno passou de ano, ou ja reprovou por
 * nota. Diz o QUE aconteceu sem expor a nota na tela de agendamento.
 */
export function motivoDeNenhumaElegivel(
  recusadas: DisciplinaRecusada[],
  filtro: FiltroDeNota,
): string {
  const semNota = recusadas.filter((r) => r.motivo === 'SEM_NOTA').length;

  // Sem nota lancada e um caso de secretaria, e nao "voce nao tem direito": a
  // turma pode simplesmente nao ter fechado as notas ainda. Misturar as duas
  // frases faria o aluno desistir de perguntar.
  if (semNota > 0 && semNota === recusadas.length) {
    return (
      'Suas disciplinas ainda nao tem nota final lancada no Brightspace, e a ' +
      'prova substitutiva depende dela. Procure a secretaria academica.'
    );
  }

  const base =
    'Nenhuma das suas disciplinas esta na faixa de nota da prova substitutiva ' +
    `(de ${formatarNota(filtro.minima)} a menos de ${formatarNota(filtro.maxima)}).`;

  if (semNota > 0) {
    return (
      `${base} Parte delas ainda esta sem nota final lancada — se for o seu ` +
      'caso, procure a secretaria academica.'
    );
  }

  return `${base} Se voce discorda da nota, procure a secretaria academica.`;
}

/** "1.5" vira "1,50" — e a tela do aluno, nao um log. */
function formatarNota(valor: number): string {
  return valor.toFixed(2).replace('.', ',');
}

/** Ver `NOTAS_INDISPONIVEIS`: a Valence caiu e a janela depende dela. */
export function notasIndisponiveis(erro: unknown): BadGatewayException {
  return new BadGatewayException(
    `${NOTAS_INDISPONIVEIS} (${erro instanceof Error ? erro.message : String(erro)})`,
  );
}
