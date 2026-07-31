import { INestApplication } from '@nestjs/common';
import { OpenAPIObject } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { construirDocumento, TAGS } from './../src/config/swagger';

/**
 * ============================================================================
 * TESTE DE CONTRATO DA DOCUMENTACAO
 * ============================================================================
 * A regra "toda rota nasce documentada" so sobrevive se algo a cobrar. Este
 * teste varre o documento OpenAPI REAL — o mesmo que a aplicacao publica em
 * /api/docs — e falha quando uma rota nova entra sem documentacao.
 *
 * Nao e um teste de estilo: cada regra aqui corresponde a uma informacao sem a
 * qual o front precisa ler o codigo do backend para saber o que chamar.
 *
 * Se um caso legitimo nao couber em alguma regra, adicione a excecao NOMEADA na
 * constante correspondente, com o motivo. Nao afrouxe a regra para todo mundo.
 *
 * Requer banco de pe (docker compose up -d mysql) e migrations aplicadas.
 */

/** Metodos HTTP que representam operacoes no documento OpenAPI. */
const METODOS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type Operacao = {
  summary?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
  security?: Record<string, unknown>[];
  requestBody?: unknown;
};

interface OperacaoLocalizada {
  /** Identificador legivel no relatorio de falha: "POST /api/auth/login". */
  id: string;
  operacao: Operacao;
}

/**
 * Rotas que respondem redirect (302) e nao tem corpo para tipar. O fluxo LTI e
 * iniciado pelo Brightspace por GET ou POST — os dois so redirecionam.
 */
const SEM_CORPO_DE_SUCESSO = new Set([
  'GET /api/lti/login',
  'POST /api/lti/login',
]);

/**
 * POSTs que agem sobre um recurso identificado na URL e nao recebem corpo algum.
 * Um @ApiBody vazio aqui so inventaria um campo que o handler ignora.
 */
const SEM_CORPO_DE_REQUISICAO = new Set([
  'POST /api/admins/{id}/resetar-senha',
]);

const TAGS_VALIDAS: string[] = Object.values(TAGS);

describe('Documentacao OpenAPI (contrato)', () => {
  let app: INestApplication;
  let documento: OpenAPIObject;
  let operacoes: OperacaoLocalizada[];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix(process.env.API_PREFIX ?? 'api');
    await app.init();

    documento = construirDocumento(app);
    operacoes = listarOperacoes(documento);
  });

  afterAll(async () => {
    await app.close();
  });

  it('o documento tem rotas (guarda contra falso verde)', () => {
    // Sem isto, uma falha no boot que zerasse as rotas faria todos os testes
    // abaixo passarem por vacuidade.
    expect(operacoes.length).toBeGreaterThan(0);
  });

  it('toda operacao tem summary', () => {
    const semSummary = operacoes
      .filter(({ operacao }) => !operacao.summary?.trim())
      .map(({ id }) => id);

    expect(mensagem(semSummary, 'faltando @ApiOperation({ summary })')).toBe(
      '',
    );
  });

  it('toda operacao tem uma tag registrada em TAGS', () => {
    const invalidas = operacoes
      .filter(({ operacao }) => {
        const tags = operacao.tags ?? [];
        return tags.length === 0 || tags.some((t) => !TAGS_VALIDAS.includes(t));
      })
      .map(({ id }) => id);

    expect(
      mensagem(
        invalidas,
        `sem @ApiTags, ou com tag fora de TAGS (${TAGS_VALIDAS.join(' | ')})`,
      ),
    ).toBe('');
  });

  it('toda operacao declara uma resposta de sucesso', () => {
    const semSucesso = operacoes
      .filter(({ operacao }) => respostasDeSucesso(operacao).length === 0)
      .map(({ id }) => id);

    expect(
      mensagem(semSucesso, 'sem nenhuma resposta 2xx/3xx documentada'),
    ).toBe('');
  });

  it('toda resposta 2xx tem schema (nada de resposta sem type)', () => {
    const semSchema = operacoes
      .filter(({ id }) => !SEM_CORPO_DE_SUCESSO.has(id))
      .filter(({ operacao }) =>
        respostasDeSucesso(operacao)
          .filter(([status]) => status.startsWith('2') && status !== '204')
          .some(([, corpo]) => !temSchema(corpo)),
      )
      .map(({ id }) => id);

    expect(
      mensagem(
        semSchema,
        'resposta de sucesso sem schema — use @ApiOkResponse({ type: XDto })',
      ),
    ).toBe('');
  });

  it('toda operacao protegida referencia um esquema de seguranca existente', () => {
    const esquemas = Object.keys(documento.components?.securitySchemes ?? {});

    const invalidas = operacoes
      .filter(({ operacao }) =>
        (operacao.security ?? []).some((s) =>
          Object.keys(s).some((nome) => !esquemas.includes(nome)),
        ),
      )
      .map(({ id }) => id);

    expect(
      mensagem(invalidas, `security fora de components.securitySchemes`),
    ).toBe('');
  });

  it('operacao que recebe corpo documenta o corpo', () => {
    const semCorpo = operacoes
      .filter(({ id }) => /^(POST|PUT|PATCH) /.test(id))
      .filter(({ id }) => !SEM_CORPO_DE_REQUISICAO.has(id))
      .filter(({ operacao }) => !operacao.requestBody)
      .map(({ id }) => id);

    expect(mensagem(semCorpo, 'sem @ApiBody nem DTO tipado no @Body()')).toBe(
      '',
    );
  });

  it('todo campo de schema tem descricao, exemplo ou tipo autoexplicativo', () => {
    const schemas = documento.components?.schemas ?? {};
    const problemas: string[] = [];

    for (const [nomeSchema, schema] of Object.entries(schemas)) {
      const propriedades =
        (schema as { properties?: Record<string, unknown> }).properties ?? {};

      for (const [campo, definicao] of Object.entries(propriedades)) {
        if (!campoDocumentado(definicao)) {
          problemas.push(`${nomeSchema}.${campo}`);
        }
      }
    }

    expect(
      mensagem(
        problemas,
        'campo sem description/example/enum — complete o @ApiProperty',
      ),
    ).toBe('');
  });
});

function listarOperacoes(documento: OpenAPIObject): OperacaoLocalizada[] {
  const encontradas: OperacaoLocalizada[] = [];

  for (const [rota, item] of Object.entries(documento.paths ?? {})) {
    for (const metodo of METODOS) {
      const operacao = (item as Record<string, Operacao | undefined>)[metodo];

      if (operacao) {
        encontradas.push({
          id: `${metodo.toUpperCase()} ${rota}`,
          operacao,
        });
      }
    }
  }

  return encontradas;
}

function respostasDeSucesso(operacao: Operacao): [string, unknown][] {
  return Object.entries(operacao.responses ?? {}).filter(([status]) =>
    /^[23]/.test(status),
  );
}

function temSchema(corpo: unknown): boolean {
  const content = (corpo as { content?: Record<string, { schema?: unknown }> })
    ?.content;

  if (!content) return false;

  return Object.values(content).some((midia) => Boolean(midia.schema));
}

/**
 * Um campo esta documentado quando o front consegue saber o que mandar/esperar:
 * texto explicativo, exemplo, conjunto fechado de valores, um `format` que ja
 * define o contrato sozinho (`uuid`, `date-time`, `binary`), ou uma referencia a
 * outro schema (que por sua vez e verificado nesta mesma varredura).
 *
 * `format` conta de proposito: exigir prosa para um campo ja totalmente tipado
 * viraria burocracia, e regra que irrita e regra que alguem afrouxa depois.
 */
function campoDocumentado(definicao: unknown): boolean {
  const campo = definicao as {
    description?: string;
    example?: unknown;
    enum?: unknown[];
    format?: string;
    $ref?: string;
    allOf?: unknown[];
    items?: { $ref?: string; type?: string };
  };

  return Boolean(
    campo.description?.trim() ||
    campo.example !== undefined ||
    campo.enum?.length ||
    campo.format ||
    campo.$ref ||
    campo.allOf?.length ||
    campo.items?.$ref,
  );
}

/**
 * Vazio quando nao ha problema; caso contrario, a lista completa. Compara-la com
 * '' faz o Jest imprimir TODOS os itens de uma vez — mais util que estourar no
 * primeiro, quando alguem acabou de adicionar um controller inteiro.
 */
function mensagem(itens: string[], problema: string): string {
  if (itens.length === 0) return '';

  return `${itens.length} operacao(oes)/campo(s) com problema — ${problema}:\n  - ${itens.join('\n  - ')}`;
}
