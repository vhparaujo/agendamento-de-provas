import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { carregarD2lApiConfig } from '../config/d2l.config';
import { D2lHttpService, OpcoesChamadaD2L } from './d2l-http.service';
import { OpcoesDeRitmo } from './d2l-quizzes.service';

/**
 * ============================================================================
 * CONDICOES DE LIBERACAO E GRUPOS — cliente REST puro
 * ============================================================================
 * Sem regra de negocio nenhuma: lista categorias, lista grupos, le e grava
 * condicoes. Quem decide qual grupo entra e o que fazer quando nada casa e o
 * `src/senha-quiz`. Mesma divisao que `D2lQuizzesService` e
 * `D2lEnrollmentsService` ja seguem.
 *
 * ⚠️ **Tudo aqui e LP, nao LE.** As condicoes de liberacao NAO sao campo do
 * `QuizData` — elas vivem num recurso proprio do Learning Platform. Por isso
 * este servico nasceu separado do de quizzes em vez de virar mais dois metodos
 * la: sao produtos com numeracao de versao independente, e misturar os dois foi
 * o bug de 11/08/2026 (`D2L_API_VERSION=1.82` correto no `le`, inexistente no
 * `lp`, 404 com corpo VAZIO em toda chamada).
 *
 * ⚠️ **O PUT SUBSTITUI A LISTA INTEIRA DE CONDICOES.** Condicao que nao volta no
 * corpo e condicao apagada da prova — e as que a API nao modela chegam como
 * `RoundTrip` com um `State` opaco que precisa voltar intacto, ou somem sem erro
 * nenhum. `gravarCondicoes` recebe o corpo pronto de `trocarGrupoNasCondicoes`,
 * que e quem garante isso, e la esta o teste.
 *
 * Portado de `brightspace-change-conditions/src/brightspaceClient.js`.
 */

/**
 * A rota de `conditionalRelease` e a de `groupcategories` **nao existem** antes
 * da LP 1.49 (1.45 e anteriores estao obsoletas). Uma versao baixa nao devolve
 * 400 explicando: devolve 404 com corpo vazio, indistinguivel de "quiz nao
 * existe". Recusar na hora, dizendo onde conferir, poupa a investigacao inteira.
 */
const LP_MINIMA_PARA_CONDICOES = 1.49;

/** `GroupCategoryData` na forma Fetch — so o que o lote consome. */
export interface CategoriaDeGrupo {
  GroupCategoryId?: number | string;
  Name?: string;
}

/** `GroupData` na forma Fetch — so o que o lote consome. */
export interface GrupoDaTurma {
  GroupId?: number | string;
  Name?: string;
}

@Injectable()
export class D2lCondicoesService {
  constructor(
    private readonly config: ConfigService,
    private readonly http: D2lHttpService,
  ) {}

  /** Enquanto `false`, nenhuma chamada de rede deve sair daqui. */
  habilitado(): boolean {
    return this.http.habilitado();
  }

  /** Todas as categorias de grupo da turma. */
  async listarCategoriasDeGrupo(
    orgUnitId: string,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<CategoriaDeGrupo[]> {
    const cfg = this.exigirLpSuficiente();

    const dados = await this.http.chamar<CategoriaDeGrupo[] | null>(
      cfg,
      'lp',
      `${encodeURIComponent(orgUnitId)}/groupcategories/`,
      this.opcoes(`as categorias de grupo da turma ${orgUnitId}`, ritmo),
    );

    return Array.isArray(dados) ? dados : [];
  }

  /**
   * Os grupos de UMA categoria.
   *
   * Sem paginacao, ao contrario da listagem de quizzes: a rota devolve o array
   * direto, e uma categoria tem meia duzia de grupos, nao centenas.
   */
  async listarGrupos(
    orgUnitId: string,
    categoriaId: number | string,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<GrupoDaTurma[]> {
    const cfg = this.exigirLpSuficiente();

    const dados = await this.http.chamar<GrupoDaTurma[] | null>(
      cfg,
      'lp',
      `${encodeURIComponent(orgUnitId)}/groupcategories/` +
        `${encodeURIComponent(String(categoriaId))}/groups/`,
      this.opcoes(
        `os grupos da categoria ${categoriaId} da turma ${orgUnitId}`,
        ritmo,
      ),
    );

    return Array.isArray(dados) ? dados : [];
  }

  /**
   * As condicoes de liberacao de um questionario — a base obrigatoria do PUT.
   *
   * Um quiz **sem condicao nenhuma** e caso normal, nao erro: a API responde com
   * a expressao vazia (ou 404, em alguns tenants). `nuloEm404` traduz o 404 para
   * `null` para que o lote reporte `SEM_CONDICAO_DE_GRUPO` — que e a verdade —
   * em vez de `FALHA_AO_LER_CONDICOES`, que mandaria alguem investigar rede.
   */
  async lerCondicoes<T>(
    orgUnitId: string,
    quizId: string,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<T | null> {
    const cfg = this.exigirLpSuficiente();

    return this.http.chamarUrl<T>(
      this.http.url(
        cfg,
        'lp',
        `${encodeURIComponent(orgUnitId)}/conditionalRelease/conditions/` +
          `quizzes/${encodeURIComponent(quizId)}`,
      ),
      {
        ...this.opcoes(
          `as condicoes do questionario ${quizId} da turma ${orgUnitId}`,
          ritmo,
        ),
        nuloEm404: true,
      },
    );
  }

  /**
   * Substitui as condicoes do questionario. O corpo tem de estar COMPLETO — ver
   * o aviso no topo.
   */
  async gravarCondicoes(
    orgUnitId: string,
    quizId: string,
    corpo: unknown,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<void> {
    const cfg = this.exigirLpSuficiente();

    await this.http.chamar(
      cfg,
      'lp',
      `${encodeURIComponent(orgUnitId)}/conditionalRelease/conditions/` +
        `quizzes/${encodeURIComponent(quizId)}`,
      {
        ...this.opcoes(
          `as condicoes do questionario ${quizId} da turma ${orgUnitId}`,
          ritmo,
        ),
        metodo: 'PUT',
        corpo,
      },
    );
  }

  /** A versao da API LP em uso — entra no diagnostico da tela e do log. */
  versaoDaApi(): string {
    return carregarD2lApiConfig(this.config).apiVersaoLp;
  }

  // ------------------------------------------------------------------ interno

  /**
   * A configuracao, ja tendo recusado uma LP baixa demais.
   *
   * A checagem fica aqui e nao no boot porque `D2L_API_VERSION_LP` e opcional na
   * validacao do `.env` (a integracao inteira pode estar desligada): derrubar a
   * aplicacao por causa de um recurso que talvez nem seja usado seria pior que
   * recusar na primeira chamada dele.
   */
  private exigirLpSuficiente() {
    const cfg = this.http.exigirConfigurado();
    const versao = Number(cfg.apiVersaoLp);

    if (Number.isFinite(versao) && versao < LP_MINIMA_PARA_CONDICOES) {
      throw new BadGatewayException(
        `D2L_API_VERSION_LP=${cfg.apiVersaoLp} e baixa demais para trocar o ` +
          `grupo da prova: as rotas de conditionalRelease e de groupcategories ` +
          `exigem LP ${LP_MINIMA_PARA_CONDICOES}+ (1.45 e anteriores estao ` +
          `obsoletas). Confira as versoes deste tenant em ` +
          `${cfg.baseUrl}/d2l/api/versions/.`,
      );
    }

    return cfg;
  }

  /**
   * As opcoes comuns a toda chamada deste servico.
   *
   * `retentar429` ligado, como no de quizzes: quem chama e o lote, que pode se
   * dar ao luxo de esperar. O PUT e idempotente — o mesmo corpo produz o mesmo
   * estado — entao repetir e seguro.
   */
  private opcoes(oQue: string, ritmo: OpcoesDeRitmo): OpcoesChamadaD2L {
    return {
      oQue,
      atrasoMs: ritmo.atrasoMs,
      timeoutMs: ritmo.timeoutMs,
      retentar429: true,
      dicaDe404:
        'Confira se a LP desta instancia e 1.49+ e se o usuario da integracao ' +
        'enxerga os grupos e as restricoes da turma. O escopo ' +
        '`groups:group:read` vive no CONSENTIMENTO: se ele foi adicionado ao ' +
        '.env sem rodar `npm run d2l:autorizar`, a chamada e recusada.',
    };
  }
}
