import type { PrismaClient } from '../src/generated/prisma/client';

/**
 * Os 27 polos, extraidos dos valores DISTINTOS da coluna CAMPUS do CSV de alunos
 * (arquivo real, ISO-8859-1) — exatamente como aparecem no arquivo.
 *
 * Polo.nome e a CHAVE DE CASAMENTO com a importacao de alunos: o import procura
 * o polo por esta string exata. Portanto NAO normalize, NAO corrija acentuacao e
 * NAO reordene palavras. Polo novo = adicionar uma linha aqui e rodar o seed.
 */
export const POLOS = [
  'Câmpus Asa Norte',
  'Câmpus Asa Sul',
  'Câmpus Ceilândia',
  'Câmpus Sobradinho',
  'Câmpus Taguatinga',
  'Polo Anápolis - Jundiaí',
  'Polo Belo Horizonte - Savassi',
  'Polo Boston',
  'Polo Cidade Ocidental - GO',
  'Polo Coronel Fabriciano - UNILESTE',
  'Polo Formosa',
  'Polo Gama',
  'Polo Goianésia',
  'Polo Ipatinga',
  'Polo Japão - Nagoya',
  'Polo Joinville',
  'Polo Morrinhos',
  'Polo Palmas - TO',
  'Polo Posse',
  'Polo Recife - FICR',
  'Polo Rio de Janeiro - Jardim Botânico',
  'Polo Salvador - BA',
  'Polo Sete Lagoas',
  'Polo São Paulo - Consolata',
  'Polo Timóteo',
  'Polo Valparaíso - GO',
  'Polo Águas Lindas',
] as const;

export async function seedPolos(prisma: PrismaClient): Promise<void> {
  for (const nome of POLOS) {
    // idempotente: re-rodar nao duplica nem sobrescreve edicoes do admin
    await prisma.polo.upsert({
      where: { nome },
      update: {},
      create: { nome },
    });
  }

  console.log(`[seed] polos: ${POLOS.length} garantidos`);
}
