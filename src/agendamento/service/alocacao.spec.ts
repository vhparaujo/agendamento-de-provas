import { escolherOferta, totalDisponivel } from './alocacao';

const oferta = (
  id: number,
  ordem: number,
  vagas: number,
  ocupadas: number,
) => ({
  id,
  ordem,
  vagas,
  ocupadas,
});

describe('escolherOferta', () => {
  it('devolve a sala de menor ordem quando todas estao vazias', () => {
    const escolhida = escolherOferta([
      oferta(2, 2, 10, 0),
      oferta(1, 1, 40, 0),
      oferta(3, 3, 30, 0),
    ]);

    expect(escolhida?.id).toBe(1);
  });

  it('so passa para a proxima quando a primeira LOTA', () => {
    // 39 de 40 ainda e a primeira: alocacao sequencial nao espalha alunos
    expect(
      escolherOferta([oferta(1, 1, 40, 39), oferta(2, 2, 10, 0)])?.id,
    ).toBe(1);

    expect(
      escolherOferta([oferta(1, 1, 40, 40), oferta(2, 2, 10, 0)])?.id,
    ).toBe(2);
  });

  it('pula salas lotadas no meio da fila', () => {
    const escolhida = escolherOferta([
      oferta(1, 1, 10, 10),
      oferta(2, 2, 10, 10),
      oferta(3, 3, 10, 4),
    ]);

    expect(escolhida?.id).toBe(3);
  });

  it('ignora a ordem em que as ofertas chegam na lista', () => {
    const escolhida = escolherOferta([
      oferta(9, 3, 10, 0),
      oferta(7, 1, 10, 10),
      oferta(8, 2, 10, 0),
    ]);

    expect(escolhida?.id).toBe(8);
  });

  it('devolve null quando tudo esta lotado — e o 409 de vaga esgotada', () => {
    expect(
      escolherOferta([oferta(1, 1, 10, 10), oferta(2, 2, 5, 5)]),
    ).toBeNull();
  });

  it('devolve null quando a faixa nao oferta nada para a modalidade', () => {
    expect(escolherOferta([])).toBeNull();
  });

  it('nao aloca em sala com mais agendamentos que vagas', () => {
    // Estado so alcancavel se alguem reduzir vagas por fora; nao piora o caso.
    expect(escolherOferta([oferta(1, 1, 10, 12)])).toBeNull();
  });
});

describe('totalDisponivel', () => {
  it('soma as vagas livres de todas as salas', () => {
    expect(totalDisponivel([oferta(1, 1, 40, 40), oferta(2, 2, 10, 3)])).toBe(
      7,
    );
  });

  it('nao deixa uma sala em overbooking descontar das outras', () => {
    expect(totalDisponivel([oferta(1, 1, 10, 12), oferta(2, 2, 10, 0)])).toBe(
      10,
    );
  });

  it('e zero sem oferta nenhuma', () => {
    expect(totalDisponivel([])).toBe(0);
  });
});
