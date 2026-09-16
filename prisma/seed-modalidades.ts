import type { PrismaClient } from '../src/generated/prisma/client';

/**
 * Modalidades e duracao da prova (especificacao, secao 3.1):
 *   EaD                    -> 3h    (180 min)
 *   Modular/Semipresencial -> 1h30  (90 min)
 *   Presencial             -> 2h    (120 min)
 *
 * O `codigo` e a chave estavel usada pelo dropdown de modalidade no upload do
 * CSV de alunos; o `nome` e o rotulo exibido.
 *
 * MAPEAMENTO ABA DO CSV -> CODIGO (confirmado pelo cliente):
 *   aba "EaD"     -> EAD
 *   aba "Semi"    -> SEMI
 *   aba "Híbrido" -> MODULAR   (Hibrido e o mesmo que Modular)
 *
 * PRESENCIAL existe no modelo (alunos presenciais fazem prova de 2h) mas ainda
 * nao tem CSV correspondente.
 */
export const MODALIDADES = [
  { codigo: 'EAD', nome: 'EaD', duracaoMinutos: 180 },
  { codigo: 'SEMI', nome: 'Semipresencial', duracaoMinutos: 90 },
  { codigo: 'MODULAR', nome: 'Modular / Híbrido', duracaoMinutos: 90 },
  { codigo: 'PRESENCIAL', nome: 'Presencial', duracaoMinutos: 120 },
] as const;

/*
 * O tempo de prova do special access nasce igual a duracao, e so na CRIACAO:
 * depois disso quem manda e a tela (Special access > Configuracao). Um `update`
 * aqui desfaria a escolha do admin a cada seed.
 */

export async function seedModalidades(prisma: PrismaClient): Promise<void> {
  for (const modalidade of MODALIDADES) {
    await prisma.modalidade.upsert({
      where: { codigo: modalidade.codigo },
      update: {
        nome: modalidade.nome,
        duracaoMinutos: modalidade.duracaoMinutos,
      },
      create: {
        ...modalidade,
        tempoDeProvaMinutos: modalidade.duracaoMinutos,
      },
    });
  }

  console.log(`[seed] modalidades: ${MODALIDADES.length} garantidas`);
}
