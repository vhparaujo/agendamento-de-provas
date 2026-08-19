import { BadRequestException } from '@nestjs/common';

/**
 * ============================================================================
 * A SENHA DA PROVA — validacao de entrada e a UNICA forma de exibi-la
 * ============================================================================
 *
 * Regras herdadas do CLI `brightspace-change-passwords` e endurecidas aqui.
 * Cada uma existe por um motivo concreto, nao por simetria:
 *
 *  - **vazio / so espacos**: a API do D2L simplesmente NAO aceita. Deixar passar
 *    trocaria "definir senha" por "remover senha" em toda turma do CSV de uma
 *    vez, e a diferenca so apareceria no dia da prova.
 *  - **espaco nas pontas**: e a regra mais valiosa do conjunto. E erro de
 *    digitacao quase certo, a API aceita, e o resultado seria centenas de alunos
 *    digitando a senha da folha impressa e sendo recusados.
 *  - **caractere de controle**: nao sobrevive ao caminho ate a folha impressa
 *    nem ao campo de texto do AVA, e polui log (log injection, ASVS 16.4.1).
 *  - **comprimento**: a coluna e VARCHAR(200); recusar antes da a mensagem
 *    certa em vez de um erro do banco.
 */

/** Mesmo teto da coluna `senha_de_prova.senha`. */
export const TAMANHO_MAXIMO_SENHA = 200;

/** \p{C} pega controle, formato e surrogates avulsos numa regra so. */
const CARACTERE_DE_CONTROLE = /\p{C}/u;

/**
 * Devolve a senha valida ou lanca com a mensagem que diz o que corrigir.
 *
 * Lanca `BadRequestException` (e nao um Error puro) porque quem chama e sempre
 * uma rota de admin digitando na tela: a mensagem e para a pessoa, na hora.
 */
export function validarSenha(valor: unknown): string {
  if (typeof valor !== 'string') {
    throw new BadRequestException('A senha e obrigatoria e deve ser um texto.');
  }

  if (valor.trim() === '') {
    throw new BadRequestException(
      'A senha nao pode ser vazia nem conter apenas espacos: o Brightspace ' +
        'recusa esse valor. Para deixar a prova SEM senha, apague a celula da grade.',
    );
  }

  if (valor !== valor.trim()) {
    throw new BadRequestException(
      'A senha comeca ou termina com espaco. Isso quase sempre e erro de ' +
        'digitacao, e faria os alunos errarem a senha no dia da prova.',
    );
  }

  if (CARACTERE_DE_CONTROLE.test(valor)) {
    throw new BadRequestException(
      'A senha tem caractere invisivel (quebra de linha, tabulacao ou similar). ' +
        'Provavelmente veio de um "colar" da planilha — digite-a novamente.',
    );
  }

  if (valor.length > TAMANHO_MAXIMO_SENHA) {
    throw new BadRequestException(
      `A senha tem ${valor.length} caracteres; o maximo e ${TAMANHO_MAXIMO_SENHA}.`,
    );
  }

  return valor;
}

/**
 * Como a senha aparece em log e em mensagem de erro. **Nunca o valor.**
 *
 * Esta funcao existe para TIRAR A TENTACAO: se ninguem tem um helper que
 * imprime a senha, ninguem imprime a senha. O CLI de origem escrevia
 * `antiga -> nova` em texto claro no console e no relatorio .md; aqui a senha
 * vive numa coluna so, atras de uma rota auditada, e o log nao e um segundo
 * lugar onde ela passa a existir.
 */
export function descreverSenha(valor: string | null | undefined): string {
  if (valor == null || valor === '') return '(sem senha)';
  return `(${valor.length} caracteres)`;
}
