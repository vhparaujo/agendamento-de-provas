import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { D2lHttpService } from './d2l-http.service';
import { D2lOauthService } from './d2l-oauth.service';
import { D2lQuizzesService } from './d2l-quizzes.service';

/**
 * O que estes testes protegem:
 *
 * 1. A paginacao segue o `Next` ate o fim — ignorar isso fazia o projeto irmao
 *    perder a prova de turmas com muitos questionarios, em silencio.
 * 2. O laco nao gira para sempre quando o servidor devolve o mesmo bookmark.
 * 3. O 429 tenta de novo UMA vez, e o segundo sobe como erro.
 * 4. O PUT manda o corpo COMPLETO — o que nao for enviado e apagado pela API.
 */
describe('D2lQuizzesService', () => {
  const ENV = {
    D2L_HABILITADO: 'true',
    D2L_BASE_URL: 'https://catolicatest.brightspace.com',
    D2L_API_VERSION_LE: '1.82',
  };

  let fetchOriginal: typeof globalThis.fetch;
  let oauth: D2lOauthService;
  let chamadas: { url: string; init: RequestInit }[];

  beforeEach(() => {
    fetchOriginal = globalThis.fetch;
    chamadas = [];
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

  const servico = (env: Record<string, string> = ENV) => {
    const config = new ConfigService(env);
    return new D2lQuizzesService(config, new D2lHttpService(config, oauth));
  };

  const resposta = (
    corpo: unknown,
    status = 200,
    cabecalhos: Record<string, string> = {},
  ) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (nome: string) => cabecalhos[nome.toLowerCase()] ?? null },
    json: () => Promise.resolve(corpo),
    text: () =>
      Promise.resolve(
        typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
      ),
  });

  /** Responde uma sequencia de corpos, um por chamada. */
  const responderEmSequencia = (respostas: ReturnType<typeof resposta>[]) => {
    let i = 0;
    globalThis.fetch = jest
      .fn()
      .mockImplementation((url: string, init: RequestInit) => {
        chamadas.push({ url, init });
        return Promise.resolve(respostas[Math.min(i++, respostas.length - 1)]);
      });
  };

  describe('listarQuizzes', () => {
    it('segue o Next e junta os quizzes das duas paginas', async () => {
      responderEmSequencia([
        resposta({
          Objects: [{ QuizId: 1, Name: 'Prova N1' }],
          Next: '/d2l/api/le/1.82/156126/quizzes/?bookmark=abc',
        }),
        resposta({ Objects: [{ QuizId: 2, Name: 'Prova N2' }], Next: null }),
      ]);

      const quizzes = await servico().listarQuizzes('156126');

      expect(quizzes.map((q) => q.Name)).toEqual(['Prova N1', 'Prova N2']);
      expect(chamadas).toHaveLength(2);
      expect(chamadas[1].url).toContain('?bookmark=abc');
    });

    /** O laco so termina quando o SERVIDOR diz que terminou — daí a trava. */
    it('para quando o bookmark se repete, em vez de girar para sempre', async () => {
      responderEmSequencia([
        resposta({
          Objects: [{ QuizId: 1, Name: 'Prova' }],
          Next: '/d2l/api/le/1.82/156126/quizzes/?bookmark=igual',
        }),
        resposta({
          Objects: [{ QuizId: 2, Name: 'Prova B' }],
          Next: '/d2l/api/le/1.82/156126/quizzes/?bookmark=igual',
        }),
      ]);

      const quizzes = await servico().listarQuizzes('156126');

      expect(quizzes).toHaveLength(2);
      expect(chamadas).toHaveLength(2);
    });

    it('respeita o teto de paginas', async () => {
      responderEmSequencia([
        resposta({
          Objects: [{ QuizId: 1, Name: 'Prova' }],
          Next: '/x?bookmark=' + Math.random(),
        }),
      ]);
      // Cada resposta traz um Next diferente do anterior? Nao: o mock repete a
      // ultima, entao o bookmark se repete e o laco para antes. Forcamos o teto
      // com bookmarks sempre novos:
      let n = 0;
      globalThis.fetch = jest.fn().mockImplementation((url: string) => {
        chamadas.push({ url, init: {} });
        return Promise.resolve(
          resposta({
            Objects: [{ QuizId: n, Name: `Q${n}` }],
            Next: `/x?bookmark=${n++}`,
          }),
        );
      });

      const quizzes = await servico().listarQuizzes('156126', {
        maxPaginas: 3,
      });

      expect(chamadas).toHaveLength(3);
      expect(quizzes).toHaveLength(3);
    });

    it('aceita resposta sem paginacao (array direto)', async () => {
      responderEmSequencia([resposta([{ QuizId: 9, Name: 'Prova' }])]);

      expect(await servico().listarQuizzes('156126')).toHaveLength(1);
    });
  });

  describe('429', () => {
    it('tenta de novo UMA vez honrando o Retry-After', async () => {
      responderEmSequencia([
        resposta('devagar', 429, { 'retry-after': '0' }),
        resposta({ Objects: [{ QuizId: 1, Name: 'Prova' }], Next: null }),
      ]);

      const quizzes = await servico().listarQuizzes('156126');

      expect(quizzes).toHaveLength(1);
      expect(chamadas).toHaveLength(2);
    });

    it('o segundo 429 sobe como erro em vez de tentar para sempre', async () => {
      responderEmSequencia([resposta('devagar', 429, { 'retry-after': '0' })]);

      await expect(servico().listarQuizzes('156126')).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(chamadas).toHaveLength(2);
    });
  });

  describe('gravarQuiz', () => {
    it('manda PUT com o corpo COMPLETO — o que faltar seria apagado pela API', async () => {
      responderEmSequencia([resposta(null, 204)]);

      const corpo = {
        Name: 'Prova',
        Password: 'nova',
        EndDate: '2026-09-16T14:30:00.000Z',
      };
      await servico().gravarQuiz('156126', '4242', corpo);

      expect(chamadas).toHaveLength(1);
      expect(chamadas[0].init.method).toBe('PUT');
      expect(chamadas[0].url).toContain('/le/1.82/156126/quizzes/4242');
      expect(JSON.parse(chamadas[0].init.body as string)).toEqual(corpo);
    });

    it('aceita 200 com corpo vazio, que e o que este tenant devolve', async () => {
      responderEmSequencia([
        {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.reject(new Error('corpo vazio')),
          text: () => Promise.resolve(''),
        } as unknown as ReturnType<typeof resposta>,
      ]);

      await expect(
        servico().gravarQuiz('156126', '4242', { Password: 'x' }),
      ).resolves.toBeUndefined();
    });
  });

  it('nao se considera habilitado sem a URL do tenant', () => {
    expect(servico({ D2L_HABILITADO: 'true' }).habilitado()).toBe(false);
  });
});
