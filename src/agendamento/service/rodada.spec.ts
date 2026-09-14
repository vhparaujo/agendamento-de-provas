import { descricaoDaRodada } from './rodada';

describe('descricaoDaRodada', () => {
  it('escreve por extenso as rodadas conhecidas', () => {
    expect(descricaoDaRodada('N2')).toBe('Regular (N2)');
    expect(descricaoDaRodada('SUB')).toBe('Substitutiva (SUB)');
  });

  /** A rodada e texto livre no cadastro: a secretaria pode ter digitado "sub". */
  it('ignora caixa e espaco', () => {
    expect(descricaoDaRodada(' sub ')).toBe('Substitutiva (SUB)');
  });

  it('rodada desconhecida sai como veio, em vez de sumir', () => {
    expect(descricaoDaRodada('N1')).toBe('N1');
  });
});
