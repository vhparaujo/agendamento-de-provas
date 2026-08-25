import {
  agoraNaOperacao,
  dataUtcDeIso,
  diaSeguinteDe,
  instanteUtcDe,
  isoDeDataUtc,
} from './relogio';

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

describe('instanteUtcDe', () => {
  it('converte a hora de Brasilia para UTC-Z', () => {
    // 09:00 em Sao Paulo (UTC-3) = 12:00 UTC.
    const r = instanteUtcDe(dataUtcDeIso('2026-08-26'), '09:00');

    expect(r.toISOString()).toBe('2026-08-26T12:00:00.000Z');
  });

  it('converte as tres janelas do EaD', () => {
    const dia = dataUtcDeIso('2026-08-26');

    expect(instanteUtcDe(dia, '12:00').toISOString()).toBe(
      '2026-08-26T15:00:00.000Z',
    );
    expect(instanteUtcDe(dia, '15:00').toISOString()).toBe(
      '2026-08-26T18:00:00.000Z',
    );
    expect(instanteUtcDe(dia, '22:00').toISOString()).toBe(
      '2026-08-27T01:00:00.000Z',
    );
  });

  /**
   * A janela das 20:00-21:30 (Semi/Modular) cai no dia UTC SEGUINTE, e isso e
   * correto: 21:30 em Brasilia e 00:30Z. Ler a hora como se fosse UTC poria a
   * prova tres horas mais cedo, e o aluno bateria num questionario fechado.
   */
  it('a janela da noite atravessa o dia em UTC, e isso e o certo', () => {
    const r = instanteUtcDe(dataUtcDeIso('2026-08-26'), '21:30');

    expect(r.toISOString()).toBe('2026-08-27T00:30:00.000Z');
  });

  it('meia-noite e meio-dia nao se confundem', () => {
    const dia = dataUtcDeIso('2026-08-26');

    expect(instanteUtcDe(dia, '00:00').toISOString()).toBe(
      '2026-08-26T03:00:00.000Z',
    );
    expect(instanteUtcDe(dia, '12:00').toISOString()).toBe(
      '2026-08-26T15:00:00.000Z',
    );
  });

  /**
   * O deslocamento e PERGUNTADO ao ICU, nunca cravado em -3. Um fuso com regra
   * diferente prova que a conta nao esta escondendo um numero magico.
   */
  it('nao assume -03:00: funciona em outro fuso', () => {
    // Lisboa em agosto esta em UTC+1 (horario de verao).
    const r = instanteUtcDe(
      dataUtcDeIso('2026-08-26'),
      '09:00',
      'Europe/Lisbon',
    );

    expect(r.toISOString()).toBe('2026-08-26T08:00:00.000Z');
  });

  it('atravessa uma virada de horario de verao sem errar a hora', () => {
    // Lisboa muda de UTC+1 para UTC+0 em 25/10/2026. No dia 26 ja e UTC+0.
    const r = instanteUtcDe(
      dataUtcDeIso('2026-10-26'),
      '09:00',
      'Europe/Lisbon',
    );

    expect(r.toISOString()).toBe('2026-10-26T09:00:00.000Z');
  });

  /**
   * Lancar e o certo aqui, ao contrario de `minutosDaHora`. Uma hora invalida
   * virando `Invalid Date` produziria `null` no JSON, e `null` no `StartDate` do
   * PUT APAGA a data em toda turma do CSV — sem erro nenhum.
   */
  it.each(['24:00', '9:00', '', '  ', 'abc', '12:60'])(
    'recusa a hora invalida %p em vez de produzir data invalida',
    (hora) => {
      expect(() => instanteUtcDe(dataUtcDeIso('2026-08-26'), hora)).toThrow(
        /Hora invalida/,
      );
    },
  );

  it('recusa null e undefined', () => {
    const dia = dataUtcDeIso('2026-08-26');

    expect(() => instanteUtcDe(dia, null as unknown as string)).toThrow(
      /Hora invalida/,
    );
    expect(() => instanteUtcDe(dia, undefined as unknown as string)).toThrow(
      /Hora invalida/,
    );
  });
});

describe('diaSeguinteDe', () => {
  it('avanca um dia mantendo a meia-noite UTC', () => {
    expect(isoDeDataUtc(diaSeguinteDe(dataUtcDeIso('2026-08-26')))).toBe(
      '2026-08-27',
    );
  });

  it('vira o mes e o ano', () => {
    expect(isoDeDataUtc(diaSeguinteDe(dataUtcDeIso('2026-08-31')))).toBe(
      '2026-09-01',
    );
    expect(isoDeDataUtc(diaSeguinteDe(dataUtcDeIso('2026-12-31')))).toBe(
      '2027-01-01',
    );
  });

  it('nao muta a data recebida', () => {
    const dia = dataUtcDeIso('2026-08-26');
    diaSeguinteDe(dia);

    expect(isoDeDataUtc(dia)).toBe('2026-08-26');
  });
});
