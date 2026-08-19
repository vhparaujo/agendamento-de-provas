import { Turno } from '../../generated/prisma/client';

/**
 * ============================================================================
 * QUAL TURNO O CRON DEVE APLICAR AGORA
 * ============================================================================
 *
 * Funcao PURA, e esse e o ponto: a alternativa seria tres `@Cron` com expressao
 * vinda do .env, e decorator e avaliado antes da configuracao existir. Um tick
 * de um minuto chamando esta funcao troca "cron configurado dinamicamente" por
 * "uma decisao com teste" — o mesmo caminho que `alocacao.ts` e `turma-match.ts`
 * ja seguem neste projeto. De quebra, mudar o horario no .env passa a valer no
 * minuto seguinte, sem re-registrar job nenhum.
 *
 * ⚠️ Este turno NAO seleciona turmas. O conjunto de turmas do lote e o mesmo em
 * toda execucao (as do CSV, no periodo letivo vigente); o turno so diz QUAL
 * SENHA da grade entra. Nao ha, e nao deve haver, derivacao de turno a partir de
 * `Faixa.horaInicio`.
 */

/** "HH:MM" em 24h, zero-padded — a mesma forma de `Faixa.horaInicio`. */
const PADRAO_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Horario de disparo de cada turno. Ausente ou vazio = turno DESLIGADO. */
export type HorariosDoCron = Partial<Record<Turno, string | null | undefined>>;

/** Rotulo em pt-BR para tela, CSV e mensagem de log. */
export function rotuloDoTurno(turno: Turno): string {
  return { MANHA: 'manha', TARDE: 'tarde', NOITE: 'noite' }[turno];
}

/**
 * "HH:MM" -> minutos desde a meia-noite, ou `null` se o formato nao servir.
 *
 * Devolver `null` em vez de lancar e deliberado: quem chama e um tick que roda a
 * cada minuto, e uma excecao ali derrubaria o cron inteiro por causa de uma
 * variavel mal digitada — justamente o cenario em que ele mais precisa
 * continuar de pe para os outros turnos.
 */
export function minutosDaHora(hhmm: string | null | undefined): number | null {
  const casado = PADRAO_HORA.exec(String(hhmm ?? '').trim());
  if (!casado) return null;
  return Number(casado[1]) * 60 + Number(casado[2]);
}

/**
 * O turno a disparar neste minuto, ou `null`.
 *
 * A JANELA DE TOLERANCIA e o que faz isto sobreviver a restart: o cron acorda a
 * cada minuto, entao um servidor que estava fora as 07:30 e sobe as 07:41 ainda
 * cai dentro de [07:30, 08:00) e aplica o turno da manha. Sem ela, um deploy na
 * hora errada custaria um turno inteiro de alunos travados na prova — e ninguem
 * perceberia ate o primeiro aluno reclamar.
 *
 * A janela e SEMIABERTA (`[inicio, inicio + tolerancia)`), a mesma convencao de
 * `exigirSalaLivreNoHorario`: com inicio 07:30 e tolerancia 30, ela cobre 07:30
 * ate 07:59 — as 08:00 o turno da manha ja nao dispara. Tolerancia `0` nao
 * significa "nunca": o piso de 1 minuto faz o cron disparar exatamente no minuto
 * configurado, que e a leitura obvia de "sem tolerancia".
 *
 * Quando duas janelas se sobrepoem (tolerancia grande demais), vence a que
 * COMECOU MAIS TARDE: e o turno corrente, e aplicar o anterior por cima poria a
 * senha vencida de volta.
 *
 * Nao ha travessia de meia-noite: nenhum turno de prova comeca as 23h e termina
 * no dia seguinte, e suportar isso exigiria decidir a QUAL data a celula da
 * grade pertence — pergunta sem resposta obvia e sem caso de uso.
 */
export function turnoParaDisparar(
  agoraHhMm: string,
  horarios: HorariosDoCron,
  toleranciaMin: number,
): Turno | null {
  const agora = minutosDaHora(agoraHhMm);
  if (agora == null) return null;

  const tolerancia = Number.isFinite(toleranciaMin)
    ? Math.max(0, toleranciaMin)
    : 0;

  let escolhido: { turno: Turno; inicio: number } | null = null;

  for (const turno of [Turno.MANHA, Turno.TARDE, Turno.NOITE]) {
    const inicio = minutosDaHora(horarios[turno]);
    if (inicio == null) continue; // turno desligado, ou horario mal digitado

    // Piso de 1: a janela precisa conter ao menos o proprio minuto de inicio,
    // senao `tolerancia = 0` viraria "cron desligado" sem ninguem pedir isso.
    const fim = inicio + Math.max(tolerancia, 1);
    const dentro = agora >= inicio && agora < fim;
    if (!dentro) continue;

    if (!escolhido || inicio > escolhido.inicio) escolhido = { turno, inicio };
  }

  return escolhido?.turno ?? null;
}
