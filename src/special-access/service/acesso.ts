import { instanteUtcDe } from '../../senha-quiz/service/relogio';

/**
 * ============================================================================
 * O SPECIAL ACCESS DE CADA ALUNO — a regra, sem rede e sem banco
 * ============================================================================
 * O questionario preparado nao tem data e so abre para quem tem special access.
 * Cada aluno recebe:
 *
 *   - **inicio** = hora de inicio da FAIXA agendada, no fuso do POLO da faixa;
 *   - **fim**    = hora de fim da faixa, + o tempo extra se for do NIOP;
 *   - **tempo**  = o tempo de prova da modalidade da reserva, + o extra do NIOP.
 *
 * O fuso e o do polo porque a faixa e cadastrada no relogio de quem faz a prova:
 * "09:00" em Cruzeiro do Sul e 09:00 no Acre, duas horas depois das 09:00 de
 * Brasilia. A conversao e sempre perguntada ao ICU (`instanteUtcDe`), nunca um
 * deslocamento somado a mao.
 *
 * O fim e o da faixa, e nao inicio + tempo (decisao de 15/09/2026): a faixa ja
 * tem o tamanho da prova da modalidade, e o NIOP ganha a mesma hora a mais nas
 * duas pontas que importam — o relogio do questionario e o fechamento.
 */

export interface ReservaParaAcesso {
  /** `@db.Date` da faixa — meia-noite UTC. */
  data: Date;
  horaInicio: string;
  horaFim: string;
  /** Fuso IANA do polo da faixa. */
  fuso: string;
  /** `Modalidade.tempoDeProvaMinutos` da modalidade DA RESERVA (fotografia). */
  tempoDeProvaMinutos: number;
  niop: boolean;
}

export interface AcessoDesejado {
  inicio: Date;
  fim: Date;
  minutos: number;
}

export function acessoDaReserva(
  reserva: ReservaParaAcesso,
  tempoExtraNiopMinutos: number,
): AcessoDesejado {
  const extra = reserva.niop ? tempoExtraNiopMinutos : 0;
  const fimDaFaixa = instanteUtcDe(reserva.data, reserva.horaFim, reserva.fuso);

  return {
    inicio: instanteUtcDe(reserva.data, reserva.horaInicio, reserva.fuso),
    fim: new Date(fimDaFaixa.getTime() + extra * 60_000),
    minutos: reserva.tempoDeProvaMinutos + extra,
  };
}

/** `Quiz.SpecialAccessData`, como o PUT espera. */
export interface CorpoDoAcessoEspecial {
  StartDate: string;
  EndDate: string;
  DueDate: null;
  SubmissionTimeLimit: { IsEnforced: true; TimeLimitValue: number };
  /** Nulo = as tentativas continuam as do questionario. */
  AttemptsAllowed: null;
}

export function corpoDoAcesso(acesso: AcessoDesejado): CorpoDoAcessoEspecial {
  return {
    // Ja em UTC com `Z`: a Valence recusa `-03:00` em alguns endpoints.
    StartDate: acesso.inicio.toISOString(),
    EndDate: acesso.fim.toISOString(),
    DueDate: null,
    SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: acesso.minutos },
    AttemptsAllowed: null,
  };
}

// ---------------------------------------------------------------------------
// Quem da turma recebe, quem perde, e quem fica de fora
// ---------------------------------------------------------------------------

export interface ReservaNaTurma extends ReservaParaAcesso {
  matricula: string;
  userIdD2L: string;
  confirmada: boolean;
}

export interface AlunoComAcesso {
  userId: number;
  matricula: string;
  niop: boolean;
  acesso: AcessoDesejado;
}

export interface AlunoSemAcesso {
  userId: number;
  matricula: string;
}

export interface AlunosDaTurma {
  /** Reserva confirmada: deve ter este acesso. */
  desejados: AlunoComAcesso[];
  /** So reserva cancelada: o acesso, se existir, sai. */
  cancelados: AlunoSemAcesso[];
  /**
   * Duas reservas confirmadas do mesmo usuario, com janelas diferentes. Acontece
   * com o RA de dois cursos na mesma turma. Nada e escolhido: ele nao e gravado
   * nem removido.
   */
  duplicados: (AlunoSemAcesso & { detalhe: string })[];
  /** Reserva confirmada sem UserId numerico: nao ha para quem gravar. */
  invalidos: { matricula: string; userIdD2L: string }[];
}

export function alunosDaTurma(
  reservas: readonly ReservaNaTurma[],
  tempoExtraNiopMinutos: number,
): AlunosDaTurma {
  const porUsuario = new Map<
    number,
    { matricula: string; niop: boolean; acessos: AcessoDesejado[] }
  >();
  const invalidos: AlunosDaTurma['invalidos'] = [];
  const canceladosPorUsuario = new Map<number, string>();

  for (const reserva of reservas) {
    const userId = userIdValido(reserva.userIdD2L);

    if (!reserva.confirmada) {
      // Cancelada sem UserId valido nao tem o que remover.
      if (userId !== null) canceladosPorUsuario.set(userId, reserva.matricula);
      continue;
    }

    if (userId === null) {
      invalidos.push({
        matricula: reserva.matricula,
        userIdD2L: reserva.userIdD2L,
      });
      continue;
    }

    const acesso = acessoDaReserva(reserva, tempoExtraNiopMinutos);
    const atual = porUsuario.get(userId);

    if (atual) {
      atual.acessos.push(acesso);
      atual.niop ||= reserva.niop;
    } else {
      porUsuario.set(userId, {
        matricula: reserva.matricula,
        niop: reserva.niop,
        acessos: [acesso],
      });
    }
  }

  const desejados: AlunoComAcesso[] = [];
  const duplicados: AlunosDaTurma['duplicados'] = [];

  for (const [userId, { matricula, niop, acessos }] of porUsuario) {
    const [primeiro] = acessos;
    const todosIguais = acessos.every((a) => mesmaJanela(a, primeiro));

    if (todosIguais) {
      desejados.push({ userId, matricula, niop, acesso: primeiro });
      continue;
    }

    duplicados.push({
      userId,
      matricula,
      detalhe:
        `${acessos.length} reservas confirmadas nesta turma, em horarios ` +
        'diferentes (em geral, o RA de dois cursos). Nenhuma foi escolhida: ' +
        'cancele a que sobra e rode de novo.',
    });
  }

  const cancelados = [...canceladosPorUsuario]
    .filter(([userId]) => !porUsuario.has(userId))
    .map(([userId, matricula]) => ({ userId, matricula }));

  return { desejados, cancelados, duplicados, invalidos };
}

// ---------------------------------------------------------------------------
// O plano de UM questionario: o que gravar, atualizar e remover
// ---------------------------------------------------------------------------

/** `Quiz.SpecialAccessUserData` na forma que a listagem devolve. */
export interface AcessoEspecialLido {
  UserId?: number | string | null;
  SpecialAccess?: {
    StartDate?: string | null;
    EndDate?: string | null;
    SubmissionTimeLimit?: {
      IsEnforced?: boolean | null;
      TimeLimitValue?: number | null;
    } | null;
  } | null;
}

export interface PlanoDeAcessos {
  gravar: AlunoComAcesso[];
  atualizar: AlunoComAcesso[];
  remover: AlunoSemAcesso[];
  /** Ja estavam com o acesso certo: nenhuma chamada. */
  jaCorretos: number;
  /** UserIds com special access e sem reserva nesta turma. Nunca tocados. */
  deOutros: number[];
}

export function planejarAcessos(entrada: {
  desejados: readonly AlunoComAcesso[];
  cancelados: readonly AlunoSemAcesso[];
  lidos: readonly AcessoEspecialLido[];
}): PlanoDeAcessos {
  const lidoPorUsuario = new Map<number, AcessoEspecialLido>();

  for (const lido of entrada.lidos) {
    const userId = userIdValido(lido.UserId);
    if (userId !== null) lidoPorUsuario.set(userId, lido);
  }

  const plano: PlanoDeAcessos = {
    gravar: [],
    atualizar: [],
    remover: [],
    jaCorretos: 0,
    deOutros: [],
  };

  const conhecidos = new Set<number>();

  for (const aluno of entrada.desejados) {
    conhecidos.add(aluno.userId);
    const lido = lidoPorUsuario.get(aluno.userId);

    if (!lido) plano.gravar.push(aluno);
    else if (jaEstaCerto(lido, aluno.acesso)) plano.jaCorretos += 1;
    else plano.atualizar.push(aluno);
  }

  for (const aluno of entrada.cancelados) {
    conhecidos.add(aluno.userId);
    if (lidoPorUsuario.has(aluno.userId)) plano.remover.push(aluno);
  }

  plano.deOutros = [...lidoPorUsuario.keys()]
    .filter((userId) => !conhecidos.has(userId))
    .sort((a, b) => a - b);

  return plano;
}

/**
 * O acesso gravado ja e o desejado? Compara INSTANTES, e nao strings: a Valence
 * pode devolver `2026-09-16T12:00:00Z` para o `...00.000Z` que foi enviado.
 */
export function jaEstaCerto(
  lido: AcessoEspecialLido,
  desejado: AcessoDesejado,
): boolean {
  const acesso = lido.SpecialAccess;
  if (!acesso) return false;

  const limite = acesso.SubmissionTimeLimit;

  return (
    instante(acesso.StartDate) === desejado.inicio.getTime() &&
    instante(acesso.EndDate) === desejado.fim.getTime() &&
    limite?.IsEnforced === true &&
    Number(limite.TimeLimitValue) === desejado.minutos
  );
}

function mesmaJanela(a: AcessoDesejado, b: AcessoDesejado): boolean {
  return (
    a.inicio.getTime() === b.inicio.getTime() &&
    a.fim.getTime() === b.fim.getTime() &&
    a.minutos === b.minutos
  );
}

function instante(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** O UserId da Valence e numerico; qualquer outra coisa nao tem para quem gravar. */
export function userIdValido(
  valor: string | number | null | undefined,
): number | null {
  const texto = String(valor ?? '').trim();
  if (!/^\d+$/.test(texto)) return null;

  const numero = Number(texto);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}
