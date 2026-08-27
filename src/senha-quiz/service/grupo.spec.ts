import { mesmoNomeDeGrupo, normalizarNomeDeGrupo, rotularGrupo } from './grupo';

describe('normalizarNomeDeGrupo', () => {
  /**
   * O falso negativo aqui NAO e um erro visivel: e uma turma inteira ficando com
   * a condicao de liberacao da sessao anterior, descoberta no dia da prova. Por
   * isso acento, caixa e espaco sao perdoados.
   */
  it.each([
    ['Manha', 'manha'],
    ['MANHÃ', 'manha'],
    ['Manhã', 'manha'],
    ['  Prova 2  ', 'prova 2'],
    ['Prova    2', 'prova 2'],
    ['Separação de Provas', 'separacao de provas'],
  ])('normaliza %j -> %j', (entrada, esperado) => {
    expect(normalizarNomeDeGrupo(entrada)).toBe(esperado);
  });

  it('trata nulo e indefinido como string vazia', () => {
    expect(normalizarNomeDeGrupo(null)).toBe('');
    expect(normalizarNomeDeGrupo(undefined)).toBe('');
  });

  /**
   * ⚠️ Hifen e pontuacao NAO sao normalizados, e isso e deliberado: sao nomes de
   * grupo distintos numa instancia que use os dois. O que se perdoa e digitacao,
   * nunca conteudo — apagar a diferenca faria a resolucao casar o grupo errado
   * em vez de recusar, e um grupo errado libera a prova para o turno errado.
   */
  it('NAO apaga hifen nem barra — sao conteudo, nao digitacao', () => {
    expect(mesmoNomeDeGrupo('Manha 16/09', 'Manha - 16/09')).toBe(false);
    expect(mesmoNomeDeGrupo('Prova 2', 'Prova-2')).toBe(false);
  });

  it('casa nomes que so diferem em acento, caixa e espaco', () => {
    expect(mesmoNomeDeGrupo('Manhã  -  16/09', 'MANHA - 16/09')).toBe(true);
  });

  /**
   * A classe de diacriticos e escrita com `\\u` porque os caracteres literais
   * sao invisiveis: um copiar-e-colar que a esvaziasse deixaria
   * `replace(/[]/g, '')`, que nao da erro nenhum. Este teste e o que percebe.
   */
  it('remove diacriticos de fato (a classe nao foi esvaziada)', () => {
    expect(normalizarNomeDeGrupo('áéíóúãõçÀÊÎ')).toBe('aeiouaocaei');
  });
});

describe('rotularGrupo', () => {
  it('usa o nome quando o id esta no mapa', () => {
    expect(rotularGrupo(156988, new Map([[156988, 'Prova 1']]))).toBe(
      'Prova 1 (#156988)',
    );
  });

  /**
   * Um numero solto nao responde "de qual sessao a prova estava liberada?", mas
   * e melhor que nada: o id ainda permite achar o grupo no Brightspace.
   */
  it('cai para o id quando o grupo nao foi varrido', () => {
    expect(rotularGrupo(999, new Map())).toBe('#999');
  });
});
