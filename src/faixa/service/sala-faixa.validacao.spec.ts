import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  exigirEncontrado,
  exigirSalaLivreNoHorario,
  janelaDaFaixa,
  seSobrepoem,
  validarOferta,
  type OfertaConcorrente,
} from './sala-faixa.validacao';

const SALA = {
  id: 21,
  nome: 'M114',
  poloId: 6,
  capacidade: 40,
  ativo: true,
};

const EAD = { id: 1, nome: 'EaD', duracaoMinutos: 180 };
const MODULAR = { id: 3, nome: 'Modular', duracaoMinutos: 90 };

// Faixa de 3h no polo 6 — comporta qualquer formato
const FAIXA = { poloId: 6, horaInicio: '08:30', horaFim: '11:30' };

describe('validarOferta', () => {
  it('aceita a combinacao valida', () => {
    expect(() => validarOferta(FAIXA, SALA, EAD, 40)).not.toThrow();
  });

  it('recusa sala de outro polo', () => {
    // sem isto, um aluno de Taguatinga poderia ser alocado em Ceilandia
    expect(() => validarOferta(FAIXA, { ...SALA, poloId: 7 }, EAD, 40)).toThrow(
      /pertence a outro polo/,
    );
  });

  it('recusa sala inativa', () => {
    expect(() =>
      validarOferta(FAIXA, { ...SALA, ativo: false }, EAD, 40),
    ).toThrow(/inativa/);
  });

  describe('a prova precisa caber na janela', () => {
    it('recusa EaD (180 min) numa faixa de 90 min', () => {
      const curta = { ...FAIXA, horaInicio: '14:00', horaFim: '15:30' };

      expect(() => validarOferta(curta, SALA, EAD, 40)).toThrow(
        /tem 90 min.*dura 180 min/s,
      );
    });

    it('aceita Modular (90 min) na mesma faixa de 90 min', () => {
      const curta = { ...FAIXA, horaInicio: '14:00', horaFim: '15:30' };

      expect(() => validarOferta(curta, SALA, MODULAR, 40)).not.toThrow();
    });

    it('aceita janela maior que a prova', () => {
      expect(() => validarOferta(FAIXA, SALA, MODULAR, 40)).not.toThrow();
    });
  });

  describe('vagas x capacidade', () => {
    it('recusa mais vagas que lugares', () => {
      expect(() => validarOferta(FAIXA, SALA, EAD, 41)).toThrow(
        /40 lugares.*41 vagas/s,
      );
    });

    it('aceita vagas iguais a capacidade', () => {
      expect(() => validarOferta(FAIXA, SALA, EAD, 40)).not.toThrow();
    });

    it('aceita ofertar menos vagas que a capacidade', () => {
      expect(() => validarOferta(FAIXA, SALA, EAD, 25)).not.toThrow();
    });
  });
});

describe('seSobrepoem', () => {
  it('detecta cruzamento parcial', () => {
    // o caso real do periodo de testes: EaD de 3h cobrindo a de 1h30
    expect(
      seSobrepoem(
        { horaInicio: '09:00', horaFim: '12:00' },
        { horaInicio: '10:30', horaFim: '12:00' },
      ),
    ).toBe(true);
  });

  it('detecta uma janela contida na outra', () => {
    expect(
      seSobrepoem(
        { horaInicio: '09:00', horaFim: '12:00' },
        { horaInicio: '10:00', horaFim: '11:00' },
      ),
    ).toBe(true);
  });

  it('NAO considera sobreposicao quando uma comeca onde a outra acaba', () => {
    // intervalo semiaberto: a sala vaga no instante em que a prova acaba
    expect(
      seSobrepoem(
        { horaInicio: '08:30', horaFim: '10:00' },
        { horaInicio: '10:00', horaFim: '11:30' },
      ),
    ).toBe(false);
  });

  it('aceita janelas separadas', () => {
    expect(
      seSobrepoem(
        { horaInicio: '08:30', horaFim: '10:00' },
        { horaInicio: '10:30', horaFim: '12:00' },
      ),
    ).toBe(false);
  });
});

describe('exigirSalaLivreNoHorario', () => {
  const CONCORRENTE: OfertaConcorrente = {
    faixaId: 42,
    horaInicio: '09:00',
    horaFim: '12:00',
    faixaAtiva: true,
    salaId: 21,
    salaNome: 'Sala 1',
    confirmados: 0,
  };

  const NOVA = { horaInicio: '10:30', horaFim: '12:00' };

  it('aceita quando nao ha concorrente nenhum', () => {
    expect(() => exigirSalaLivreNoHorario(NOVA, [])).not.toThrow();
  });

  it('recusa a mesma sala num horario que se sobrepoe', () => {
    expect(() => exigirSalaLivreNoHorario(NOVA, [CONCORRENTE])).toThrow(
      ConflictException,
    );
  });

  it('a mensagem nomeia a sala, o horario e a faixa em conflito', () => {
    expect(() => exigirSalaLivreNoHorario(NOVA, [CONCORRENTE])).toThrow(
      /Sala 1.*09:00 as 12:00.*faixa 42/s,
    );
  });

  it('aceita a mesma sala em horario que nao se cruza', () => {
    const cedo = { horaInicio: '07:00', horaFim: '08:30' };

    expect(() => exigirSalaLivreNoHorario(cedo, [CONCORRENTE])).not.toThrow();
  });

  describe('faixa inativa', () => {
    const INATIVA = { ...CONCORRENTE, faixaAtiva: false };

    it('NAO ocupa a sala quando esta vazia', () => {
      // sem isso, uma faixa desativada com agendamento so CANCELADO prenderia
      // a sala para sempre: ela nao pode ser apagada (FaixaService.remover)
      expect(() => exigirSalaLivreNoHorario(NOVA, [INATIVA])).not.toThrow();
    });

    it('OCUPA a sala quando tem confirmado', () => {
      // desativar nao cancela prova nenhuma; aquelas pessoas vao estar la
      expect(() =>
        exigirSalaLivreNoHorario(NOVA, [{ ...INATIVA, confirmados: 1 }]),
      ).toThrow(ConflictException);
    });
  });

  it('avisa quando mais de uma sala choca', () => {
    const outra: OfertaConcorrente = {
      ...CONCORRENTE,
      faixaId: 43,
      salaId: 22,
      salaNome: 'Sala 2',
    };

    expect(() => exigirSalaLivreNoHorario(NOVA, [CONCORRENTE, outra])).toThrow(
      /Outra\(s\) 1 sala\(s\)/,
    );
  });

  it('nao conta duas vezes a mesma sala em duas faixas', () => {
    const mesmaSalaOutraFaixa: OfertaConcorrente = {
      ...CONCORRENTE,
      faixaId: 44,
      horaInicio: '11:00',
      horaFim: '12:30',
    };

    expect(() =>
      exigirSalaLivreNoHorario(NOVA, [CONCORRENTE, mesmaSalaOutraFaixa]),
    ).toThrow(/^(?!.*Outra\(s\)).*$/s);
  });
});

describe('janelaDaFaixa', () => {
  it('devolve a duracao em minutos', () => {
    expect(janelaDaFaixa('08:30', '11:30')).toBe(180);
  });

  it('recusa fim antes do inicio', () => {
    expect(() => janelaDaFaixa('11:30', '08:30')).toThrow(BadRequestException);
  });

  it('recusa inicio igual ao fim', () => {
    expect(() => janelaDaFaixa('08:30', '08:30')).toThrow(/precisa ser depois/);
  });

  it('recusa faixa que viraria a meia-noite', () => {
    expect(() => janelaDaFaixa('22:00', '02:00')).toThrow(/meia-noite/);
  });
});

describe('exigirEncontrado', () => {
  it('devolve o valor quando existe', () => {
    expect(exigirEncontrado({ id: 1 }, 'nao achou')).toEqual({ id: 1 });
  });

  it('lanca 404 para null', () => {
    expect(() => exigirEncontrado(null, 'Sala 99 nao encontrada')).toThrow(
      NotFoundException,
    );
  });
});
