import { PrismaMariaDb } from '@prisma/adapter-mariadb';

/**
 * O Prisma 7 (rust-free) exige um driver adapter para MySQL. O adapter recebe
 * host/porta/usuario/senha/banco separados, enquanto o resto do projeto (Prisma
 * CLI, docker-compose, .env) fala em DATABASE_URL. Este modulo faz a ponte, para
 * que exista UMA unica fonte de configuracao de conexao.
 */
export function parseDatabaseUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);

  if (url.protocol !== 'mysql:') {
    throw new Error(
      `DATABASE_URL deve usar o protocolo mysql:// (recebido: ${url.protocol}//)`,
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new Error('DATABASE_URL nao informa o nome do banco de dados');
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

export function createMariaDbAdapter(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL nao definida (veja o .env.example)');
  }

  return new PrismaMariaDb({
    ...parseDatabaseUrl(databaseUrl),
    connectionLimit: 10,
    connectTimeout: 5_000,
    idleTimeout: 300,
  });
}
