import { BadRequestException } from '@nestjs/common';
import { descreverSenha, TAMANHO_MAXIMO_SENHA, validarSenha } from './senha';

describe('validarSenha', () => {
  it('aceita uma senha normal da grade', () => {
    expect(validarSenha('897325')).toBe('897325');
  });

  it('recusa vazio e so-espacos: a API do D2L nao aceita esse valor', () => {
    for (const ruim of ['', '   ', '\t']) {
      expect(() => validarSenha(ruim)).toThrow(BadRequestException);
    }
  });

  /**
   * A regra mais valiosa do arquivo. A API ACEITA o espaco, entao nada falharia:
   * a prova entraria no ar com uma senha que ninguem consegue digitar a partir
   * da folha impressa.
   */
  it('recusa espaco nas pontas', () => {
    expect(() => validarSenha(' 897325')).toThrow(BadRequestException);
    expect(() => validarSenha('897325 ')).toThrow(BadRequestException);
  });

  it('recusa caractere invisivel (colar da planilha)', () => {
    expect(() => validarSenha('897\n325')).toThrow(BadRequestException);
    expect(() => validarSenha('897​325')).toThrow(BadRequestException);
  });

  it('recusa alem do tamanho da coluna', () => {
    expect(() => validarSenha('a'.repeat(TAMANHO_MAXIMO_SENHA + 1))).toThrow(
      BadRequestException,
    );
    expect(validarSenha('a'.repeat(TAMANHO_MAXIMO_SENHA))).toHaveLength(
      TAMANHO_MAXIMO_SENHA,
    );
  });

  it('recusa o que nao e texto', () => {
    for (const ruim of [null, undefined, 897325, {}]) {
      expect(() => validarSenha(ruim)).toThrow(BadRequestException);
    }
  });
});

describe('descreverSenha', () => {
  /**
   * O contrato inteiro deste helper: ele existe para que a senha NUNCA apareca
   * em log. Se algum dia ele devolver o valor, este teste e o que avisa.
   */
  it('nunca devolve o valor', () => {
    expect(descreverSenha('897325')).toBe('(6 caracteres)');
    expect(descreverSenha('897325')).not.toContain('897325');
  });

  it('distingue ausencia de senha', () => {
    expect(descreverSenha(null)).toBe('(sem senha)');
    expect(descreverSenha(undefined)).toBe('(sem senha)');
    expect(descreverSenha('')).toBe('(sem senha)');
  });
});
