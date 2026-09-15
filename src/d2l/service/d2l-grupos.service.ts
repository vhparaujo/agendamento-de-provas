import { BadGatewayException, Injectable } from '@nestjs/common';
import { CategoriaDeGrupo, D2lCondicoesService } from './d2l-condicoes.service';
import { D2lHttpService, OpcoesChamadaD2L } from './d2l-http.service';
import { OpcoesDeRitmo } from './d2l-quizzes.service';

/**
 * ============================================================================
 * ESCRITA DE GRUPOS — cliente REST puro (14/09/2026)
 * ============================================================================
 * Criar categoria, criar e renomear grupo, inscrever e remover aluno. Sem regra
 * de negocio: qual categoria, quais nomes e quem vai para onde e decidido em
 * src/grupos-d2l. Mesma divisao de `D2lCondicoesService`, de quem este servico
 * reusa a listagem de categorias e a recusa de LP baixa (as rotas de
 * `groupcategories` so existem a partir da LP 1.49).
 *
 * ⚠️ **Nao ha rota de inscricao em lote na Valence.** E um POST por aluno por
 * grupo — por isso o lote le os inscritos antes (`listarGrupos` traz o
 * `Enrollments` de todos os grupos da categoria numa chamada so) e so escreve a
 * diferenca.
 *
 * ⚠️ **Criar categoria e ASSINCRONO** desde a release 20.22.6: o POST responde
 * 202 com o id, e grupo criado antes de `categoriaConcluida` voltar `true` toma
 * 409.
 *
 * Escopos: `groups:group:create` (categoria e grupo), `groups:enrollment:create`
 * e `groups:enrollment:delete`. Vivem no CONSENTIMENTO — reautorize
 * (`npm run d2l:autorizar`) depois de acrescentar ao `D2L_SCOPES`.
 */

/** `GRPENROLL_T.NumberOfGroupsNoEnrollment`: N grupos, ninguem inscrito sozinho. */
const NUMERO_DE_GRUPOS_SEM_INSCRICAO = 0;

/** `GROUPSJOBSTATUS_T.Complete`. */
const CRIACAO_CONCLUIDA = 1;

/** `RichTextInput` vazio: a descricao e obrigatoria no corpo, nao no conteudo. */
const DESCRICAO_VAZIA = { Content: '', Type: 'Text' };

export interface GrupoComInscritos {
  GroupId: number;
  Name: string;
  /** UserIds dos inscritos explicitamente. */
  Enrollments: number[];
}

export interface DadosDoGrupo {
  nome: string;
  /** ≤ 50 caracteres, sem `\ : * ? " < > | ' # , % &`. */
  codigo: string;
}

export interface CategoriaCriada {
  categoriaId: number;
  /** A D2L ja terminou de processar? Quase sempre `false` na resposta do POST. */
  concluida: boolean;
}

interface GrupoLidoCru {
  GroupId?: number | string;
  Name?: string;
  Enrollments?: (number | string)[] | null;
}

interface TrabalhoDeGrupos {
  CategoryId?: number | string;
  Status?: number | string;
}

@Injectable()
export class D2lGruposService {
  constructor(
    private readonly http: D2lHttpService,
    private readonly condicoes: D2lCondicoesService,
  ) {}

  /** Enquanto `false`, nenhuma chamada de rede deve sair daqui. */
  habilitado(): boolean {
    return this.http.habilitado();
  }

  listarCategorias(
    orgUnitId: string,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<CategoriaDeGrupo[]> {
    return this.condicoes.listarCategoriasDeGrupo(orgUnitId, ritmo);
  }

  /**
   * Cria a categoria JA com `numeroDeGrupos` grupos genericos dentro.
   *
   * O tipo "numero de grupos, sem inscricao" exige `NumberOfGroups` nao nulo, e
   * a documentacao nao garante que zero seja aceito. Pedir exatamente o numero
   * de nomes faz os genericos virarem os grupos da prova por renomeacao
   * (`planejarGrupos`), com o mesmo numero de chamadas que criar um a um.
   */
  async criarCategoria(
    orgUnitId: string,
    nome: string,
    numeroDeGrupos: number,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<CategoriaCriada> {
    const cfg = this.condicoes.exigirLpSuficiente();

    const trabalho = await this.http.chamar<TrabalhoDeGrupos | null>(
      cfg,
      'lp',
      this.categorias(orgUnitId),
      {
        ...this.opcoes(`a categoria "${nome}" da turma ${orgUnitId}`, ritmo),
        metodo: 'POST',
        corpo: {
          Name: nome,
          Description: DESCRICAO_VAZIA,
          EnrollmentStyle: NUMERO_DE_GRUPOS_SEM_INSCRICAO,
          EnrollmentQuantity: null,
          AutoEnroll: false,
          RandomizeEnrollments: false,
          NumberOfGroups: Math.max(1, numeroDeGrupos),
          MaxUsersPerGroup: null,
          AllocateAfterExpiry: false,
          SelfEnrollmentStartDate: null,
          SelfEnrollmentExpiryDate: null,
          // Com prefixo, a D2L o grudaria no nome E no codigo de cada grupo — e
          // o nome e a chave com que o disparo do quiz acha o grupo.
          GroupPrefix: null,
          RestrictedByOrgUnitId: null,
          DescriptionsVisibleToEnrolees: false,
        },
      },
    );

    const categoriaId = Number(trabalho?.CategoryId);

    if (!Number.isInteger(categoriaId) || categoriaId <= 0) {
      throw new BadGatewayException(
        `O Brightspace aceitou criar a categoria "${nome}" na turma ${orgUnitId}, ` +
          'mas nao devolveu o id dela. Resposta: ' +
          JSON.stringify(trabalho ?? null).slice(0, 200),
      );
    }

    return {
      categoriaId,
      concluida: Number(trabalho?.Status) === CRIACAO_CONCLUIDA,
    };
  }

  /** A criacao assincrona da categoria terminou? */
  async categoriaConcluida(
    orgUnitId: string,
    categoriaId: number,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<boolean> {
    const cfg = this.condicoes.exigirLpSuficiente();

    const situacao = await this.http.chamar<{
      Status?: number | string;
    } | null>(
      cfg,
      'lp',
      `${this.categorias(orgUnitId)}${categoriaId}/status`,
      this.opcoes(
        `a situacao da categoria ${categoriaId} da turma ${orgUnitId}`,
        ritmo,
      ),
    );

    return Number(situacao?.Status) === CRIACAO_CONCLUIDA;
  }

  /**
   * Os grupos da categoria, COM os inscritos.
   *
   * Ids normalizados para numero aqui, na fronteira: `Enrollments` e comparado
   * com o `userIdD2L` do agendamento, que o banco guarda como texto — comparar
   * `"183381"` com `183381` daria "nao inscrito" para todo mundo, e o lote
   * tentaria inscrever a turma inteira de novo.
   */
  async listarGrupos(
    orgUnitId: string,
    categoriaId: number,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<GrupoComInscritos[]> {
    const cfg = this.condicoes.exigirLpSuficiente();

    const dados = await this.http.chamar<GrupoLidoCru[] | null>(
      cfg,
      'lp',
      this.grupos(orgUnitId, categoriaId),
      this.opcoes(
        `os grupos da categoria ${categoriaId} da turma ${orgUnitId}`,
        ritmo,
      ),
    );

    return (Array.isArray(dados) ? dados : []).flatMap((grupo) => {
      const id = Number(grupo.GroupId);
      if (!Number.isInteger(id)) return [];

      return [
        {
          GroupId: id,
          Name: String(grupo.Name ?? ''),
          Enrollments: (grupo.Enrollments ?? [])
            .map(Number)
            .filter((userId) => Number.isInteger(userId)),
        },
      ];
    });
  }

  /** Devolve o `GroupId` criado, ou `null` se a resposta nao o trouxer. */
  async criarGrupo(
    orgUnitId: string,
    categoriaId: number,
    grupo: DadosDoGrupo,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<number | null> {
    const cfg = this.condicoes.exigirLpSuficiente();

    const criado = await this.http.chamar<GrupoLidoCru | null>(
      cfg,
      'lp',
      this.grupos(orgUnitId, categoriaId),
      {
        ...this.opcoes(`o grupo "${grupo.nome}" da turma ${orgUnitId}`, ritmo),
        metodo: 'POST',
        corpo: this.corpoDoGrupo(grupo),
      },
    );

    const id = Number(criado?.GroupId);
    return Number.isInteger(id) ? id : null;
  }

  async renomearGrupo(
    orgUnitId: string,
    categoriaId: number,
    groupId: number,
    grupo: DadosDoGrupo,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<void> {
    const cfg = this.condicoes.exigirLpSuficiente();

    await this.http.chamar(
      cfg,
      'lp',
      `${this.grupos(orgUnitId, categoriaId)}${groupId}`,
      {
        ...this.opcoes(`o grupo ${groupId} da turma ${orgUnitId}`, ritmo),
        metodo: 'PUT',
        corpo: this.corpoDoGrupo(grupo),
      },
    );
  }

  /**
   * ⚠️ `UserId` vai NUMERO no corpo. O `userIdD2L` do agendamento e texto, e a
   * conversao e responsabilidade de quem chama — este metodo so aceita `number`
   * para que o tipo obrigue a conversao a acontecer antes.
   *
   * 404 = usuario inexistente ou fora da turma (sobe `NaoEncontradoNoBrightspace`);
   * 409 = grupo cheio ou categoria ainda processando.
   */
  async inscrever(
    orgUnitId: string,
    categoriaId: number,
    groupId: number,
    userId: number,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<void> {
    const cfg = this.condicoes.exigirLpSuficiente();

    await this.http.chamar(
      cfg,
      'lp',
      `${this.grupos(orgUnitId, categoriaId)}${groupId}/enrollments/`,
      {
        ...this.opcoes(
          `a inscricao do usuario ${userId} no grupo ${groupId} da turma ${orgUnitId}`,
          ritmo,
        ),
        metodo: 'POST',
        corpo: { UserId: userId },
      },
    );
  }

  async desinscrever(
    orgUnitId: string,
    categoriaId: number,
    groupId: number,
    userId: number,
    ritmo: OpcoesDeRitmo = {},
  ): Promise<void> {
    const cfg = this.condicoes.exigirLpSuficiente();

    await this.http.chamar(
      cfg,
      'lp',
      `${this.grupos(orgUnitId, categoriaId)}${groupId}/enrollments/${userId}`,
      {
        ...this.opcoes(
          `a remocao do usuario ${userId} do grupo ${groupId} da turma ${orgUnitId}`,
          ritmo,
        ),
        metodo: 'DELETE',
      },
    );
  }

  // ------------------------------------------------------------------ interno

  private categorias(orgUnitId: string): string {
    return `${encodeURIComponent(orgUnitId)}/groupcategories/`;
  }

  private grupos(orgUnitId: string, categoriaId: number): string {
    return `${this.categorias(orgUnitId)}${encodeURIComponent(String(categoriaId))}/groups/`;
  }

  private corpoDoGrupo(grupo: DadosDoGrupo) {
    return {
      Name: grupo.nome,
      Code: grupo.codigo,
      Description: DESCRICAO_VAZIA,
    };
  }

  /**
   * `retentar429` ligado: quem chama e o lote. Repetir depois de um 429 e seguro
   * porque a chamada recusada nao foi executada.
   */
  private opcoes(oQue: string, ritmo: OpcoesDeRitmo): OpcoesChamadaD2L {
    return {
      oQue,
      atrasoMs: ritmo.atrasoMs,
      timeoutMs: ritmo.timeoutMs,
      retentar429: true,
      dicaDe404:
        'Confira se a turma, a categoria e o grupo existem — e, numa inscricao, ' +
        'se o aluno esta matriculado nesta turma do Brightspace.',
    };
  }
}
