import {
  acessoDaReserva,
  alunosDaTurma,
  corpoDoAcesso,
  jaEstaCerto,
  planejarAcessos,
  ReservaNaTurma,
  userIdValido,
} from './acesso';

/**
 * A regra do special access de cada aluno. O que erra calado aqui:
 *
 * - **o fuso**: a faixa de Cruzeiro do Sul lida no relogio de Brasilia abriria a
 *   prova duas horas cedo demais, e ninguem veria ate o dia;
 * - **o NIOP**: a hora a mais precisa ir no tempo E no fechamento — so no tempo,
 *   o questionario fecharia com o aluno no meio da prova;
 * - **o plano**: reescrever quem ja esta certo e so custo, mas remover quem o
 *   portal nao conhece e tirar um acesso que alguem deu a mao.
 */

/** 16/09/2026, meia-noite UTC — o formato de `@db.Date`. */
const DIA = new Date('2026-09-16T00:00:00.000Z');

const reserva = (sobrepor: Partial<ReservaNaTurma> = {}): ReservaNaTurma => ({
  matricula: 'UC100',
  userIdD2L: '101',
  confirmada: true,
  data: DIA,
  horaInicio: '09:00',
  horaFim: '12:00',
  fuso: 'America/Sao_Paulo',
  tempoDeProvaMinutos: 180,
  niop: false,
  ...sobrepor,
});

describe('acessoDaReserva', () => {
  it('abre e fecha com a faixa, no relogio de Brasilia', () => {
    expect(acessoDaReserva(reserva(), 60)).toEqual({
      inicio: new Date('2026-09-16T12:00:00.000Z'),
      fim: new Date('2026-09-16T15:00:00.000Z'),
      minutos: 180,
    });
  });

  it('Cruzeiro do Sul: a mesma faixa abre DUAS HORAS depois da de Brasilia', () => {
    const acesso = acessoDaReserva(reserva({ fuso: 'America/Rio_Branco' }), 60);

    expect(acesso.inicio).toEqual(new Date('2026-09-16T14:00:00.000Z'));
    expect(acesso.fim).toEqual(new Date('2026-09-16T17:00:00.000Z'));
  });

  it('NIOP: a hora a mais vai no tempo e no fechamento; o inicio nao muda', () => {
    expect(acessoDaReserva(reserva({ niop: true }), 60)).toEqual({
      inicio: new Date('2026-09-16T12:00:00.000Z'),
      fim: new Date('2026-09-16T16:00:00.000Z'),
      minutos: 240,
    });
  });

  it('o extra do NIOP e o configurado, nao uma hora cravada', () => {
    expect(acessoDaReserva(reserva({ niop: true }), 30).minutos).toBe(210);
  });

  it('o tempo e o do formato da reserva, nao o tamanho da faixa', () => {
    const acesso = acessoDaReserva(
      reserva({
        horaInicio: '14:00',
        horaFim: '15:30',
        tempoDeProvaMinutos: 90,
      }),
      60,
    );

    expect(acesso.minutos).toBe(90);
    expect(acesso.fim).toEqual(new Date('2026-09-16T18:30:00.000Z'));
  });
});

describe('corpoDoAcesso', () => {
  it('datas em UTC com Z, tempo obrigatorio e tentativas do questionario', () => {
    const corpo = corpoDoAcesso(acessoDaReserva(reserva({ niop: true }), 60));

    expect(corpo).toEqual({
      StartDate: '2026-09-16T12:00:00.000Z',
      EndDate: '2026-09-16T16:00:00.000Z',
      DueDate: null,
      SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: 240 },
      AttemptsAllowed: null,
    });
  });
});

describe('alunosDaTurma', () => {
  it('reserva confirmada vira acesso desejado', () => {
    const r = alunosDaTurma([reserva()], 60);

    expect(r.desejados).toHaveLength(1);
    expect(r.desejados[0]).toMatchObject({ userId: 101, matricula: 'UC100' });
    expect(r.cancelados).toEqual([]);
  });

  it('so cancelada vira remocao; cancelada + confirmada, fica a confirmada', () => {
    const r = alunosDaTurma(
      [
        reserva({ userIdD2L: '201', matricula: 'UC200', confirmada: false }),
        reserva({ userIdD2L: '101', confirmada: false }),
        reserva({ userIdD2L: '101', horaInicio: '15:00', horaFim: '18:00' }),
      ],
      60,
    );

    expect(r.cancelados).toEqual([{ userId: 201, matricula: 'UC200' }]);
    expect(r.desejados.map((d) => d.userId)).toEqual([101]);
  });

  it('duas confirmadas iguais do mesmo usuario sao UM acesso', () => {
    const r = alunosDaTurma([reserva(), reserva()], 60);

    expect(r.desejados).toHaveLength(1);
    expect(r.duplicados).toEqual([]);
  });

  /** O RA de dois cursos com a mesma disciplina, em horarios diferentes. */
  it('duas confirmadas em horarios diferentes: nada e escolhido', () => {
    const r = alunosDaTurma(
      [reserva(), reserva({ horaInicio: '15:00', horaFim: '18:00' })],
      60,
    );

    expect(r.desejados).toEqual([]);
    expect(r.cancelados).toEqual([]);
    expect(r.duplicados).toHaveLength(1);
    expect(r.duplicados[0].userId).toBe(101);
  });

  it('UserId nao numerico nao tem para quem gravar', () => {
    const r = alunosDaTurma([reserva({ userIdD2L: 'abc' })], 60);

    expect(r.desejados).toEqual([]);
    expect(r.invalidos).toEqual([{ matricula: 'UC100', userIdD2L: 'abc' }]);
  });
});

describe('planejarAcessos', () => {
  const [aluno] = alunosDaTurma([reserva()], 60).desejados;

  const lido = (
    userId: number,
    start = '2026-09-16T12:00:00Z',
    end = '2026-09-16T15:00:00Z',
    minutos = 180,
  ) => ({
    UserId: userId,
    SpecialAccess: {
      StartDate: start,
      EndDate: end,
      SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: minutos },
    },
  });

  it('sem acesso: grava', () => {
    const plano = planejarAcessos({
      desejados: [aluno],
      cancelados: [],
      lidos: [],
    });

    expect(plano.gravar).toEqual([aluno]);
    expect(plano.jaCorretos).toBe(0);
  });

  it('acesso igual, mesmo com a data escrita diferente: nenhuma chamada', () => {
    const plano = planejarAcessos({
      desejados: [aluno],
      cancelados: [],
      lidos: [lido(101)],
    });

    expect(plano).toMatchObject({ gravar: [], atualizar: [], jaCorretos: 1 });
  });

  it('remanejo (outro horario) ou outro tempo: atualiza', () => {
    expect(
      planejarAcessos({
        desejados: [aluno],
        cancelados: [],
        lidos: [lido(101, '2026-09-16T18:00:00Z', '2026-09-16T21:00:00Z')],
      }).atualizar,
    ).toEqual([aluno]);

    expect(
      planejarAcessos({
        desejados: [aluno],
        cancelados: [],
        lidos: [lido(101, undefined, undefined, 240)],
      }).atualizar,
    ).toEqual([aluno]);
  });

  it('cancelado com acesso: remove; sem acesso: nada', () => {
    const cancelado = { userId: 201, matricula: 'UC200' };

    expect(
      planejarAcessos({
        desejados: [],
        cancelados: [cancelado],
        lidos: [lido(201)],
      }).remover,
    ).toEqual([cancelado]);

    expect(
      planejarAcessos({ desejados: [], cancelados: [cancelado], lidos: [] })
        .remover,
    ).toEqual([]);
  });

  it('acesso de quem o portal nao conhece nunca e removido', () => {
    const plano = planejarAcessos({
      desejados: [aluno],
      cancelados: [],
      lidos: [lido(101), lido(999)],
    });

    expect(plano.remover).toEqual([]);
    expect(plano.deOutros).toEqual([999]);
  });
});

describe('jaEstaCerto', () => {
  const desejado = acessoDaReserva(reserva(), 60);

  it('exige o tempo aplicado (IsEnforced)', () => {
    expect(
      jaEstaCerto(
        {
          SpecialAccess: {
            StartDate: '2026-09-16T12:00:00.000Z',
            EndDate: '2026-09-16T15:00:00.000Z',
            SubmissionTimeLimit: { IsEnforced: false, TimeLimitValue: 180 },
          },
        },
        desejado,
      ),
    ).toBe(false);
  });

  it('acesso sem dados nao esta certo', () => {
    expect(jaEstaCerto({ UserId: 101, SpecialAccess: null }, desejado)).toBe(
      false,
    );
  });
});

describe('userIdValido', () => {
  it('so inteiro positivo', () => {
    expect(userIdValido('123')).toBe(123);
    expect(userIdValido(456)).toBe(456);
    expect(userIdValido('0')).toBeNull();
    expect(userIdValido('12a')).toBeNull();
    expect(userIdValido('')).toBeNull();
    expect(userIdValido(null)).toBeNull();
  });
});
