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
 * A regra do cliente (08/09/2026) sao DOIS criterios sobre notas DIFERENTES, e
 * a disciplina so entra quando passa nos dois:
 *
 * | Criterio | Nota olhada | Comparacao | Por que |
 * |---|---|---|---|
 * | piso  | **N1** | `>= minimaN1` (1,50) | quem nem isso fez ja reprovou |
 * | teto  | **nota final calculada** | `< maximaFinal` (7,00) | quem alcancou a media ja passou |
 *
 * ⚠️ **Nao e mais uma faixa sobre um numero so.** Ate 08/09/2026 os dois limites
 * comparavam a MESMA nota (a final, em `[1,5 ; 6,75)`); hoje o piso mudou de
 * nota. Ler `minimaN1` como piso da final volta a liberar quem tem final 2,0 com
 * N1 zerada — e o resultado continua "parecendo certo" na tela.
 *
 * A regra e **por DISCIPLINA, nao por aluno**: um aluno com tres materias pode
 * ter uma elegivel e duas nao, e a prova dele cobre so a elegivel. Isso NAO
 * quebra a regra 4 ("um agendamento cobre todas as disciplinas"): a lista
 * encolhe antes de chegar ao aluno, e ele continua sem escolher disciplina por
 * disciplina.
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
  /** Nota final >= o teto: o aluno ja alcancou a media e passou. */
  | 'FINAL_ATINGIU_A_MEDIA'
  /** N1 abaixo do piso: nao ha substitutiva que salve o semestre. */
  | 'N1_ABAIXO_DO_MINIMO'
  /** A turma nao lancou nota final para este aluno. */
  | 'SEM_NOTA_FINAL'
  /** A turma tem a categoria N1, mas este aluno nao tem nota nela. */
  | 'SEM_NOTA_N1'
  /** A turma inteira nao tem categoria N1: e problema de montagem da turma. */
  | 'SEM_CATEGORIA_N1';

export interface DisciplinaRecusada {
  orgUnitId: string;
  nomeDisciplina: string | null;
  /** A nota final lida. `null` quando ela e que faltou. */
  notaFinal: number | null;
  /** A N1 lida. `null` quando a recusa aconteceu antes de chegar nela. */
  notaN1: number | null;
  motivo: MotivoDaRecusa;
}

export interface DisciplinaComNota extends DisciplinaAgendavel {
  /** `null` quando a janela nao filtra por nota (a N2): nada foi consultado. */
  notaFinal: number | null;
  /** Idem. As DUAS decidem, entao as DUAS viram fotografia no agendamento. */
  notaN1: number | null;
}

export interface ResultadoDaElegibilidade {
  /**
   * As que passaram, com as notas que decidiram — elas vao gravadas em
   * `AgendamentoDisciplina.notaFinal` e `.notaN1` como fotografia.
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
 * duas vezes. Com dois criterios, esse dobro tambem dobrou.
 *
 * Curto porque nota muda: o professor lanca uma pendencia e o aluno que estava
 * fora entra. Cinco minutos e menos que o tempo de um atendimento na secretaria.
 */
const CACHE_MS = 5 * 60_000;

/** Identifica a nota FINAL no cache — nunca colide com um `CategoryId`. */
const ALVO_FINAL = 'final';

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

  /** Nota por `orgUnitId + userId + alvo`. Ver `CACHE_MS` e `chaveDaNota`. */
  private cache = new Map<string, { nota: NotaFinalD2L; expiraEmMs: number }>();

  constructor(private readonly grades: D2lGradesService) {}

  /**
   * ==========================================================================
   * O FILTRO
   * ==========================================================================
   * `filtro === null` devolve tudo intacto e **sem uma unica chamada de rede** —
   * e o caminho da N2, e ele precisa continuar custando zero. As disciplinas
   * saem com as duas notas em `null`, que e a verdade: nada foi consultado.
   *
   * **A ordem das leituras e deliberada: nota final primeiro, N1 depois.** A
   * maioria dos alunos de uma turma passou de ano, e esses saem no primeiro
   * criterio — checar a N1 antes faria o portal pagar DUAS chamadas por
   * disciplina para todo mundo, quando uma ja resolve. O efeito colateral e bom:
   * a recusa mais comum ja sai com a nota final preenchida, que e o numero que a
   * secretaria pede quando o aluno reclama.
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
        elegiveis: disciplinas.map((d) => ({
          ...d,
          notaFinal: null,
          notaN1: null,
        })),
        recusadas: [],
      };
    }

    const elegiveis: DisciplinaComNota[] = [];
    const recusadas: DisciplinaRecusada[] = [];

    for (const disciplina of disciplinas) {
      const recusa = (motivo: MotivoDaRecusa, notas: Notas) =>
        recusadas.push({
          orgUnitId: disciplina.orgUnitId,
          nomeDisciplina: disciplina.nomeDisciplina,
          notaFinal: notas.final,
          notaN1: notas.n1,
          motivo,
        });

      const final = await this.notaFinalDe(disciplina.orgUnitId, userIdD2L);

      if (final.situacao === 'SEM_NOTA') {
        recusa('SEM_NOTA_FINAL', { final: null, n1: null });
        continue;
      }

      if (final.pontos >= filtro.maximaFinal) {
        recusa('FINAL_ATINGIU_A_MEDIA', { final: final.pontos, n1: null });
        continue;
      }

      const n1 = await this.notaN1De(disciplina.orgUnitId, userIdD2L);

      if (n1 === 'SEM_CATEGORIA') {
        recusa('SEM_CATEGORIA_N1', { final: final.pontos, n1: null });
        continue;
      }

      if (n1.situacao === 'SEM_NOTA') {
        recusa('SEM_NOTA_N1', { final: final.pontos, n1: null });
        continue;
      }

      if (n1.pontos < filtro.minimaN1) {
        recusa('N1_ABAIXO_DO_MINIMO', { final: final.pontos, n1: n1.pontos });
        continue;
      }

      elegiveis.push({
        ...disciplina,
        notaFinal: final.pontos,
        notaN1: n1.pontos,
      });
    }

    this.logger.debug(
      `Aluno ${userIdD2L}: ${elegiveis.length} de ${disciplinas.length} ` +
        `disciplina(s) com N1 >= ${filtro.minimaN1} e final < ${filtro.maximaFinal}.`,
    );

    return { elegiveis, recusadas };
  }

  /**
   * ==========================================================================
   * O LOTE LE A TURMA INTEIRA ANTES DE COMECAR
   * ==========================================================================
   * Com uma chamada por (aluno x disciplina), o compulsorio de uma substitutiva
   * faria dezenas de milhares de requisicoes para ler dados que se repetem — a
   * mesma turma aparece para todos os alunos dela. Aqui sao DUAS por turma (a
   * final e a N1), e o `filtrar` de cada aluno passa a ser leitura de memoria.
   *
   * **Falha de UMA turma nao derruba o pre-aquecimento.** Ela fica de fora do
   * cache e volta a ser consultada aluno a aluno em `notaFinalDe`/`notaN1De` —
   * mais lento, mas correto. Deixar o erro subir aqui pararia o lote inteiro por
   * causa de uma turma, e lote parado e o que o compulsorio mais evita.
   *
   * A turma SEM categoria N1 nao e falha: ela nao tem o que pre-carregar, e cada
   * aluno dela vai ser recusado com `SEM_CATEGORIA_N1` (o aviso no log sai uma
   * vez, do `D2lGradesService`). Contar isso como falha esconderia as falhas de
   * verdade, que sao as de rede.
   *
   * NAO e chamado pelo portal: baixar a turma inteira para responder a um aluno
   * poria centenas de alunos na frente dele na primeira consulta do dia.
   */
  async preAquecer(
    orgUnitIds: string[],
    ritmo: { atrasoMs?: number; timeoutMs?: number } = {},
  ): Promise<{ turmas: number; falhas: number; semN1: number }> {
    let turmas = 0;
    let falhas = 0;
    let semN1 = 0;

    for (const orgUnitId of [...new Set(orgUnitIds)]) {
      try {
        const finais = await this.grades.notasFinaisDaTurma(orgUnitId, ritmo);

        for (const [userId, nota] of finais) {
          this.guardar(orgUnitId, userId, ALVO_FINAL, nota);
        }

        const categoriaN1 = await this.grades.categoriaPorNome(
          orgUnitId,
          this.grades.nomeDaCategoriaN1(),
          ritmo,
        );

        if (categoriaN1 === null) {
          semN1 += 1;
          turmas += 1;
          continue;
        }

        const notasN1 = await this.grades.notasDeGradeObjectDaTurma(
          orgUnitId,
          categoriaN1,
          ritmo,
        );

        for (const [userId, nota] of notasN1) {
          this.guardar(orgUnitId, userId, categoriaN1, nota);
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
      `Notas pre-carregadas: ${turmas} turma(s), ${falhas} falha(s), ` +
        `${semN1} sem categoria N1.`,
    );

    return { turmas, falhas, semN1 };
  }

  /** Esvazia o cache. Existe para um lote nao herdar notas de outra execucao. */
  esquecer(): void {
    this.cache.clear();
  }

  /** Enquanto `false`, nenhuma janela deveria ter filtro de nota configurado. */
  habilitado(): boolean {
    return this.grades.habilitado();
  }

  /** A nota final de um aluno numa turma, do cache ou da Valence. */
  private async notaFinalDe(
    orgUnitId: string,
    userIdD2L: string,
  ): Promise<NotaFinalD2L> {
    return this.doCacheOu(orgUnitId, userIdD2L, ALVO_FINAL, () =>
      this.grades.notaFinal(orgUnitId, userIdD2L),
    );
  }

  /**
   * A N1 de um aluno numa turma — ou `'SEM_CATEGORIA'`, que nao e nota nenhuma.
   *
   * Os dois "nao tem" sao SEPARADOS de proposito: turma sem categoria N1 e um
   * defeito de montagem que atinge a turma inteira e se conserta no Brightspace;
   * aluno sem nota na N1 e um caso individual, e pode ser so a pendencia que o
   * professor ainda nao lancou. Misturar os dois daria a mesma frase para quem
   * precisa de acoes diferentes.
   */
  private async notaN1De(
    orgUnitId: string,
    userIdD2L: string,
  ): Promise<NotaFinalD2L | 'SEM_CATEGORIA'> {
    const categoria = await this.grades.categoriaPorNome(
      orgUnitId,
      this.grades.nomeDaCategoriaN1(),
    );

    if (categoria === null) return 'SEM_CATEGORIA';

    return this.doCacheOu(orgUnitId, userIdD2L, categoria, () =>
      this.grades.notaDeGradeObject(orgUnitId, categoria, userIdD2L),
    );
  }

  private async doCacheOu(
    orgUnitId: string,
    userIdD2L: string,
    alvo: string,
    ler: () => Promise<NotaFinalD2L>,
  ): Promise<NotaFinalD2L> {
    const chave = chaveDaNota(orgUnitId, userIdD2L, alvo);
    const emCache = this.cache.get(chave);

    if (emCache && emCache.expiraEmMs > Date.now()) return emCache.nota;

    const nota = await ler();

    this.guardar(orgUnitId, userIdD2L, alvo, nota);

    return nota;
  }

  private guardar(
    orgUnitId: string,
    userIdD2L: string,
    alvo: string,
    nota: NotaFinalD2L,
  ): void {
    this.cache.set(chaveDaNota(orgUnitId, userIdD2L, alvo), {
      nota,
      expiraEmMs: Date.now() + CACHE_MS,
    });
  }
}

/** As duas notas de uma disciplina, do jeito que a recusa as registra. */
interface Notas {
  final: number | null;
  n1: number | null;
}

/**
 * A chave do cache.
 *
 * O separador e um caractere que nao aparece em id nenhum (os tres sao
 * numericos, ou a constante `final`): sem ele, `("1", "23")` e `("12", "3")`
 * colidiriam — e a colisao daria a nota de um aluno a outro, sem erro nenhum.
 * O `alvo` entrou junto com a N1: sem ele, a N1 e a nota final do mesmo aluno na
 * mesma turma dividiriam a chave, e a segunda leitura devolveria a primeira.
 */
function chaveDaNota(
  orgUnitId: string,
  userIdD2L: string,
  alvo: string,
): string {
  return `${orgUnitId}|${userIdD2L}|${alvo}`;
}

/**
 * A frase que o aluno le quando NENHUMA disciplina dele passou pelos criterios.
 *
 * Ela existe porque o motivo generico do cruzamento ("nenhuma disciplina sua
 * aparece no periodo letivo") mandaria a secretaria conferir o CSV de turmas — e
 * na maioria destes casos nao ha nada para conferir: o aluno passou de ano, ou
 * ja reprovou pela N1.
 *
 * A frase escolhida e a do motivo que EXPLICA o caso todo; havendo mistura, a
 * regra fica visivel e o resto vira um "parte delas". Nota nenhuma aparece na
 * tela de agendamento — quem quiser o numero pede na secretaria, que o tem no
 * relatorio.
 */
export function motivoDeNenhumaElegivel(
  recusadas: DisciplinaRecusada[],
  filtro: FiltroDeNota,
): string {
  const quantos = (motivo: MotivoDaRecusa) =>
    recusadas.filter((r) => r.motivo === motivo).length;

  const semNota = quantos('SEM_NOTA_FINAL') + quantos('SEM_NOTA_N1');
  const semCategoria = quantos('SEM_CATEGORIA_N1');

  // Turma sem categoria N1 e defeito de montagem, e nao "voce nao tem direito":
  // dizer ao aluno que ele nao esta na faixa seria mentir, e ele nao tem como
  // descobrir sozinho que o problema esta na turma.
  if (semCategoria > 0 && semCategoria === recusadas.length) {
    return (
      'Suas disciplinas estao sem a nota N1 configurada no Brightspace, e a ' +
      'prova substitutiva depende dela. Procure a secretaria academica.'
    );
  }

  // Sem nota lancada tambem e caso de secretaria: a turma pode simplesmente nao
  // ter fechado as notas ainda. Misturar com a frase da regra faria o aluno
  // desistir de perguntar.
  if (semNota > 0 && semNota === recusadas.length) {
    return (
      'Suas disciplinas ainda estao sem nota lancada no Brightspace (a N1 ou a ' +
      'nota final), e a prova substitutiva depende delas. Procure a secretaria ' +
      'academica.'
    );
  }

  const base =
    'Nenhuma das suas disciplinas atende aos criterios da prova substitutiva: ' +
    `e preciso ter N1 de pelo menos ${formatarNota(filtro.minimaN1)} e nota ` +
    `final abaixo de ${formatarNota(filtro.maximaFinal)}.`;

  if (semNota > 0 || semCategoria > 0) {
    return (
      `${base} Parte delas ainda esta sem nota lancada — se for o seu caso, ` +
      'procure a secretaria academica.'
    );
  }

  return `${base} Se voce discorda das notas, procure a secretaria academica.`;
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
