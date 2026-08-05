import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Nomes dos esquemas de seguranca registrados no OpenAPI. Use estas constantes
 * no @ApiBearerAuth() dos controllers — nunca a string solta, para que renomear
 * um esquema nao deixe rota orfa.
 *
 * Os dois perfis usam Bearer JWT, mas sao tokens DIFERENTES (emissores, tempo de
 * vida e payload distintos): separa-los deixa claro na doc qual token cada rota
 * espera, e permite autorizar os dois ao mesmo tempo no Swagger UI.
 */
export const AUTH_ADMIN = 'admin-jwt';
export const AUTH_ALUNO = 'aluno-jwt';

/** Agrupamento das rotas na interface. Toda rota nova entra em uma destas tags. */
export const TAGS = {
  SISTEMA: 'Sistema',
  AUTH_ADMIN: 'Autenticacao — Admin',
  AUTH_ALUNO: 'Autenticacao — Aluno (LTI 1.3)',
  ADMINS: 'Administradores',
  IMPORTACAO: 'Importacao de CSV',
  MODALIDADES: 'Modalidades',
  POLOS: 'Polos',
  SALAS: 'Salas',
  FAIXAS: 'Faixas e oferta de vagas',
  PORTAL: 'Portal do Aluno',
  PERIODO: 'Periodo de agendamento',
  AGENDAMENTOS: 'Agendamentos (admin)',
  D2L: 'Integracao D2L (Valence)',
} as const;

const DESCRICAO = `
API do portal em que **alunos** da UCB agendam a data e o horario de suas provas
presenciais, e **administradores** gerenciam polos, salas, horarios, turmas e o
periodo de agendamento. Ao confirmar um agendamento, o sistema libera o acesso as
provas (*special access*) no Brightspace (D2L) via Valence API.

## Os dois perfis

| Perfil | Como autentica | Token |
|---|---|---|
| **Aluno** | LTI 1.3 a partir do Brightspace — **nao tem senha** | JWT curto (2h), so para navegacao |
| **Admin** | E-mail + senha (bcrypt) | Access token (15min) + refresh token (7d) |

Nao ha niveis dentro do admin: um JWT de admin valido da acesso total.

## Como testar por aqui

1. **Admin** — chame \`POST /auth/login\`, copie o \`accessToken\` e clique em
   **Authorize** → \`${AUTH_ADMIN}\`. Se a resposta trouxer
   \`mustChangePassword: true\`, so \`/auth/trocar-senha\` e \`/auth/me\` respondem
   ate a troca ser feita.
2. **Aluno** — o launch e disparado pelo Brightspace e exige um \`id_token\`
   assinado; nao da para simular pelo Swagger UI. O contrato de resposta de
   \`POST /lti/launch\` esta documentado para orientar o front.

## Convencoes de erro

Erros de negocio usam exececoes tipadas do Nest e sempre respondem no formato
padrao \`{ statusCode, message, error }\`. \`409\` significa conflito de estado
(e-mail duplicado, vaga esgotada) e \`403\` significa regra de negocio barrando
(periodo fechado, senha provisoria pendente).
`.trim();

/**
 * Monta o documento OpenAPI.
 *
 * Separado do `setup` de proposito: e assim que o teste de contrato
 * (test/openapi.e2e-spec.ts) valida exatamente o mesmo documento que a aplicacao
 * publica, sem precisar subir a UI.
 */
export function construirDocumento(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Portal de Agendamento de Provas — UCB')
    .setDescription(DESCRICAO)
    .setVersion(process.env.npm_package_version ?? '0.0.1')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Access token devolvido por POST /auth/login ou POST /auth/refresh.',
      },
      AUTH_ADMIN,
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'JWT interno emitido pelo launch LTI (POST /lti/launch). Curto e so para navegacao no portal.',
      },
      AUTH_ALUNO,
    )
    .addTag(TAGS.SISTEMA, 'Health check e metadados da API')
    .addTag(TAGS.AUTH_ADMIN, 'Login, refresh e troca de senha do administrador')
    .addTag(
      TAGS.AUTH_ALUNO,
      'Fluxo LTI 1.3: iniciacao OIDC, launch e chave publica (JWKS)',
    )
    .addTag(TAGS.ADMINS, 'Gestao de contas administrativas')
    .addTag(
      TAGS.IMPORTACAO,
      'Upload dos CSVs de alunos e de turmas reais, com auditoria',
    )
    .addTag(TAGS.MODALIDADES, 'Modalidades e a duracao de prova de cada uma')
    .addTag(TAGS.POLOS, 'Unidades fisicas (populadas por seed a partir do CSV)')
    .addTag(
      TAGS.SALAS,
      'Espacos fisicos de um polo — neutros quanto a modalidade',
    )
    .addTag(
      TAGS.FAIXAS,
      'Horarios de prova e a montagem de Sala + Modalidade + vagas (SalaFaixa), ' +
        'que e onde a oferta realmente existe',
    )
    .addTag(
      TAGS.PORTAL,
      'O que o aluno acessa depois do launch LTI: ver horarios e confirmar a prova',
    )
    .addTag(
      TAGS.PERIODO,
      'A janela em que se pode agendar — fecha so por data/hora, nunca por vagas',
    )
    .addTag(
      TAGS.AGENDAMENTOS,
      'Consulta, ocupacao por sala e exportacao do relatorio de agendamentos',
    )
    .addTag(
      TAGS.D2L,
      'Autorizacao OAuth 2.0 da Valence — obter e persistir o refresh token do Brightspace',
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}

/**
 * Serve a documentacao em {API_PREFIX}/docs.
 *
 * Desligada por padrao em producao: a doc revela toda a superficie da API. Para
 * publicar mesmo assim (ambiente interno, homologacao), use SWAGGER_ENABLED=true.
 */
export function configurarSwagger(
  app: INestApplication,
  prefixo: string,
): void {
  if (!swaggerHabilitado()) return;

  const documento = construirDocumento(app);
  const caminho = `${prefixo}/docs`;

  SwaggerModule.setup(caminho, app, documento, {
    jsonDocumentUrl: `${caminho}-json`,
    customSiteTitle: 'Agendamento de Provas — API',
    swaggerOptions: {
      // mantem o token entre reloads da pagina
      persistAuthorization: true,
      docExpansion: 'list',
      tagsSorter: 'alpha',
    },
  });

  new Logger('Swagger').log(`Documentacao em /${caminho}`);
}

function swaggerHabilitado(): boolean {
  // Vazio conta como ausente: `SWAGGER_ENABLED=` no .env nao deve desligar a doc
  // em desenvolvimento por acidente.
  const explicito = process.env.SWAGGER_ENABLED?.trim();

  if (explicito) return explicito === 'true';

  return process.env.NODE_ENV !== 'production';
}
