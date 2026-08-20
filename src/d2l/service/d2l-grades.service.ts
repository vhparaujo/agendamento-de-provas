import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { carregarD2lApiConfig } from '../config/d2l.config';
import { D2lHttpService, OpcoesChamadaD2L } from './d2l-http.service';
import { OpcoesDeRitmo } from './d2l-quizzes.service';

/**
 * ============================================================================
 * NOTAS DA VALENCE — cliente REST puro
 * ============================================================================
 * Sem regra de negocio nenhuma: le a nota final e normaliza o retorno. Quem sabe
 * o que e a substitutiva, qual faixa habilita quem e o que fazer com o aluno sem
 * nota e o `ElegibilidadeDeNotaService` (src/agendamento). Mesma divisao que o
 * `D2lEnrollmentsService` e o `D2lQuizzesService` ja seguem.
 *
 * Rotas usadas (produto **LE**, nao LP — a versao e a `apiVersaoLe`):
 *
 * | Rota | Para que |
 * |---|---|
 * | `GET (orgUnitId)/grades/final/values/(userId)` | a nota de UM aluno numa turma — o portal |
 * | `GET (orgUnitId)/grades/final/values/` | a turma INTEIRA de uma vez — o lote |
 *
 * Escopo OAuth: **`grades:gradevalues:read`**. Como todo escopo, ele vive no
 * CONSENTIMENTO e nao no `.env`: acrescenta-lo a `D2L_SCOPES` nao muda nada sem
 * refazer `npm run d2l:autorizar`, e ate la todo GET daqui volta **403**.
 */

/** Um `GradeValue` como a Valence o devolve. Campos em PascalCase, como na API. */
interface ValorDeNotaD2L {
  DisplayedGrade?: string | null;
  GradeObjectIdentifier?: string | number | null;
  /** "Final Calculated Grade" / "Final Adjusted Grade" — ver `origemDoNome`. */
  GradeObjectName?: string | null;
  GradeObjectType?: number | string | null;
  GradeObjectTypeName?: string | null;
  PointsNumerator?: number | null;
  PointsDenominator?: number | null;
  WeightedNumerator?: number | null;
  WeightedDenominator?: number | null;
}

/** Item de `grades/final/values/` — o valor vem embrulhado com o usuario. */
interface NotaDeUmUsuarioD2L {
  User?: { Identifier?: string | number | null };
  GradeValue?: ValorDeNotaD2L | null;
}

/** Uma pagina de `ObjectListPage`. */
interface PaginaDeNotas {
  Objects?: NotaDeUmUsuarioD2L[];
  /** URL/caminho da proxima pagina; carrega o bookmark na query string. */
  Next?: string | null;
}

/**
 * De qual nota final o valor veio.
 *
 * ⚠️ **E informativo, nao um seletor.** A rota `grades/final/values/` devolve UMA
 * nota final por aluno — a ajustada quando o professor a lancou, a calculada
 * quando nao —, entao o "ajustada com fallback na calculada" que o cliente pediu
 * ja e o comportamento do Brightspace, e nao ha o que escolher aqui. O campo
 * existe para o log e para o diagnostico: se algum dia toda turma passar a
 * responder `CALCULADA` mesmo com notas ajustadas lancadas, e por aqui que se
 * descobre — e a correcao seria ler o grade object ajustado por
 * `grades/(gradeObjectId)/values/(userId)`, que exige tambem
 * `grades:gradeobjects:read`.
 */
export type OrigemDaNota = 'AJUSTADA' | 'CALCULADA' | 'DESCONHECIDA';

/**
 * A nota final de um aluno numa turma.
 *
 * Resultado CLASSIFICADO, e nao um numero ou uma excecao — mesma escolha de
 * `IdentidadeNoD2L`: "este aluno nao tem nota lancada" e estado ESPERADO (a
 * turma que ainda nao fechou notas, o aluno que trancou), e transformar isso em
 * erro faria o lote inteiro parar por um caso normal. Ja a Valence fora do ar
 * continua sendo excecao, e sobe.
 */
export type NotaFinalD2L =
  | {
      situacao: 'ACHOU';
      /** `PointsNumerator` — os PONTOS, nao o percentual. Ver `pontosDe`. */
      pontos: number;
      /** `PointsDenominator`. `null` quando a API nao o informa. */
      denominador: number | null;
      origem: OrigemDaNota;
      /** `DisplayedGrade` — o texto que o aluno ve no Brightspace. */
      exibida: string | null;
    }
  /** 404, ou nota sem numerador: o aluno nao tem nota final nesta turma. */
  | { situacao: 'SEM_NOTA' };

/**
 * Teto de paginas na leitura de uma turma inteira.
 *
 * Mesmo freio do `listarQuizzes`: o laco so termina quando o SERVIDOR diz que
 * terminou, e um bookmark repetido giraria para sempre. 50 paginas ja e uma
 * ordem de grandeza acima de qualquer turma real.
 */
const MAX_PAGINAS_PADRAO = 50;

/**
 * O denominador que uma nota final FECHADA tem nesta instituicao.
 *
 * Nao entra em nenhuma decisao — a comparacao e de pontos brutos, por decisao do
 * cliente. Serve so para o aviso de `conferirDenominador`.
 */
const DENOMINADOR_ESPERADO = 10;

@Injectable()
export class D2lGradesService {
  private readonly logger = new Logger(D2lGradesService.name);

  /** Ver `conferirDenominador`: um aviso por turma, nao um por aluno. */
  private avisadasDoDenominador = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly http: D2lHttpService,
  ) {}

  /**
   * A nota final de UM aluno numa turma.
   *
   * **404 aqui e estado ESPERADO, nao falha** (`nuloEm404`): e a resposta do
   * tenant para aluno sem nota final na turma, e tambem para aluno que nao esta
   * mais matriculado nela. Os dois viram `SEM_NOTA`. E o mesmo tratamento que
   * `identidadePorMatricula` da a matricula inexistente.
   */
  async notaFinal(
    orgUnitId: string,
    userIdD2L: string,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<NotaFinalD2L> {
    const cfg = this.http.exigirConfigurado();

    const url = this.http.url(
      cfg,
      'le',
      `${encodeURIComponent(orgUnitId)}/grades/final/values/` +
        `${encodeURIComponent(userIdD2L)}`,
    );

    const dados = await this.http.chamarUrl<ValorDeNotaD2L>(url, {
      ...this.opcoes(
        `a nota final do aluno ${userIdD2L} na turma ${orgUnitId}`,
        ritmo,
      ),
      nuloEm404: true,
    });

    return this.converter(orgUnitId, dados);
  }

  /**
   * As notas finais de TODA a turma, indexadas pelo UserId.
   *
   * Existe para o lote: com uma chamada por (aluno x disciplina), o compulsorio
   * de uma substitutiva faria dezenas de milhares de requisicoes ao tenant para
   * ler dados que se repetem — a mesma turma aparece para todos os alunos dela.
   * Aqui e UMA chamada por turma.
   *
   * ⚠️ **Nao simplifique para uma chamada so**: a resposta e paginada, e ignorar
   * o `Next` devolveria a primeira pagina de alunos como se fosse a turma
   * inteira. Todo aluno de fora viraria "sem nota" — que, na substitutiva,
   * significa NAO PODE AGENDAR. E a mesma armadilha que ja deixou turmas sem
   * senha em `listarQuizzes`, com consequencia pior.
   */
  async notasFinaisDaTurma(
    orgUnitId: string,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<Map<string, NotaFinalD2L>> {
    const cfg = this.http.exigirConfigurado();
    const maxPaginas = ritmo.maxPaginas ?? MAX_PAGINAS_PADRAO;

    const notas = new Map<string, NotaFinalD2L>();
    let queryString = '';

    for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
      const url =
        this.http.url(
          cfg,
          'le',
          `${encodeURIComponent(orgUnitId)}/grades/final/values/`,
        ) + queryString;

      const dados = await this.http.chamarUrl<
        PaginaDeNotas | NotaDeUmUsuarioD2L[] | null
      >(url, this.opcoes(`as notas finais da turma ${orgUnitId}`, ritmo));

      // Resposta sem paginacao: algumas versoes devolvem o array direto.
      const itens = Array.isArray(dados) ? dados : (dados?.Objects ?? []);

      for (const item of itens) {
        const identificador = item.User?.Identifier;

        // §4.3: o UserId vem NUMERO em umas rotas e STRING em outras. Sem
        // normalizar, o lookup por string nao acha nada — e sem erro nenhum.
        if (identificador === null || identificador === undefined) continue;

        notas.set(
          String(identificador),
          this.converter(orgUnitId, item.GradeValue ?? null),
        );
      }

      if (Array.isArray(dados) || !dados) return notas;

      const proxima = dados.Next;
      if (!proxima) return notas;

      const inicioDaQuery = String(proxima).indexOf('?');
      if (inicioDaQuery === -1) return notas;

      const seguinte = String(proxima).slice(inicioDaQuery);
      if (seguinte === queryString) return notas; // bookmark travado
      queryString = seguinte;
    }

    // Devolver o que temos seria PIOR que falhar aqui: as notas que faltaram
    // viram "sem nota", e sem nota ninguem agenda a substitutiva. Melhor o erro,
    // que o portal traduz e o lote registra como reprocessavel.
    throw new Error(
      `A listagem de notas da turma ${orgUnitId} passou de ${maxPaginas} ` +
        'paginas sem terminar. Os alunos nao lidos apareceriam como "sem nota", ' +
        'e ninguem sem nota agenda a substitutiva.',
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
   * O `GradeValue` cru virando resultado classificado.
   *
   * `PointsNumerator` ausente ou nao numerico e `SEM_NOTA`, e nao zero: a turma
   * que ainda nao lancou nada devolve o valor vazio, e ler isso como 0,00
   * poria TODO o curso abaixo do piso da substitutiva — errado no sentido que
   * mais dói, porque ninguem reclama de nao ter sido oferecida uma prova que
   * nao existia.
   */
  private converter(
    orgUnitId: string,
    dados: ValorDeNotaD2L | null,
  ): NotaFinalD2L {
    if (!dados) return { situacao: 'SEM_NOTA' };

    const pontos = Number(dados.PointsNumerator);

    if (dados.PointsNumerator === null || !Number.isFinite(pontos)) {
      return { situacao: 'SEM_NOTA' };
    }

    const bruto = Number(dados.PointsDenominator);
    const denominador = Number.isFinite(bruto) ? bruto : null;

    this.conferirDenominador(orgUnitId, denominador);

    return {
      situacao: 'ACHOU',
      pontos,
      denominador,
      origem: origemDoNome(dados.GradeObjectName),
      exibida: dados.DisplayedGrade ?? null,
    };
  }

  /**
   * Avisa quando a nota final da turma nao esta na escala esperada.
   *
   * **Avisa e nao bloqueia**, por decisao do cliente: a comparacao com a faixa e
   * de PONTOS BRUTOS. Mas um denominador diferente de 10 quase sempre significa
   * que a nota ainda nao e final — e o caso da turma com so a N1 lancada, cuja
   * "Nota Calculada Final" vale 4,5 no maximo. Ler essa turma daria a impressao
   * de que a metade dos alunos esta na faixa da substitutiva.
   *
   * Uma linha por TURMA, nao por aluno: a turma inteira compartilha a escala, e
   * um aviso por aluno enterraria o log num lote de milhares.
   */
  private conferirDenominador(
    orgUnitId: string,
    denominador: number | null,
  ): void {
    if (denominador === null || denominador === DENOMINADOR_ESPERADO) return;
    if (this.avisadasDoDenominador.has(orgUnitId)) return;

    this.avisadasDoDenominador.add(orgUnitId);

    this.logger.warn(
      `A nota final da turma ${orgUnitId} vale no maximo ${denominador}, e nao ` +
        `${DENOMINADOR_ESPERADO}. A faixa de nota da rodada e comparada em ` +
        'PONTOS, entao confira se as notas do semestre ja foram todas lancadas ' +
        'antes de abrir a janela.',
    );
  }

  /**
   * As opcoes comuns a toda chamada deste servico.
   *
   * `retentar429` fica DESLIGADO por padrao, ao contrario do servico de quizzes:
   * a leitura de nota esta no caminho critico do portal, e o aluno na tela nao
   * pode esperar o `Retry-After` do tenant. O lote liga o freio passando
   * `atrasoMs` — mesma escolha que o enrollments faz.
   */
  private opcoes(oQue: string, ritmo: OpcoesDeRitmo): OpcoesChamadaD2L {
    return {
      oQue,
      atrasoMs: ritmo.atrasoMs,
      timeoutMs: ritmo.timeoutMs,
      dicaDe404:
        'Confira se a turma ainda existe neste tenant e se o usuario da ' +
        'integracao enxerga as notas dela.',
    };
  }
}

/**
 * De qual nota final o valor veio, lido do nome do grade object.
 *
 * A comparacao e por SUBSTRING e sem acento porque o nome vem no idioma do
 * tenant: "Final Adjusted Grade" no ingles, "Nota Ajustada Final" no portugues.
 * Nome desconhecido nao inventa origem — vira `DESCONHECIDA`, que e informacao
 * para quem investiga e nao muda decisao nenhuma.
 */
function origemDoNome(nome: string | null | undefined): OrigemDaNota {
  const texto = String(nome ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (!texto) return 'DESCONHECIDA';
  if (texto.includes('adjust') || texto.includes('ajust')) return 'AJUSTADA';
  if (texto.includes('calculat') || texto.includes('calculad')) {
    return 'CALCULADA';
  }

  return 'DESCONHECIDA';
}
