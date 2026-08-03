/**
 * ============================================================================
 * HORARIO DA FAIXA -> INSTANTE UTC
 * ============================================================================
 * O special access do Brightspace exige datas em UTC com sufixo `Z`. As faixas
 * guardam a data como `@db.Date` (meia-noite UTC) e a hora como texto local
 * ("08:30"). Juntar os dois exige saber o fuso — e e exatamente aqui que um erro
 * passa despercebido: uma prova liberada 3 horas fora do horario abre cedo
 * demais ou fecha antes de o aluno terminar, e ninguem descobre ate acontecer.
 *
 * Por isso a conversao existe num lugar so, com teste, em vez de espalhada em
 * template strings pelo cliente D2L.
 *
 * Nao usamos biblioteca de fuso: o `Intl` do Node ja carrega a base do IANA e
 * conhece o horario de verao (que o Brasil nao usa desde 2019, mas a regra vale
 * para qualquer fuso que a UCB venha a ter).
 */

/** Deslocamento do fuso, em minutos, no instante indicado. */
function deslocamentoEmMinutos(instanteUtc: Date, timeZone: string): number {
  // `en-US` com `timeZoneName: 'longOffset'` produz "GMT-03:00".
  const formatador = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  });

  const parte = formatador
    .formatToParts(instanteUtc)
    .find((p) => p.type === 'timeZoneName')?.value;

  const casado = /GMT([+-])(\d{2}):?(\d{2})?/.exec(parte ?? '');

  // "GMT" sozinho = UTC (deslocamento zero).
  if (!casado) return 0;

  const sinal = casado[1] === '-' ? -1 : 1;
  const horas = Number(casado[2]);
  const minutos = Number(casado[3] ?? '0');

  return sinal * (horas * 60 + minutos);
}

/**
 * Combina a data da faixa com uma hora local e devolve o instante em UTC.
 *
 * @param data   dia da prova; so a parte de calendario e usada (a coluna e @db.Date)
 * @param hora   "HH:MM" no fuso local do polo
 * @param timeZone fuso IANA (ex: "America/Sao_Paulo")
 *
 * Ex.: 2026-08-20 08:30 em America/Sao_Paulo -> 2026-08-20T11:30:00.000Z
 */
export function paraInstanteUtc(
  data: Date,
  hora: string,
  timeZone: string,
): Date {
  const casado = /^(\d{2}):(\d{2})$/.exec(hora);

  if (!casado) {
    throw new Error(`Hora invalida: "${hora}". Use HH:MM em 24h.`);
  }

  const horas = Number(casado[1]);
  const minutos = Number(casado[2]);

  if (horas > 23 || minutos > 59) {
    throw new Error(`Hora invalida: "${hora}".`);
  }

  // A data vem em meia-noite UTC; lemos as partes de calendario em UTC para nao
  // deslizar um dia em fusos a oeste de Greenwich.
  const comoSeFosseUtc = Date.UTC(
    data.getUTCFullYear(),
    data.getUTCMonth(),
    data.getUTCDate(),
    horas,
    minutos,
  );

  // Duas passadas: o deslocamento depende do instante, e o instante depende do
  // deslocamento. A primeira estimativa erra apenas na virada do horario de
  // verao; a segunda corrige.
  const primeira = deslocamentoEmMinutos(new Date(comoSeFosseUtc), timeZone);
  const estimado = new Date(comoSeFosseUtc - primeira * 60_000);
  const segunda = deslocamentoEmMinutos(estimado, timeZone);

  return new Date(comoSeFosseUtc - segunda * 60_000);
}

/** Formato que o Brightspace espera: ISO 8601 em UTC, com `Z`. */
export function paraIsoUtc(instante: Date): string {
  return instante.toISOString();
}
