/**
 * ============================================================================
 * CASAMENTO DE TURMA: CODIGO + NOME
 * ============================================================================
 * Princípio, herdado do projeto `brightspace-change-dates` (src/orgUnitResolver.js),
 * que já resolve isto contra a instância real da UCB:
 *
 *   **O código sozinho NÃO identifica a turma.** O mesmo código aparece em mais
 *   de uma oferta (semestres diferentes, turmas diferentes), então o código é
 *   apenas o primeiro filtro — quem decide é a comparação de NOME.
 *
 * E a consequência que importa mais que a regra: **nada é chutado.** Quando a
 * comparação não é conclusiva, a turma fica de fora e o caso é reportado. No
 * nosso contexto, chutar significaria liberar (ou negar) a prova da disciplina
 * errada para um aluno — erro que só apareceria no dia.
 *
 * Módulo puro: sem banco, sem HTTP. Só normalização, comparação e classificação.
 */

/** Como o nome bateu. Vai no relatório para auditar os parciais. */
export const TIPO_MATCH = {
  EXATO: 'exato',
  PARCIAL: 'parcial',
} as const;

export type TipoMatch = (typeof TIPO_MATCH)[keyof typeof TIPO_MATCH];

/**
 * Tamanho mínimo, em caracteres normalizados, para aceitar match por "contém".
 * Sem esse piso, um nome curto ou truncado como "ADM" casaria com qualquer
 * disciplina que o contenha.
 */
export const TAMANHO_MINIMO_PARCIAL = 6;

function escaparRegex(valor: string): string {
  return valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function semAcento(valor: string): string {
  return valor.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

/**
 * Normaliza um nome de turma para comparação:
 *  - tira acento (GESTÃO -> GESTAO) e sobe para maiúsculas;
 *  - REMOVE o próprio código de dentro do nome — no Brightspace o nome costuma
 *    vir como "HISTORIA E CULTURA DO CORPO - GSPS0I10227", e no nosso CSV como
 *    "HISTÓRIA E CULTURA DO CORPO (1-GSPS02EAD003)". Sem remover, o mesmo nome
 *    com e sem código deixaria de casar;
 *  - transforma pontuação e separadores em espaço;
 *  - colapsa espaços.
 */
export function normalizarNome(
  nome: string,
  ...codigos: (string | null | undefined)[]
): string {
  let texto = semAcento(String(nome ?? ''));

  for (const bruto of codigos) {
    const codigo = semAcento(String(bruto ?? '')).trim();
    if (!codigo) continue;

    // Remove o código como "palavra" inteira, no início, meio ou fim. \b não
    // funciona bem com códigos terminados em caractere não alfanumérico.
    texto = texto.replace(
      new RegExp(`(^|[^A-Z0-9])${escaparRegex(codigo)}([^A-Z0-9]|$)`, 'g'),
      ' ',
    );
  }

  return texto
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Código sem espaços nas pontas, em maiúsculas. */
export function normalizarCodigo(codigo: string | null | undefined): string {
  return String(codigo ?? '')
    .trim()
    .toUpperCase();
}

/**
 * Compara o nome que veio do launch com o nome cadastrado no CSV.
 *
 * `null` = não bate. O match parcial cobre nome truncado numa das pontas, mas só
 * a partir de `TAMANHO_MINIMO_PARCIAL` — abaixo disso vira match frouxo e pega a
 * turma errada.
 */
export function compararNomes(
  nomeA: string,
  nomeB: string,
  ...codigos: (string | null | undefined)[]
): TipoMatch | null {
  const a = normalizarNome(nomeA, ...codigos);
  const b = normalizarNome(nomeB, ...codigos);

  if (!a || !b) return null;
  if (a === b) return TIPO_MATCH.EXATO;

  const menor = a.length <= b.length ? a : b;
  const maior = a.length <= b.length ? b : a;

  if (menor.length >= TAMANHO_MINIMO_PARCIAL && maior.includes(menor)) {
    return TIPO_MATCH.PARCIAL;
  }

  return null;
}

export interface TurmaCandidata {
  id: number;
  codigoTurma: string;
  nomeDisciplina: string;
  codigoEad: string | null;
  orgUnitId: string | null;
}

/**
 * O que o launch LTI oferece para identificar a turma. Os nomes dos campos
 * seguem `ContextoLaunch` de propósito, para o contexto do token poder ser
 * passado direto, sem tradução no meio.
 */
export interface TurmaDoLaunch {
  /** `context.label` — normalmente o código da turma. */
  codigo?: string | null;
  /** `context.title` — o nome da disciplina. */
  titulo?: string | null;
  /** `context.id` — o orgUnitId. */
  orgUnitId?: string | null;
}

export type ResultadoMatch =
  | {
      situacao: 'ENCONTRADA';
      turma: TurmaCandidata;
      tipoMatch: TipoMatch | null;
      motivo: string;
    }
  | { situacao: 'NAO_ENCONTRADA' | 'AMBIGUA' | 'DIVERGENTE'; motivo: string };

/**
 * Decide qual candidata é a turma, aplicando as regras nesta ordem:
 *
 *  - 0 candidatas                                   -> não encontrada
 *  - 1 candidata, nome bate                         -> encontrada
 *  - 1 candidata, nome NÃO bate                     -> divergente (não libera)
 *  - várias, exatamente 1 com nome batendo          -> encontrada
 *  - várias, empate no mesmo nível de match         -> ambígua (não libera)
 *
 * Refinamento: se UMA bate de forma exata e as outras só parcialmente, a exata
 * vence. Isso é evidência estritamente melhor, não um desempate arbitrário.
 */
export function escolherTurma(
  launch: TurmaDoLaunch,
  candidatas: TurmaCandidata[],
): ResultadoMatch {
  const codigo = normalizarCodigo(launch.codigo);
  const nome = String(launch.titulo ?? '').trim();

  if (candidatas.length === 0) {
    return {
      situacao: 'NAO_ENCONTRADA',
      motivo: codigo
        ? `Nenhuma turma cadastrada com o codigo "${codigo}".`
        : 'O launch nao trouxe codigo de turma para procurar.',
    };
  }

  // Sem nome não há como cruzar. Uma candidata só passa (o código já é bem
  // específico); mais de uma vira ambígua — é onde o chute apareceria.
  if (!normalizarNome(nome, codigo)) {
    if (candidatas.length === 1) {
      return {
        situacao: 'ENCONTRADA',
        turma: candidatas[0],
        tipoMatch: null,
        motivo:
          'Launch sem nome de disciplina; resolvido pelo codigo por haver uma unica turma.',
      };
    }

    return {
      situacao: 'AMBIGUA',
      motivo: `Launch sem nome de disciplina e ${candidatas.length} turmas com o codigo "${codigo}".`,
    };
  }

  const avaliadas = candidatas.map((turma) => ({
    turma,
    match: compararNomes(nome, turma.nomeDisciplina, codigo, turma.codigoEad),
  }));

  const batem = avaliadas.filter((a) => a.match !== null);
  const exatas = batem.filter((a) => a.match === TIPO_MATCH.EXATO);
  const parciais = batem.filter((a) => a.match === TIPO_MATCH.PARCIAL);

  if (candidatas.length === 1) {
    const unica = avaliadas[0];

    if (unica.match) {
      return {
        situacao: 'ENCONTRADA',
        turma: unica.turma,
        tipoMatch: unica.match,
        motivo:
          unica.match === TIPO_MATCH.EXATO
            ? 'Turma unica, nome identico.'
            : 'Turma unica, nome bate parcialmente.',
      };
    }

    return {
      situacao: 'DIVERGENTE',
      motivo:
        `Ha uma turma com o codigo "${codigo}", mas o nome nao confere. ` +
        `Launch: "${nome}" · CSV: "${unica.turma.nomeDisciplina}".`,
    };
  }

  if (exatas.length === 1) {
    return {
      situacao: 'ENCONTRADA',
      turma: exatas[0].turma,
      tipoMatch: TIPO_MATCH.EXATO,
      motivo: `${candidatas.length} turmas com o codigo; 1 com nome identico.`,
    };
  }

  if (exatas.length === 0 && parciais.length === 1) {
    return {
      situacao: 'ENCONTRADA',
      turma: parciais[0].turma,
      tipoMatch: TIPO_MATCH.PARCIAL,
      motivo: `${candidatas.length} turmas com o codigo; 1 com nome batendo parcialmente.`,
    };
  }

  if (batem.length > 1) {
    return {
      situacao: 'AMBIGUA',
      motivo:
        `${candidatas.length} turmas com o codigo "${codigo}" e ${batem.length} com nome ` +
        'compativel. Nao da para decidir com seguranca.',
    };
  }

  return {
    situacao: 'NAO_ENCONTRADA',
    motivo:
      `${candidatas.length} turmas com o codigo "${codigo}", mas nenhuma com nome ` +
      `compativel com "${nome}" — pode ser diferenca de grafia no CSV.`,
  };
}
