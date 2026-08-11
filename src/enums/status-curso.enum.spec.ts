import {
  permiteAgendar,
  statusDesconhecido,
  STATUS_BLOQUEIAM_AGENDAR,
  STATUS_PERMITEM_AGENDAR,
} from './status-curso.enum';

describe('elegibilidade por STATUS CURSO', () => {
  describe('permitem agendar', () => {
    it.each([...STATUS_PERMITEM_AGENDAR])('%s', (status) => {
      expect(permiteAgendar(status)).toBe(true);
    });
  });

  describe('bloqueiam o agendamento', () => {
    it.each([...STATUS_BLOQUEIAM_AGENDAR])('%s', (status) => {
      expect(permiteAgendar(status)).toBe(false);
    });
  });

  /**
   * A regra vigente (11/08/2026) e "SO Ativo agenda" — as situacoes de
   * transicao voltaram a bloquear. Estes casos existem para que uma reversao
   * acidental da lista quebre um teste com nome, e nao passe despercebida.
   */
  describe('situacoes de transicao BLOQUEIAM', () => {
    it.each([
      'Transf. Interna',
      'Transf. de Curriculo',
      'Alter. de Habilitação',
    ])('%s nao agenda', (status) => {
      expect(permiteAgendar(status)).toBe(false);
    });

    it('mas continuam sendo status CONHECIDOS — nao viram novidade na importacao', () => {
      expect(statusDesconhecido('Transf. Interna')).toBe(false);
      expect(statusDesconhecido('Alter. de Habilitação')).toBe(false);
    });
  });

  it('so "Ativo" esta na lista de permitidos', () => {
    expect([...STATUS_PERMITEM_AGENDAR]).toEqual(['Ativo']);
  });

  describe('tolerancia de grafia', () => {
    // O CSV e ISO-8859-1; um acento perdido na reexportacao nao pode mudar a
    // situacao de um aluno — nem para liberar, nem para barrar.
    it('aceita "Alter. de Habilitacao" sem acento (e bloqueia dos dois jeitos)', () => {
      expect(permiteAgendar('Alter. de Habilitacao')).toBe(false);
      expect(statusDesconhecido('Alter. de Habilitacao')).toBe(false);
      expect(statusDesconhecido('Alter. de Habilitação')).toBe(false);
    });

    it('aceita "Transf. de Curriculo" com e sem acento', () => {
      expect(statusDesconhecido('Transf. de Curriculo')).toBe(false);
      expect(statusDesconhecido('Transf. de Currículo')).toBe(false);
    });

    it('ignora caixa e espacos sobrando', () => {
      expect(permiteAgendar('  ATIVO ')).toBe(true);
      expect(permiteAgendar('ativo')).toBe(true);
      expect(permiteAgendar('transf.  interna')).toBe(false);
    });
  });

  describe('valores fora das duas listas', () => {
    it('bloqueiam por seguranca', () => {
      expect(permiteAgendar('Status Que Nunca Vimos')).toBe(false);
      expect(permiteAgendar('')).toBe(false);
      expect(permiteAgendar(null)).toBe(false);
      expect(permiteAgendar(undefined)).toBe(false);
    });

    it('sao sinalizados como desconhecidos, para a importacao avisar', () => {
      expect(statusDesconhecido('Status Que Nunca Vimos')).toBe(true);
      expect(statusDesconhecido('')).toBe(true);
    });

    it('status conhecidos nao sao sinalizados', () => {
      for (const status of [
        ...STATUS_PERMITEM_AGENDAR,
        ...STATUS_BLOQUEIAM_AGENDAR,
      ]) {
        expect(statusDesconhecido(status)).toBe(false);
      }
    });
  });
});
