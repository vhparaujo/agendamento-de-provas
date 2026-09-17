import {
  escolherOferta,
  ocuparVagaSimulada,
  ordenarPorProximidade,
  totalDisponivel,
  type VagaSimulada,
} from './alocacao';

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

  it('devolve null quando a faixa nao oferta nada para o formato', () => {
    expect(escolherOferta([])).toBeNull();
  });

  it('nao aloca em sala com mais agendamentos que vagas', () => {
    // Estado so alcancavel se alguem reduzir vagas por fora; nao piora o caso.
    expect(escolherOferta([oferta(1, 1, 10, 12)])).toBeNull();
  });
});

describe('ordenarPorProximidade', () => {
  const faixa = (id: number, data: string, horaInicio = '08:30') => ({
    id,
    data: new Date(`${data}T00:00:00Z`),
    horaInicio,
  });

  it('poe a data mais proxima primeiro', () => {
    const ordenadas = ordenarPorProximidade([
      faixa(3, '2026-09-10'),
      faixa(1, '2026-08-20'),
      faixa(2, '2026-08-25'),
    ]);

    expect(ordenadas.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('desempata o mesmo dia pelo horario mais cedo', () => {
    const ordenadas = ordenarPorProximidade([
      faixa(1, '2026-08-20', '14:00'),
      faixa(2, '2026-08-20', '08:30'),
      faixa(3, '2026-08-20', '19:00'),
    ]);

    expect(ordenadas.map((f) => f.id)).toEqual([2, 1, 3]);
  });

  it('compara horario por minutos, nao por texto', () => {
    // "9:00" < "10:00" numericamente, mas ">" como string. O PADRAO_HORA exige
    // zero a esquerda; comparar por minutos nao depende disso continuar valendo.
    const ordenadas = ordenarPorProximidade([
      faixa(1, '2026-08-20', '10:00'),
      faixa(2, '2026-08-20', '09:00'),
    ]);

    expect(ordenadas.map((f) => f.id)).toEqual([2, 1]);
  });

  /**
   * O lote roda duas vezes: uma simulando, uma gravando. Sem desempate estavel,
   * o admin aprovaria um resultado e receberia outro.
   */
  it('desempata pelo id — a ordem nao muda entre simulacao e execucao', () => {
    const mesmoHorario = [
      faixa(9, '2026-08-20', '08:30'),
      faixa(4, '2026-08-20', '08:30'),
      faixa(7, '2026-08-20', '08:30'),
    ];

    expect(ordenarPorProximidade(mesmoHorario).map((f) => f.id)).toEqual([
      4, 7, 9,
    ]);

    expect(
      ordenarPorProximidade([...mesmoHorario].reverse()).map((f) => f.id),
    ).toEqual([4, 7, 9]);
  });

  it('nao modifica a lista recebida', () => {
    const original = [faixa(2, '2026-09-10'), faixa(1, '2026-08-20')];

    ordenarPorProximidade(original);

    expect(original.map((f) => f.id)).toEqual([2, 1]);
  });

  it('aceita lista vazia', () => {
    expect(ordenarPorProximidade([])).toEqual([]);
  });
});

/**
 * A contagem da SIMULACAO do compulsorio.
 *
 * Estes testes existem por um bug real: a primeira versao trabalhava sobre uma
 * copia do estado, entao a vaga tomada por um aluno nunca era descontada e
 * todos "cabiam" na primeira sala. A simulacao responderia "cabe todo mundo"
 * exatamente no caso em que nao cabe.
 */
describe('ocuparVagaSimulada', () => {
  const EAD = 1;
  const PRESENCIAL = 2;

  /**
   * Uma PESSOA DIFERENTE a cada chamada — o caso normal, e o que os testes de
   * enchimento simulam. Quem quiser repetir o mesmo RA passa o mesmo conjunto,
   * que e o que carrega "esta pessoa ja tem prova nesta faixa" de uma chamada
   * para a outra (ver o bloco "uma prova por pessoa em cada faixa").
   */
  const ocupar = (
    faixas: Parameters<typeof ocuparVagaSimulada>[0],
    modalidadeId: number,
    ocupacao: Map<number, VagaSimulada>,
    pessoa: Set<number> = new Set(),
  ) => ocuparVagaSimulada(faixas, modalidadeId, ocupacao, pessoa);

  /** Faixas ja ordenadas, como `ordenarPorProximidade` as devolve. */
  const cenario = () => {
    const ocupacao = new Map([
      [10, { vagas: 2, ocupadas: 0, ordem: 1 }],
      [11, { vagas: 1, ocupadas: 0, ordem: 2 }],
      [20, { vagas: 1, ocupadas: 0, ordem: 1 }],
    ]);

    const faixas = [
      // dia mais proximo: duas salas EaD
      {
        id: 1,
        ofertas: [
          { id: 10, modalidadeId: EAD },
          { id: 11, modalidadeId: EAD },
        ],
      },
      // dia seguinte: uma sala EaD
      { id: 2, ofertas: [{ id: 20, modalidadeId: EAD }] },
    ];

    return { ocupacao, faixas };
  };

  it('enche a sala de menor ordem antes de abrir a proxima', () => {
    const { ocupacao, faixas } = cenario();

    expect(ocupar(faixas, EAD, ocupacao)).toBe(true);
    expect(ocupar(faixas, EAD, ocupacao)).toBe(true);

    expect(ocupacao.get(10)?.ocupadas).toBe(2);
    expect(ocupacao.get(11)?.ocupadas).toBe(0);
  });

  it('CONSOME a vaga: dois alunos nao ficam na mesma cadeira', () => {
    // O bug que este teste trava. Sem o desconto, `ocupadas` ficaria em 1 e a
    // sala de 2 lugares aceitaria os quatro alunos.
    const { ocupacao, faixas } = cenario();

    for (let i = 0; i < 4; i++) ocupar(faixas, EAD, ocupacao);

    expect(ocupacao.get(10)?.ocupadas).toBe(2);
    expect(ocupacao.get(11)?.ocupadas).toBe(1);
    expect(ocupacao.get(20)?.ocupadas).toBe(1);
  });

  it('so passa para o DIA seguinte quando o primeiro lota inteiro', () => {
    const { ocupacao, faixas } = cenario();

    // 3 vagas no primeiro dia (2 + 1); a quarta cai no dia seguinte.
    for (let i = 0; i < 3; i++) ocupar(faixas, EAD, ocupacao);

    expect(ocupacao.get(20)?.ocupadas).toBe(0);

    ocupar(faixas, EAD, ocupacao);

    expect(ocupacao.get(20)?.ocupadas).toBe(1);
  });

  it('devolve false quando tudo lotou — e o SEM_VAGA do relatorio', () => {
    const { ocupacao, faixas } = cenario();

    for (let i = 0; i < 4; i++) ocupar(faixas, EAD, ocupacao);

    expect(ocupar(faixas, EAD, ocupacao)).toBe(false);
  });

  it('nao poe o aluno numa sala de OUTRO formato', () => {
    // A prova tem outra duracao. Uma sala Presencial vazia nao serve para EaD.
    const ocupacao = new Map([[30, { vagas: 50, ocupadas: 0, ordem: 1 }]]);
    const faixas = [{ id: 1, ofertas: [{ id: 30, modalidadeId: PRESENCIAL }] }];

    expect(ocupar(faixas, EAD, ocupacao)).toBe(false);
    expect(ocupacao.get(30)?.ocupadas).toBe(0);
  });

  it('parte da ocupacao REAL: nao reoferece vaga de quem ja agendou', () => {
    const ocupacao = new Map([[10, { vagas: 2, ocupadas: 2, ordem: 1 }]]);
    const faixas = [{ id: 1, ofertas: [{ id: 10, modalidadeId: EAD }] }];

    expect(ocupar(faixas, EAD, ocupacao)).toBe(false);
  });

  it('ignora oferta que sumiu do mapa em vez de quebrar', () => {
    // Estado alcancavel se a oferta for apagada entre as duas consultas.
    const ocupacao = new Map([[11, { vagas: 1, ocupadas: 0, ordem: 2 }]]);
    const faixas = [
      {
        id: 1,
        ofertas: [
          { id: 99, modalidadeId: EAD },
          { id: 11, modalidadeId: EAD },
        ],
      },
    ];

    expect(ocupar(faixas, EAD, ocupacao)).toBe(true);
    expect(ocupacao.get(11)?.ocupadas).toBe(1);
  });

  it('aceita polo sem faixa nenhuma', () => {
    expect(ocupar([], EAD, new Map())).toBe(false);
  });

  /**
   * ==========================================================================
   * UMA PROVA POR PESSOA EM CADA FAIXA — a regra do RA com dois cursos
   * ==========================================================================
   * A execucao real pega o `ConflictException` de `exigirUmaProvaPorFaixa` e
   * tenta a proxima data. A simulacao precisa fazer EXATAMENTE o mesmo, senao
   * ela prometeria um resultado que o lote nao entrega — e prever o lote e a
   * unica coisa que ela existe para fazer.
   */
  describe('uma prova por pessoa em cada faixa', () => {
    it('poe o segundo vinculo do mesmo RA no DIA SEGUINTE, com vaga sobrando hoje', () => {
      const { ocupacao, faixas } = cenario();

      // O mesmo conjunto nas duas chamadas: e a MESMA pessoa, dois cursos.
      const pessoa = new Set<number>();

      expect(ocupar(faixas, EAD, ocupacao, pessoa)).toBe(true);
      expect(ocupar(faixas, EAD, ocupacao, pessoa)).toBe(true);

      // A faixa 1 ainda tinha 2 lugares livres, e mesmo assim a segunda prova
      // foi para a faixa 2. Sem a regra, as duas cairiam na sala 10.
      expect(ocupacao.get(10)?.ocupadas).toBe(1);
      expect(ocupacao.get(11)?.ocupadas).toBe(0);
      expect(ocupacao.get(20)?.ocupadas).toBe(1);

      expect([...pessoa]).toEqual([1, 2]);
    });

    it('respeita a prova que a pessoa JA tem no banco', () => {
      const { ocupacao, faixas } = cenario();

      // Ela ja agendou a faixa 1 pelo portal, antes do lote.
      expect(ocupar(faixas, EAD, ocupacao, new Set([1]))).toBe(true);

      expect(ocupacao.get(10)?.ocupadas).toBe(0);
      expect(ocupacao.get(20)?.ocupadas).toBe(1);
    });

    it('devolve false quando so sobram faixas em que a pessoa ja tem prova', () => {
      const { ocupacao, faixas } = cenario();

      // Sobra vaga em todas, mas as duas faixas ja sao dela: nao ha terceira
      // data, e o lote reporta SEM_VAGA. E a informacao certa — falta DATA.
      expect(ocupar(faixas, EAD, ocupacao, new Set([1, 2]))).toBe(false);

      expect(ocupacao.get(10)?.ocupadas).toBe(0);
      expect(ocupacao.get(20)?.ocupadas).toBe(0);
    });

    it('nao atrapalha duas PESSOAS diferentes na mesma faixa', () => {
      const { ocupacao, faixas } = cenario();

      expect(ocupar(faixas, EAD, ocupacao, new Set())).toBe(true);
      expect(ocupar(faixas, EAD, ocupacao, new Set())).toBe(true);

      // Duas pessoas, mesma sala. A regra e sobre o RA, nao sobre a sala.
      expect(ocupacao.get(10)?.ocupadas).toBe(2);
    });
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
