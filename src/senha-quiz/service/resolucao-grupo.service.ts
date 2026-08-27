import { Injectable } from '@nestjs/common';
import {
  CategoriaDeGrupo,
  D2lCondicoesService,
  GrupoDaTurma,
} from '../../d2l/service/d2l-condicoes.service';
import { ResultadoGrupoQuiz } from '../../generated/prisma/client';
import { OpcoesDeRitmo } from '../../d2l/service/d2l-quizzes.service';
import { normalizarNomeDeGrupo } from './grupo';

/**
 * ============================================================================
 * NOME DE GRUPO -> GroupId, TURMA A TURMA
 * ============================================================================
 * A diferenca central em relacao a senha: a senha e um LITERAL — a mesma string
 * serve para as 157 turmas. O `GroupId` NAO e. Cada turma tem os seus proprios
 * grupos, com ids proprios, mesmo com nomes identicos: "Prova 2" existe em todas
 * as turmas, com um id diferente em cada uma.
 *
 * Por isso `JanelaDeProva` guarda o NOME e este servico resolve o id turma a
 * turma. Gravar um id na janela liberaria a prova de 156 turmas para um grupo que
 * so existe numa delas — e a API aceitaria, porque o id existe.
 *
 * De quebra, o mapa carregado aqui (`nomePorId`) serve ao relatorio, que mostra
 * o NOME do grupo que estava na condicao antes da troca em vez de um numero.
 *
 * ⚠️ **Uma instancia POR EXECUCAO, nunca um singleton com cache longo.** O cache
 * abaixo e o que evita relistar os grupos de uma turma que aparece em varios
 * quizzes; mante-lo entre execucoes faria um grupo criado (ou renomeado) no
 * Brightspace as 11h continuar invisivel no disparo das 12:01, sem nada no log
 * dizendo por que. Grupo e cadastro que a secretaria mexe no dia.
 *
 * Portado de `brightspace-change-conditions/src/groupResolver.js`.
 */

export interface GrupoResolvido {
  GroupId: number;
  Name: string;
  Categoria: string;
}

export interface ResolucaoDeGrupo {
  /** O grupo-alvo naquela turma, ou `null` quando `falha` explica o porque. */
  alvo: GrupoResolvido | null;
  /** O desfecho a gravar no item. Nulo quando `alvo` veio preenchido. */
  falha: ResultadoGrupoQuiz | null;
  /** A mensagem que vai para o `detalhe` do item. */
  motivo: string | null;
  /** Todos os grupos vistos na varredura — para rotular o grupo ANTERIOR. */
  nomePorId: Map<number, string>;
}

@Injectable()
export class ResolucaoGrupoService {
  constructor(private readonly condicoes: D2lCondicoesService) {}

  /**
   * Uma sessao de resolucao com cache proprio, para UM lote.
   *
   * Fabrica em vez de metodo com `Map` interno: o servico e um singleton do Nest,
   * e um cache no campo da instancia sobreviveria entre execucoes — ver o aviso
   * no cabecalho.
   */
  paraOLote(
    nome: string,
    categoria: string | null,
    ritmo: OpcoesDeRitmo,
  ): SessaoDeResolucao {
    return new SessaoDeResolucao(this.condicoes, nome, categoria, ritmo);
  }
}

/** O cache vive aqui, e morre junto com o lote. */
export class SessaoDeResolucao {
  private readonly cache = new Map<string, ResolucaoDeGrupo>();

  constructor(
    private readonly condicoes: D2lCondicoesService,
    private readonly nome: string,
    private readonly categoria: string | null,
    private readonly ritmo: OpcoesDeRitmo,
  ) {}

  /**
   * Localiza o grupo-alvo dentro de uma turma.
   *
   * **NUNCA lanca.** Falha vira `{ alvo: null, falha, motivo }`, porque quem
   * chama esta dentro de um `Promise.all` de turmas e uma excecao levaria junto
   * a fatia inteira. Mesma decisao de `aplicarNaTurma`.
   */
  async resolver(orgUnitId: string): Promise<ResolucaoDeGrupo> {
    const cacheado = this.cache.get(orgUnitId);
    if (cacheado) return cacheado;

    const resultado = await this.buscar(orgUnitId);
    this.cache.set(orgUnitId, resultado);
    return resultado;
  }

  private async buscar(orgUnitId: string): Promise<ResolucaoDeGrupo> {
    const nomePorId = new Map<number, string>();

    let categorias: CategoriaDeGrupo[];

    try {
      categorias = await this.condicoes.listarCategoriasDeGrupo(
        orgUnitId,
        this.ritmo,
      );
    } catch (erro) {
      return {
        alvo: null,
        falha: ResultadoGrupoQuiz.FALHA_AO_LER_CONDICOES,
        motivo: `Falha ao listar as categorias de grupo: ${this.motivo(erro)}`,
        nomePorId,
      };
    }

    if (categorias.length === 0) {
      return {
        alvo: null,
        falha: ResultadoGrupoQuiz.SEM_CATEGORIA_DE_GRUPO,
        motivo:
          'A turma nao tem nenhuma categoria de grupo, entao nao ha onde ' +
          `procurar "${this.nome}". Como toda turma deveria ter os grupos de ` +
          'prova criados, isto e falta de cadastro nesta turma.',
        nomePorId,
      };
    }

    // Com a categoria informada, busca-se so nela: e mais barato em chamadas e
    // evita casar um homonimo de outra categoria.
    const alvoCategoria = this.categoria
      ? normalizarNomeDeGrupo(this.categoria)
      : null;

    const aVarrer = alvoCategoria
      ? categorias.filter(
          (c) => normalizarNomeDeGrupo(c.Name) === alvoCategoria,
        )
      : categorias;

    if (alvoCategoria && aVarrer.length === 0) {
      return {
        alvo: null,
        falha: ResultadoGrupoQuiz.GRUPO_NAO_ENCONTRADO,
        motivo:
          `A categoria "${this.categoria}" nao existe nesta turma. ` +
          `Existem: ${categorias.map((c) => c.Name).join(', ')}.`,
        nomePorId,
      };
    }

    const alvoNome = normalizarNomeDeGrupo(this.nome);
    const achados: GrupoResolvido[] = [];

    for (const categoria of aVarrer) {
      let grupos: GrupoDaTurma[];

      try {
        grupos = await this.condicoes.listarGrupos(
          orgUnitId,
          categoria.GroupCategoryId ?? '',
          this.ritmo,
        );
      } catch (erro) {
        return {
          alvo: null,
          falha: ResultadoGrupoQuiz.FALHA_AO_LER_CONDICOES,
          motivo:
            `Falha ao listar os grupos da categoria "${categoria.Name}": ` +
            this.motivo(erro),
          nomePorId,
        };
      }

      for (const grupo of grupos) {
        const id = Number(grupo.GroupId);
        if (!Number.isFinite(id)) continue;

        // O mapa recebe TODOS os grupos vistos, nao so os que casaram: ele
        // existe para nomear o grupo ANTERIOR da condicao, que por definicao e
        // outro.
        nomePorId.set(id, String(grupo.Name ?? ''));

        if (normalizarNomeDeGrupo(grupo.Name) === alvoNome) {
          achados.push({
            GroupId: id,
            Name: String(grupo.Name ?? this.nome),
            Categoria: String(categoria.Name ?? ''),
          });
        }
      }
    }

    if (achados.length === 0) {
      const disponiveis = [...nomePorId.values()].filter(Boolean);

      return {
        alvo: null,
        falha: ResultadoGrupoQuiz.GRUPO_NAO_ENCONTRADO,
        motivo:
          `Nenhum grupo chamado "${this.nome}" nesta turma. ` +
          (disponiveis.length
            ? `Grupos existentes: ${disponiveis.join(' | ')}.`
            : 'A turma nao tem grupos nessa(s) categoria(s).'),
        nomePorId,
      };
    }

    if (achados.length > 1) {
      // ⚠️ Ambiguo e PIOR que ausente. Escolher um no chute liberaria a prova
      // para o turno errado, e o erro so apareceria no dia, com os alunos na
      // frente. Mesma regra de ORGUNIT_AMBIGUO e MODALIDADE_AMBIGUA: nada e
      // chutado.
      return {
        alvo: null,
        falha: ResultadoGrupoQuiz.GRUPO_AMBIGUO,
        motivo:
          `"${this.nome}" aparece ${achados.length} vezes nesta turma ` +
          `(categorias: ${achados.map((a) => a.Categoria).join(', ')}). ` +
          'Preencha a categoria na janela para desempatar.',
        nomePorId,
      };
    }

    return { alvo: achados[0], falha: null, motivo: null, nomePorId };
  }

  /** Truncado: `detalhe` e para ler, nao para despejar stack. */
  private motivo(erro: unknown): string {
    return (erro instanceof Error ? erro.message : String(erro)).slice(0, 400);
  }
}
