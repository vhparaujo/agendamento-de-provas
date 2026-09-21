import {
  DIGITOS_DA_SENHA,
  gerarSenha,
  MAXIMO_DE_REPETICOES,
  repeticaoMaxima,
  senhaAceitavel,
  sortearSenhasDoDia,
} from './senha-aleatoria';

/**
 * O sorteio e aleatorio, entao os testes rodam MUITAS amostras em vez de fixar
 * uma semente. Duas razoes: `crypto.randomInt` nao tem semente para fixar, e a
 * propriedade que importa aqui ("nenhuma saida viola a regra") so se verifica
 * em volume. Com 5 mil amostras, um caminho que produzisse senha invalida uma
 * vez a cada mil passaria despercebido em menos de uma execucao a cada 10^2.
 */
const AMOSTRAS = 5000;

describe('repeticaoMaxima', () => {
  it('conta o digito mais repetido', () => {
    expect(repeticaoMaxima('123456')).toBe(1);
    expect(repeticaoMaxima('112345')).toBe(2);
    expect(repeticaoMaxima('111234')).toBe(3);
    expect(repeticaoMaxima('111123')).toBe(4);
    expect(repeticaoMaxima('777777')).toBe(6);
  });

  it('nao quebra com texto vazio', () => {
    expect(repeticaoMaxima('')).toBe(0);
  });
});

describe('senhaAceitavel', () => {
  it('aceita seis digitos com no maximo tres repeticoes', () => {
    expect(senhaAceitavel('897325')).toBe(true);
    expect(senhaAceitavel('717273')).toBe(true);
    expect(senhaAceitavel('777123')).toBe(true);
  });

  it('recusa o quarto digito repetido — a regra que o cliente pediu', () => {
    expect(senhaAceitavel('777712')).toBe(false);
    expect(senhaAceitavel('111111')).toBe(false);
  });

  it('recusa tamanho diferente de seis', () => {
    expect(senhaAceitavel('12345')).toBe(false);
    expect(senhaAceitavel('1234567')).toBe(false);
  });

  /**
   * O D2L aceita letras no campo `Password`, mas a folha impressa e lida em voz
   * alta para a sala: "b" e "v", "m" e "n". O cliente pediu numeros.
   */
  it('recusa o que nao e digito', () => {
    expect(senhaAceitavel('12a456')).toBe(false);
    expect(senhaAceitavel('12 456')).toBe(false);
    expect(senhaAceitavel('12-456')).toBe(false);
  });
});

describe('gerarSenha', () => {
  it('sempre devolve senha dentro da regra', () => {
    for (let i = 0; i < AMOSTRAS; i += 1) {
      const senha = gerarSenha();

      expect(senha).toHaveLength(DIGITOS_DA_SENHA);
      expect(senha).toMatch(/^\d{6}$/);
      expect(repeticaoMaxima(senha)).toBeLessThanOrEqual(MAXIMO_DE_REPETICOES);
    }
  });

  it('nunca devolve uma senha da lista a evitar', () => {
    // A lista cobre 999 dos 1000 sufixos possiveis depois de "897": o sorteio
    // e obrigado a sair dali, em vez de tentar duas vezes e desistir.
    const evitar = new Set<string>();
    for (let n = 0; n < 1000; n += 1) {
      evitar.add(`897${String(n).padStart(3, '0')}`);
    }

    for (let i = 0; i < 200; i += 1) {
      expect(evitar.has(gerarSenha(evitar))).toBe(false);
    }
  });

  /**
   * Sem variedade o resto nao significa nada: uma implementacao que devolvesse
   * sempre "123456" passaria em todos os testes acima.
   */
  it('nao devolve sempre a mesma coisa', () => {
    const vistas = new Set<string>();
    for (let i = 0; i < 500; i += 1) vistas.add(gerarSenha());

    expect(vistas.size).toBeGreaterThan(400);
  });

  it('usa os dez digitos, e nao so um pedaco deles', () => {
    const digitos = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      for (const d of gerarSenha()) digitos.add(d);
    }

    expect(digitos.size).toBe(10);
  });
});

describe('sortearSenhasDoDia', () => {
  /**
   * A razao de esta funcao existir. Chamar `gerarSenha` num laco, com o mesmo
   * conjunto a evitar, repetiria uma senha dentro do dia de vez em quando —
   * raro o bastante para nunca aparecer num teste manual e exatamente o defeito
   * que so apareceria com a sala cheia.
   */
  it('nao repete dentro do lote', () => {
    for (let i = 0; i < 200; i += 1) {
      const senhas = sortearSenhasDoDia(20);

      expect(new Set(senhas).size).toBe(20);
      for (const senha of senhas) expect(senhaAceitavel(senha)).toBe(true);
    }
  });

  it('nao repete as que o dia ja tinha', () => {
    const jaNoDia = ['897325', '104507'];

    for (let i = 0; i < 500; i += 1) {
      const senhas = sortearSenhasDoDia(6, jaNoDia);

      for (const senha of senhas) expect(jaNoDia).not.toContain(senha);
    }
  });

  it('pedir zero senhas devolve lista vazia', () => {
    expect(sortearSenhasDoDia(0)).toEqual([]);
  });
});
