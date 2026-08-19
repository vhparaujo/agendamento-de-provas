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
