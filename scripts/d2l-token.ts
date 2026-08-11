import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createMariaDbAdapter } from '../src/database/mariadb-adapter';
import { PrismaService } from '../src/database/prisma.service';
import { D2lOauthService } from '../src/d2l/service/d2l-oauth.service';
import { PrismaClient } from '../src/generated/prisma/client';
import { AuditoriaService } from '../src/seguranca/service/auditoria.service';

/**
 * ============================================================================
 * ACCESS TOKEN DA VALENCE PARA TESTE — SOMENTE DESENVOLVIMENTO
 * ============================================================================
 * Usa o refresh token gravado em `integracao_d2l` para obter um access token,
 * sem repetir a autorizacao no browser.
 *
 *   npm run d2l:token
 *
 * Passa pelo D2lOauthService de proposito, em vez de montar a chamada aqui: e o
 * mesmo caminho que a aplicacao usa, entao a ROTACAO do refresh token e
 * persistida igual. Um script que falasse direto com o token endpoint deixaria
 * o banco com um refresh token invalido — e a integracao morreria depois, em
 * outro lugar, sem ninguem ligar uma coisa a outra.
 *
 * As dependencias sao montadas A MAO, sem subir o Nest: o `tsx` compila com
 * esbuild, que NAO emite `emitDecoratorMetadata`, entao a injecao por tipo chega
 * como `undefined` e o container falha no primeiro provider. O mesmo motivo pelo
 * qual o token:aluno usa o PrismaClient direto.
 *
 * RECUSA rodar com NODE_ENV=production: imprimir credencial de integracao no
 * terminal de producao e exatamente o que nao se deve fazer.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'd2l:token nao roda em producao. Em producao quem usa o token e o servidor, ' +
        'nao a linha de comando.',
    );
  }

  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() });

  // O service so usa `integracaoD2L` do Prisma; o cast evita arrastar o
  // PrismaService (que e um provider do Nest) para dentro do script.
  const d2l = new D2lOauthService(
    new ConfigService(process.env as Record<string, unknown>),
    prisma as unknown as PrismaService,
    new AuditoriaService(),
  );

  try {
    const token = await d2l.obterAccessToken();
    const minutos = Math.round((token.expiraEm.getTime() - Date.now()) / 60000);

    console.log(`\nEscopos: ${token.escopos || '(nao informados)'}`);
    console.log(
      `Expira:  ${token.expiraEm.toISOString()} (~${minutos} min a partir de agora)`,
    );
    console.log(`\nAuthorization: Bearer ${token.valor}\n`);
    console.log('Exemplo de uso:');
    console.log(
      `  curl -H "Authorization: Bearer ${token.valor.slice(0, 12)}..." \\\n` +
        `    "${process.env.D2L_BASE_URL ?? 'https://catolicatest.brightspace.com'}` +
        `/d2l/api/lp/${process.env.D2L_API_VERSION_LP ?? '1.62'}/orgstructure/?orgUnitType=103"\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((erro: unknown) => {
  new Logger('d2l:token').error(
    erro instanceof Error ? erro.message : String(erro),
  );
  process.exit(1);
});
