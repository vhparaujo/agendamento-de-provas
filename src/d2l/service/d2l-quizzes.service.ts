import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { carregarD2lApiConfig } from '../config/d2l.config';
import {
  D2lHttpService,
  NaoEncontradoNoBrightspace,
  OpcoesChamadaD2L,
} from './d2l-http.service';

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
  /**
   * A listagem traz o `QuizReadData` inteiro. O lote de special access so le
   * este campo dela, para avisar quando a prova ainda esta aberta a turma toda.
   */
  AllowOnlyUsersWithSpecialAccess?: unknown;
}

/** `Quiz.SpecialAccessUserData`, como a listagem de special access devolve. */
export interface AcessoEspecialDaLista {
  UserId?: number | string | null;
  SpecialAccess?: {
    StartDate?: string | null;
    EndDate?: string | null;
    SubmissionTimeLimit?: {
      IsEnforced?: boolean | null;
      TimeLimitValue?: number | null;
    } | null;
  } | null;
}

/** Uma pagina de `ObjectListPage`. */
interface Pagina<T> {
  Objects?: T[];
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
    return this.paginar<QuizDaLista>(
      `${encodeURIComponent(orgUnitId)}/quizzes/`,
      `os questionários da turma ${orgUnitId}`,
      ritmo,
    );
  }

  /**
   * TODOS os special access de um questionario, seguindo a paginacao.
   *
   * E a leitura que faz o lote gravar so a diferenca: sem ela, cada execucao
   * reescreveria o acesso de todos os alunos de novo.
   */
  async listarAcessosEspeciais(
    orgUnitId: string,
    quizId: string,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<AcessoEspecialDaLista[]> {
    return this.paginar<AcessoEspecialDaLista>(
      `${encodeURIComponent(orgUnitId)}/quizzes/${encodeURIComponent(quizId)}/specialaccess/`,
      `os acessos especiais do questionário ${quizId} da turma ${orgUnitId}`,
      ritmo,
    );
  }

  /**
   * Cria ou substitui o special access de UM aluno. E um recurso separado do
   * questionario: nao passa por `montarCorpoDoQuiz` e nao apaga senha nem data.
   *
   * 404 sobe como `NaoEncontradoNoBrightspace`. Com o questionario ja achado na
   * listagem, quase sempre e "este usuario nao e aluno da turma".
   */
  async gravarAcessoEspecial(
    orgUnitId: string,
    quizId: string,
    userId: number,
    corpo: unknown,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<void> {
    const cfg = this.http.exigirConfigurado();

    await this.http.chamar(
      cfg,
      'le',
      this.caminhoDoAcesso(orgUnitId, quizId, userId),
      {
        ...this.opcoes(
          `o acesso especial do usuário ${userId} no questionário ${quizId} da turma ${orgUnitId}`,
          ritmo,
        ),
        dicaDe404:
          'Com o questionário já encontrado, isto costuma ser o aluno fora da ' +
          'turma no AVA.',
        metodo: 'PUT',
        corpo,
      },
    );
  }

  /**
   * Remove o special access de UM aluno. `false` quando nao havia o que remover.
   *
   * ⚠️ Escopo proprio: `quizzing:quizzes:delete`, que o `read,write` da troca de
   * senha NAO cobre. Sem reautorizar, toda remocao volta 403.
   *
   * O 404 nao usa `nuloEm404` de proposito: o DELETE bem-sucedido tambem
   * responde sem corpo, e os dois virariam o mesmo `null`.
   */
  async removerAcessoEspecial(
    orgUnitId: string,
    quizId: string,
    userId: number,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<boolean> {
    const cfg = this.http.exigirConfigurado();

    try {
      await this.http.chamar(
        cfg,
        'le',
        this.caminhoDoAcesso(orgUnitId, quizId, userId),
        {
          ...this.opcoes(
            `o acesso especial do usuário ${userId} no questionário ${quizId} da turma ${orgUnitId}`,
            ritmo,
          ),
          metodo: 'DELETE',
        },
      );
      return true;
    } catch (erro) {
      if (erro instanceof NaoEncontradoNoBrightspace) return false;
      throw erro;
    }
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
      this.opcoes(`o questionário ${quizId} da turma ${orgUnitId}`, ritmo),
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
        ...this.opcoes(`o questionário ${quizId} da turma ${orgUnitId}`, ritmo),
        metodo: 'PUT',
        corpo,
      },
    );
  }

  /**
   * Uma listagem inteira de `ObjectListPage`, seguindo o `Next` ate o fim.
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
  private async paginar<T>(
    caminho: string,
    oQue: string,
    ritmo: OpcoesDeRitmo,
  ): Promise<T[]> {
    const cfg = this.http.exigirConfigurado();
    const maxPaginas = ritmo.maxPaginas ?? 50;

    const encontrados: T[] = [];
    let queryString = '';

    for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
      const url = this.http.url(cfg, 'le', caminho) + queryString;

      const dados = await this.http.chamarUrl<Pagina<T> | T[] | null>(
        url,
        this.opcoes(oQue, ritmo),
      );

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
      `Listagem de ${oQue} interrompida em ${maxPaginas} paginas. ` +
        'Parte dela pode nao ter sido alcancada.',
    );

    return encontrados;
  }

  private caminhoDoAcesso(
    orgUnitId: string,
    quizId: string,
    userId: number,
  ): string {
    return (
      `${encodeURIComponent(orgUnitId)}/quizzes/${encodeURIComponent(quizId)}` +
      `/specialaccess/${encodeURIComponent(String(userId))}`
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
        'Confira se a turma ainda existe neste tenant e se o usuário da ' +
        'integração enxerga os questionários dela.',
    };
  }
}
