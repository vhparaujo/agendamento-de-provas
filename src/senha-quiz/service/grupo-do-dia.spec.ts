import { escolherGrupoDoDia } from './grupo-do-dia';

describe('escolherGrupoDoDia', () => {
  const celula = (sobrepor: Record<string, unknown> = {}) => ({
    id: 5,
    nomeGrupo: 'Turma A - 16/09 tarde',
    categoriaGrupo: null,
    versao: 2,
    ...sobrepor,
  });

  const JANELA_SEM_NOME = { nomeGrupo: null, categoriaGrupo: null };
  const JANELA_COM_NOME = { nomeGrupo: 'Prova 2', categoriaGrupo: 'Separacao' };

  it('a celula do dia vence o nome fixo da janela', () => {
    expect(
      escolherGrupoDoDia({
        celula: celula(),
        janela: JANELA_COM_NOME,
        janelaUsaGrade: true,
      }),
    ).toEqual({
      origem: 'GRADE',
      nome: 'Turma A - 16/09 tarde',
      categoria: 'Separacao',
      celulaId: 5,
      versao: 2,
    });
  });

  it('a categoria da celula, quando existe, vence a da janela', () => {
    expect(
      escolherGrupoDoDia({
        celula: celula({ categoriaGrupo: 'Outra' }),
        janela: JANELA_COM_NOME,
        janelaUsaGrade: true,
      }).categoria,
    ).toBe('Outra');
  });

  it('sem celula, cai no nome fixo da janela — sem celula na chave', () => {
    expect(
      escolherGrupoDoDia({
        celula: null,
        janela: JANELA_COM_NOME,
        janelaUsaGrade: true,
      }),
    ).toEqual({
      origem: 'JANELA',
      nome: 'Prova 2',
      categoria: 'Separacao',
      celulaId: null,
      versao: null,
    });
  });

  /**
   * O caso que justifica o arquivo: o dia esquecido na grade. Tratar como "nao
   * troca" deixaria a prova aberta para o grupo da sessao anterior, com a
   * execucao verde.
   */
  it('janela que usa a grade e ficou sem o dia vira SEM_GRUPO_NO_DIA', () => {
    expect(
      escolherGrupoDoDia({
        celula: null,
        janela: JANELA_SEM_NOME,
        janelaUsaGrade: true,
      }).origem,
    ).toBe('SEM_GRUPO_NO_DIA');
  });

  it('janela que nunca teve grupo continua sem trocar nada', () => {
    expect(
      escolherGrupoDoDia({
        celula: null,
        janela: JANELA_SEM_NOME,
        janelaUsaGrade: false,
      }),
    ).toEqual({
      origem: 'NAO_TROCA',
      nome: null,
      categoria: null,
      celulaId: null,
      versao: null,
    });
  });

  it('nome so com espacos (celula ou janela) nao conta como grupo', () => {
    expect(
      escolherGrupoDoDia({
        celula: celula({ nomeGrupo: '   ' }),
        janela: { nomeGrupo: '  ', categoriaGrupo: null },
        janelaUsaGrade: true,
      }).origem,
    ).toBe('SEM_GRUPO_NO_DIA');
  });
});
