import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Configuracao do Prisma CLI (migrate / generate / db seed).
 * No Prisma 7 o bloco "prisma" do package.json nao e mais lido: schema, caminho
 * das migrations e comando de seed vivem aqui.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
