import { agoraNaOperacao, dataUtcDeIso, isoDeDataUtc } from './relogio';

describe('agoraNaOperacao', () => {
  it('traduz o instante UTC para o dia e a hora de Brasilia', () => {
    // 16/09/2026 10:30 UTC = 07:30 em Sao Paulo (UTC-3).
    const r = agoraNaOperacao(new Date('2026-09-16T10:30:00.000Z'));

    expect(r.hhmm).toBe('07:30');
    expect(isoDeDataUtc(r.data)).toBe('2026-09-16');
  });

  /**
   * O caso que `hojeUtc()` nao cobre: depois das 21h de Brasilia o UTC ja virou
   * o dia. Derivar a data do FUSO e o que impede o lote de procurar a celula de
   * amanha.
   */
  it('mantem o dia de Brasilia depois de o UTC virar', () => {
    // 17/09 01:00 UTC = 16/09 22:00 em Sao Paulo.
    const r = agoraNaOperacao(new Date('2026-09-17T01:00:00.000Z'));

    expect(r.hhmm).toBe('22:00');
    expect(isoDeDataUtc(r.data)).toBe('2026-09-16');
  });

  it('meia-noite de Brasilia sai como 00:00, nunca 24:00', () => {
    const r = agoraNaOperacao(new Date('2026-09-16T03:00:00.000Z'));

    expect(r.hhmm).toBe('00:00');
    expect(isoDeDataUtc(r.data)).toBe('2026-09-16');
  });
});

describe('dataUtcDeIso', () => {
  it('produz meia-noite UTC, e nao meia-noite local', () => {
    expect(dataUtcDeIso('2026-09-16').toISOString()).toBe(
      '2026-09-16T00:00:00.000Z',
    );
  });

  it('e o inverso de isoDeDataUtc', () => {
    expect(isoDeDataUtc(dataUtcDeIso('2026-09-16'))).toBe('2026-09-16');
  });
});
