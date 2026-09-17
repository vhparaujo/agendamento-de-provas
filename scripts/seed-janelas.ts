import 'dotenv/config';
import { seedJanelas } from '../prisma/seed-janelas';
import { createMariaDbAdapter } from '../src/database/mariadb-adapter';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * ============================================================================
 * SO AS JANELAS DO QUESTIONARIO — sem tocar em polo, admin ou formato
 * ============================================================================
 *
 *   npm run seed:janelas
 *
 * `npm run seed` faz isto e mais tres coisas, e todas sao idempotentes — rodar
 * o orquestrador inteiro nao quebra nada. Este comando existe para o caso em que
 * a unica coisa que mudou foi o CALENDARIO: um formato novo ganhou horarios
 * (foi o caso do Presencial, em 25/08/2026) e o servidor ja esta com polos e
 * admins configurados. Mexer so no que mudou e o que torna a operacao obvia de
 * revisar antes de rodar.
 *
 * ⚠️ **Ele NAO sobrescreve janela existente.** A regra e do proprio
 * `seedJanelas`, e vale aqui: o admin edita os horarios na tela, e um seed que
 * sobrescrevesse devolveria o calendario semeado por cima do que a secretaria
 * acabou de ajustar. Ele CRIA o que falta e nao encosta no que existe — a saida
 * diz quantas foram criadas e quantas ficaram como estavam.
 *
 * Para MUDAR um horario ja cadastrado, use a tela (Senhas e datas > Janelas do
 * questionario). Este script nao e o caminho, de proposito.
 *
 * Depende de `seedModalidades` ja ter rodado: as janelas referenciam o
 * formato por `codigo`. Numa base que passou por `npm run seed` alguma vez,
 * ja rodou.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() });

  try {
    await seedJanelas(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((erro: unknown) => {
  console.error('[seed:janelas] falhou:', erro);
  process.exit(1);
});
