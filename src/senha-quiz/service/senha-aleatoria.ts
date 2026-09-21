import { randomInt } from 'node:crypto';

/**
 * ============================================================================
 * A SENHA NASCE SORTEADA, E NAO DIGITADA (21/09/2026)
 * ============================================================================
 *
 * Ate aqui a administracao escrevia as senhas da grade a mao. Com a troca
 * passando a ser por SESSAO — ~20 celulas por dia, contra 3 —, digitar deixou
 * de ser viavel, e o que se digita a mao tende a "123456", "010203" e a data do
 * dia. O sistema sorteia; a pessoa le, confere e imprime.
 *
 * REGRA PEDIDA PELO CLIENTE: seis digitos, e **nenhum digito aparecendo mais de
 * tres vezes** nos seis. E uma regra de LEGIBILIDADE, nao de forca: "777773"
 * lido em voz alta para uma sala, ou copiado da folha impressa, erra mais.
 * Proibir o quarto digito repetido corta "111112" e "777777" sem cortar
 * "771723", que ninguem confunde.
 *
 * ⚠️ **`crypto.randomInt`, nunca `Math.random`.** O universo e de um milhao de
 * senhas e elas ficam VALIDAS por uma sessao inteira de prova. `Math.random` e
 * previsivel a partir de saidas observadas, e aqui as saidas sao observaveis: um
 * aluno ve a senha da sessao dele. Com o gerador do V8, ver algumas senhas e
 * prever as das proximas sessoes deixa de ser teorico.
 *
 * ⚠️ **Nao ha unicidade global, e ela nao e desejavel.** Duas sessoes de DIAS
 * diferentes podem sortear a mesma senha, e isso nao ajuda ninguem: o que barra
 * o aluno de ontem e a JANELA, que fechou. O que importa e nao repetir DENTRO
 * do mesmo dia (ver `sortearSenhasDoDia`), porque ai as sessoes sao vizinhas e
 * uma senha repetida seria a mesma prova aberta duas vezes.
 */

/** Quantos digitos a senha tem. O cliente fixou seis. */
export const DIGITOS_DA_SENHA = 6;

/** Quantas vezes o MESMO digito pode aparecer nos seis. */
export const MAXIMO_DE_REPETICOES = 3;

/**
 * Teto de sorteios antes de desistir.
 *
 * Duas guardas diferentes moram neste numero. A da regra de repeticao e folgada:
 * ~1,2% dos sorteios caem fora dela, e falhar 200 vezes seguidas e impossivel
 * na pratica. A que de fato pode bater e a de unicidade no dia — se alguem pedir
 * mais celulas do que ha senhas disponiveis, o laco nao pode girar para sempre.
 * Um teto e a diferenca entre um erro legivel e um processo travado.
 */
const MAXIMO_DE_TENTATIVAS = 200;

/**
 * Quantas vezes o digito mais repetido aparece.
 *
 * Exportada porque e a forma de o TESTE (e o `definir` manual) checarem a regra
 * sem reimplementa-la — duas copias da mesma contagem divergiriam no dia em que
 * o cliente pedisse quatro.
 */
export function repeticaoMaxima(senha: string): number {
  const vezes = new Map<string, number>();

  for (const digito of senha) {
    vezes.set(digito, (vezes.get(digito) ?? 0) + 1);
  }

  return Math.max(0, ...vezes.values());
}

/** A senha cabe na regra: seis digitos e nenhum deles mais de tres vezes. */
export function senhaAceitavel(senha: string): boolean {
  if (senha.length !== DIGITOS_DA_SENHA) return false;
  if (!/^\d+$/.test(senha)) return false;

  return repeticaoMaxima(senha) <= MAXIMO_DE_REPETICOES;
}

/**
 * Uma senha nova, opcionalmente diferente das que ja existem naquele dia.
 *
 * REJEICAO, e nao correcao: sortear os seis digitos e descartar o que nao
 * servir mantem a distribuicao UNIFORME entre as senhas validas. "Consertar" o
 * digito repetido (trocar o quarto 7 por outro) concentraria o resultado num
 * subconjunto, e a senha passaria a ser mais adivinhavel justamente no padrao
 * que a regra existe para tratar.
 */
export function gerarSenha(evitar: ReadonlySet<string> = new Set()): string {
  for (let tentativa = 0; tentativa < MAXIMO_DE_TENTATIVAS; tentativa += 1) {
    let senha = '';
    for (let i = 0; i < DIGITOS_DA_SENHA; i += 1) senha += randomInt(10);

    if (!senhaAceitavel(senha)) continue;
    if (evitar.has(senha)) continue;

    return senha;
  }

  // So se chega aqui pedindo perto de um milhao de senhas distintas no mesmo
  // dia — cenario que nenhuma grade real produz. Falhar alto e melhor que
  // devolver uma repetida em silencio: a repetida abriria duas sessoes com a
  // mesma senha, e isso so apareceria no dia da prova.
  throw new Error(
    `Não foi possível sortear uma senha nova em ${MAXIMO_DE_TENTATIVAS} ` +
      `tentativas (${evitar.size} senha(s) já em uso neste dia).`,
  );
}

/**
 * `quantidade` senhas distintas entre si e distintas das que ja existem no dia.
 *
 * Existe como funcao propria — em vez de um laco sobre `gerarSenha` em quem
 * chama — porque o conjunto a evitar precisa CRESCER a cada sorteio. Chamar
 * `gerarSenha` seis vezes com o mesmo conjunto devolveria duas senhas iguais
 * para duas sessoes do mesmo dia mais ou menos uma vez a cada 67 mil pedidos:
 * raro o bastante para nunca aparecer em teste manual, e exatamente o tipo de
 * defeito que aparece sozinho num dia de prova.
 */
export function sortearSenhasDoDia(
  quantidade: number,
  jaUsadasNoDia: Iterable<string> = [],
): string[] {
  const usadas = new Set(jaUsadasNoDia);
  const sorteadas: string[] = [];

  for (let i = 0; i < quantidade; i += 1) {
    const senha = gerarSenha(usadas);
    usadas.add(senha);
    sorteadas.push(senha);
  }

  return sorteadas;
}
