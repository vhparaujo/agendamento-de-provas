import { ConfigService } from '@nestjs/config';
import { D2lGradesService } from './d2l-grades.service';
import { D2lHttpService } from './d2l-http.service';
import { D2lOauthService } from './d2l-oauth.service';

/**
 * O que estes testes protegem:
 *
 * 1. **404 e "sem nota", nao erro.** A turma que nao lancou notas e o aluno que
 *    saiu dela respondem 404, e transformar isso em excecao pararia o lote por
 *    um estado normal.
 * 2. **A paginacao segue ate o fim.** Ler so a primeira pagina deixaria os
 *    outros alunos da turma como "sem nota" — que, na substitutiva, significa
 *    NAO PODE AGENDAR. Ninguem reclamaria: eles simplesmente nao veriam a prova.
 * 3. **O UserId numerico casa com a chave string.** O `Identifier` vem numero em
 *    umas rotas e string em outras (§4.3 da referencia da API); sem normalizar,
 *    o lookup nao acha nada, e sem erro nenhum.
 * 4. **Numerador ausente e SEM_NOTA, nunca zero.** Zero poria o curso inteiro
 *    abaixo do piso da substitutiva — errado no sentido que mais dói, porque
 *    ninguem reclama de uma prova que nao lhe foi oferecida.
 * 5. A rota e a do produto **LE**, com a versao do LE.
 * 6. **A N1 e achada pelo NOME da categoria, e o id sai de la.** O `CategoryId`
 *    muda de turma para turma; procurar pelo id de uma turma em outra leria a
 *    nota de um item qualquer — ou de nenhum — sem erro nenhum aparecer.
 */
describe('D2lGradesService', () => {
  const ENV = {
    D2L_HABILITADO: 'true',
    D2L_BASE_URL: 'https://catolicatest.brightspace.com',
    D2L_API_VERSION_LE: '1.82',
    D2L_API_VERSION_LP: '1.62',
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
    return new D2lGradesService(config, new D2lHttpService(config, oauth));
  };

  const resposta = (corpo: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(corpo),
    text: () =>
      Promise.resolve(
        typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
      ),
  });

  const responderEmSequencia = (respostas: ReturnType<typeof resposta>[]) => {
    let i = 0;
    globalThis.fetch = jest
      .fn()
      .mockImplementation((url: string, init: RequestInit) => {
        chamadas.push({ url, init });
        return Promise.resolve(respostas[Math.min(i++, respostas.length - 1)]);
      });
  };

  describe('notaFinal', () => {
    it('le os PONTOS, e nao o percentual', async () => {
      responderEmSequencia([
        resposta({
          DisplayedGrade: '58 %',
          GradeObjectName: 'Nota Calculada Final',
          PointsNumerator: 5.8,
          PointsDenominator: 10,
        }),
      ]);

      const nota = await servico().notaFinal('156126', '76629');

      expect(nota).toEqual({
        situacao: 'ACHOU',
        pontos: 5.8,
        denominador: 10,
        origem: 'CALCULADA',
        exibida: '58 %',
      });
    });

    it('usa o produto LE e a versao do LE na URL', async () => {
      responderEmSequencia([resposta({ PointsNumerator: 5.8 })]);

      await servico().notaFinal('156126', '76629');

      expect(chamadas[0].url).toBe(
        'https://catolicatest.brightspace.com/d2l/api/le/1.82/156126/grades/final/values/76629',
      );
    });

    /** 404 aqui e a turma sem notas ou o aluno fora dela — estado esperado. */
    it('404 vira SEM_NOTA, e nao excecao', async () => {
      responderEmSequencia([
        resposta({ Errors: [{ Message: 'Not Found' }] }, 404),
      ]);

      await expect(servico().notaFinal('156126', '76629')).resolves.toEqual({
        situacao: 'SEM_NOTA',
      });
    });

    it('numerador nulo e SEM_NOTA — nunca 0,00', async () => {
      responderEmSequencia([
        resposta({
          DisplayedGrade: '',
          GradeObjectName: 'Nota Calculada Final',
          PointsNumerator: null,
          PointsDenominator: 10,
        }),
      ]);

      await expect(servico().notaFinal('156126', '76629')).resolves.toEqual({
        situacao: 'SEM_NOTA',
      });
    });

    /**
     * O nome vem no idioma do tenant, e e so ele que diz de qual nota final o
     * valor veio. Serve ao diagnostico: se toda turma passar a responder
     * CALCULADA com notas ajustadas lancadas, e por aqui que se descobre.
     */
    it.each([
      ['Nota Ajustada Final', 'AJUSTADA'],
      ['Final Adjusted Grade', 'AJUSTADA'],
      ['Nota Calculada Final', 'CALCULADA'],
      ['Final Calculated Grade', 'CALCULADA'],
      ['Outra coisa qualquer', 'DESCONHECIDA'],
    ])('le a origem de "%s" como %s', async (nome, esperado) => {
      responderEmSequencia([
        resposta({ GradeObjectName: nome, PointsNumerator: 5.8 }),
      ]);

      const nota = await servico().notaFinal('156126', '76629');

      expect(nota.situacao === 'ACHOU' && nota.origem).toBe(esperado);
    });

    it('403 (escopo faltando no consentimento) SOBE como erro', async () => {
      responderEmSequencia([resposta('Forbidden', 403)]);

      await expect(servico().notaFinal('156126', '76629')).rejects.toThrow(
        /403/,
      );
    });
  });

  describe('notasFinaisDaTurma', () => {
    it('segue o Next e junta as duas paginas', async () => {
      responderEmSequencia([
        resposta({
          Objects: [
            {
              User: { Identifier: '76629' },
              GradeValue: { PointsNumerator: 4 },
            },
          ],
          Next: '/d2l/api/le/1.82/156126/grades/final/values/?bookmark=abc',
        }),
        resposta({
          Objects: [
            {
              User: { Identifier: '80001' },
              GradeValue: { PointsNumerator: 9 },
            },
          ],
          Next: null,
        }),
      ]);

      const notas = await servico().notasFinaisDaTurma('156126');

      expect([...notas.keys()]).toEqual(['76629', '80001']);
      expect(chamadas).toHaveLength(2);
      expect(chamadas[1].url).toContain('?bookmark=abc');
    });

    /** §4.3: o Identifier vem numero em umas rotas e string em outras. */
    it('normaliza o UserId numerico para chave string', async () => {
      responderEmSequencia([
        resposta({
          Objects: [
            { User: { Identifier: 76629 }, GradeValue: { PointsNumerator: 4 } },
          ],
          Next: null,
        }),
      ]);

      const notas = await servico().notasFinaisDaTurma('156126');

      expect(notas.get('76629')).toEqual({
        situacao: 'ACHOU',
        pontos: 4,
        denominador: null,
        origem: 'DESCONHECIDA',
        exibida: null,
      });
    });

    it('aluno da turma sem nota entra no mapa como SEM_NOTA', async () => {
      responderEmSequencia([
        resposta({
          Objects: [{ User: { Identifier: '76629' }, GradeValue: null }],
          Next: null,
        }),
      ]);

      const notas = await servico().notasFinaisDaTurma('156126');

      expect(notas.get('76629')).toEqual({ situacao: 'SEM_NOTA' });
    });

    it('aceita o array puro, sem envelope de paginacao', async () => {
      responderEmSequencia([
        resposta([
          { User: { Identifier: '76629' }, GradeValue: { PointsNumerator: 4 } },
        ]),
      ]);

      const notas = await servico().notasFinaisDaTurma('156126');

      expect(notas.size).toBe(1);
      expect(chamadas).toHaveLength(1);
    });

    /** O laco so termina quando o SERVIDOR diz que terminou — daí a trava. */
    it('para quando o bookmark se repete, em vez de girar para sempre', async () => {
      responderEmSequencia([
        resposta({
          Objects: [
            {
              User: { Identifier: '76629' },
              GradeValue: { PointsNumerator: 4 },
            },
          ],
          Next: '/d2l/api/le/1.82/156126/grades/final/values/?bookmark=abc',
        }),
      ]);

      const notas = await servico().notasFinaisDaTurma('156126');

      expect(notas.size).toBe(1);
      expect(chamadas).toHaveLength(2);
    });

    /**
     * Devolver a lista incompleta seria PIOR que falhar: os alunos que faltaram
     * apareceriam como "sem nota", e sem nota ninguem agenda a substitutiva.
     */
    it('estoura quando passa do teto de paginas, em vez de devolver meia turma', async () => {
      // O bookmark precisa MUDAR a cada chamada: repetido, o laco pararia pela
      // outra trava (a do teste acima) e nunca chegaria ao teto de paginas.
      let n = 0;
      globalThis.fetch = jest.fn().mockImplementation((url: string) => {
        chamadas.push({ url, init: {} });
        n += 1;
        return Promise.resolve(
          resposta({
            Objects: [],
            Next: `/d2l/api/le/1.82/156126/grades/final/values/?bookmark=${n}`,
          }),
        );
      });

      await expect(
        servico().notasFinaisDaTurma('156126', { maxPaginas: 3 }),
      ).rejects.toThrow(/sem nota/);
    });
  });

  /**
   * ==========================================================================
   * A CATEGORIA N1 — a segunda nota da substitutiva
   * ==========================================================================
   * Uma categoria de notas e um grade object como outro qualquer
   * (`GradeObjectType: 9`), lido pelo mesmo `/grades/{id}/values/`. O que muda e
   * o id — e ele e DIFERENTE em cada turma, que e a razao de a busca ser por
   * nome.
   */
  describe('categoriaPorNome', () => {
    it('acha o CategoryId pelo nome, ignorando caixa e espaco', async () => {
      responderEmSequencia([
        resposta([
          { CategoryId: 4230, Name: 'Atividades' },
          { CategoryId: 4231, Name: ' n1 ' },
        ]),
      ]);

      const id = await servico().categoriaPorNome('156126', 'N1');

      expect(id).toBe('4231');
      expect(chamadas[0].url).toContain(
        '/d2l/api/le/1.82/156126/grades/categories/',
      );
    });

    /**
     * "N1" nao pode achar "N10". Casar por pedaco leria a nota de outra
     * categoria e o aluno seria julgado por um numero que nao e o dele.
     */
    it('nao casa por substring', async () => {
      responderEmSequencia([resposta([{ CategoryId: 4299, Name: 'N10' }])]);

      await expect(
        servico().categoriaPorNome('156126', 'N1'),
      ).resolves.toBeNull();
    });

    /** Turma sem a categoria e estado ESPERADO: a regra e que decide o que fazer. */
    it('turma sem a categoria devolve null, e 404 tambem', async () => {
      responderEmSequencia([resposta([{ CategoryId: 1, Name: 'Provas' }])]);
      await expect(
        servico().categoriaPorNome('156126', 'N1'),
      ).resolves.toBeNull();

      responderEmSequencia([resposta('', 404)]);
      await expect(
        servico().categoriaPorNome('156127', 'N1'),
      ).resolves.toBeNull();
    });

    /**
     * ⚠️ 403 e o oposto de 404 aqui: ele atinge TODA turma (falta
     * `grades:gradecategories:read` no consentimento), e traduzi-lo para "turma
     * sem N1" mandaria o curso inteiro a secretaria enquanto a correcao e um
     * `npm run d2l:autorizar`.
     */
    it('403 SOBE, e nao vira "turma sem N1"', async () => {
      responderEmSequencia([resposta({ error: 'insufficient scope' }, 403)]);

      await expect(
        servico().categoriaPorNome('156126', 'N1'),
      ).rejects.toThrow();
    });

    /** Uma listagem por turma, e nao uma por aluno da turma. */
    it('o segundo pedido da mesma turma sai do cache', async () => {
      responderEmSequencia([resposta([{ CategoryId: 4231, Name: 'N1' }])]);

      const service = servico();
      await service.categoriaPorNome('156126', 'N1');
      await service.categoriaPorNome('156126', 'N1');

      expect(chamadas).toHaveLength(1);
    });
  });

  describe('notaDeGradeObject', () => {
    it('le o valor da categoria pela rota do grade object', async () => {
      responderEmSequencia([
        resposta({
          GradeObjectTypeName: 'Category',
          GradeObjectType: 9,
          PointsNumerator: 2.5,
          PointsDenominator: 10,
        }),
      ]);

      const nota = await servico().notaDeGradeObject('156126', '4231', '76629');

      expect(nota).toEqual({
        situacao: 'ACHOU',
        pontos: 2.5,
        denominador: 10,
        origem: 'DESCONHECIDA',
        exibida: null,
      });

      expect(chamadas[0].url).toContain(
        '/d2l/api/le/1.82/156126/grades/4231/values/76629',
      );
    });

    /** Mesmo contrato de `notaFinal`: aluno sem nota na categoria nao e erro. */
    it('404 vira SEM_NOTA', async () => {
      responderEmSequencia([resposta('', 404)]);

      await expect(
        servico().notaDeGradeObject('156126', '4231', '76629'),
      ).resolves.toEqual({ situacao: 'SEM_NOTA' });
    });
  });

  describe('notasDeGradeObjectDaTurma', () => {
    /** A mesma paginacao da nota final — ignora-la daria meia turma sem N1. */
    it('segue a paginacao ate o fim', async () => {
      responderEmSequencia([
        resposta({
          Objects: [
            { User: { Identifier: 76629 }, GradeValue: { PointsNumerator: 3 } },
          ],
          Next: '/d2l/api/le/1.82/156126/grades/4231/values/?bookmark=abc',
        }),
        resposta({
          Objects: [
            {
              User: { Identifier: '80001' },
              GradeValue: { PointsNumerator: 1 },
            },
          ],
          Next: null,
        }),
      ]);

      const notas = await servico().notasDeGradeObjectDaTurma('156126', '4231');

      expect(notas.size).toBe(2);
      expect(notas.get('76629')).toMatchObject({ pontos: 3 });
      expect(chamadas[0].url).toContain('/156126/grades/4231/values/');
    });
  });
});
