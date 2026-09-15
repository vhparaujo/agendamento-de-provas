import { ConfigService } from '@nestjs/config';
import { D2lCondicoesService } from './d2l-condicoes.service';
import { D2lGruposService } from './d2l-grupos.service';
import { D2lHttpService, NaoEncontradoNoBrightspace } from './d2l-http.service';
import { D2lOauthService } from './d2l-oauth.service';

/**
 * O que estes testes protegem:
 *
 * 1. As rotas e os verbos exatos — um DELETE que saisse como GET "funcionaria"
 *    sem remover ninguem.
 * 2. `UserId` NUMERO no corpo: o agendamento guarda texto.
 * 3. `Enrollments` normalizados para numero: comparar texto com numero faria o
 *    lote reinscrever a turma inteira a cada execucao.
 * 4. 404 tipado, para a inscricao virar pendencia do aluno e nao falha de rede.
 */
describe('D2lGruposService', () => {
  const ENV = {
    D2L_HABILITADO: 'true',
    D2L_BASE_URL: 'https://ava.catolica.edu.br',
    D2L_API_VERSION_LE: '1.82',
    D2L_API_VERSION_LP: '1.62',
  };

  let fetchOriginal: typeof globalThis.fetch;
  let chamadas: { url: string; init: RequestInit }[];

  const oauth = {
    obterAccessToken: jest.fn().mockResolvedValue({
      valor: 'token-123',
      expiraEm: new Date(),
      escopos: '',
    }),
  } as unknown as D2lOauthService;

  const servico = () => {
    const config = new ConfigService(ENV);
    const http = new D2lHttpService(config, oauth);
    return new D2lGruposService(http, new D2lCondicoesService(config, http));
  };

  const responder = (corpo: unknown, status = 200) => {
    globalThis.fetch = jest
      .fn()
      .mockImplementation((url: string, init: RequestInit) => {
        chamadas.push({ url, init });
        return Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: { get: () => null },
          json: () => Promise.resolve(corpo),
          text: () => Promise.resolve(JSON.stringify(corpo ?? '')),
        });
      });
  };

  const BASE =
    'https://ava.catolica.edu.br/d2l/api/lp/1.62/156979/groupcategories/';

  beforeEach(() => {
    fetchOriginal = globalThis.fetch;
    chamadas = [];
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
  });

  it('cria a categoria "numero de grupos, sem inscricao", sem prefixo', async () => {
    responder({ OrgUnitId: 156979, CategoryId: 777, Status: 0 }, 202);

    const r = await servico().criarCategoria(
      '156979',
      'Provas Presenciais - EAD',
      18,
    );

    expect(r).toEqual({ categoriaId: 777, concluida: false });
    expect(chamadas[0].url).toBe(BASE);
    expect(chamadas[0].init.method).toBe('POST');
    expect(JSON.parse(chamadas[0].init.body as string)).toMatchObject({
      Name: 'Provas Presenciais - EAD',
      EnrollmentStyle: 0,
      NumberOfGroups: 18,
      GroupPrefix: null,
      AutoEnroll: false,
    });
  });

  it('le os grupos com Enrollments em numero', async () => {
    responder([{ GroupId: '10', Name: 'A', Enrollments: ['183381', 5] }]);

    const grupos = await servico().listarGrupos('156979', 777);

    expect(grupos).toEqual([
      { GroupId: 10, Name: 'A', Enrollments: [183381, 5] },
    ]);
    expect(chamadas[0].url).toBe(`${BASE}777/groups/`);
  });

  it('inscreve com UserId numerico', async () => {
    responder(null);

    await servico().inscrever('156979', 777, 10, 183381);

    expect(chamadas[0].url).toBe(`${BASE}777/groups/10/enrollments/`);
    expect(chamadas[0].init.method).toBe('POST');
    expect(JSON.parse(chamadas[0].init.body as string)).toEqual({
      UserId: 183381,
    });
  });

  it('remove com DELETE na rota do usuario', async () => {
    responder(null);

    await servico().desinscrever('156979', 777, 10, 183381);

    expect(chamadas[0].url).toBe(`${BASE}777/groups/10/enrollments/183381`);
    expect(chamadas[0].init.method).toBe('DELETE');
  });

  it('404 na inscricao sobe tipado', async () => {
    responder('', 404);

    await expect(
      servico().inscrever('156979', 777, 10, 1),
    ).rejects.toBeInstanceOf(NaoEncontradoNoBrightspace);
  });

  it('renomeia com nome e codigo', async () => {
    responder({ GroupId: 10 });

    await servico().renomearGrupo('156979', 777, 10, {
      nome: '16/09 - 9h',
      codigo: '16/09 - 9h',
    });

    expect(chamadas[0].init.method).toBe('PUT');
    expect(JSON.parse(chamadas[0].init.body as string)).toMatchObject({
      Name: '16/09 - 9h',
      Code: '16/09 - 9h',
    });
  });
});
