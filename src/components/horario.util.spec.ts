import {
  duracaoEmMinutos,
  horaValida,
  paraHora,
  paraMinutos,
} from './horario.util';

describe('horario.util', () => {
  describe('horaValida', () => {
    it.each(['00:00', '08:30', '13:05', '23:59'])('aceita %s', (h) => {
      expect(horaValida(h)).toBe(true);
    });

    it.each([
      ['24:00', 'hora inexistente'],
      ['08:60', 'minuto inexistente'],
      ['8:30', 'sem zero a esquerda'],
      ['0830', 'sem separador'],
      ['08:30:00', 'com segundos'],
      ['', 'vazio'],
    ])('recusa %s (%s)', (h) => {
      expect(horaValida(h)).toBe(false);
    });
  });

  it('converte hora para minutos e de volta', () => {
    expect(paraMinutos('08:30')).toBe(510);
    expect(paraHora(510)).toBe('08:30');
    expect(paraHora(paraMinutos('23:59'))).toBe('23:59');
  });

  describe('duracaoEmMinutos', () => {
    it('mede a janela da faixa', () => {
      expect(duracaoEmMinutos('08:30', '11:30')).toBe(180); // cabe EaD
      expect(duracaoEmMinutos('14:00', '15:30')).toBe(90); // cabe Modular
      expect(duracaoEmMinutos('19:00', '21:00')).toBe(120); // cabe Presencial
    });

    it('devolve negativo quando o fim vem antes do inicio', () => {
      // quem chama trata: e o sinal de faixa invertida ou virando o dia
      expect(duracaoEmMinutos('22:00', '02:00')).toBeLessThan(0);
    });
  });
});
