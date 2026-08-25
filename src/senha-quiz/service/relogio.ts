/**
 * ============================================================================
 * QUE HORAS SAO, E QUE DIA E, PARA O CRON
 * ============================================================================
 * O cron compara `HH:MM` no fuso de Brasilia, mas `SenhaDeProva.data` e
 * `@db.Date` — meia-noite UTC. Misturar `new Date()` local com a data da celula
 * desliza um dia inteiro, e o sintoma seria o pior possivel: o lote aplicaria a
 * senha do dia errado, e ninguem perceberia ate os alunos serem recusados.
 *
 * `hojeUtc()` (src/components/utc.util.ts) resolve o corte de "faixa que ja
 * passou" usando as partes UTC do instante atual — o que basta para os turnos de
 * prova, mas nao para o dia inteiro: depois das 21h de Brasilia o UTC ja virou.
 * Aqui a data e derivada do FUSO, nao do UTC, para que a regra valha em qualquer
 * hora e nao so nas que temos hoje.
 */

/** O fuso da operacao. Os containers ja sobem com TZ=America/Sao_Paulo. */
export const FUSO_DA_OPERACAO = 'America/Sao_Paulo';

export interface AgoraNaOperacao {
  /** Meia-noite (UTC) do dia corrente NO FUSO — casa com `@db.Date`. */
  data: Date;
  /** "HH:MM" em 24h no fuso, pronto para `turnoParaDisparar`. */
  hhmm: string;
}

/**
 * O instante atual traduzido para (dia, hora) da operacao.
 *
 * Recebe `agora` para o teste poder fixar o relogio sem mockar `Date` global.
 */
export function agoraNaOperacao(
  agora: Date = new Date(),
  fuso: string = FUSO_DA_OPERACAO,
): AgoraNaOperacao {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(agora);

  const valor = (tipo: Intl.DateTimeFormatPartTypes) =>
    partes.find((p) => p.type === tipo)?.value ?? '00';

  // `hour12: false` produz "24" a meia-noite em algumas versoes do ICU; o
  // modulo devolve a hora a "00", que e o que o resto do sistema espera.
  const hora = String(Number(valor('hour')) % 24).padStart(2, '0');

  return {
    data: new Date(
      Date.UTC(
        Number(valor('year')),
        Number(valor('month')) - 1,
        Number(valor('day')),
      ),
    ),
    hhmm: `${hora}:${valor('minute')}`,
  };
}

/**
 * "AAAA-MM-DD" -> meia-noite UTC, o formato de `@db.Date`.
 *
 * `new Date('2026-09-16')` ja produz meia-noite UTC, mas `new Date(2026, 8, 16)`
 * produz meia-noite LOCAL — e a segunda forma e a que alguem escreve por
 * reflexo. Concentrar a conversao aqui tira a escolha do caminho.
 */
export function dataUtcDeIso(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** O inverso: `@db.Date` -> "AAAA-MM-DD", para a resposta da API. */
export function isoDeDataUtc(data: Date): string {
  return data.toISOString().slice(0, 10);
}

/**
 * (dia em `@db.Date`, "HH:MM" no fuso da operacao) -> o INSTANTE em UTC.
 *
 * E o que o Brightspace exige no `StartDate`/`EndDate` do questionario: ISO 8601
 * em UTC, com `Z`. Mandar `-03:00` faz alguns endpoints da Valence responderem
 * `400 Invalid Parameters` — foi o que o CLI de origem aprendeu na pratica
 * (`brightspace-change-dates/src/updateDates.js`, `toApiDate`).
 *
 * ⚠️ NAO subtraia 3 horas. O Brasil aboliu o horario de verao em 2019, entao
 * `-03:00` esta certo HOJE — mas a regra ja mudou uma vez, e um `-3` cravado no
 * codigo so falharia se ela voltasse: silenciosamente, uma hora errada em toda
 * prova da instituicao. O deslocamento e sempre PERGUNTADO ao ICU, para a data
 * em questao, pelo mesmo `Intl.DateTimeFormat` que `agoraNaOperacao` usa.
 *
 * Como o deslocamento e descoberto: formatamos um instante candidato NO FUSO e
 * comparamos com o que queriamos ler. A diferenca e o offset. Uma segunda
 * passada resolve o caso em que o proprio offset muda entre o palpite e o
 * resultado (a virada do horario de verao) — mais que isso nao ha, porque
 * nenhum fuso salta duas vezes no mesmo dia.
 */
export function instanteUtcDe(
  dia: Date,
  hhmm: string,
  fuso: string = FUSO_DA_OPERACAO,
): Date {
  const casado = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? '').trim());

  if (!casado) {
    // Lancar aqui e o certo, ao contrario de `minutosDaHora`: quem chama nao e o
    // tick (que precisa continuar de pe), e sim a montagem do corpo do PUT. Uma
    // hora invalida virando data invalida produziria `Invalid Date` -> `null` no
    // JSON -> `StartDate` APAGADO em toda turma, sem erro nenhum.
    throw new Error(`Hora invalida para conversao em UTC: "${String(hhmm)}"`);
  }

  const desejado =
    Date.UTC(
      dia.getUTCFullYear(),
      dia.getUTCMonth(),
      dia.getUTCDate(),
      Number(casado[1]),
      Number(casado[2]),
    ) / 1000;

  let palpite = desejado * 1000;

  for (let passada = 0; passada < 2; passada += 1) {
    // O que o relogio DAQUELE fuso marca no instante do palpite, lido como se
    // fosse UTC. A diferenca para o que queriamos e exatamente o offset.
    const lido = leituraComoUtc(new Date(palpite), fuso) / 1000;
    const erro = desejado - lido;
    if (erro === 0) break;
    palpite += erro * 1000;
  }

  return new Date(palpite);
}

/** O relogio do fuso naquele instante, reinterpretado como epoch UTC (ms). */
function leituraComoUtc(instante: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instante);

  const valor = (tipo: Intl.DateTimeFormatPartTypes) =>
    Number(partes.find((p) => p.type === tipo)?.value ?? '0');

  return Date.UTC(
    valor('year'),
    valor('month') - 1,
    valor('day'),
    // Mesma armadilha de `agoraNaOperacao`: `hour12: false` produz "24" a
    // meia-noite em algumas versoes do ICU.
    valor('hour') % 24,
    valor('minute'),
    valor('second'),
  );
}

/** O dia seguinte de um `@db.Date`, sem passar pelo fuso local. */
export function diaSeguinteDe(dia: Date): Date {
  return new Date(dia.getTime() + 24 * 60 * 60 * 1000);
}
