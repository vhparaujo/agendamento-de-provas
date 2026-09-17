import {
  CondicoesLidas,
  gruposDasCondicoes,
  removerGruposDasCondicoes,
  trocarGrupoNasCondicoes,
} from './condicoes';

/**
 * ============================================================================
 * A REDE DE SEGURANCA DA TROCA DE GRUPO
 * ============================================================================
 * O PUT de `conditionalRelease` SUBSTITUI a lista inteira de condicoes. O modo
 * de falha que estes testes existem para pegar nao produz erro nenhum na API:
 * uma condicao que nao volta no corpo simplesmente desaparece da prova, e a
 * descoberta e no dia, com o aluno na frente.
 *
 * Gemeo de `quiz-body.spec.ts` em papel: la a lista congelada de 35 campos, aqui
 * a preservacao verbatim dos operandos.
 */

/** Um operando de grupo, como a instancia real o devolve. */
const operandoDeGrupo = (groupId: number, state = '224735') => ({
  Type: 'EnrolledInGroup',
  State: state,
  EnrolledInGroupParams: { GroupId: groupId, GroupCategoryId: null },
  Text: { Text: 'Membro do grupo: Prova 1', Html: '<b>Prova 1</b>' },
});

const condicoesCom = (
  operandos: Record<string, unknown>[],
  operador = 'All',
  state: unknown = null,
): CondicoesLidas => ({
  Expression: {
    Type: 'Expression',
    State: state,
    ExpressionParams: { Operator: operador, Operands: operandos },
    Text: { Text: 'Todas as condicoes', Html: 'Todas as condicoes' },
  },
});

describe('trocarGrupoNasCondicoes', () => {
  it('troca so o GroupId do operando de grupo', () => {
    const r = trocarGrupoNasCondicoes(
      condicoesCom([operandoDeGrupo(156988)]),
      156989,
    );

    expect(r.trocadas).toBe(1);
    expect(r.antes).toEqual([156988]);
    expect(r.corpo?.Expression.ExpressionParams.Operands[0]).toMatchObject({
      Type: 'EnrolledInGroup',
      EnrolledInGroupParams: { GroupId: 156989, GroupCategoryId: null },
    });
  });

  /**
   * ⚠️ O TESTE MAIS IMPORTANTE DESTE ARQUIVO.
   *
   * Condicoes que a API nao modela chegam como `RoundTrip` com um `State` opaco.
   * Se elas nao voltarem com `Type` e `State` INTACTOS, elas somem — e nada no
   * retorno da API acusa isso. Uma prova pode ter restricao de data, de nota ou
   * de conclusao de conteudo; o lote nao sabe ler nenhuma delas, e nao precisa:
   * ele so precisa devolve-las byte a byte.
   */
  it('devolve operandos RoundTrip com Type e State intactos', () => {
    const roundTrip = {
      Type: 'RoundTrip',
      State: '{"opaco":true,"nota":7}',
    };

    const r = trocarGrupoNasCondicoes(
      condicoesCom([roundTrip, operandoDeGrupo(156988)]),
      156989,
    );

    const operandos = r.corpo!.Expression.ExpressionParams.Operands;

    expect(operandos).toHaveLength(2);
    expect(operandos[0]).toEqual(roundTrip);
    expect(r.preservadas).toBe(1);
  });

  it('preserva verbatim um operando de tipo desconhecido', () => {
    const outro = {
      Type: 'DateRestriction',
      State: 'xyz',
      CampoQueNaoConhecemos: { aninhado: [1, 2, 3] },
    };

    const r = trocarGrupoNasCondicoes(
      condicoesCom([outro, operandoDeGrupo(156988)]),
      156989,
    );

    expect(r.corpo!.Expression.ExpressionParams.Operands[0]).toEqual(outro);
  });

  /**
   * `Text` e gerado pelo servidor e ignorado na escrita. Sai de todo operando e
   * do topo da expressao — o corpo e remontado do zero com `Type`, `State` e
   * `ExpressionParams`, e nada mais.
   */
  it('descarta Text dos operandos e do topo da expressao', () => {
    const r = trocarGrupoNasCondicoes(
      condicoesCom([operandoDeGrupo(156988)]),
      156989,
    );

    expect(r.corpo!.Expression.ExpressionParams.Operands[0]).not.toHaveProperty(
      'Text',
    );
    expect(r.corpo!.Expression).not.toHaveProperty('Text');
  });

  /**
   * `GroupCategoryId` preenchido significa "qualquer grupo da categoria": a
   * condicao aponta para o CONJUNTO de sessoes, nao para uma. Trocar isso por um
   * GroupId mudaria o significado dela, nao o alvo.
   */
  it('preserva e avisa quando a condicao de grupo e por CATEGORIA', () => {
    const porCategoria = {
      Type: 'EnrolledInGroup',
      State: 'abc',
      EnrolledInGroupParams: { GroupId: null, GroupCategoryId: 8882 },
    };

    const r = trocarGrupoNasCondicoes(condicoesCom([porCategoria]), 156989);

    expect(r.trocadas).toBe(0);
    expect(r.porCategoria).toBe(true);
    expect(r.corpo).toBeNull();
    expect(r.avisos.join(' ')).toContain('QUALQUER grupo de uma categoria');
  });

  /**
   * NADA e criado. `corpo: null` e o sinal de que NENHUM PUT deve sair — nao a
   * mesma coisa que um corpo vazio, que ainda seria uma escrita num endpoint que
   * substitui tudo.
   */
  it('devolve corpo NULO quando nao ha condicao de grupo — nao cria nenhuma', () => {
    const r = trocarGrupoNasCondicoes(
      condicoesCom([{ Type: 'RoundTrip', State: 'x' }]),
      156989,
    );

    expect(r.corpo).toBeNull();
    expect(r.trocadas).toBe(0);
  });

  it('devolve corpo NULO quando a prova nao tem condicao nenhuma', () => {
    expect(trocarGrupoNasCondicoes(condicoesCom([]), 156989).corpo).toBeNull();
    expect(trocarGrupoNasCondicoes(null, 156989).corpo).toBeNull();
    expect(trocarGrupoNasCondicoes({}, 156989).corpo).toBeNull();
  });

  /**
   * O `Operator` vem do GET e volta verbatim. Trocar um `Any` por `All`
   * APERTARIA a restricao da prova, e o contrario a afrouxaria — os dois sem
   * ninguem ter pedido.
   */
  it('copia o Operator do GET, e usa All so quando ele falta', () => {
    expect(
      trocarGrupoNasCondicoes(condicoesCom([operandoDeGrupo(1)], 'Any'), 2)
        .corpo!.Expression.ExpressionParams.Operator,
    ).toBe('Any');

    expect(
      trocarGrupoNasCondicoes(
        {
          Expression: { ExpressionParams: { Operands: [operandoDeGrupo(1)] } },
        },
        2,
      ).corpo!.Expression.ExpressionParams.Operator,
    ).toBe('All');
  });

  /**
   * O `State` da expressao e opaco e vem do servidor. `undefined` viraria chave
   * AUSENTE no JSON, que nao e a mesma coisa que `null` para uma API que
   * substitui o objeto inteiro.
   */
  it('copia o State da expressao, e usa null quando ele e undefined', () => {
    expect(
      trocarGrupoNasCondicoes(
        condicoesCom([operandoDeGrupo(1)], 'All', 'estado-opaco'),
        2,
      ).corpo!.Expression.State,
    ).toBe('estado-opaco');

    expect(
      trocarGrupoNasCondicoes(
        {
          Expression: { ExpressionParams: { Operands: [operandoDeGrupo(1)] } },
        },
        2,
      ).corpo!.Expression.State,
    ).toBeNull();
  });

  /**
   * O `State` do OPERANDO trocado continua o antigo — foi nessa forma que o PUT
   * validado na instancia real devolveu 200. Inventar um `State` novo e o
   * caminho de perder a condicao.
   */
  it('mantem o State do operando trocado', () => {
    const r = trocarGrupoNasCondicoes(
      condicoesCom([operandoDeGrupo(156988, 'state-do-prova-1')]),
      156989,
    );

    expect(r.corpo!.Expression.ExpressionParams.Operands[0].State).toBe(
      'state-do-prova-1',
    );
  });

  it('nao modifica o objeto lido — o backup precisa continuar fiel', () => {
    const lidas = condicoesCom([operandoDeGrupo(156988)]);
    const copia = JSON.parse(JSON.stringify(lidas)) as unknown;

    trocarGrupoNasCondicoes(lidas, 156989);

    expect(lidas).toEqual(copia);
  });

  it('avisa quando duas condicoes de grupo viram o MESMO grupo', () => {
    const r = trocarGrupoNasCondicoes(
      condicoesCom([operandoDeGrupo(1), operandoDeGrupo(2)]),
      99,
    );

    expect(r.trocadas).toBe(2);
    expect(r.antes).toEqual([1, 2]);
    expect(r.avisos.join(' ')).toContain('MESMO grupo');
  });
});

describe('gruposDasCondicoes', () => {
  it('lista os GroupId exigidos hoje, sem trocar nada', () => {
    expect(
      gruposDasCondicoes(
        condicoesCom([
          { Type: 'RoundTrip', State: 'x' },
          operandoDeGrupo(156988),
        ]),
      ),
    ).toEqual([156988]);
  });

  it('ignora condicao de grupo por categoria e ausencia de condicoes', () => {
    expect(
      gruposDasCondicoes(
        condicoesCom([
          {
            Type: 'EnrolledInGroup',
            EnrolledInGroupParams: { GroupId: null, GroupCategoryId: 8882 },
          },
        ]),
      ),
    ).toEqual([]);

    expect(gruposDasCondicoes(null)).toEqual([]);
  });
});

/**
 * O preparo para o special access (15/09/2026). O mesmo risco da troca: o PUT
 * substitui a lista inteira, e o que nao voltar some da prova.
 */
describe('removerGruposDasCondicoes', () => {
  const outroTipo = () => ({
    Type: 'RoundTrip',
    State: 'opaco-que-o-servidor-precisa-de-volta',
    Text: { Text: 'Concluiu o modulo 3', Html: null },
  });

  const porCategoria = {
    Type: 'EnrolledInGroup',
    State: '991',
    EnrolledInGroupParams: { GroupId: null, GroupCategoryId: 77 },
  };

  it('tira TODO operando de grupo e devolve os outros verbatim', () => {
    const r = removerGruposDasCondicoes(
      condicoesCom(
        [operandoDeGrupo(156988), outroTipo(), porCategoria],
        'All',
        'estado-da-expressao',
      ),
    );

    expect(r.removidas).toBe(2);
    expect(r.preservadas).toBe(1);
    expect(r.corpo).toEqual({
      Expression: {
        Type: 'Expression',
        State: 'estado-da-expressao',
        ExpressionParams: {
          Operator: 'All',
          // Sem `Text`, que o servidor gera; `Type` e `State` intactos.
          Operands: [
            {
              Type: 'RoundTrip',
              State: 'opaco-que-o-servidor-precisa-de-volta',
            },
          ],
        },
      },
    });
  });

  it('so condicao de grupo: lista VAZIA, que e como a Valence remove todas', () => {
    const r = removerGruposDasCondicoes(
      condicoesCom([operandoDeGrupo(156988)], 'Any'),
    );

    expect(r.corpo?.Expression.ExpressionParams).toEqual({
      Operator: 'Any',
      Operands: [],
    });
  });

  it('sem condicao de grupo: nenhum PUT', () => {
    expect(
      removerGruposDasCondicoes(condicoesCom([outroTipo()])).corpo,
    ).toBeNull();
    expect(removerGruposDasCondicoes(null).corpo).toBeNull();
  });

  it('nao altera o objeto lido', () => {
    const lidas = condicoesCom([operandoDeGrupo(1), outroTipo()]);
    const antes = JSON.stringify(lidas);

    removerGruposDasCondicoes(lidas);

    expect(JSON.stringify(lidas)).toBe(antes);
  });
});
