import { paraInstanteUtc, paraIsoUtc } from './utc.util';

/** Data da faixa como o Prisma devolve um @db.Date: meia-noite UTC. */
const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const SP = 'America/Sao_Paulo';

describe('paraInstanteUtc', () => {
  it('converte o exemplo da documentacao D2L (08:30 BRT -> 11:30Z)', () => {
    const inicio = paraInstanteUtc(dia('2026-08-20'), '08:30', SP);

    expect(paraIsoUtc(inicio)).toBe('2026-08-20T11:30:00.000Z');
  });

  it('converte o fim da faixa de 3h', () => {
    expect(paraIsoUtc(paraInstanteUtc(dia('2026-08-20'), '11:30', SP))).toBe(
      '2026-08-20T14:30:00.000Z',
    );
  });

  it('vira o dia quando a hora local passa das 21h', () => {
    // 22:00 em Brasilia (UTC-3) e 01:00 do dia seguinte em UTC
    expect(paraIsoUtc(paraInstanteUtc(dia('2026-08-20'), '22:00', SP))).toBe(
      '2026-08-21T01:00:00.000Z',
    );
  });

  it('nao desloca o dia por causa do fuso da maquina', () => {
    // O bug classico: montar a data no fuso local faria "2026-08-20" virar 19.
    expect(paraIsoUtc(paraInstanteUtc(dia('2026-08-20'), '00:00', SP))).toBe(
      '2026-08-20T03:00:00.000Z',
    );
  });

  it('trata UTC como deslocamento zero', () => {
    expect(paraIsoUtc(paraInstanteUtc(dia('2026-08-20'), '08:30', 'UTC'))).toBe(
      '2026-08-20T08:30:00.000Z',
    );
  });

  it('respeita fuso com deslocamento quebrado (meia hora)', () => {
    // Calcutá e UTC+05:30 — pega implementacao que ignora os minutos do offset.
    expect(
      paraIsoUtc(paraInstanteUtc(dia('2026-08-20'), '10:00', 'Asia/Kolkata')),
    ).toBe('2026-08-20T04:30:00.000Z');
  });

  it('respeita horario de verao onde ele existe', () => {
    // Nova York: -04:00 em agosto (EDT), -05:00 em janeiro (EST).
    expect(
      paraIsoUtc(
        paraInstanteUtc(dia('2026-08-20'), '09:00', 'America/New_York'),
      ),
    ).toBe('2026-08-20T13:00:00.000Z');

    expect(
      paraIsoUtc(
        paraInstanteUtc(dia('2026-01-20'), '09:00', 'America/New_York'),
      ),
    ).toBe('2026-01-20T14:00:00.000Z');
  });

  it('recusa hora fora do formato', () => {
    expect(() => paraInstanteUtc(dia('2026-08-20'), '8:30', SP)).toThrow(
      /Hora invalida/,
    );
    expect(() => paraInstanteUtc(dia('2026-08-20'), '25:00', SP)).toThrow(
      /Hora invalida/,
    );
  });
});
