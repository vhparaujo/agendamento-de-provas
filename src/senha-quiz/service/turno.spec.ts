import { Turno } from '../../generated/prisma/client';
import { minutosDaHora, rotuloDoTurno, turnoParaDisparar } from './turno';

const HORARIOS = {
  [Turno.MANHA]: '07:30',
  [Turno.TARDE]: '12:30',
  [Turno.NOITE]: '18:00',
};

describe('minutosDaHora', () => {
  it('converte HH:MM zero-padded', () => {
    expect(minutosDaHora('00:00')).toBe(0);
    expect(minutosDaHora('07:30')).toBe(450);
    expect(minutosDaHora('23:59')).toBe(1439);
  });

  /**
   * Devolve null em vez de lancar porque quem chama e um tick que roda a cada
   * minuto: uma excecao ali derrubaria o cron dos OUTROS turnos por causa de uma
   * variavel mal digitada.
   */
  it('devolve null no que nao for HH:MM valido', () => {
    for (const ruim of [
      '7:30',
      '24:00',
      '12:60',
      'manha',
      '',
      null,
      undefined,
    ]) {
      expect(minutosDaHora(ruim)).toBeNull();
    }
  });
});

describe('turnoParaDisparar', () => {
  it('dispara no minuto exato do horario configurado', () => {
    expect(turnoParaDisparar('07:30', HORARIOS, 30)).toBe(Turno.MANHA);
    expect(turnoParaDisparar('12:30', HORARIOS, 30)).toBe(Turno.TARDE);
    expect(turnoParaDisparar('18:00', HORARIOS, 30)).toBe(Turno.NOITE);
  });

  /**
   * A razao de ser da tolerancia: servidor que estava fora as 07:30 e sobe as
   * 07:41 ainda aplica. Sem isso, um deploy na hora errada custa o turno inteiro.
   */
  it('ainda dispara dentro da janela de tolerancia (restart)', () => {
    expect(turnoParaDisparar('07:41', HORARIOS, 30)).toBe(Turno.MANHA);
    expect(turnoParaDisparar('07:59', HORARIOS, 30)).toBe(Turno.MANHA);
  });

  it('a janela e SEMIABERTA: 08:00 com tolerancia 30 ja nao dispara', () => {
    expect(turnoParaDisparar('08:00', HORARIOS, 30)).toBeNull();
    expect(turnoParaDisparar('08:05', HORARIOS, 30)).toBeNull();
  });

  it('nao dispara antes do horario', () => {
    expect(turnoParaDisparar('07:29', HORARIOS, 30)).toBeNull();
  });

  it('fora de qualquer janela devolve null', () => {
    expect(turnoParaDisparar('03:00', HORARIOS, 30)).toBeNull();
    expect(turnoParaDisparar('23:59', HORARIOS, 30)).toBeNull();
  });

  it('tolerancia 0 dispara SO no minuto exato — nao "nunca"', () => {
    expect(turnoParaDisparar('07:30', HORARIOS, 0)).toBe(Turno.MANHA);
    expect(turnoParaDisparar('07:31', HORARIOS, 0)).toBeNull();
  });

  it('horario vazio ou ausente DESLIGA aquele turno', () => {
    const semNoite = { ...HORARIOS, [Turno.NOITE]: '' };
    expect(turnoParaDisparar('18:00', semNoite, 30)).toBeNull();
    expect(
      turnoParaDisparar('18:00', { [Turno.MANHA]: '07:30' }, 30),
    ).toBeNull();
  });

  it('horario mal digitado desliga aquele turno sem derrubar os outros', () => {
    const quebrado = { ...HORARIOS, [Turno.MANHA]: '7:30' };
    expect(turnoParaDisparar('07:30', quebrado, 30)).toBeNull();
    expect(turnoParaDisparar('12:30', quebrado, 30)).toBe(Turno.TARDE);
  });

  /**
   * Tolerancia grande demais faz as janelas se cruzarem. Vence a que COMECOU
   * MAIS TARDE: e o turno corrente, e aplicar o anterior por cima poria a senha
   * ja vencida de volta nas turmas.
   */
  it('com janelas sobrepostas, vence o turno que comecou mais tarde', () => {
    expect(turnoParaDisparar('12:35', HORARIOS, 600)).toBe(Turno.TARDE);
    expect(turnoParaDisparar('18:10', HORARIOS, 600)).toBe(Turno.NOITE);
  });

  it('hora atual invalida nao dispara nada', () => {
    expect(turnoParaDisparar('nao-e-hora', HORARIOS, 30)).toBeNull();
  });
});

describe('rotuloDoTurno', () => {
  it('da o rotulo em pt-BR para tela, CSV e log', () => {
    expect(rotuloDoTurno(Turno.MANHA)).toBe('manha');
    expect(rotuloDoTurno(Turno.TARDE)).toBe('tarde');
    expect(rotuloDoTurno(Turno.NOITE)).toBe('noite');
  });
});
