import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { D2lApiConfig } from '../config/d2l.config';
import { D2lHttpService } from './d2l-http.service';

/**
 * Uma oferta de disciplina como a Valence a devolve.
 *
 * Os nomes dos campos seguem `TurmaDoLaunch` (`src/turma/service/turma-match.ts`)
 * de proposito: o cruzamento com o CSV e o MESMO, venha a turma do claim
 * `context` do LTI ou dos enrollments. Uma unica implementacao de match, duas
 * fontes.
 */
export interface OfertaDoAluno {
  orgUnitId: string;
  /** `OrgUnit.Code` — o codigo da turma, chave de busca no CSV. */
  codigo: string | null;
  /** `OrgUnit.Name` — quem desempata quando o codigo se repete. */
  titulo: string | null;
}

/** Item do retorno de `enrollments/users/{id}/orgUnits/`. */
interface ItemDeMatricula {
  OrgUnit?: {
    Id?: number | string;
    Code?: string | null;
    Name?: string | null;
    Type?: { Id?: number | string };
  };
}

interface PaginaDeMatriculas {
  Items?: ItemDeMatricula[];
  PagingInfo?: { Bookmark?: string | null; HasMoreItems?: boolean };
}

/** Item do retorno de `orgstructure/{id}/descendants/`. */
interface Descendente {
  Identifier?: number | string;
  Name?: string | null;
  Code?: string | null;
  Type?: { Id?: number | string };
}

/** Retorno de `orgstructure/?orgUnitType=N`: paginado por bookmark. */
interface PaginaDeOrgUnits {
  Items?: Descendente[];
  PagingInfo?: { Bookmark?: string | null; HasMoreItems?: boolean };
}

/** Item do retorno de `users/?orgDefinedId=`. */
interface UsuarioD2L {
  UserId?: number | string;
  OrgDefinedId?: string | null;
  DisplayName?: string | null;
  Activation?: { IsActive?: boolean };
}

/**
 * Quem e o aluno dentro do Brightspace, a partir da matricula.
 *
 * E um resultado CLASSIFICADO, nao um id ou uma excecao: quem chama e o
 * agendamento compulsorio, que precisa separar "esta pessoa nao tem conta" de
 * "a busca falhou" para montar o relatorio de excecoes. Uma excecao a cada
 * aluno sem conta transformaria um estado esperado em erro de lote.
 */
export type IdentidadeNoD2L =
  | {
      situacao: 'ACHOU';
      userIdD2L: string;
      /** `Activation.IsActive`: conta desativada nao consegue abrir a prova. */
      ativoNoD2L: boolean;
      nome: string | null;
    }
  /** 404, ou lista vazia: a matricula nao existe neste tenant. */
  | { situacao: 'SEM_CONTA' }
  /** Duas contas com a mesma matricula. Nao se escolhe uma: alguem decide. */
  | { situacao: 'AMBIGUA'; quantos: number }
  /** `UserId` nao numerico — a Valence o recusaria depois (ver lti.service). */
  | { situacao: 'ID_INVALIDO'; valor: string };

/** Um Periodo Letivo do Brightspace, para o dropdown do admin. */
export interface PeriodoLetivoD2L {
  /** OrgUnitId — e o que vai gravado em `PeriodoAgendamento.periodoLetivoId`. */
  id: string;
  nome: string | null;
  codigo: string | null;
  /** Ano extraido do nome ("2026/1" -> 2026). `null` quando nao da para ler. */
  ano: number | null;
  /** Semestre extraido do nome ("2026/1" -> 1). */
  semestre: number | null;
}

/**
 * Teto de paginas por consulta de matriculas.
 *
 * Nao e otimizacao: e o freio de um loop que so termina quando o SERVIDOR diz
 * que terminou. Um bookmark que se repetisse giraria para sempre segurando um
 * request do portal. 100 paginas x 100 itens ja e uma ordem de grandeza acima de
 * qualquer aluno real.
 */
const MAX_PAGINAS = 100;

/**
 * Por quanto tempo a arvore do periodo letivo fica em cache.
 *
 * A lista de ofertas de um semestre e IGUAL para todos os alunos e muda no ritmo
 * da secretaria (dias), nao no ritmo dos acessos. Sem cache, cada abertura do
 * portal baixaria a estrutura inteira do semestre — a chamada mais cara das duas
 * — para descartar 99% dela.
 *
 * Nao ha invalidacao manual porque a chave e o PROPRIO periodo letivo: virar o
 * semestre e cadastrar outro id, que ja e outra entrada. O TTL cobre so o caso
 * de uma oferta criada dentro do semestre em curso.
 */
const CACHE_DESCENDENTES_MS = 10 * 60_000;

/**
 * ============================================================================
 * AS DISCIPLINAS DO ALUNO NO SEMESTRE ESCOLHIDO PELO ADMIN
 * ============================================================================
 * Cliente REST puro: fala com a Valence e normaliza o retorno. Nenhuma regra de
 * negocio mora aqui — quem decide o que e agendavel e o cruzamento com o CSV
 * (`TurmaService`), e quem decide de qual vinculo e cada disciplina e o
 * `DisciplinasDoAlunoService`.
 *
 * O fluxo e o do §4.2 de docs/D2L_API_REFERENCE.md:
 *   1. matriculas do aluno            -> ofertas em que ele esta inscrito
 *   2. descendentes do periodo letivo -> ofertas que pertencem AO SEMESTRE
 *   3. intersecao
 *
 * O passo 2 e o que responde a pergunta "do semestre que o administrador
 * escolher": o `periodoLetivoId` vem de `PeriodoAgendamento`, cadastrado pelo
 * admin. Sem ele, as matriculas trariam tambem os semestres passados.
 *
 * Daqui sai tambem a IDENTIDADE do aluno no LMS (`identidadePorMatricula`),
 * necessaria para o agendamento compulsorio: quem nunca fez launch nao tem
 * `userIdD2L` gravado, e sem ele nao ha como ler as disciplinas dele.
 *
 * E daqui tambem sai a LISTA de periodos letivos (`periodosLetivos`), que
 * alimenta o dropdown onde o admin escolhe qual cadastrar — digitar o OrgUnitId
 * na mao e a receita para o erro que nao aparece: um id errado nao da erro
 * nenhum, so devolve interseção vazia e todo aluno fica sem disciplina.
 */
@Injectable()
export class D2lEnrollmentsService {
  private readonly logger = new Logger(D2lEnrollmentsService.name);

  /**
   * Arvore do periodo, por `periodoLetivoId`. Em memoria de proposito: e cache
   * de leitura, reconstruivel a qualquer momento, e nao vale uma tabela.
   */
  private descendentes = new Map<
    string,
    { ofertas: OfertaDoAluno[]; ids: Set<string>; expiraEmMs: number }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly http: D2lHttpService,
  ) {}

  /** Enquanto `false`, nenhuma chamada de rede sai daqui. */
  habilitado(): boolean {
    return this.http.habilitado();
  }

  /**
   * As ofertas em que o aluno esta matriculado DENTRO do periodo letivo dado.
   *
   * Devolve tudo o que a Valence conhece — inclusive disciplina sem prova. O
   * filtro do CSV vem depois, no `TurmaService`: misturar as duas coisas aqui
   * faria o cliente REST precisar do banco.
   */
  async ofertasDoPeriodo(
    userIdD2L: string,
    periodoLetivoId: string,
  ): Promise<OfertaDoAluno[]> {
    const cfg = this.exigirConfigurado();

    const [matriculas, doPeriodo] = await Promise.all([
      this.matriculas(cfg, userIdD2L),
      this.ofertasDoPeriodoLetivo(cfg, periodoLetivoId),
    ]);

    const dentro = matriculas.filter((o) => doPeriodo.has(o.orgUnitId));

    this.logger.debug(
      `Aluno ${userIdD2L}: ${matriculas.length} matricula(s), ` +
        `${dentro.length} no periodo letivo ${periodoLetivoId}.`,
    );

    return dentro;
  }

  /**
   * ==========================================================================
   * QUEM E O ALUNO NO BRIGHTSPACE, PELA MATRICULA
   * ==========================================================================
   * Existe para o agendamento COMPULSORIO: o admin agenda por quem nao agendou,
   * e essas pessoas nunca fizeram launch — entao nao ha `userIdD2L` gravado em
   * lugar nenhum. Sem esta rota, o compulsorio nao teria como descobrir as
   * disciplinas de ninguem.
   *
   * A matricula e o `OrgDefinedId` do Brightspace, o mesmo campo que chega no
   * claim do launch.
   *
   * **404 aqui e estado ESPERADO, nao falha** — e a resposta do tenant para
   * matricula inexistente (`{"Errors":[{"Message":"Resource Not Found"}]}`).
   * Um aluno pode estar na planilha da secretaria e nao ter conta no LMS. Por
   * isso este e o unico ponto que pede `nuloEm404`.
   *
   * **O filtro do tenant e por igualdade, nao por prefixo** (verificado: um RA
   * truncado devolve 404, e a caixa e ignorada). Mesmo assim a comparacao e
   * refeita aqui: se uma versao futura da API passar a casar por prefixo, o
   * efeito seria alocar a prova de uma pessoa para outra, em silencio.
   */
  async identidadePorMatricula(matricula: string): Promise<IdentidadeNoD2L> {
    const cfg = this.exigirConfigurado();

    const url = this.url(cfg, 'lp', 'users/', { orgDefinedId: matricula });

    const dados = await this.pedir<UsuarioD2L[]>(url, 'usuario por matricula', {
      nuloEm404: true,
    });

    const alvo = matricula.trim().toLowerCase();

    const exatos = (dados ?? []).filter(
      (u) => (u.OrgDefinedId ?? '').trim().toLowerCase() === alvo,
    );

    if (exatos.length === 0) return { situacao: 'SEM_CONTA' };

    if (exatos.length > 1) {
      // Duas contas para a mesma matricula e problema de cadastro no LMS.
      // Escolher uma seria decidir de qual conta a prova sai — nao e nossa
      // decisao, e o erro so apareceria no dia.
      this.logger.warn(
        `Matricula ${matricula} tem ${exatos.length} contas no Brightspace; ` +
          'nenhuma foi escolhida.',
      );

      return { situacao: 'AMBIGUA', quantos: exatos.length };
    }

    const usuario = exatos[0];
    const userId = String(usuario.UserId ?? '');

    // Mesma trava do launch (lti.service.ts): a Valence so aceita UserId
    // numerico, e um valor de outro formato falharia depois, ao ler as
    // disciplinas — longe daqui e sem ligacao obvia com a causa.
    if (!/^\d+$/.test(userId)) {
      return { situacao: 'ID_INVALIDO', valor: userId };
    }

    return {
      situacao: 'ACHOU',
      userIdD2L: userId,
      ativoNoD2L: usuario.Activation?.IsActive !== false,
      nome: usuario.DisplayName ?? null,
    };
  }

  /**
   * ==========================================================================
   * OS PERIODOS LETIVOS DO TENANT — a lista do dropdown do admin
   * ==========================================================================
   * Devolve os org units do tipo Periodo Letivo (103 neste tenant, configuravel
   * por `D2L_TIPO_PERIODO_LETIVO`), para o admin ESCOLHER em vez de digitar.
   *
   * Existe por causa de um modo de falha silencioso: `periodoLetivoId` errado
   * nao produz erro nenhum. A chamada de descendentes responde 200 com lista
   * vazia, a intersecao com as matriculas da vazia, e TODO aluno recebe "nenhuma
   * disciplina sua aparece no periodo letivo vigente" — sem nada no log ligando
   * uma coisa a outra. Escolher de uma lista fechada elimina a classe inteira.
   *
   * **A rota e `orgstructure/` com `orgUnitType`, e ela E PAGINADA.** A resposta
   * real do tenant traz 10 itens por pagina, `HasMoreItems: true` e um
   * `Bookmark` — e vem em ordem de CRIACAO, nao cronologica: a primeira pagina
   * do ava.catolica e 2021/1, 2020/3, 2020/2, ... Ler so a primeira pagina
   * deixaria o semestre atual DE FORA do dropdown, que e exatamente o unico item
   * que o admin quase sempre quer.
   *
   * `anosRecentes` corta a lista pelo ano lido do nome ("2026/1" -> 2026);
   * `undefined` devolve tudo. Itens sem ano legivel no nome — o tenant tem um
   * "Esperancar" cadastrado como Periodo Letivo — ficam de fora do recorte,
   * porque nao ha como situa-los numa janela de anos, e aparecem so na lista
   * completa.
   */
  async periodosLetivos(
    opcoes: { anosRecentes?: number } = {},
  ): Promise<PeriodoLetivoD2L[]> {
    const cfg = this.exigirConfigurado();
    const brutos = await this.todosOsPeriodos(cfg);

    const periodos = brutos
      // O `orgUnitType` na query ja filtra, mas conferimos de novo: se o
      // parametro for ignorado por outra versao da API, o dropdown mostraria a
      // organizacao inteira e o admin escolheria algo que nao e semestre.
      .filter(
        (d) => Number(d.Type?.Id) === cfg.tipoPeriodoLetivo && d.Identifier,
      )
      .map((d) => {
        const { ano, semestre } = lerAnoSemestre(d.Name, d.Code);

        return {
          id: String(d.Identifier),
          nome: d.Name ?? null,
          codigo: d.Code ?? null,
          ano,
          semestre,
        };
      });

    const recorte = this.recortarPorAno(periodos, opcoes.anosRecentes);

    this.logger.debug(
      `${brutos.length} org unit(s) do tipo ${cfg.tipoPeriodoLetivo}; ` +
        `${recorte.length} no dropdown.`,
    );

    return recorte;
  }

  /**
   * Do mais recente para o mais antigo, cortando pela janela de anos.
   *
   * A ordenacao e por (ano, semestre) lidos do nome, NAO por string: comparar
   * texto poria "Esperancar" antes de "2026/2", e o admin escolheria o primeiro
   * item da lista achando que e o semestre atual.
   */
  private recortarPorAno(
    periodos: PeriodoLetivoD2L[],
    anosRecentes?: number,
  ): PeriodoLetivoD2L[] {
    const comAno = periodos.filter((p) => p.ano !== null);

    const ordenados = [...comAno].sort(
      (a, b) => b.ano! - a.ano! || (b.semestre ?? 0) - (a.semestre ?? 0),
    );

    if (!anosRecentes || anosRecentes <= 0) {
      // Lista completa: os sem ano legivel vao para o fim, nunca para o topo.
      const semAno = periodos.filter((p) => p.ano === null);
      return [...ordenados, ...semAno];
    }

    // A janela conta do ano MAIS RECENTE QUE EXISTE, nao do relogio: se o
    // tenant ainda nao criou 2026, pedir "atual + 3" nao pode devolver vazio.
    const maisRecente = ordenados[0]?.ano;
    if (maisRecente === undefined || maisRecente === null) return [];

    const corte = maisRecente - (anosRecentes - 1);

    return ordenados.filter((p) => p.ano! >= corte);
  }

  /**
   * Todas as paginas de `orgstructure/?orgUnitType=N`.
   *
   * Mesmo freio da paginacao de matriculas: o loop so termina quando o SERVIDOR
   * diz que terminou, e um bookmark repetido giraria para sempre.
   */
  private async todosOsPeriodos(cfg: D2lApiConfig): Promise<Descendente[]> {
    const itens: Descendente[] = [];
    let bookmark: string | undefined;

    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const url = this.url(cfg, 'lp', 'orgstructure/', {
        orgUnitType: String(cfg.tipoPeriodoLetivo),
        ...(bookmark ? { bookmark } : {}),
      });

      const dados = await this.pedir<Descendente[] | PaginaDeOrgUnits>(
        url,
        'periodos letivos',
      );

      // Versoes antigas da API devolvem array puro, sem envelope de paginacao.
      if (Array.isArray(dados)) return [...itens, ...dados];

      itens.push(...(dados?.Items ?? []));

      const proximo = dados?.PagingInfo?.Bookmark ?? undefined;

      if (
        !dados?.PagingInfo?.HasMoreItems ||
        !proximo ||
        proximo === bookmark
      ) {
        return itens;
      }

      bookmark = proximo;
    }

    this.logger.warn(
      `Paginacao de periodos letivos passou de ${MAX_PAGINAS} paginas; ` +
        'lista pode estar incompleta.',
    );

    return itens;
  }

  /**
   * Todas as ofertas do aluno, de todos os semestres, paginadas por bookmark.
   *
   * O `orgUnitTypeId` na query ja pede so Course Offering, mas o tipo e
   * conferido de novo no retorno: se o parametro for ignorado por uma versao
   * diferente da API, o filtro do cliente segura — e a alternativa seria tratar
   * o proprio semestre como se fosse uma disciplina.
   */
  private async matriculas(
    cfg: D2lApiConfig,
    userIdD2L: string,
  ): Promise<OfertaDoAluno[]> {
    const ofertas: OfertaDoAluno[] = [];
    const vistos = new Set<string>();
    let bookmark: string | undefined;

    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const url = this.url(
        cfg,
        'lp',
        `enrollments/users/${encodeURIComponent(userIdD2L)}/orgUnits/`,
        {
          orgUnitTypeId: String(cfg.tipoOferta),
          ...(bookmark ? { bookmark } : {}),
        },
      );

      const dados = await this.pedir<PaginaDeMatriculas>(url, 'matriculas');

      // `?.` porque corpo vazio ou malformado vira `null` aqui: virar TypeError
      // devolveria 500 generico em vez de "a lista veio sem itens".
      for (const item of dados?.Items ?? []) {
        const oferta = this.converter(cfg, item);

        // Um aluno pode aparecer duas vezes na mesma oferta (dois papeis).
        if (!oferta || vistos.has(oferta.orgUnitId)) continue;

        vistos.add(oferta.orgUnitId);
        ofertas.push(oferta);
      }

      const proximo = dados.PagingInfo?.Bookmark ?? undefined;

      if (!dados.PagingInfo?.HasMoreItems || !proximo || proximo === bookmark) {
        return ofertas;
      }

      bookmark = proximo;
    }

    // Chegar aqui significa que a API nunca disse "acabou". Devolver o que temos
    // e melhor que estourar: o aluno agenda com as disciplinas encontradas, e o
    // log denuncia o caso para quem investiga.
    this.logger.warn(
      `Paginacao de matriculas do usuario ${userIdD2L} passou de ${MAX_PAGINAS} paginas; ` +
        'lista pode estar incompleta.',
    );

    return ofertas;
  }

  private converter(
    cfg: D2lApiConfig,
    item: ItemDeMatricula,
  ): OfertaDoAluno | null {
    const orgUnit = item.OrgUnit;

    if (!orgUnit?.Id) return null;
    if (Number(orgUnit.Type?.Id) !== cfg.tipoOferta) return null;

    return {
      // §4.3: o Id vem NUMERO aqui e STRING nos descendentes. Normalizar para
      // string nos dois lados e o que impede a intersecao de dar vazia sem erro.
      orgUnitId: String(orgUnit.Id),
      codigo: orgUnit.Code ?? null,
      titulo: orgUnit.Name ?? null,
    };
  }

  /** Os ids das ofertas que pertencem ao periodo letivo, com cache. */
  /**
   * As ofertas do periodo letivo, COM codigo e titulo, para quem precisa casar
   * turma por `Code` — hoje, a resolucao de `orgUnitId` das turmas do CSV no
   * lote de senhas (src/senha-quiz).
   *
   * Existe porque ate 18/08/2026 esta chamada baixava `Code` e `Name` e os
   * JOGAVA FORA, guardando so os ids: quem precisasse dos codigos teria de
   * repetir a mesma consulta ao tenant. Agora e UMA chamada e UM cache para os
   * dois usos — o filtro por id (portal do aluno) e o casamento por codigo.
   */
  async ofertasDoSemestre(periodoLetivoId: string): Promise<OfertaDoAluno[]> {
    const cfg = this.exigirConfigurado();
    const { ofertas } = await this.descendentesDoPeriodo(cfg, periodoLetivoId);
    return ofertas;
  }

  /** Os ids das ofertas que pertencem ao periodo letivo, com cache. */
  private async ofertasDoPeriodoLetivo(
    cfg: D2lApiConfig,
    periodoLetivoId: string,
  ): Promise<Set<string>> {
    const { ids } = await this.descendentesDoPeriodo(cfg, periodoLetivoId);
    return ids;
  }

  /**
   * A arvore do periodo, baixada uma vez e servida das duas formas.
   *
   * O `Set` de ids e derivado da lista, e nao o contrario: assim as duas visoes
   * nunca divergem, e o filtro por `Type.Id` vale para as duas.
   */
  private async descendentesDoPeriodo(
    cfg: D2lApiConfig,
    periodoLetivoId: string,
  ): Promise<{ ofertas: OfertaDoAluno[]; ids: Set<string> }> {
    const emCache = this.descendentes.get(periodoLetivoId);

    if (emCache && emCache.expiraEmMs > Date.now()) {
      return { ofertas: emCache.ofertas, ids: emCache.ids };
    }

    const url = this.url(
      cfg,
      'lp',
      `orgstructure/${encodeURIComponent(periodoLetivoId)}/descendants/`,
      { orgUnitType: String(cfg.tipoOferta) },
    );

    const dados = await this.pedir<Descendente[] | { Items?: Descendente[] }>(
      url,
      'descendentes',
    );

    const lista = Array.isArray(dados) ? dados : (dados.Items ?? []);

    const ofertas: OfertaDoAluno[] = lista
      .filter((d) => Number(d.Type?.Id) === cfg.tipoOferta && d.Identifier)
      .map((d) => ({
        // §4.3: `Identifier` vem STRING aqui e `Id` vem NUMERO nas matriculas.
        // Normalizar nos dois lados e o que impede a intersecao de dar vazia.
        orgUnitId: String(d.Identifier),
        codigo: d.Code ?? null,
        titulo: d.Name ?? null,
      }));

    const ids = new Set(ofertas.map((o) => o.orgUnitId));

    this.descendentes.set(periodoLetivoId, {
      ofertas,
      ids,
      expiraEmMs: Date.now() + CACHE_DESCENDENTES_MS,
    });

    return { ofertas, ids };
  }

  private url(
    cfg: D2lApiConfig,
    produto: 'lp' | 'le',
    caminho: string,
    query: Record<string, string> = {},
  ): string {
    return this.http.url(cfg, produto, caminho, query);
  }

  /**
   * `nuloEm404` inverte o significado do 404 para UMA chamada: em vez de "id
   * errado no cadastro", passa a ser "nao existe", devolvido como `null`.
   *
   * As sobrecargas existem para que so quem passa a opcao precise tratar o
   * `null` — os outros chamadores continuam com o tipo nao-nulavel de antes.
   */
  private async pedir<T>(url: string, o_que: string): Promise<T>;
  private async pedir<T>(
    url: string,
    o_que: string,
    opcoes: { nuloEm404: true },
  ): Promise<T | null>;
  private async pedir<T>(
    url: string,
    o_que: string,
    opcoes: { nuloEm404?: boolean } = {},
  ): Promise<T | null> {
    return this.http.chamarUrl<T>(url, {
      oQue: o_que,
      nuloEm404: opcoes.nuloEm404,
      // 404 aqui quase sempre e id errado no cadastro — do periodo letivo ou do
      // aluno —, nao instabilidade. A mensagem diz onde procurar.
      dicaDe404:
        'Confira o periodo letivo cadastrado e o UserId do aluno — ' +
        'ambos precisam existir neste tenant.',
    } as { oQue: string; nuloEm404: true; dicaDe404: string });
  }

  private exigirConfigurado(): D2lApiConfig {
    // Chamar isto com a integracao desligada e erro de programacao: quem chama
    // deve consultar `habilitado()` antes e usar o caminho do launch.
    return this.http.exigirConfigurado();
  }
}

/**
 * Le ano e semestre do nome do periodo letivo: "2026/1", "2026_1", "2026.1".
 *
 * O `Code` serve de segunda tentativa porque o tenant tem os dois formatos
 * ("2021/1" com Code "2021_1"). Sem numero reconhecivel devolve nulos — e o
 * item fica fora do recorte por ano, em vez de virar um ano inventado.
 */
function lerAnoSemestre(...candidatos: (string | null | undefined)[]): {
  ano: number | null;
  semestre: number | null;
} {
  for (const bruto of candidatos) {
    const casado = /(\d{4})\s*[/._-]\s*(\d{1,2})/.exec(String(bruto ?? ''));

    if (casado) {
      return { ano: Number(casado[1]), semestre: Number(casado[2]) };
    }
  }

  return { ano: null, semestre: null };
}
