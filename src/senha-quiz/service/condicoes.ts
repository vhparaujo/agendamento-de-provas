/**
 * ============================================================================
 * O CORPO DO PUT DE CONDICOES — e por que ele copia TUDO verbatim
 * ============================================================================
 *
 * `PUT /lp/{v}/{orgUnitId}/conditionalRelease/conditions/quizzes/{quizId}`
 * **SUBSTITUI A LISTA INTEIRA de condicoes.** Condicao que nao voltar no corpo e
 * condicao APAGADA da prova. E o mesmo principio do PUT do quiz (`quiz-body.ts`),
 * com um agravante que o objeto do quiz nao tinha:
 *
 * ⚠️ **Condicoes que a API nao modela chegam com `Type: "RoundTrip"` e um `State`
 * opaco.** Se elas nao voltarem com `Type` e `State` INTACTOS, elas somem — e
 * nada no retorno da API acusa isso. Uma prova pode ter restricao de data, de
 * nota, de conclusao de conteudo; o lote nao sabe ler nenhuma delas, e nao
 * precisa. Ele so precisa devolve-las byte a byte.
 *
 * Por isso a funcao abaixo **clona todos os operandos** e mexe em exatamente um
 * campo de um tipo de operando. Nao "simplifique" para montar o operando de
 * grupo do zero: montar do zero e o bug, porque o `State` se perde.
 *
 * ============================================================================
 * ESTE ARQUIVO NAO TOCA O OBJETO DO QUIZ
 * ============================================================================
 * As condicoes de liberacao vivem num recurso LP separado — nao sao campo do
 * `QuizData`. Isso e uma boa noticia: a troca de grupo NAO passa pelos ~35
 * campos de `montarCorpoDoQuiz`, entao ela nao pode apagar `EndDate` nem
 * `Password`. Os dois PUTs sao independentes e falham independentemente, que e
 * exatamente o que sustenta a decisao "falha de grupo nao bloqueia a data".
 *
 * Portado de `brightspace-change-conditions/src/updateConditions.js`
 * (`trocarGrupo`), validado contra a instancia real em 07/08/2026.
 */

/** O discriminador do operando de grupo. A LP usa string, nao id numerico. */
const TIPO_GRUPO = 'EnrolledInGroup';
const PARAMS_GRUPO = 'EnrolledInGroupParams';

/**
 * `Text` e gerado pelo SERVIDOR e ignorado na escrita — a doc da D2L diz isso, e
 * o PUT validado na instancia real foi enviado sem ele. Reenvia-lo nao da erro;
 * simplesmente nao ha por que mandar de volta um campo que o servidor recalcula.
 */
interface TextoDoServidor {
  Text?: string | null;
  Html?: string | null;
}

export interface ParamsDeGrupo {
  GroupId?: number | null;
  /**
   * Preenchido significa "qualquer grupo da CATEGORIA", nao um grupo especifico.
   * Ver o aviso em `trocarGrupoNasCondicoes`.
   */
  GroupCategoryId?: number | null;
}

/**
 * Um operando como a LEITURA devolve.
 *
 * O index signature nao e preguica: e o que permite copiar verbatim os campos de
 * tipos de condicao que este codigo nao conhece — que sao a maioria deles, e os
 * que somem em silencio se forem perdidos.
 */
export interface OperandoLido {
  Type?: string;
  State?: unknown;
  Text?: TextoDoServidor | null;
  [outros: string]: unknown;
}

export interface CondicoesLidas {
  Expression?: {
    Type?: string;
    State?: unknown;
    Text?: TextoDoServidor | null;
    ExpressionParams?: {
      Operator?: string;
      Operands?: OperandoLido[];
    } | null;
  } | null;
}

/** O corpo que o PUT aceita. Sem `Text`, nem no topo nem nos operandos. */
export interface CorpoDeCondicoes {
  Expression: {
    Type: 'Expression';
    State: unknown;
    ExpressionParams: {
      Operator: string;
      Operands: OperandoLido[];
    };
  };
}

export interface ResultadoDaTroca {
  /**
   * `null` = **nao ha o que trocar, e nenhum PUT deve ser emitido**.
   *
   * Nao e a mesma coisa que "corpo vazio": um PUT com a lista de operandos
   * intacta seria uma escrita sem efeito, mas ainda assim uma escrita — em toda
   * prova da instituicao, contra um endpoint que substitui tudo. Emitir zero
   * chamadas quando nao ha troca e a diferenca entre um no-op e um risco.
   */
  corpo: CorpoDeCondicoes | null;
  /** Quantos operandos de grupo tiveram o `GroupId` trocado. */
  trocadas: number;
  /** Os `GroupId` que estavam la antes — para o relatorio dizer de onde saiu. */
  antes: number[];
  /** Operandos copiados sem alteracao, incluindo os de outros tipos. */
  preservadas: number;
  /** Um operando de grupo por CATEGORIA foi encontrado e preservado. */
  porCategoria: boolean;
  avisos: string[];
}

/** Copia profunda. Os operandos sao JSON puro — vieram de um `response.json()`. */
function clonar<T>(valor: T): T {
  return JSON.parse(JSON.stringify(valor)) as T;
}

/**
 * Recebe o `ConditionsData` lido no GET e devolve o corpo do PUT com o grupo
 * trocado, mais o diagnostico do que aconteceu.
 *
 * As regras, uma a uma:
 *
 *  - operando `EnrolledInGroup` com `GroupId` preenchido → **troca o GroupId**;
 *  - operando `EnrolledInGroup` com `GroupCategoryId`    → **preserva e avisa**;
 *  - qualquer outro operando                            → **preserva verbatim**.
 *
 * ⚠️ **Por que a condicao por CATEGORIA nao e trocada.** `GroupCategoryId`
 * preenchido quer dizer "membro de qualquer grupo desta categoria" — a condicao
 * nao aponta para uma sessao, aponta para o conjunto delas. Trocar isso por um
 * `GroupId` mudaria o SIGNIFICADO da condicao, nao o alvo dela: uma prova que
 * estava liberada para todos os turnos passaria a valer para um so, ou o
 * contrario, dependendo de quem a configurou e por que. Ninguem pediu isso.
 *
 * ⚠️ **O `State` do operando trocado continua o ANTIGO.** Ele descreve, do lado
 * do servidor, a condicao que estava la ("Prova 1"). Parece errado e nao e: foi
 * exatamente nessa forma que o PUT manual validado na instancia real devolveu
 * 200, e o servidor recalcula o `State` a partir dos params. Inventar um `State`
 * novo e o caminho de perder a condicao.
 */
export function trocarGrupoNasCondicoes(
  condicoes: CondicoesLidas | null | undefined,
  novoGroupId: number,
): ResultadoDaTroca {
  const expressao = condicoes?.Expression ?? null;
  const params = expressao?.ExpressionParams ?? {};
  const originais = Array.isArray(params.Operands) ? params.Operands : [];

  // O operador vem do GET e volta verbatim. `All` como fallback e o que a
  // instancia real usa e o que a API assume; inventar `Any` afrouxaria a
  // restricao de uma prova sem ninguem ter pedido.
  const operador = params.Operator ?? 'All';

  const avisos: string[] = [];
  const antes: number[] = [];
  let trocadas = 0;
  let preservadas = 0;
  let porCategoria = false;

  const operandos = originais.map((operando) => {
    const copia = clonar(operando ?? {});

    // Gerado pelo servidor e ignorado na escrita — ver TextoDoServidor.
    delete copia.Text;

    if (copia.Type === TIPO_GRUPO) {
      const p = (copia[PARAMS_GRUPO] ?? {}) as ParamsDeGrupo;

      if (p.GroupId != null) {
        antes.push(Number(p.GroupId));
        copia[PARAMS_GRUPO] = {
          GroupId: Number(novoGroupId),
          GroupCategoryId: null,
        };
        trocadas += 1;
        return copia;
      }

      porCategoria = true;
      avisos.push(
        'Há uma condição que libera QUALQUER grupo de uma categoria: ela ' +
          'foi preservada, não trocada.',
      );
    }

    preservadas += 1;
    return copia;
  });

  if (trocadas === 0) {
    return {
      corpo: null,
      trocadas: 0,
      antes,
      preservadas,
      porCategoria,
      avisos,
    };
  }

  if (trocadas > 1) {
    // Nao e recusa: a prova pode legitimamente exigir dois grupos. Mas mandar as
    // duas para o MESMO grupo transforma um `All` de dois grupos numa condicao
    // redundante, e isso quase nunca e o que se queria.
    avisos.push(
      `${trocadas} condições de grupo foram apontadas para o MESMO grupo — ` +
        'confira se era isso mesmo.',
    );
  }

  return {
    corpo: {
      Expression: {
        Type: 'Expression',
        // Copiado do GET. `undefined` viraria chave ausente no JSON, que nao e a
        // mesma coisa que `null` para uma API que substitui o objeto.
        State: expressao?.State !== undefined ? expressao.State : null,
        ExpressionParams: { Operator: operador, Operands: operandos },
      },
    },
    trocadas,
    antes,
    preservadas,
    porCategoria,
    avisos,
  };
}

export interface ResultadoDaRemocao {
  /**
   * `null` = **a prova nao tem condicao de grupo, e nenhum PUT deve sair** — mesma
   * regra de `ResultadoDaTroca.corpo`.
   */
  corpo: CorpoDeCondicoes | null;
  /** Quantos operandos `EnrolledInGroup` sairam (por GroupId ou por categoria). */
  removidas: number;
  /** Operandos de outros tipos, que voltam verbatim. */
  preservadas: number;
}

/**
 * O corpo do PUT SEM as condicoes de grupo — o preparo para o special access
 * (15/09/2026).
 *
 * Com o questionario restrito a quem tem special access, a condicao de grupo
 * deixa de ser o que libera a prova e passa a ser o que a TRANCA: o
 * special access nao passa por cima de uma condicao de liberacao, e o aluno
 * agendado ficaria sem acesso por nao estar no grupo da sessao.
 *
 * Saem TODOS os `EnrolledInGroup`, inclusive os por categoria: todos restringem
 * por grupo, que e o que o special access substitui. Qualquer outro operando
 * volta verbatim, com `Type` e `State` intactos — ver o cabecalho.
 *
 * Lista de operandos VAZIA e valida: a documentacao da Valence diz que e assim
 * que se removem todas as condicoes do alvo.
 */
export function removerGruposDasCondicoes(
  condicoes: CondicoesLidas | null | undefined,
): ResultadoDaRemocao {
  const expressao = condicoes?.Expression ?? null;
  const params = expressao?.ExpressionParams ?? {};
  const originais = Array.isArray(params.Operands) ? params.Operands : [];

  const mantidos: OperandoLido[] = [];
  let removidas = 0;

  for (const operando of originais) {
    if (operando?.Type === TIPO_GRUPO) {
      removidas += 1;
      continue;
    }

    const copia = clonar(operando ?? {});
    // Gerado pelo servidor e ignorado na escrita — ver TextoDoServidor.
    delete copia.Text;
    mantidos.push(copia);
  }

  if (removidas === 0) {
    return { corpo: null, removidas: 0, preservadas: mantidos.length };
  }

  return {
    corpo: {
      Expression: {
        Type: 'Expression',
        State: expressao?.State !== undefined ? expressao.State : null,
        ExpressionParams: {
          // Verbatim, como na troca: inventar `Any` afrouxaria o que sobrou.
          Operator: params.Operator ?? 'All',
          Operands: mantidos,
        },
      },
    },
    removidas,
    preservadas: mantidos.length,
  };
}

/**
 * Os `GroupId` de grupo que a prova exige hoje — sem trocar nada.
 *
 * Existe para o dry-run e para o relatorio poderem dizer "estava em Prova 1"
 * mesmo quando nenhuma troca aconteceu.
 */
export function gruposDasCondicoes(
  condicoes: CondicoesLidas | null | undefined,
): number[] {
  const operandos = condicoes?.Expression?.ExpressionParams?.Operands ?? [];

  return operandos
    .filter((op) => op?.Type === TIPO_GRUPO)
    .map((op) => (op[PARAMS_GRUPO] as ParamsDeGrupo | undefined)?.GroupId)
    .filter((id): id is number => id != null)
    .map(Number);
}
