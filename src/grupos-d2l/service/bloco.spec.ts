import type { ModalidadeDaTurma } from '../../senha-quiz/service/modalidade-da-turma.service';
import {
  blocoDaModalidade,
  blocoDaTurma,
  codigoDoGrupo,
  DEFINICAO_DO_BLOCO,
} from './bloco';

const contagem = (codigo: string, reservas = 10) => ({
  modalidadeId: codigo.length,
  codigo,
  nome: codigo,
  reservas,
});

const ambigua = (...codigos: string[]): ModalidadeDaTurma => ({
  situacao: 'SEM_MODALIDADE',
  motivo: 'AMBIGUA',
  candidatas: codigos.map((c) => contagem(c)),
  detalhe: `Alunos de ${codigos.length} formatos.`,
});

const encontrada = (codigo: string): ModalidadeDaTurma => ({
  situacao: 'ENCONTRADA',
  modalidadeId: 1,
  codigo,
  nome: codigo,
  reservas: 10,
  escolha: null,
  candidatas: [],
});

describe('Blocos de grupos', () => {
  it('as categorias sao as que o cliente definiu', () => {
    expect(DEFINICAO_DO_BLOCO.EAD.categoria).toBe('Provas Presenciais - EAD');
    expect(DEFINICAO_DO_BLOCO.SEMI_MODULAR.categoria).toBe(
      'Provas Presenciais - Semi e Modular',
    );
    expect(DEFINICAO_DO_BLOCO.PRESENCIAL.categoria).toBe(
      'Provas Presenciais - Presencial',
    );
  });

  it('Semi e Modular dividem o bloco; EaD e Presencial tem o seu', () => {
    expect(blocoDaModalidade('EAD')).toBe('EAD');
    expect(blocoDaModalidade('semi')).toBe('SEMI_MODULAR');
    expect(blocoDaModalidade('MODULAR')).toBe('SEMI_MODULAR');
    expect(blocoDaModalidade('PRESENCIAL')).toBe('PRESENCIAL');
    expect(blocoDaModalidade('OUTRA')).toBeNull();
    expect(blocoDaModalidade(undefined)).toBeNull();
  });

  describe('blocoDaTurma', () => {
    it('turma de um formato vai para o bloco dela', () => {
      expect(blocoDaTurma(encontrada('EAD'))).toEqual({
        situacao: 'BLOCO',
        bloco: 'EAD',
      });
    });

    /**
     * Para o lote de datas Semi + Modular e ambigua. Aqui nao: as duas caem na
     * mesma categoria, e exigir desempate travaria turmas sem motivo.
     */
    it('Semi + Modular na mesma turma NAO e ambigua', () => {
      expect(blocoDaTurma(ambigua('SEMI', 'MODULAR'))).toEqual({
        situacao: 'BLOCO',
        bloco: 'SEMI_MODULAR',
      });
    });

    it('EaD + Semi sem desempate e ambigua e manda desempatar', () => {
      const r = blocoDaTurma(ambigua('EAD', 'SEMI'));

      expect(r.situacao).toBe('AMBIGUA');
      expect(r.situacao === 'AMBIGUA' && r.detalhe).toContain('Senhas e datas');
    });

    it('EaD + Presencial tambem e ambigua', () => {
      expect(blocoDaTurma(ambigua('EAD', 'PRESENCIAL')).situacao).toBe(
        'AMBIGUA',
      );
    });

    it('turma presencial vai para o bloco Presencial', () => {
      expect(blocoDaTurma(encontrada('PRESENCIAL'))).toEqual({
        situacao: 'BLOCO',
        bloco: 'PRESENCIAL',
      });
    });

    it('turma sem agendamento fica fora', () => {
      expect(
        blocoDaTurma({
          situacao: 'SEM_MODALIDADE',
          motivo: 'SEM_AGENDAMENTO',
          candidatas: [],
          detalhe: 'ninguem agendou',
        }),
      ).toEqual({ situacao: 'FORA' });
    });
  });

  describe('codigoDoGrupo', () => {
    it('troca o que a API recusa e preserva a barra da data', () => {
      expect(codigoDoGrupo('16/09 - 9h: manhã, #1')).toBe(
        '16/09 - 9h- manhã- -1',
      );
    });

    it('corta no limite de 50 caracteres da API', () => {
      expect(codigoDoGrupo('x'.repeat(80))).toHaveLength(50);
    });
  });
});
