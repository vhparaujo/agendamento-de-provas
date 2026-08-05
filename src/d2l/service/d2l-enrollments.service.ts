import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  carregarD2lApiConfig,
  D2lApiConfig,
  faltandoParaApi,
} from '../config/d2l.config';
import { D2lOauthService } from './d2l-oauth.service';

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
  Type?: { Id?: number | string };
}

/** A Valence e externa: sem limite, um travamento dela trava o portal. */
const TIMEOUT_MS = 15_000;

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
    { ids: Set<string>; expiraEmMs: number }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly oauth: D2lOauthService,
  ) {}

  /** Enquanto `false`, nenhuma chamada de rede sai daqui. */
  habilitado(): boolean {
    const cfg = carregarD2lApiConfig(this.config);
    return cfg.habilitado && faltandoParaApi(cfg).length === 0;
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
  private async ofertasDoPeriodoLetivo(
    cfg: D2lApiConfig,
    periodoLetivoId: string,
  ): Promise<Set<string>> {
    const emCache = this.descendentes.get(periodoLetivoId);

    if (emCache && emCache.expiraEmMs > Date.now()) return emCache.ids;

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

    const ids = new Set(
      lista
        .filter((d) => Number(d.Type?.Id) === cfg.tipoOferta && d.Identifier)
        .map((d) => String(d.Identifier)),
    );

    this.descendentes.set(periodoLetivoId, {
      ids,
      expiraEmMs: Date.now() + CACHE_DESCENDENTES_MS,
    });

    return ids;
  }

  private url(
    cfg: D2lApiConfig,
    produto: 'lp' | 'le',
    caminho: string,
    query: Record<string, string> = {},
  ): string {
    const parametros = new URLSearchParams(query).toString();

    return (
      `${cfg.baseUrl}/d2l/api/${produto}/${cfg.apiVersion}/${caminho}` +
      (parametros ? `?${parametros}` : '')
    );
  }

  private async pedir<T>(url: string, o_que: string): Promise<T> {
    const token = await this.oauth.obterAccessToken();

    let resposta: Response;

    try {
      resposta = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token.valor}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);

      throw new BadGatewayException(
        `Nao foi possivel ler ${o_que} no Brightspace: ${motivo}`,
      );
    }

    if (!resposta.ok) {
      const corpo = (await resposta.text().catch(() => '')).slice(0, 300);

      // 404 aqui quase sempre e id errado no cadastro — do periodo letivo ou do
      // aluno —, nao instabilidade. A mensagem diz onde procurar.
      if (resposta.status === 404) {
        throw new BadGatewayException(
          `O Brightspace nao encontrou ${o_que} (404). Confira o periodo letivo cadastrado ` +
            'e o UserId do aluno — ambos precisam existir neste tenant.',
        );
      }

      throw new BadGatewayException(
        `O Brightspace recusou a leitura de ${o_que} (HTTP ${resposta.status}). ${corpo}`.trim(),
      );
    }

    return (await resposta.json()) as T;
  }

  private exigirConfigurado(): D2lApiConfig {
    const cfg = carregarD2lApiConfig(this.config);
    const faltando = faltandoParaApi(cfg);

    if (!cfg.habilitado || faltando.length > 0) {
      // Chamar isto com a integracao desligada e erro de programacao: quem chama
      // deve consultar `habilitado()` antes e usar o caminho do launch.
      throw new BadGatewayException(
        'Integracao D2L desligada ou incompleta' +
          (faltando.length ? `: faltam ${faltando.join(', ')}` : '.'),
      );
    }

    return cfg;
  }
}
