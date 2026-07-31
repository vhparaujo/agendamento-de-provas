import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  exigirEncontrado,
  janelaDaFaixa,
  validarOferta,
} from './sala-faixa.validacao';

const SALA = {
  id: 21,
  nome: 'M114',
  poloId: 6,
  capacidade: 40,
  ativo: true,
};

const EAD = { id: 1, nome: 'EaD', duracaoMinutos: 180 };
const MODULAR = { id: 3, nome: 'Modular / Híbrido', duracaoMinutos: 90 };

// Faixa de 3h no polo 6 — comporta qualquer modalidade
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
