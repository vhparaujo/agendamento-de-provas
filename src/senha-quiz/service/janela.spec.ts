import {
  ehDoDiaSeguinte,
  janelasParaDisparar,
  type JanelaCandidata,
} from './janela';

/**
 * As janelas semeadas, para os testes falarem do calendario REAL da instituicao
 * em vez de horarios inventados: e ele que precisa continuar funcionando.
 */
const EAD = 1;
const SEMI = 2;
const MODULAR = 3;
const PRESENCIAL = 4;

const janela = (
  id: number,
  modalidadeId: number,
  horaDisparo: string,
  ativo = true,
): JanelaCandidata => ({ id, modalidadeId, horaDisparo, ativo });

const CALENDARIO: JanelaCandidata[] = [
  janela(1, EAD, '22:01'),
  janela(2, EAD, '12:01'),
  janela(3, EAD, '18:01'),
  janela(11, SEMI, '21:31'),
  janela(12, SEMI, '10:01'),
  janela(13, SEMI, '12:01'),
  janela(14, SEMI, '15:31'),
  janela(15, SEMI, '17:31'),
  janela(16, SEMI, '19:31'),
  janela(21, MODULAR, '21:31'),
  janela(22, MODULAR, '10:01'),
  janela(23, MODULAR, '12:01'),
  janela(24, MODULAR, '15:31'),
  janela(25, MODULAR, '17:31'),
  janela(26, MODULAR, '19:31'),
  janela(31, PRESENCIAL, '22:01'),
  janela(32, PRESENCIAL, '10:31'),
  janela(33, PRESENCIAL, '13:01'),
  janela(34, PRESENCIAL, '17:01'),
  janela(35, PRESENCIAL, '19:31'),
];

const ids = (resultado: JanelaCandidata[]) => resultado.map((j) => j.id);

describe('janelasParaDisparar', () => {
  it('nao dispara nada fora de qualquer janela', () => {
    expect(janelasParaDisparar('09:00', CALENDARIO, 30)).toEqual([]);
  });

  it('dispara no minuto exato do horario configurado', () => {
    expect(ids(janelasParaDisparar('18:01', CALENDARIO, 30))).toEqual([3]);
  });

  it('AS 12:01 DISPARA TRES MODALIDADES, cada uma com a sua janela', () => {
    // O caso que motivou a funcao devolver lista. Um item so faria duas das tres
    // modalidades perderem a sessao inteira, sem erro nenhum no log.
    // O presencial NAO entra aqui: o calendario dele nao tem disparo as 12:01.
    expect(ids(janelasParaDisparar('12:01', CALENDARIO, 30))).toEqual([
      2, 13, 23,
    ]);
  });

  it('as 21:31 dispara Semi e Modular, e ainda NAO o EaD das 22:01', () => {
    expect(ids(janelasParaDisparar('21:31', CALENDARIO, 30))).toEqual([11, 21]);
  });

  it('as 22:01 dispara EaD e Presencial: a de Semi/Modular ja fechou', () => {
    // [21:31, 22:01) e semiaberta — as 22:01 ela nao pega mais.
    expect(ids(janelasParaDisparar('22:01', CALENDARIO, 30))).toEqual([1, 31]);
  });

  /**
   * O presencial (5 sessoes de 2h) partilha dois minutos de disparo com as
   * outras modalidades — 22:01 com o EaD e 19:31 com Semi/Modular. Nao ha
   * conflito: cada modalidade tem o seu calendario, e o cron aplica uma janela
   * por tick, dentro da tolerancia.
   */
  it('as 19:31 dispara Semi, Modular E Presencial', () => {
    expect(ids(janelasParaDisparar('19:31', CALENDARIO, 30))).toEqual([
      16, 26, 35,
    ]);
  });

  it('as 13:01 dispara so o Presencial', () => {
    expect(ids(janelasParaDisparar('13:01', CALENDARIO, 30))).toEqual([33]);
  });

  it('as 17:01 dispara so o Presencial, e as 17:31 so Semi e Modular', () => {
    // Trinta minutos separam os dois, exatamente o tamanho da tolerancia — e a
    // janela e SEMIABERTA, entao elas nao se pisam.
    expect(ids(janelasParaDisparar('17:01', CALENDARIO, 30))).toEqual([34]);
    expect(ids(janelasParaDisparar('17:31', CALENDARIO, 30))).toEqual([15, 25]);
  });

  describe('tolerancia', () => {
    it('um restart 11 min depois ainda aplica a sessao', () => {
      expect(ids(janelasParaDisparar('15:42', CALENDARIO, 30))).toEqual([
        14, 24,
      ]);
    });

    it('a janela e SEMIABERTA: no minuto do fim ja nao dispara', () => {
      expect(janelasParaDisparar('16:01', CALENDARIO, 30)).toEqual([]);
    });

    it('tolerancia 0 ainda dispara no minuto exato', () => {
      // Piso de 1 minuto: "sem tolerancia" nao pode significar "cron desligado".
      expect(ids(janelasParaDisparar('17:31', CALENDARIO, 0))).toEqual([
        15, 25,
      ]);
      expect(janelasParaDisparar('17:32', CALENDARIO, 0)).toEqual([]);
    });

    it('tolerancia negativa ou nao numerica e tratada como 0', () => {
      expect(ids(janelasParaDisparar('17:31', CALENDARIO, -5))).toEqual([
        15, 25,
      ]);
      expect(ids(janelasParaDisparar('17:31', CALENDARIO, NaN))).toEqual([
        15, 25,
      ]);
    });

    it('a tolerancia padrao NAO faz duas janelas da mesma modalidade se cruzarem', () => {
      // O menor intervalo dentro de uma modalidade, no calendario real, e de 120
      // min (10:01 -> 12:01 no Semi/Modular; 150 min no Presencial), contra 30
      // de tolerancia. Se alguem apertar os horarios na tela, o desempate abaixo
      // entra em acao — mas hoje ele nunca precisa.
      //
      // O laco varre TODOS os disparos das quatro modalidades: e a rede que pega
      // o dia em que um calendario novo for semeado perto demais de outro da
      // mesma modalidade.
      for (const hhmm of [...new Set(CALENDARIO.map((j) => j.horaDisparo))]) {
        const resultado = janelasParaDisparar(hhmm, CALENDARIO, 30);
        const porModalidade = new Set(resultado.map((j) => j.modalidadeId));
        expect(resultado.length).toBe(porModalidade.size);
      }
    });
  });

  describe('empate dentro da mesma modalidade', () => {
    it('vence a que comecou MAIS TARDE — e a sessao corrente', () => {
      // Aplicar a anterior por cima reabriria a prova que acabou de fechar.
      const apertadas = [janela(1, EAD, '10:00'), janela(2, EAD, '10:20')];
      expect(ids(janelasParaDisparar('10:25', apertadas, 60))).toEqual([2]);
    });

    it('modalidades diferentes no mesmo minuto NAO competem', () => {
      const duas = [janela(1, EAD, '10:00'), janela(2, SEMI, '10:00')];
      expect(ids(janelasParaDisparar('10:00', duas, 30))).toEqual([1, 2]);
    });
  });

  describe('entradas que nao devem derrubar o tick', () => {
    it('janela inativa nao dispara', () => {
      const desligada = [janela(1, EAD, '12:01', false)];
      expect(janelasParaDisparar('12:01', desligada, 30)).toEqual([]);
    });

    it('hora mal digitada e ignorada sem afetar as outras', () => {
      const misto = [
        janela(1, EAD, '25:99'),
        janela(2, EAD, ''),
        janela(3, SEMI, '12:01'),
      ];
      expect(ids(janelasParaDisparar('12:01', misto, 30))).toEqual([3]);
    });

    it('hora atual invalida devolve lista vazia, nao excecao', () => {
      expect(janelasParaDisparar('sei la', CALENDARIO, 30)).toEqual([]);
    });

    it('calendario vazio devolve lista vazia', () => {
      expect(janelasParaDisparar('12:01', [], 30)).toEqual([]);
    });
  });

  it('a ordem do resultado e estavel entre chamadas', () => {
    const embaralhado = [...CALENDARIO].reverse();
    expect(ids(janelasParaDisparar('12:01', embaralhado, 30))).toEqual([
      2, 13, 23,
    ]);
  });

  /**
   * O pior minuto do calendario real: quantas janelas o cron pode encontrar de
   * uma vez. Importa porque ele aplica UMA por tick — com N candidatas, a
   * ultima so entra N minutos depois, e isso precisa caber na tolerancia.
   */
  it('nenhum minuto acumula mais candidatas do que a tolerancia comporta', () => {
    const disparos = [...new Set(CALENDARIO.map((j) => j.horaDisparo))];

    const pior = Math.max(
      ...disparos.map((h) => janelasParaDisparar(h, CALENDARIO, 30).length),
    );

    expect(pior).toBe(3);
    expect(pior).toBeLessThan(30);
  });
});

/**
 * `diaSeguinte` deixou de ser escolha do admin em 25/08/2026. Nao e
 * configuracao: se o disparo acontece depois da hora de abertura, ele NAO PODE
 * ser para hoje — nao ha como abrir uma prova as 08:30 quando ja sao 22:01.
 */
describe('ehDoDiaSeguinte', () => {
  it('disparo DEPOIS da abertura so pode ser para amanha', () => {
    // O ultimo disparo de cada calendario semeado.
    expect(ehDoDiaSeguinte('22:01', '09:00')).toBe(true); // EaD
    expect(ehDoDiaSeguinte('21:31', '08:30')).toBe(true); // Semi/Modular
    expect(ehDoDiaSeguinte('22:01', '08:30')).toBe(true); // Presencial
  });

  it('disparo ANTES da abertura e do mesmo dia', () => {
    expect(ehDoDiaSeguinte('12:01', '15:00')).toBe(false); // EaD
    expect(ehDoDiaSeguinte('10:01', '10:30')).toBe(false); // Semi/Modular
    expect(ehDoDiaSeguinte('19:31', '20:00')).toBe(false); // Presencial
  });

  /**
   * A rede que importa: nos tres calendarios reais, EXATAMENTE UMA janela por
   * modalidade cai no dia seguinte. Zero deixaria a prova da manha sem ser
   * armada; duas fariam uma sessao do dia sumir.
   */
  it.each([
    [
      'EaD',
      [
        ['22:01', '09:00'],
        ['12:01', '15:00'],
        ['18:01', '19:00'],
      ],
    ],
    [
      'Semi/Modular',
      [
        ['21:31', '08:30'],
        ['10:01', '10:30'],
        ['12:01', '14:00'],
        ['15:31', '16:00'],
        ['17:31', '18:00'],
        ['19:31', '20:00'],
      ],
    ],
    [
      'Presencial',
      [
        ['22:01', '08:30'],
        ['10:31', '11:00'],
        ['13:01', '15:00'],
        ['17:01', '17:30'],
        ['19:31', '20:00'],
      ],
    ],
  ])('%s tem exatamente UMA janela do dia seguinte', (_nome, calendario) => {
    const doDiaSeguinte = calendario.filter(([d, i]) => ehDoDiaSeguinte(d, i));

    expect(doDiaSeguinte).toHaveLength(1);
    // E ela e a que abre a PRIMEIRA sessao do dia — a mais cedo do calendario.
    const maisCedo = calendario.map(([, inicio]) => inicio).sort()[0];
    expect(doDiaSeguinte[0][1]).toBe(maisCedo);
  });

  it('empate conta como MESMO DIA', () => {
    // Aplicar no minuto exato da abertura e apertado, mas possivel; jogar para
    // amanha deixaria a prova de hoje fechada.
    expect(ehDoDiaSeguinte('15:00', '15:00')).toBe(false);
  });

  it('hora mal formada nao decide nada, e nao lanca', () => {
    expect(ehDoDiaSeguinte('25:99', '09:00')).toBe(false);
    expect(ehDoDiaSeguinte('22:01', '')).toBe(false);
  });
});
