/**
 * ============================================================================
 * CASAMENTO DE TURMA — O `Code` DO BRIGHTSPACE É COMPOSTO
 * ============================================================================
 * Portado de `../brightspace-orgunits` (src/matching.js + src/normalize.js), que
 * já resolve isto contra a instância real da UCB.
 *
 * O fato que organiza tudo: nesta instância o `Code` da oferta carrega DOIS
 * códigos, o da disciplina e o da turma:
 *
 *   GSPS02_GSPS02EAD003_GSPS0I10227_2026/1
 *          └─ disciplina  └─ turma
 *
 * E o código da turma **se repete**: HISTÓRIA, DANÇA e LUTAS rodam todas sob
 * `GSPS0I10227`, e o que as separa é o código da disciplina no meio do `Code`.
 * Por isso o par (turma + disciplina) identifica a oferta **sem depender do
 * nome** — e é o primeiro critério, não o último.
 *
 * De onde vem o `Code` do nosso lado:
 * - **enrollments** (`D2L_HABILITADO=true`): `OrgUnit.Code`, ou seja, o composto
 *   inteiro. Comparar por igualdade com o código do CSV NUNCA casaria;
 * - **launch LTI**: `context.label` — que vem VAZIO neste tenant, e aí o código
 *   sai do fim do título (`extrairCodigoDoTitulo`), já na forma simples.
 *
 * Comparar por TOKEN cobre os dois: um código simples tokeniza para um token só.
 * E token a token, nunca por substring — `GSPS02` existe dentro de
 * `GSPS02EAD003`, e por substring o prefixo do curso passaria por código de
 * disciplina.
 *
 * A consequência que importa mais que a regra: **nada é chutado.** Quando a
 * comparação não é conclusiva, a turma fica de fora e o caso é reportado. Aqui
 * chutar significaria liberar (ou negar) a prova da disciplina errada para um
 * aluno — erro que só apareceria no dia.
 *
 * Módulo puro: sem banco, sem HTTP.
 */

/** Como a turma foi identificada. Vai no log, para auditar os casos frouxos. */
export const ESTRATEGIA = {
  CODIGO_COMPOSTO: 'codigo-composto',
  CODIGO: 'codigo',
  CODIGO_E_NOME: 'codigo-e-nome',
  NOME_EXATO: 'nome-exato',
  NOME_PARCIAL: 'nome-parcial',
  /** Código único no CSV e launch sem nome — resolvido só pelo código. */
  CODIGO_UNICO: 'codigo-unico',
} as const;

export type Estrategia = (typeof ESTRATEGIA)[keyof typeof ESTRATEGIA];

/**
 * Tamanho mínimo, em caracteres normalizados, para aceitar match por "contém".
 * Sem esse piso, um nome curto ou truncado como "ADM" casaria com qualquer
 * disciplina que o contenha.
 */
export const TAMANHO_MINIMO_PARCIAL = 6;

/**
 * Um token só é "código" se tiver letra E número e nenhum espaço
 * (ex.: GEG09I70171). É o que evita tratar "2026.2", "NOTURNO" ou "TURMA A"
 * como código quando aparecem no fim do nome ou entre parênteses.
 */
export const TOKEN_CODIGO = /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9._-]{4,}$/;

/**
 * Remove acentos, caixa, pontuação e espaços redundantes.
 *
 * "Gestão de Pessoas — ADM0142 " -> "gestao de pessoas adm0142"
 *
 * Normalizar é SEMPRE operação de comparação, nunca de exibição: o valor
 * original nunca é sobrescrito.
 */
export function normalizar(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return '';

  return valor
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Tokens de um `Code`. "GSPS02_GSPS02EAD003_GSPS0I10227_2026/1" vira
 * ['gsps02','gsps02ead003','gsps0i10227','2026','1'].
 *
 * Um código simples devolve um token só — é o que faz a mesma comparação servir
 * para o launch e para os enrollments.
 */
export function tokensDoCodigo(codigo: string | null | undefined): string[] {
  const norm = normalizar(codigo);
  return norm ? norm.split(' ') : [];
}

/**
 * Remove o código de dentro do nome, quando ele aparece embutido.
 *
 * É o caso comum: o `Name` do Brightspace carrega o código
 * ("HISTÓRIA E CULTURA DO CORPO - GSPS0I10227") e o CSV não. Sem isso, comparar
 * os dois nunca bate exato. A remoção é por TOKEN, não por regex: um código que
 * seja prefixo de outra palavra não pode levar meia palavra junto.
 */
export function removerCodigo(
  nome: string | null | undefined,
  ...codigos: (string | null | undefined)[]
): string {
  const alvos = new Set(
    codigos.flatMap((c) => tokensDoCodigo(c)).filter((t) => t !== ''),
  );

  const nomeNorm = normalizar(nome);
  if (alvos.size === 0) return nomeNorm;

  return nomeNorm
    .split(' ')
    .filter((token) => !alvos.has(token))
    .join(' ')
    .trim();
}

/**
 * Tira o código do FIM do título: no Brightspace o nome costuma vir como
 * "LABORATÓRIO DE REDES DE COMPUTADORES - GEE11I40254".
 *
 * Serve de último recurso quando o launch não traz `context.label` — acontece
 * neste tenant. **Não afrouxa nada**: o código extraído ainda precisa existir em
 * `TurmaImportada`. Separa por hífen/travessão CERCADO DE ESPAÇO — o espaço
 * importa, senão "PRÉ-CÁLCULO" seria partido ao meio.
 *
 *   "REDES - GEE11I40254"   -> "GEE11I40254"
 *   "MATEMATICA - TURMA A"  -> null  (tem espaco)
 *   "QUIMICA - 2"           -> null  (sem letra)
 *   "HISTORIA DO BRASIL"    -> null  (nao ha separador)
 */
export function extrairCodigoDoTitulo(
  titulo: string | null | undefined,
): string | null {
  const partes = String(titulo ?? '')
    .trim()
    .split(/\s+[-–—]\s+/);

  if (partes.length < 2) return null;

  const ultimo = partes[partes.length - 1].trim().toUpperCase();

  return TOKEN_CODIGO.test(ultimo) ? ultimo : null;
}

/** Código sem espaços nas pontas, em maiúsculas. */
export function normalizarCodigo(codigo: string | null | undefined): string {
  return String(codigo ?? '')
    .trim()
    .toUpperCase();
}

export interface TurmaCandidata {
  id: number;
  codigoTurma: string;
  nomeDisciplina: string;
  codigoEad: string | null;
  orgUnitId: string | null;
}

/**
 * O que a fonte do lado do aluno oferece para identificar a turma. Os nomes dos
 * campos seguem `ContextoLaunch` de propósito, para o contexto do token poder
 * ser passado direto, sem tradução no meio.
 */
export interface TurmaDoLaunch {
  /** `context.label` (simples) ou `OrgUnit.Code` (composto). */
  codigo?: string | null;
  /** `context.title` / `OrgUnit.Name` — o nome da disciplina. */
  titulo?: string | null;
  /** `context.id` / `OrgUnit.Id` — o orgUnitId. */
  orgUnitId?: string | null;
}

/**
 * Todos os códigos que esta turma oferece para procurar no CSV:
 *
 *  - o código **inteiro** — é ele que casa com um `codigoTurma` que tenha hífen
 *    ou ponto (`ADM-0142`), que tokenizado viraria duas palavras e não acharia
 *    nada;
 *  - cada **token** do `Code` — é o que casa quando ele vem composto dos
 *    enrollments (`GSPS02_GSPS02EAD003_GSPS0I10227_2026/1`);
 *  - o código no fim do **título**, quando o label veio vazio.
 *
 * Os dois primeiros são necessários: nenhum cobre o caso do outro.
 * É a lista que a consulta ao banco usa — em maiúsculas, como o CSV grava.
 */
export function codigosParaBuscar(turma: TurmaDoLaunch): string[] {
  const codigos = [
    normalizarCodigo(turma.codigo),
    ...tokensDoCodigo(turma.codigo).map((t) => t.toUpperCase()),
    extrairCodigoDoTitulo(turma.titulo) ?? '',
  ];

  return [...new Set(codigos.filter((c) => c !== ''))];
}

/**
 * O mesmo conjunto, normalizado para comparação em memória. Um `codigoTurma` do
 * CSV pertence a esta turma se estiver aqui.
 */
function codigosNormalizados(turma: TurmaDoLaunch): Set<string> {
  return new Set(
    codigosParaBuscar(turma)
      .map((c) => normalizar(c))
      .filter((c) => c !== ''),
  );
}

/**
 * Separa, de um lote carregado de uma vez, as candidatas desta turma: as cujo
 * `codigoTurma` é um dos códigos que ela oferece, mais a que já tem o mesmo
 * orgUnitId (aprendido antes).
 */
export function candidatasDe(
  turma: TurmaDoLaunch,
  lote: TurmaCandidata[],
): TurmaCandidata[] {
  const codigos = codigosNormalizados(turma);
  const orgUnitId = String(turma.orgUnitId ?? '').trim();

  return lote.filter(
    (c) =>
      codigos.has(normalizar(c.codigoTurma)) ||
      (orgUnitId !== '' && c.orgUnitId === orgUnitId),
  );
}

export type ResultadoMatch =
  | {
      situacao: 'ENCONTRADA';
      turma: TurmaCandidata;
      estrategia: Estrategia;
      motivo: string;
    }
  | { situacao: 'NAO_ENCONTRADA' | 'AMBIGUA' | 'DIVERGENTE'; motivo: string };

function encontrada(
  turma: TurmaCandidata,
  estrategia: Estrategia,
  motivo: string,
): ResultadoMatch {
  return { situacao: 'ENCONTRADA', turma, estrategia, motivo };
}

/** O nome do CSV bate com o título que veio do Brightspace? */
export function casaNomeExato(
  candidata: TurmaCandidata,
  launch: TurmaDoLaunch,
): boolean {
  const alvo = normalizar(launch.titulo);
  if (!alvo) return false;

  const codigos = [launch.codigo, candidata.codigoTurma, candidata.codigoEad];
  const semCodigoLaunch = removerCodigo(launch.titulo, ...codigos);
  const semCodigoCsv = removerCodigo(candidata.nomeDisciplina, ...codigos);
  const doCsv = normalizar(candidata.nomeDisciplina);

  return (
    doCsv === alvo || semCodigoCsv === semCodigoLaunch || semCodigoCsv === alvo
  );
}

/** Um nome contém o outro. Só a partir de `TAMANHO_MINIMO_PARCIAL`. */
export function casaNomeParcial(
  candidata: TurmaCandidata,
  launch: TurmaDoLaunch,
): boolean {
  const codigos = [launch.codigo, candidata.codigoTurma, candidata.codigoEad];
  const doLaunch = removerCodigo(launch.titulo, ...codigos);
  const doCsv = removerCodigo(candidata.nomeDisciplina, ...codigos);

  if (!doLaunch || !doCsv) return false;

  const menor = doLaunch.length <= doCsv.length ? doLaunch : doCsv;
  const maior = doLaunch.length <= doCsv.length ? doCsv : doLaunch;

  return menor.length >= TAMANHO_MINIMO_PARCIAL && maior.includes(menor);
}

/**
 * Decide qual candidata é a turma. A primeira estratégia que produzir
 * exatamente UMA vence:
 *
 *  0. **código composto** — o `Code` contém o código da turma E o da disciplina
 *  1. código da turma sozinho
 *  2. desempate por nome dentro do mesmo código (exato, depois parcial)
 *  3. nome exato
 *  4. nome parcial
 *
 * O tier 0 só existe quando a linha do CSV tem `codigoEad` (o parêntese do fim
 * da célula) e o launch trouxe um `Code`. Zero acertos ali **não é falha**:
 * significa que o `Code` não é composto ou que a disciplina não bate, e a
 * decisão segue para os tiers seguintes. É o que garante que ele nunca piore o
 * que já funcionava.
 *
 * Empate em qualquer tier -> AMBIGUA. Nunca um vencedor arbitrário.
 */
export function escolherTurma(
  launch: TurmaDoLaunch,
  candidatas: TurmaCandidata[],
): ResultadoMatch {
  const tokens = codigosNormalizados(launch);
  const nome = String(launch.titulo ?? '').trim();
  const rotulo = normalizarCodigo(launch.codigo) || nome || '(sem codigo)';

  if (candidatas.length === 0) {
    return {
      situacao: 'NAO_ENCONTRADA',
      motivo: tokens.size
        ? `Nenhuma turma cadastrada com o codigo "${rotulo}".`
        : 'O launch nao trouxe codigo de turma para procurar.',
    };
  }

  // --- Tier 0: codigo composto (turma + disciplina no mesmo Code) ---
  if (tokens.size > 0) {
    const compostas = candidatas.filter(
      (c) =>
        c.codigoEad &&
        tokens.has(normalizar(c.codigoTurma)) &&
        tokens.has(normalizar(c.codigoEad)),
    );

    if (compostas.length === 1) {
      return encontrada(
        compostas[0],
        ESTRATEGIA.CODIGO_COMPOSTO,
        'Codigo da turma e da disciplina batem no Code composto.',
      );
    }

    if (compostas.length > 1) {
      const porNome = compostas.filter((c) => casaNomeExato(c, launch));

      if (porNome.length === 1) {
        return encontrada(
          porNome[0],
          ESTRATEGIA.CODIGO_COMPOSTO,
          'Codigo composto com empate, desempatado pelo nome.',
        );
      }

      return {
        situacao: 'AMBIGUA',
        motivo: `${compostas.length} turmas com o mesmo par codigo+disciplina em "${rotulo}".`,
      };
    }
  }

  // --- Tier 1: codigo da turma ---
  const porCodigo = candidatas.filter((c) =>
    tokens.has(normalizar(c.codigoTurma)),
  );

  if (porCodigo.length === 1) {
    const unica = porCodigo[0];

    // Sem nome no launch nao ha o que cruzar, mas o codigo ja e bem especifico.
    if (!normalizar(nome)) {
      return encontrada(
        unica,
        ESTRATEGIA.CODIGO_UNICO,
        'Launch sem nome de disciplina; resolvido pelo codigo por haver uma unica turma.',
      );
    }

    if (casaNomeExato(unica, launch) || casaNomeParcial(unica, launch)) {
      return encontrada(unica, ESTRATEGIA.CODIGO, 'Turma unica, nome bate.');
    }

    return {
      situacao: 'DIVERGENTE',
      motivo:
        `Ha uma turma com o codigo "${rotulo}", mas o nome nao confere. ` +
        `Launch: "${nome}" · CSV: "${unica.nomeDisciplina}".`,
    };
  }

  if (porCodigo.length > 1) {
    // --- Tier 2: desempate por nome dentro do mesmo codigo ---
    if (!normalizar(nome)) {
      return {
        situacao: 'AMBIGUA',
        motivo: `Launch sem nome de disciplina e ${porCodigo.length} turmas com o codigo "${rotulo}".`,
      };
    }

    const exatas = porCodigo.filter((c) => casaNomeExato(c, launch));

    if (exatas.length === 1) {
      return encontrada(
        exatas[0],
        ESTRATEGIA.CODIGO_E_NOME,
        `${porCodigo.length} turmas com o codigo; 1 com nome identico.`,
      );
    }

    if (exatas.length > 1) {
      return {
        situacao: 'AMBIGUA',
        motivo: `${exatas.length} turmas com o codigo "${rotulo}" e o mesmo nome.`,
      };
    }

    const parciais = porCodigo.filter((c) => casaNomeParcial(c, launch));

    if (parciais.length === 1) {
      return encontrada(
        parciais[0],
        ESTRATEGIA.NOME_PARCIAL,
        `${porCodigo.length} turmas com o codigo; 1 com nome batendo parcialmente.`,
      );
    }

    return {
      situacao: parciais.length > 1 ? 'AMBIGUA' : 'NAO_ENCONTRADA',
      motivo:
        `${porCodigo.length} turmas com o codigo "${rotulo}", e o nome "${nome}" ` +
        'nao decide entre elas — pode ser diferenca de grafia no CSV.',
    };
  }

  // --- Tier 3: nome exato ---
  const exatas = candidatas.filter((c) => casaNomeExato(c, launch));

  if (exatas.length === 1) {
    return encontrada(exatas[0], ESTRATEGIA.NOME_EXATO, 'Nome identico.');
  }

  if (exatas.length > 1) {
    return {
      situacao: 'AMBIGUA',
      motivo: `${exatas.length} turmas com o nome "${nome}".`,
    };
  }

  // --- Tier 4: nome parcial ---
  const parciais = candidatas.filter((c) => casaNomeParcial(c, launch));

  if (parciais.length === 1) {
    return encontrada(
      parciais[0],
      ESTRATEGIA.NOME_PARCIAL,
      'Nome bate parcialmente.',
    );
  }

  return {
    situacao: parciais.length > 1 ? 'AMBIGUA' : 'NAO_ENCONTRADA',
    motivo:
      `${candidatas.length} candidata(s) para o codigo "${rotulo}", mas nenhuma ` +
      `decide com o nome "${nome}" — pode ser diferenca de grafia no CSV.`,
  };
}
