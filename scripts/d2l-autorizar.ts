import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * ============================================================================
 * MONTA A URL DE AUTORIZACAO DA VALENCE (Authorization Code)
 * ============================================================================
 * Imprime o link que o admin abre no browser UMA VEZ para autorizar a
 * integracao. O redirect cai em `GET {D2L_REDIRECT_URI}` (a nossa rota
 * `/api/d2l/callback`), que troca o `code` e grava o refresh token em
 * `integracao_d2l`.
 *
 *   npm run d2l:autorizar
 *
 * Existe porque essa URL precisa ser reconstruida toda vez que o
 * `D2L_REDIRECT_URI` muda (ngrok -> producao, troca de dominio): o Brightspace
 * compara o redirect BYTE A BYTE contra o registro do aplicativo, e montar a
 * query a mao e onde nascem os erros de barra final e de scope faltando.
 *
 * Nao fala com a rede e nao imprime segredo: o `client_id` e publico por
 * natureza (vai na URL do browser) e o `client_secret` nao entra nesta etapa —
 * ele so aparece na troca do code, feita pelo servidor.
 */

/** Endpoint GLOBAL da D2L, nao do tenant (docs/D2L_API_REFERENCE.md §2.2). */
const AUTH_URL_PADRAO = 'https://auth.brightspace.com/oauth2/auth';

/**
 * ⚠️ NAO acrescente `offline_access` aqui.
 *
 * E a convencao de OUTROS provedores (Azure AD, IdentityServer padrao) para
 * pedir refresh token, e a tentacao de copia-la e grande — mas a D2L valida o
 * FORMATO do escopo (`group:resource:permission`) e recusa a autorizacao inteira
 * com `invalid_scope: Invalid scope format: offline_access`, antes mesmo da tela
 * de consentimento. Testado em 17/08/2026.
 *
 * O refresh token do `grant_type=authorization_code` vem por padrao neste fluxo;
 * nao ha escopo que o ligue ou desligue.
 */

function ler(nome: string, padrao = ''): string {
  return process.env[nome]?.trim() || padrao;
}

function main(): void {
  const clientId = ler('D2L_CLIENT_ID');
  const redirectUri = ler('D2L_REDIRECT_URI');
  const escopos = ler('D2L_SCOPES');

  const faltando = [
    ['D2L_CLIENT_ID', clientId],
    ['D2L_REDIRECT_URI', redirectUri],
    ['D2L_SCOPES', escopos],
  ]
    .filter(([, valor]) => !valor)
    .map(([nome]) => nome);

  if (faltando.length > 0) {
    throw new Error(
      `Faltam variaveis no .env: ${faltando.join(', ')}. ` +
        'Elas sao as mesmas do registro em Admin Tools > Manage Extensibility > OAuth 2.0.',
    );
  }

  const url = new URL(ler('D2L_AUTH_URL', AUTH_URL_PADRAO));
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    // Vai como esta no .env, sem acrescimo: ver o aviso sobre `offline_access`.
    scope: escopos,
    state: randomUUID(),
  }).toString();

  console.log('\nRedirect que o Brightspace vai conferir byte a byte:');
  console.log(`  ${redirectUri}`);
  console.log(
    '\nAbra no browser, logado como o admin que autoriza a integracao:\n',
  );
  console.log(`${url.toString()}\n`);
  console.log(
    'Depois de aceitar, o Brightspace redireciona para a rota acima e o refresh\n' +
      'token e gravado em `integracao_d2l`. Confira com GET /api/health (campo d2l).\n',
  );
}

try {
  main();
} catch (erro: unknown) {
  new Logger('d2l:autorizar').error(
    erro instanceof Error ? erro.message : String(erro),
  );
  process.exit(1);
}
