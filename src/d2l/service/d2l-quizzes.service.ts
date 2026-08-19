import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { carregarD2lApiConfig } from '../config/d2l.config';
import { D2lHttpService, OpcoesChamadaD2L } from './d2l-http.service';

/**
 * ============================================================================
 * QUIZZES DA VALENCE — cliente REST puro
 * ============================================================================
 * Sem regra de negocio nenhuma: lista, le e grava. Quem decide qual quiz e a
 * prova, qual senha entra e o que fazer quando nada casa e o `src/senha-quiz`.
 * Mesma divisao que o `D2lEnrollmentsService` ja segue.
 *
 * ⚠️ **O PUT SUBSTITUI O OBJETO INTEIRO.** Nao existe patch parcial nesta API:
 * campo que nao volta no corpo e campo APAGADO. `gravarQuiz` recebe o corpo
 * pronto de `montarCorpoDoQuiz`, que remonta os ~35 campos a partir do GET — e
 * la esta o teste de cobertura que impede alguem de perder um deles.
 */

/** Um quiz como a LISTAGEM o devolve (o resto vem no GET individual). */
export interface QuizDaLista {
  QuizId?: number | string;
  Name?: string;
}

/** Uma pagina de `ObjectListPage`. */
interface PaginaDeQuizzes {
  Objects?: QuizDaLista[];
  /** URL/caminho da proxima pagina; carrega o bookmark na query string. */
  Next?: string | null;
}

export interface OpcoesDeRitmo {
  atrasoMs?: number;
  timeoutMs?: number;
  maxPaginas?: number;
}

@Injectable()
export class D2lQuizzesService {
  private readonly logger = new Logger(D2lQuizzesService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly http: D2lHttpService,
  ) {}

  /**
   * TODOS os quizzes da turma, seguindo a paginacao ate o fim.
   *
   * ⚠️ **Nao simplifique isto para uma chamada so.** Foi exatamente essa a
   * diferenca entre o CLI de origem e o projeto irmao `brightspace-bulk-dates`:
   * la o `asList` lia apenas `Objects` e ignorava o `Next`, entao uma turma com
   * muitos questionarios simplesmente NAO trazia a prova — sem erro, sem aviso,
   * e a turma ficava sem senha no dia.
   *
   * Do `Next` reaproveitamos so a QUERY STRING (que carrega o bookmark), para a
   * chamada seguinte continuar passando pelo mesmo caminho de token, atraso e
   * retry de 429. Duas travas contra laco infinito: o teto de paginas e o
   * bookmark repetido — o segundo importa porque o laco so termina quando o
   * SERVIDOR diz que terminou.
   */
  async listarQuizzes(
    orgUnitId: string,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<QuizDaLista[]> {
    const cfg = this.http.exigirConfigurado();
    const maxPaginas = ritmo.maxPaginas ?? 50;

    const encontrados: QuizDaLista[] = [];
    let queryString = '';

    for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
      const url =
        this.http.url(cfg, 'le', `${encodeURIComponent(orgUnitId)}/quizzes/`) +
        queryString;

      const dados = await this.http.chamarUrl<
        PaginaDeQuizzes | QuizDaLista[] | null
      >(url, this.opcoes(`os questionarios da turma ${orgUnitId}`, ritmo));

      // Resposta sem paginacao: algumas versoes devolvem o array direto.
      if (Array.isArray(dados)) return encontrados.concat(dados);
      if (!dados) return encontrados;

      encontrados.push(...(dados.Objects ?? []));

      const proxima = dados.Next;
      if (!proxima) return encontrados;

      const inicioDaQuery = String(proxima).indexOf('?');
      if (inicioDaQuery === -1) return encontrados;

      const seguinte = String(proxima).slice(inicioDaQuery);
      if (seguinte === queryString) return encontrados; // bookmark travado
      queryString = seguinte;
    }

    this.logger.warn(
      `Listagem de questionarios da turma ${orgUnitId} interrompida em ` +
        `${maxPaginas} paginas. A prova pode nao ter sido alcancada.`,
    );

    return encontrados;
  }

  /** O `QuizReadData` completo — a base obrigatoria do PUT. */
  async lerQuiz<T>(
    orgUnitId: string,
    quizId: string,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<T> {
    const cfg = this.http.exigirConfigurado();

    return this.http.chamar<T>(
      cfg,
      'le',
      `${encodeURIComponent(orgUnitId)}/quizzes/${encodeURIComponent(quizId)}`,
      this.opcoes(`o questionario ${quizId} da turma ${orgUnitId}`, ritmo),
    );
  }

  /** Substitui o quiz. O corpo tem de estar COMPLETO — ver o aviso no topo. */
  async gravarQuiz(
    orgUnitId: string,
    quizId: string,
    corpo: unknown,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<void> {
    const cfg = this.http.exigirConfigurado();

    await this.http.chamar(
      cfg,
      'le',
      `${encodeURIComponent(orgUnitId)}/quizzes/${encodeURIComponent(quizId)}`,
      {
        ...this.opcoes(`o questionario ${quizId} da turma ${orgUnitId}`, ritmo),
        metodo: 'PUT',
        corpo,
      },
    );
  }

  /** Enquanto `false`, nenhuma chamada de rede deve sair daqui. */
  habilitado(): boolean {
    return this.http.habilitado();
  }

  /** A versao da API LE em uso — entra no diagnostico da tela e do log. */
  versaoDaApi(): string {
    return carregarD2lApiConfig(this.config).apiVersaoLe;
  }

  /**
   * As opcoes comuns a toda chamada deste servico.
   *
   * `retentar429` fica LIGADO aqui e desligado no enrollments: o lote pode se dar
   * ao luxo de esperar, o portal do aluno nao. O PUT e idempotente (o mesmo corpo
   * produz o mesmo estado), entao repetir e seguro.
   */
  private opcoes(oQue: string, ritmo: OpcoesDeRitmo): OpcoesChamadaD2L {
    return {
      oQue,
      atrasoMs: ritmo.atrasoMs,
      timeoutMs: ritmo.timeoutMs,
      retentar429: true,
      dicaDe404:
        'Confira se a turma ainda existe neste tenant e se o usuario da ' +
        'integracao enxerga os questionarios dela.',
    };
  }
}
