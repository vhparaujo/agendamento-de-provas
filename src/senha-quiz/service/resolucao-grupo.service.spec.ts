import { D2lCondicoesService } from '../../d2l/service/d2l-condicoes.service';
import { ResultadoGrupoQuiz } from '../../generated/prisma/client';
import { ResolucaoGrupoService } from './resolucao-grupo.service';

describe('ResolucaoGrupoService', () => {
  const montar = (opcoes: {
    categorias?: { GroupCategoryId: number; Name: string }[];
    /** categoriaId -> grupos. */
    grupos?: Record<number, { GroupId: number; Name: string }[]>;
    categoriasLanca?: boolean;
    gruposLanca?: boolean;
  }) => {
    const listarCategoriasDeGrupo = jest.fn().mockImplementation(() => {
      if (opcoes.categoriasLanca)
        return Promise.reject(new Error('403 sem escopo'));
      return Promise.resolve(
        opcoes.categorias ?? [{ GroupCategoryId: 1, Name: 'Provas' }],
      );
    });

    const listarGrupos = jest
      .fn()
      .mockImplementation((_org: string, categoriaId: number) => {
        if (opcoes.gruposLanca)
          return Promise.reject(new Error('tenant fora do ar'));
        return Promise.resolve(
          opcoes.grupos?.[categoriaId] ?? [
            { GroupId: 11, Name: 'Prova 1' },
            { GroupId: 12, Name: 'Prova 2' },
          ],
        );
      });

    const cliente = {
      listarCategoriasDeGrupo,
      listarGrupos,
    } as unknown as D2lCondicoesService;

    return {
      servico: new ResolucaoGrupoService(cliente),
      listarCategoriasDeGrupo,
      listarGrupos,
    };
  };

  it('resolve o nome para o GroupId daquela turma', async () => {
    const { servico } = montar({});

    const r = await servico.paraOLote('Prova 2', null, {}).resolver('156126');

    expect(r.falha).toBeNull();
    expect(r.alvo).toMatchObject({ GroupId: 12, Name: 'Prova 2' });
  });

  it('casa o nome ignorando acento, caixa e espaco', async () => {
    const { servico } = montar({
      grupos: { 1: [{ GroupId: 20, Name: 'Manhã - 16/09' }] },
    });

    const r = await servico
      .paraOLote('  MANHA  -  16/09 ', null, {})
      .resolver('156126');

    expect(r.alvo?.GroupId).toBe(20);
  });

  /**
   * ⚠️ Ambiguo e PIOR que ausente. Escolher um homonimo no chute liberaria a
   * prova para o turno errado, e o erro so apareceria no dia. Mesma regra de
   * ORGUNIT_AMBIGUO e MODALIDADE_AMBIGUA: nada e chutado.
   */
  it('recusa quando o nome aparece em duas categorias', async () => {
    const { servico } = montar({
      categorias: [
        { GroupCategoryId: 1, Name: 'Provas' },
        { GroupCategoryId: 2, Name: 'Seminarios' },
      ],
      grupos: {
        1: [{ GroupId: 11, Name: 'Prova 2' }],
        2: [{ GroupId: 22, Name: 'Prova 2' }],
      },
    });

    const r = await servico.paraOLote('Prova 2', null, {}).resolver('156126');

    expect(r.alvo).toBeNull();
    expect(r.falha).toBe(ResultadoGrupoQuiz.GRUPO_AMBIGUO);
    expect(r.motivo).toContain('categoria');
  });

  it('desempata pela categoria informada, e so varre ela', async () => {
    const { servico, listarGrupos } = montar({
      categorias: [
        { GroupCategoryId: 1, Name: 'Provas' },
        { GroupCategoryId: 2, Name: 'Seminarios' },
      ],
      grupos: {
        1: [{ GroupId: 11, Name: 'Prova 2' }],
        2: [{ GroupId: 22, Name: 'Prova 2' }],
      },
    });

    const r = await servico
      .paraOLote('Prova 2', 'Seminarios', {})
      .resolver('156126');

    expect(r.alvo?.GroupId).toBe(22);
    // A economia de chamadas nao e detalhe: sao ~157 turmas por lote.
    expect(listarGrupos).toHaveBeenCalledTimes(1);
  });

  /**
   * Como toda turma ja tem os grupos de prova criados, isto e anomalia de
   * cadastro — e o `detalhe` precisa listar o que existe, senao quem le nao tem
   * como descobrir se errou o nome ou se o grupo faltou ser criado.
   */
  it('lista os grupos existentes quando o alvo nao esta la', async () => {
    const { servico } = montar({});

    const r = await servico.paraOLote('Prova 9', null, {}).resolver('156126');

    expect(r.falha).toBe(ResultadoGrupoQuiz.GRUPO_NAO_ENCONTRADO);
    expect(r.motivo).toContain('Prova 1');
    expect(r.motivo).toContain('Prova 2');
  });

  it('reporta turma sem categoria de grupo nenhuma', async () => {
    const { servico } = montar({ categorias: [] });

    const r = await servico.paraOLote('Prova 2', null, {}).resolver('156126');

    expect(r.falha).toBe(ResultadoGrupoQuiz.SEM_CATEGORIA_DE_GRUPO);
  });

  it('recusa a categoria que nao existe, dizendo quais existem', async () => {
    const { servico } = montar({
      categorias: [{ GroupCategoryId: 1, Name: 'Provas' }],
    });

    const r = await servico
      .paraOLote('Prova 2', 'Inexistente', {})
      .resolver('156126');

    expect(r.falha).toBe(ResultadoGrupoQuiz.GRUPO_NAO_ENCONTRADO);
    expect(r.motivo).toContain('Provas');
  });

  /**
   * **NUNCA lanca**: quem chama esta dentro de um `Promise.all` de turmas, e uma
   * excecao levaria junto a fatia inteira.
   */
  it('traduz falha de rede em resultado, sem lancar', async () => {
    const { servico } = montar({ categoriasLanca: true });

    const r = await servico.paraOLote('Prova 2', null, {}).resolver('156126');

    expect(r.falha).toBe(ResultadoGrupoQuiz.FALHA_AO_LER_CONDICOES);
    expect(r.motivo).toContain('categorias');
  });

  it('traduz falha ao listar os grupos, sem lancar', async () => {
    const { servico } = montar({ gruposLanca: true });

    const r = await servico.paraOLote('Prova 2', null, {}).resolver('156126');

    expect(r.falha).toBe(ResultadoGrupoQuiz.FALHA_AO_LER_CONDICOES);
  });

  /**
   * O mapa recebe TODOS os grupos vistos, nao so o que casou: ele existe para
   * nomear o grupo ANTERIOR da condicao, que por definicao e outro.
   */
  it('devolve o mapa com todos os grupos vistos, para rotular o anterior', async () => {
    const { servico } = montar({});

    const r = await servico.paraOLote('Prova 2', null, {}).resolver('156126');

    expect(r.nomePorId.get(11)).toBe('Prova 1');
    expect(r.nomePorId.get(12)).toBe('Prova 2');
  });

  it('cacheia por turma dentro do mesmo lote', async () => {
    const { servico, listarCategoriasDeGrupo } = montar({});
    const sessao = servico.paraOLote('Prova 2', null, {});

    await sessao.resolver('156126');
    await sessao.resolver('156126');

    expect(listarCategoriasDeGrupo).toHaveBeenCalledTimes(1);
  });

  it('cacheia tambem o ERRO — nao insiste numa turma que ja recusou', async () => {
    const { servico, listarCategoriasDeGrupo } = montar({ categorias: [] });
    const sessao = servico.paraOLote('Prova 2', null, {});

    await sessao.resolver('156126');
    await sessao.resolver('156126');

    expect(listarCategoriasDeGrupo).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ O cache morre com o lote. Um grupo criado no Brightspace as 11h precisa
   * estar visivel no disparo das 12:01 — um cache que sobrevivesse entre
   * execucoes o esconderia, sem nada no log dizendo por que.
   */
  it('nao compartilha cache entre lotes', async () => {
    const { servico, listarCategoriasDeGrupo } = montar({});

    await servico.paraOLote('Prova 2', null, {}).resolver('156126');
    await servico.paraOLote('Prova 2', null, {}).resolver('156126');

    expect(listarCategoriasDeGrupo).toHaveBeenCalledTimes(2);
  });
});
