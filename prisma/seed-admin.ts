import * as bcrypt from 'bcrypt';
import type { PrismaClient } from '../src/generated/prisma/client';

const BCRYPT_ROUNDS = 12;

/**
 * Primeiro administrador do sistema. Idempotente: se o e-mail ja existir, NADA e
 * sobrescrito — nem a senha, nem mustChangePassword. Assim, re-rodar o seed em um
 * ambiente ja em uso nunca reseta a senha de quem ja trocou.
 *
 * Le SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NOME do .env.
 * A senha e gravada em hash bcrypt e o admin nasce com mustChangePassword = true.
 */
export async function seedAdmin(prisma: PrismaClient): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const senha = process.env.SEED_ADMIN_PASSWORD;
  const nome = process.env.SEED_ADMIN_NOME?.trim() || 'Administrador';

  if (!email || !senha) {
    throw new Error(
      'SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD sao obrigatorios para o seed do admin (veja o .env.example)',
    );
  }

  const existente = await prisma.admin.findUnique({ where: { email } });
  if (existente) {
    console.log(`[seed] admin: ${email} ja existe — nada alterado`);
    return;
  }

  await prisma.admin.create({
    data: {
      email,
      nome,
      senhaHash: await bcrypt.hash(senha, BCRYPT_ROUNDS),
      mustChangePassword: true,
    },
  });

  console.log(`[seed] admin: ${email} criado (troca de senha obrigatoria)`);
}
