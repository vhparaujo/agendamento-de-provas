import {
  calcularSaidas,
  LIMITE_SAIDAS_PERCENTUAL,
  VinculoDoFormato,
} from './saidas-da-planilha';

const vinculo = (
  id: number,
  matricula = `UC${id}`,
  foraDaPlanilhaEm: Date | null = null,
): VinculoDoFormato => ({ id, matricula, foraDaPlanilhaEm });

describe('calcularSaidas', () => {
  it('marca quem esta no banco e nao foi gravado por este arquivo', () => {
    const r = calcularSaidas(
      [vinculo(1), vinculo(2), vinculo(3)],
      new Set([1, 3]),
      new Set(),
    );

    expect(r.ids).toEqual([2]);
    expect(r.base).toBe(3);
  });

  it('nao marca de novo quem ja estava fora — a data da saida original fica', () => {
    const r = calcularSaidas(
      [vinculo(1), vinculo(2, 'UC2', new Date('2026-08-01'))],
      new Set([1]),
      new Set(),
    );

    expect(r.ids).toEqual([]);
    expect(r.base).toBe(1);
  });

  it('quem estava fora e voltou neste arquivo conta na base, e nao sai', () => {
    const r = calcularSaidas(
      [vinculo(1, 'UC1', new Date('2026-08-01')), vinculo(2)],
      new Set([1, 2]),
      new Set(),
    );

    expect(r.ids).toEqual([]);
    expect(r.base).toBe(2);
  });

  it('linha rejeitada protege TODOS os vinculos do RA: e cadastro errado, nao saida', () => {
    const r = calcularSaidas(
      [vinculo(1, 'UC9'), vinculo(2, 'uc9'), vinculo(3, 'UC3')],
      new Set(),
      new Set(['UC9']),
    );

    expect(r.ids).toEqual([3]);
  });

  describe('o limite', () => {
    const base = (n: number) =>
      Array.from({ length: n }, (_, i) => vinculo(i + 1));

    it(`exatamente ${LIMITE_SAIDAS_PERCENTUAL}% ainda passa`, () => {
      const vinculos = base(100);
      const gravados = new Set(vinculos.slice(10).map((v) => v.id));

      const r = calcularSaidas(vinculos, gravados, new Set());

      expect(r.percentual).toBe(10);
      expect(r.acimaDoLimite).toBe(false);
    });

    it('acima dele pede a segunda confirmacao', () => {
      const vinculos = base(100);
      const gravados = new Set(vinculos.slice(11).map((v) => v.id));

      expect(calcularSaidas(vinculos, gravados, new Set()).acimaDoLimite).toBe(
        true,
      );
    });

    it('o CSV de UM aluno com a caixa marcada estoura o limite', () => {
      const r = calcularSaidas(base(2000), new Set([1]), new Set());

      expect(r.ids).toHaveLength(1999);
      expect(r.acimaDoLimite).toBe(true);
    });

    it('formato vazio no banco nao divide por zero', () => {
      expect(calcularSaidas([], new Set(), new Set())).toEqual({
        ids: [],
        base: 0,
        percentual: 0,
        acimaDoLimite: false,
      });
    });
  });
});
