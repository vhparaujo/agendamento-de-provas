/**
 * ============================================================================
 * CURSO RENOMEADO — QUANDO A GRAFIA MUDA, O VINCULO SE DUPLICA
 * ============================================================================
 * A chave do vinculo e `[matricula, curso]`. O upsert da importacao e
 * idempotente sobre ela — mas so sobre ela: se a planilha do semestre seguinte
 * escrever "Psicologia — Bacharelado" onde antes escrevia "PSICOLOGIA", o par
 * muda, o upsert nao encontra nada, e o resultado e uma LINHA NOVA.
 *
 * O estrago nao aparece na importacao. Aparece depois:
 * - o RA passa a ter dois vinculos na tela de atendimento, e a secretaria nao
 *   sabe qual e o real;
 * - a prova ja marcada continua pendurada no vinculo ANTIGO, entao o novo
 *   aparece como "Nao Agendado" na exportacao — e o aluno e cobrado por uma
 *   prova que ele ja agendou;
 * - o compulsorio trata o vinculo novo como quem nao agendou e aloca de novo,
 *   ocupando uma segunda vaga para a mesma pessoa.
 *
 * Este modulo so RESPONDE A PERGUNTA "isto parece a mesma coisa escrita de
 * outro jeito?". Ele nao mescla nada, e de proposito: um RA pode ter dois
 * vinculos de verdade (2 em 7519 na base real), e fundir dois cursos distintos
 * misturaria as provas de dois cursos numa pessoa so. Quem decide e a
 * secretaria, pela rota de mesclagem.
 *
 * Modulo puro: sem banco, sem HTTP.
 */

import { normalizar } from '../../turma/service/turma-match';

/** Como a semelhanca foi estabelecida. Vai no relatorio, para o admin julgar. */
export const SEMELHANCA = {
  /** So acento, caixa, pontuacao ou espaco mudaram: "PSICOLOGIA" / "Psicología". */
  IDENTICO_NORMALIZADO: 'identico-normalizado',
  /** Um e o outro com palavras a mais: "PSICOLOGIA" / "Psicologia — Bacharelado". */
  TOKENS_CONTIDOS: 'tokens-contidos',
} as const;

export type Semelhanca = (typeof SEMELHANCA)[keyof typeof SEMELHANCA];

/**
 * Piso de tamanho, em caracteres normalizados, do MENOR dos dois nomes.
 *
 * Sem ele, um curso de nome curto ("ADM", "TI") casaria por conter-tokens com
 * qualquer curso que tivesse aquela palavra no meio. O mesmo motivo do
 * `TAMANHO_MINIMO_PARCIAL` em turma-match.
 */
export const TAMANHO_MINIMO = 4;

export interface VinculoExistente {
  id: number;
  curso: string;
}

export interface Candidata<T extends VinculoExistente = VinculoExistente> {
  vinculo: T;
  semelhanca: Semelhanca;
}

/**
 * Compara dois nomes de curso e diz se um e plausivelmente o outro reescrito.
 *
 * `undefined` = nao se parecem. NAO e um score: sao duas regras fechadas, ambas
 * exatas depois de normalizar. Nao ha distancia de edicao aqui de proposito —
 * "ENGENHARIA CIVIL" e "ENGENHARIA QUIMICA" ficam a poucas letras de distancia
 * e sao cursos diferentes.
 */
export function compararCurso(a: string, b: string): Semelhanca | undefined {
  const normA = normalizar(a);
  const normB = normalizar(b);

  if (!normA || !normB) return undefined;

  // Grafia exatamente igual ja teria casado no upsert; chegar aqui identico
  // significa que so mudou acento/caixa/pontuacao — o caso mais claro de todos.
  if (normA === normB) return SEMELHANCA.IDENTICO_NORMALIZADO;

  const menor = normA.length <= normB.length ? normA : normB;
  if (menor.length < TAMANHO_MINIMO) return undefined;

  const tokensA = new Set(normA.split(' '));
  const tokensB = new Set(normB.split(' '));

  // Comparacao por TOKEN, nunca por substring: "ADM" esta dentro de
  // "ADMINISTRACAO", e por substring um curso passaria pelo outro. E sem exigir
  // ordem — "Bacharelado em Psicologia" e "Psicologia" sao o mesmo caso de
  // "Psicologia — Bacharelado".
  const contido = (menores: Set<string>, maiores: Set<string>) =>
    [...menores].every((t) => maiores.has(t));

  if (contido(tokensA, tokensB) || contido(tokensB, tokensA)) {
    return SEMELHANCA.TOKENS_CONTIDOS;
  }

  return undefined;
}

/**
 * Dentre os vinculos que o RA ja tinha, quais parecem ser este mesmo curso
 * escrito de outro jeito.
 *
 * `jaNoArquivo` e o que separa "renomeacao" de "aluno com dois cursos": se a
 * grafia antiga TAMBEM aparece em alguma linha do arquivo que esta sendo
 * importado, entao as duas coexistem na fonte de verdade e nao ha nada a
 * reportar. So vinculo ORFAO — o que sumiu da planilha — e candidato.
 *
 * Devolve lista, nao a melhor: com duas candidatas, escolher uma seria
 * exatamente o chute que este modulo existe para nao dar.
 */
export function candidatasARenomeacao<T extends VinculoExistente>(
  cursoNovo: string,
  vinculosDoRa: T[],
  jaNoArquivo: (vinculo: T) => boolean,
): Candidata<T>[] {
  const candidatas: Candidata<T>[] = [];

  for (const vinculo of vinculosDoRa) {
    if (jaNoArquivo(vinculo)) continue;

    const semelhanca = compararCurso(cursoNovo, vinculo.curso);
    if (semelhanca) candidatas.push({ vinculo, semelhanca });
  }

  return candidatas;
}

/**
 * Chave do vinculo para uso em Set/Map: o RA em caixa alta (como o import o
 * grava) e o curso EXATAMENTE como veio — e a grafia literal que decide se o
 * upsert encontra a linha, entao normalizar aqui esconderia justamente o caso
 * que este modulo procura.
 *
 * O separador e NUL escrito como escape, nao digitado: e o unico caractere que
 * nao aparece num campo de CSV, e um NUL literal no fonte seria invisivel na
 * revisao (ja custou um teste que falhava mostrando dois textos identicos).
 */
export function chaveDoVinculo(matricula: string, curso: string): string {
  return `${matricula.toUpperCase()}\u0000${curso}`;
}
