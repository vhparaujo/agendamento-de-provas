/**
 * Faixas guardam hora como texto "HH:MM" (schema.prisma). Comparar string
 * funciona por acaso no formato zero-padded, mas somar duracao nao — entao toda
 * conta de horario passa por aqui, em minutos.
 */
export const PADRAO_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function horaValida(hora: string): boolean {
  return PADRAO_HORA.test(hora);
}

/** "08:30" -> 510 */
export function paraMinutos(hora: string): number {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/** 510 -> "08:30" */
export function paraHora(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Duracao da faixa em minutos. Nao trata virada de meia-noite de proposito:
 * prova das 22:00 as 02:00 nao existe no calendario da universidade, e aceitar
 * silenciosamente uma duracao negativa seria pior que recusar.
 */
export function duracaoEmMinutos(horaInicio: string, horaFim: string): number {
  return paraMinutos(horaFim) - paraMinutos(horaInicio);
}
