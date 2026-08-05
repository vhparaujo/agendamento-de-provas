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
    D2L_API_VERSION: '1.82',
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

  it('nao se considera habilitado sem a URL do tenant', () => {
    // Sem base URL a chamada iria para lugar nenhum — ou para o tenant errado.
    expect(servico({ D2L_HABILITADO: 'true' }).habilitado()).toBe(false);
  });
});
