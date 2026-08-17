import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * POR QUE O LAUNCH RECUSOU ESTE id_token — DIAGNOSTICO
 * ============================================================================
 * Compara os claims do id_token com o que esta no .env e aponta QUAL diverge.
 *
 *   npm run lti:diagnosticar -- <id_token>
 *   npm run lti:diagnosticar               # le do stdin (pipe ou colar + Ctrl-D)
 *
 * Existe porque `POST /lti/launch` devolve "id_token do LTI invalido" para as
 * quatro causas possiveis (assinatura, iss, aud, exp) — e tem que ser generico
 * mesmo: detalhar a recusa na resposta contaria a quem sonda a rota o que
 * exatamente precisa forjar. O motivo real so aparece no WARN do servidor, e
 * nem sempre ha acesso ao log de producao com o Brightspace na tela.
 *
 * Onde pegar o token: DevTools > Network > a requisicao `launch` > Payload >
 * campo `id_token`.
 *
 * NAO VERIFICA A ASSINATURA, de proposito. Isto e uma ferramenta de leitura, e
 * quem valida de verdade e o servidor (`verificarIdToken`, com o JWKS remoto).
 * Um token expirado — que e justamente o caso a diagnosticar — falharia na
 * verificacao e nao contaria o que ha dentro dele, que e o que se quer ver.
 */

interface Claims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nonce?: string;
  [claim: string]: unknown;
}

const CLAIM_DEPLOYMENT_ID =
  'https://purl.imsglobal.org/spec/lti/claim/deployment_id';

function ler(nome: string): string {
  return process.env[nome]?.trim() ?? '';
}

/** O payload e a 2a parte do JWT, em base64url. */
function decodificar(token: string): Claims {
  const partes = token.trim().split('.');

  if (partes.length !== 3) {
    throw new Error(
      `Isto nao parece um JWT: ${partes.length} parte(s) separadas por ponto, esperava 3.`,
    );
  }

  return JSON.parse(
    Buffer.from(partes[1], 'base64url').toString('utf8'),
  ) as Claims;
}

function comparar(rotulo: string, doToken: unknown, doEnv: string): boolean {
  // `aud` pode ser array pela especificacao do JWT — o jose aceita os dois, e o
  // diagnostico tem que aceitar tambem, ou acusaria divergencia inexistente.
  const valores = Array.isArray(doToken) ? doToken : [doToken];
  const bate = valores.some((v) => String(v ?? '') === doEnv);

  console.log(`\n${rotulo}`);
  console.log(`  id_token : ${valores.map((v) => String(v)).join(', ')}`);
  console.log(`  .env     : ${doEnv || '(vazio)'}`);
  console.log(`  ${bate ? 'OK' : '>>> DIVERGE — e esta a causa da recusa'}`);

  return bate;
}

function main(): void {
  const token = process.argv[2]?.trim() || lerStdin();

  if (!token) {
    throw new Error(
      'Passe o id_token: npm run lti:diagnosticar -- <id_token>\n' +
        'Ele esta em DevTools > Network > requisicao `launch` > Payload > id_token.',
    );
  }

  const claims = decodificar(token);
  const agora = Math.floor(Date.now() / 1000);

  let tudoOk = true;
  tudoOk = comparar('ISSUER (iss)', claims.iss, ler('LTI_ISSUER')) && tudoOk;
  tudoOk =
    comparar('AUDIENCE (aud) = client_id', claims.aud, ler('LTI_CLIENT_ID')) &&
    tudoOk;
  tudoOk =
    comparar(
      'DEPLOYMENT_ID',
      claims[CLAIM_DEPLOYMENT_ID],
      ler('LTI_DEPLOYMENT_ID'),
    ) && tudoOk;

  // O servidor tolera 30s de relogio fora de sincronia (clockTolerance).
  const exp = claims.exp ?? 0;
  const segundos = exp - agora;
  const expirado = segundos < -30;

  console.log('\nEXPIRACAO (exp)');
  console.log(`  expira em : ${new Date(exp * 1000).toISOString()}`);
  console.log(`  agora     : ${new Date(agora * 1000).toISOString()}`);
  console.log(
    `  ${
      expirado
        ? `>>> EXPIRADO ha ${Math.abs(segundos)}s — token reaproveitado, ou o RELOGIO DO SERVIDOR esta fora`
        : `OK (faltam ${segundos}s)`
    }`,
  );

  console.log(
    tudoOk && !expirado
      ? '\nOs claims batem com o .env. Sobra a ASSINATURA: confira se o LTI_JWKS_URL\n' +
          'e do mesmo tenant que emitiu este token (o `iss` acima).\n'
      : '\nCorrija o item marcado acima no .env e reinicie a API.\n',
  );
}

/** Token grande nao cabe confortavelmente em argv; aceitar pipe/colagem ajuda. */
function lerStdin(): string {
  try {
    return readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

try {
  main();
} catch (erro: unknown) {
  new Logger('lti:diagnosticar').error(
    erro instanceof Error ? erro.message : String(erro),
  );
  process.exit(1);
}
