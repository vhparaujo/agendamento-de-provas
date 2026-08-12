import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { D2lEnrollmentsService } from './d2l-enrollments.service';
import { D2lOauthService } from './d2l-oauth.service';

/**
 * O que estes testes protegem:
 *
 * 1. So entram disciplinas DO SEMESTRE que o admin cadastrou — o resto da vida
 *    academica do aluno fica de fora.
 * 2. A intersecao numero-vs-string (§4.3 da referencia) nao volta a dar vazia em
 *    silencio: foi a armadilha documentada da API.
 * 3. A paginacao busca todas as paginas e nao gira para sempre.
 */
describe('D2lEnrollmentsService', () => {
  const ENV = {
    D2L_HABILITADO: 'true',
    D2L_BASE_URL: 'https://catolicatest.brightspace.com',
    D2L_API_VERSION_LP: '1.62',
    D2L_API_VERSION_LE: '1.82',
  };

  let fetchOriginal: typeof globalThis.fetch;
  let oauth: D2lOauthService;

  beforeEach(() => {
    fetchOriginal = globalThis.fetch;
    oauth = {
      obterAccessToken: jest.fn().mockResolvedValue({
        valor: 'token-123',
        expiraEm: new Date(),
        escopos: '',
      }),
    } as unknown as D2lOauthService;
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    jest.restoreAllMocks();
  });

  const servico = (env: Record<string, string> = ENV) =>
    new D2lEnrollmentsService(new ConfigService(env), oauth);

  /** Uma matricula como a Valence a devolve: Id NUMERO, tipo aninhado. */
  const matricula = (id: number, code: string, name: string, tipo = 3) => ({
    OrgUnit: { Id: id, Code: code, Name: name, Type: { Id: tipo } },
  });

  /** Um descendente do periodo letivo: Identifier STRING. */
  const descendente = (id: string, tipo = 3) => ({
    Identifier: id,
    Type: { Id: tipo },
  });

  /** Responde cada URL conforme ela contenha `enrollments` ou `descendants`. */
  const responder = (
    paginas: unknown[],
    descendentes: unknown[],
    status = 200,
  ) => {
    let pagina = 0;

    globalThis.fetch = jest.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () =>
          Promise.resolve(
            url.includes('descendants')
              ? descendentes
              : // A ultima pagina se repete: o teste do cache chama duas vezes.
                paginas[Math.min(pagina++, paginas.length - 1)],
          ),
        text: () => Promise.resolve(''),
      }),
    );
  };

  const UMA_PAGINA = (itens: unknown[]) => [
    { Items: itens, PagingInfo: { Bookmark: null, HasMoreItems: false } },
  ];

  it('devolve so as ofertas que pertencem ao periodo letivo escolhido', async () => {
    responder(
      UMA_PAGINA([
        matricula(6606, 'GSPS0I10227', 'HISTORIA E CULTURA DO CORPO'),
        matricula(1111, 'ANTIGA0001', 'DISCIPLINA DO SEMESTRE PASSADO'),
      ]),
      [descendente('6606')],
    );

    const ofertas = await servico().ofertasDoPeriodo('76629', '103');

    expect(ofertas).toEqual([
      {
        orgUnitId: '6606',
        codigo: 'GSPS0I10227',
        titulo: 'HISTORIA E CULTURA DO CORPO',
      },
    ]);
  });

  it('monta as rotas LP com a versao do LP, nunca com a do LE', async () => {
    // A regressao de 11/08/2026: a versao do LE (1.82) valia para os dois
    // produtos e NAO EXISTE no LP. Toda chamada voltava 404 de corpo vazio, e o
    // sintoma no portal era "o aluno nao tem disciplina" — nada apontava a URL.
    responder(UMA_PAGINA([matricula(6606, 'GSPS0I10227', 'HISTORIA')]), [
      descendente('6606'),
    ]);

    await servico().ofertasDoPeriodo('76629', '103');

    const chamadas = (globalThis.fetch as jest.Mock).mock.calls.map(
      ([url]: [string]) => url,
    );

    expect(chamadas.length).toBeGreaterThan(0);

    for (const url of chamadas) {
      expect(url).toContain('/d2l/api/lp/1.62/');
      expect(url).not.toContain('/1.82/');
    }
  });

  it('casa o Id NUMERO das matriculas com o Identifier STRING dos descendentes', async () => {
    // A armadilha do §4.3: comparar sem normalizar daria lista vazia, sem erro.
    responder(UMA_PAGINA([matricula(6606, 'GSPS0I10227', 'HISTORIA')]), [
      descendente('6606'),
    ]);

    expect(await servico().ofertasDoPeriodo('76629', '103')).toHaveLength(1);
  });

  it('ignora org units que nao sao oferta de disciplina', async () => {
    // O retorno mistura semestre, curso e oferta; so a oferta (tipo 3) e turma.
    responder(
      UMA_PAGINA([
        matricula(103, 'SEMESTRE', 'PERIODO LETIVO 2026.2', 103),
        matricula(6606, 'GSPS0I10227', 'HISTORIA'),
      ]),
      [descendente('6606'), descendente('103', 103)],
    );

    const ofertas = await servico().ofertasDoPeriodo('76629', '103');

    expect(ofertas.map((o) => o.orgUnitId)).toEqual(['6606']);
  });

  it('percorre todas as paginas do bookmark', async () => {
    responder(
      [
        {
          Items: [matricula(6606, 'A', 'PRIMEIRA')],
          PagingInfo: { Bookmark: 'b2', HasMoreItems: true },
        },
        {
          Items: [matricula(6607, 'B', 'SEGUNDA')],
          PagingInfo: { Bookmark: null, HasMoreItems: false },
        },
      ],
      [descendente('6606'), descendente('6607')],
    );

    const ofertas = await servico().ofertasDoPeriodo('76629', '103');

    expect(ofertas.map((o) => o.orgUnitId)).toEqual(['6606', '6607']);
  });

  it('para quando o bookmark se repete, em vez de girar para sempre', async () => {
    const pagina = {
      Items: [matricula(6606, 'A', 'PRIMEIRA')],
      PagingInfo: { Bookmark: 'b1', HasMoreItems: true },
    };

    let chamadas = 0;

    globalThis.fetch = jest.fn().mockImplementation((url: string) => {
      if (!url.includes('descendants')) chamadas++;

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url.includes('descendants') ? [descendente('6606')] : pagina,
          ),
        text: () => Promise.resolve(''),
      });
    });

    await servico().ofertasDoPeriodo('76629', '103');

    // Segunda pagina veio com o mesmo bookmark: nao ha o que avancar.
    expect(chamadas).toBe(2);
  });

  it('reusa a arvore do periodo entre dois alunos', async () => {
    responder(UMA_PAGINA([matricula(6606, 'A', 'PRIMEIRA')]), [
      descendente('6606'),
    ]);

    const service = servico();
    await service.ofertasDoPeriodo('1', '103');
    await service.ofertasDoPeriodo('2', '103');

    const urls = (globalThis.fetch as jest.Mock).mock.calls.map(
      ([url]: [string]) => url,
    );

    expect(urls.filter((u) => u.includes('descendants'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('enrollments'))).toHaveLength(2);
  });

  it('traduz 404 em mensagem que aponta para o cadastro', async () => {
    responder([], [], 404);

    await expect(servico().ofertasDoPeriodo('76629', '999')).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('nao faz chamada nenhuma com a integracao desligada', async () => {
    const service = servico({ ...ENV, D2L_HABILITADO: 'false' });

    expect(service.habilitado()).toBe(false);
    await expect(service.ofertasDoPeriodo('76629', '103')).rejects.toThrow(
      /desligada/,
    );
  });

  /**
   * O dropdown do admin. Sem ele, o `periodoLetivoId` e digitado a mao — e um id
   * errado nao da erro nenhum, so esvazia a lista de disciplinas de todo aluno.
   */
  /**
   * O dropdown do admin. Sem ele, o `periodoLetivoId` e digitado a mao — e um id
   * errado nao da erro nenhum, so esvazia a lista de disciplinas de todo aluno.
   */
  describe('periodosLetivos', () => {
    const periodo = (id: string, nome: string, tipo = 103) => ({
      Identifier: id,
      Name: nome,
      Code: nome.replace('/', '_'),
      Type: { Id: tipo, Code: 'Período Letivo', Name: 'Período Letivo' },
    });

    /** Responde `orgstructure/` paginado por bookmark, como o tenant real. */
    const responderPaginado = (paginas: unknown[][]) => {
      globalThis.fetch = jest.fn().mockImplementation((url: string) => {
        const bookmark = new URL(url).searchParams.get('bookmark');
        const indice = bookmark ? Number(bookmark) : 0;
        const itens = paginas[indice] ?? [];
        const temMais = indice < paginas.length - 1;

        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              Items: itens,
              PagingInfo: {
                Bookmark: temMais ? String(indice + 1) : null,
                HasMoreItems: temMais,
              },
            }),
          text: () => Promise.resolve(''),
        });
      });
    };

    /**
     * A PRIMEIRA pagina do ava.catolica, verbatim: a API devolve em ordem de
     * CRIACAO, e os semestres recentes ficam nas paginas seguintes.
     */
    const PAGINA_REAL = [
      periodo('6828', '2021/1'),
      periodo('8114', '2020/3'),
      periodo('8115', '2020/2'),
      periodo('10668', '2021/2'),
      periodo('10669', '2021/3'),
      periodo('19905', '2021/4'),
      periodo('20958', '2022/1'),
      periodo('29078', 'Esperancar'),
      periodo('29083', '2023/1'),
      periodo('29715', '2023/2'),
    ];

    it('SEGUE A PAGINACAO — o semestre atual nao esta na primeira pagina', async () => {
      // O bug que este teste tranca: ler so a primeira pagina deixaria 2026/1
      // de fora, que e justamente o unico item que o admin quase sempre quer.
      responderPaginado([PAGINA_REAL, [periodo('40000', '2026/1')]]);

      const r = await servico().periodosLetivos({ anosRecentes: 0 });

      expect(r.map((p) => p.id)).toContain('40000');
      expect(r[0].nome).toBe('2026/1');
    });

    it('ordena por (ano, semestre), nao por texto', async () => {
      responderPaginado([
        [
          periodo('1', '2025/4'),
          periodo('2', '2026/1'),
          periodo('3', '2025/3'),
        ],
      ]);

      const r = await servico().periodosLetivos({ anosRecentes: 0 });

      expect(r.map((p) => p.nome)).toEqual(['2026/1', '2025/4', '2025/3']);
    });

    it('"Esperancar" nunca encabeca a lista, e some do recorte por ano', async () => {
      // Ordenando por string ele viria ANTES de "2026/2", e o admin escolheria o
      // primeiro item achando que e o semestre atual.
      responderPaginado([
        [periodo('29078', 'Esperancar'), periodo('2', '2026/1')],
      ]);

      const completa = await servico().periodosLetivos({ anosRecentes: 0 });
      expect(completa.map((p) => p.nome)).toEqual(['2026/1', 'Esperancar']);

      const recorte = await servico().periodosLetivos({ anosRecentes: 4 });
      expect(recorte.map((p) => p.nome)).toEqual(['2026/1']);
    });

    it('recorta no ano mais recente QUE EXISTE, nao no relogio', async () => {
      // Se o tenant ainda nao criou o ano corrente, pedir "atual + 3" nao pode
      // devolver lista vazia.
      responderPaginado([
        [
          periodo('1', '2023/2'),
          periodo('2', '2022/1'),
          periodo('3', '2021/1'),
          periodo('4', '2020/2'),
        ],
      ]);

      const r = await servico().periodosLetivos({ anosRecentes: 3 });

      expect(r.map((p) => p.nome)).toEqual(['2023/2', '2022/1', '2021/1']);
    });

    it('devolve ano e semestre lidos do nome', async () => {
      responderPaginado([[periodo('29715', '2023/2')]]);

      const [p] = await servico().periodosLetivos({ anosRecentes: 0 });

      expect(p).toEqual({
        id: '29715',
        nome: '2023/2',
        codigo: '2023_2',
        ano: 2023,
        semestre: 2,
      });
    });

    it('pede orgstructure/ com o tipo configurado', async () => {
      responderPaginado([[periodo('1', '2026/1')]]);

      await servico().periodosLetivos();

      const url = (globalThis.fetch as jest.Mock).mock.calls[0][0] as string;

      expect(url).toContain('orgstructure/');
      expect(url).toContain('orgUnitType=103');
    });

    it('descarta o que NAO e periodo letivo, mesmo se a API ignorar o filtro', async () => {
      responderPaginado([
        [periodo('2', '2026/1'), periodo('500', '2026/1', 3)],
      ]);

      const r = await servico().periodosLetivos({ anosRecentes: 0 });

      expect(r.map((p) => p.id)).toEqual(['2']);
    });

    it('respeita D2L_TIPO_PERIODO_LETIVO de outro tenant', async () => {
      responderPaginado([[periodo('7', '2026/1', 5)]]);

      const r = await servico({
        ...ENV,
        D2L_TIPO_PERIODO_LETIVO: '5',
      }).periodosLetivos({ anosRecentes: 0 });

      expect(r.map((p) => p.id)).toEqual(['7']);
    });

    it('recusa com a integracao desligada', async () => {
      await expect(
        servico({ D2L_HABILITADO: 'false' }).periodosLetivos(),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  /**
   * A identidade do aluno pela matricula — a base do agendamento compulsorio.
   *
   * O que estes testes protegem: que "nao tem conta" continue sendo um ESTADO
   * (relatorio de excecoes) e nao uma excecao que derruba o lote, e que nenhum
   * caminho aqui escolha uma pessoa por aproximacao.
   */
  describe('identidadePorMatricula', () => {
    /** `users/?orgDefinedId=` devolve uma LISTA, ou 404 quando nao acha. */
    const responderUsuarios = (corpo: unknown, status = 200) => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(corpo),
        text: () => Promise.resolve(''),
      });
    };

    const usuario = (
      userId: number | string,
      orgDefinedId: string,
      ativo = true,
    ) => ({
      UserId: userId,
      OrgDefinedId: orgDefinedId,
      DisplayName: 'FULANO DE TAL',
      Activation: { IsActive: ativo },
    });

    it('resolve a matricula para o UserId numerico do Brightspace', async () => {
      responderUsuarios([usuario(6007, 'UC18120644')]);

      await expect(
        servico().identidadePorMatricula('UC18120644'),
      ).resolves.toEqual({
        situacao: 'ACHOU',
        userIdD2L: '6007',
        ativoNoD2L: true,
        nome: 'FULANO DE TAL',
      });
    });

    it('pede pelo orgDefinedId, que e onde a matricula vive no LMS', async () => {
      responderUsuarios([usuario(6007, 'UC18120644')]);

      await servico().identidadePorMatricula('UC18120644');

      const url = (globalThis.fetch as jest.Mock).mock.calls[0][0] as string;

      expect(url).toContain('users/');
      expect(url).toContain('orgDefinedId=UC18120644');
    });

    /**
     * O caso que decide o desenho do lote: aluno na planilha da secretaria sem
     * conta no LMS e normal. Se isto virasse excecao, um aluno derrubaria o
     * compulsorio inteiro em vez de sair no relatorio.
     */
    it('trata 404 como SEM_CONTA, nao como falha', async () => {
      responderUsuarios({ Errors: [{ Message: 'Resource Not Found' }] }, 404);

      await expect(
        servico().identidadePorMatricula('NAOEXISTE999'),
      ).resolves.toEqual({ situacao: 'SEM_CONTA' });
    });

    it('trata lista vazia como SEM_CONTA', async () => {
      responderUsuarios([]);

      await expect(
        servico().identidadePorMatricula('UC18120644'),
      ).resolves.toEqual({ situacao: 'SEM_CONTA' });
    });

    /**
     * Hoje o tenant filtra por igualdade — foi verificado contra a instancia
     * real. Este teste existe para o dia em que isso mudar: casar por prefixo
     * alocaria a prova de uma pessoa na vaga de outra, em silencio.
     */
    it('NAO aceita quem so casa por prefixo, se a API mudar', async () => {
      responderUsuarios([usuario(6007, 'UC18120644')]);

      await expect(servico().identidadePorMatricula('UC18')).resolves.toEqual({
        situacao: 'SEM_CONTA',
      });
    });

    it('ignora caixa e espacos, que sao a mesma pessoa', async () => {
      responderUsuarios([usuario(6007, ' uc18120644 ')]);

      await expect(
        servico().identidadePorMatricula('UC18120644'),
      ).resolves.toMatchObject({ situacao: 'ACHOU', userIdD2L: '6007' });
    });

    it('nao escolhe nenhuma quando a matricula tem duas contas', async () => {
      responderUsuarios([
        usuario(6007, 'UC18120644'),
        usuario(9999, 'UC18120644'),
      ]);

      await expect(
        servico().identidadePorMatricula('UC18120644'),
      ).resolves.toEqual({ situacao: 'AMBIGUA', quantos: 2 });
    });

    it('reporta a conta desativada no LMS em vez de escondê-la', async () => {
      // Ela resolve, mas quem recebe precisa saber: conta inativa nao abre a
      // prova, e alocar essa pessoa consome uma vaga que ninguem usa.
      responderUsuarios([usuario(180521, 'UC26427287', false)]);

      await expect(
        servico().identidadePorMatricula('UC26427287'),
      ).resolves.toMatchObject({ situacao: 'ACHOU', ativoNoD2L: false });
    });

    it('recusa UserId nao numerico, que a Valence rejeitaria depois', async () => {
      responderUsuarios([usuario('abc_76629', 'UC18120644')]);

      await expect(
        servico().identidadePorMatricula('UC18120644'),
      ).resolves.toEqual({ situacao: 'ID_INVALIDO', valor: 'abc_76629' });
    });

    /** `nuloEm404` abre uma excecao para o 404, e SO para ele. */
    it('continua falhando em erro que nao e 404', async () => {
      responderUsuarios({}, 500);

      await expect(
        servico().identidadePorMatricula('UC18120644'),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  it('nao se considera habilitado sem a URL do tenant', () => {
    // Sem base URL a chamada iria para lugar nenhum — ou para o tenant errado.
    expect(servico({ D2L_HABILITADO: 'true' }).habilitado()).toBe(false);
  });
});
