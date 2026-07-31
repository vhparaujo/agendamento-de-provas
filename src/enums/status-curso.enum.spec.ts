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

  it('nao confunde "Transf. Interna" (permite) com "Trancado" (bloqueia)', () => {
    expect(permiteAgendar('Transf. Interna')).toBe(true);
    expect(permiteAgendar('Trancado')).toBe(false);
  });

  describe('tolerancia de grafia', () => {
    // O CSV e ISO-8859-1; um acento perdido na reexportacao nao pode barrar
    // um aluno que tem direito a fazer prova.
    it('aceita "Alter. de Habilitacao" sem acento', () => {
      expect(permiteAgendar('Alter. de Habilitacao')).toBe(true);
      expect(permiteAgendar('Alter. de Habilitação')).toBe(true);
    });

    it('aceita "Transf. de Curriculo" com e sem acento', () => {
      expect(permiteAgendar('Transf. de Curriculo')).toBe(true);
      expect(permiteAgendar('Transf. de Currículo')).toBe(true);
    });

    it('ignora caixa e espacos sobrando', () => {
      expect(permiteAgendar('  ATIVO ')).toBe(true);
      expect(permiteAgendar('transf.  interna')).toBe(true);
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
