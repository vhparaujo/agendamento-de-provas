/**
 * ============================================================================
 * COMPARACAO DE NOME DE GRUPO — normalizada, e so aqui
 * ============================================================================
 * O nome do grupo e digitado por gente em dois lugares diferentes: na tela do
 * portal (uma vez, por janela) e no Brightspace (uma vez por turma, em dezenas
 * de turmas). Comparar byte a byte produziria falso negativo por um acento ou um
 * espaco a mais — e um falso negativo aqui NAO e um erro visivel: e uma turma
 * inteira ficando com a condicao de liberacao da sessao anterior, descoberta no
 * dia da prova.
 *
 * ⚠️ **Nao unifique isto com `casarPorNome` (`quiz-body.ts`), que compara nome de
 * QUESTIONARIO.** La a comparacao e literal de proposito: o alvo e configurado
 * uma vez e casa contra o catalogo da API, e afrouxar produziria o casamento
 * errado num universo de dezenas de quizzes por turma. Aqui o universo e de meia
 * duzia de grupos e o risco esta invertido. Sao duas regras, com dois motivos, e
 * junta-las quebraria uma das duas.
 *
 * Portado de `brightspace-change-conditions/src/groupResolver.js` (`normalizar`).
 */

/**
 * O bloco Combining Diacritical Marks, escapado.
 *
 * Escrito com `\u`, e nao com os caracteres literais, porque eles sao invisiveis
 * no editor: um `replace(/[<invisivel>]/g, '')` e indistinguivel de um
 * `replace(/[]/g, '')` quebrado, e nenhum teste de acento pega isso se a classe
 * for esvaziada por um copiar-e-colar.
 */
const DIACRITICOS = /[\u0300-\u036f]/g;

/**
 * Sem acento, sem espaco duplicado, sem espaco nas pontas, minusculo.
 *
 * ⚠️ **Hifen e pontuacao NAO sao normalizados.** "Manha 16/09" continua diferente
 * de "Manha - 16/09", e isso e deliberado: sao nomes de grupo distintos numa
 * instancia que use os dois, e apagar a diferenca faria a resolucao casar o
 * grupo errado em vez de recusar. O que se perdoa aqui e digitacao (acento,
 * caixa, espaco), nunca conteudo.
 */
export function normalizarNomeDeGrupo(
  valor: string | null | undefined,
): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(DIACRITICOS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Dois nomes de grupo sao o mesmo grupo? */
export function mesmoNomeDeGrupo(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizarNomeDeGrupo(a) === normalizarNomeDeGrupo(b);
}

/**
 * O rotulo de um grupo no relatorio: `"Prova 1 (#156988)"`.
 *
 * O nome vem do mapa que a resolucao ja carregou para aquela turma. Quando o id
 * nao esta la — grupo de uma categoria que nao foi varrida, por exemplo — sobra
 * `"#156988"`. Um numero solto nao responde "de qual sessao a prova estava
 * liberada?", que e a pergunta que se faz com o cliente na frente; por isso o
 * mapa existe, e por isso este rotulo nao e montado no lugar da leitura.
 */
export function rotularGrupo(
  groupId: number,
  nomePorId: ReadonlyMap<number, string>,
): string {
  const nome = nomePorId.get(groupId);
  return nome ? `${nome} (#${groupId})` : `#${groupId}`;
}
