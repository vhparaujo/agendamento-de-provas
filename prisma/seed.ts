import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { createMariaDbAdapter } from '../src/database/mariadb-adapter';
import { seedAdmin } from './seed-admin';
import { seedModalidades } from './seed-modalidades';
import { seedPolos } from './seed-polos';

/**
 * Orquestrador dos seeds. Todos sao idempotentes: rodar de novo e seguro.
 *   npm run seed          (ou: npx prisma db seed)
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() });

  try {
    await seedModalidades(prisma);
    await seedPolos(prisma);
    await seedAdmin(prisma);
    console.log('[seed] concluido');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((erro: unknown) => {
  console.error('[seed] falhou:', erro);
  process.exit(1);
});
