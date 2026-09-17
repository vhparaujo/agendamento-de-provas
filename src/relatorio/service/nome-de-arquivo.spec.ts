import {
  horarioDaProva,
  nomeDaListaDePresenca,
  sanear,
} from './nome-de-arquivo';

/**
 * O nome do arquivo e o que diz de que sala, dia e horario e a folha antes de
 * ela ser aberta. Quem baixa a pilha inteira separa os arquivos por ele, e um
 * nome errado nao da erro em lugar nenhum — a folha errada chega na mao do
 * fiscal errado, e a descoberta e no dia da prova.
 */
describe('nome dos arquivos de lista de presenca', () => {
  const FAIXA = {
    data: new Date('2026-08-20T00:00:00.000Z'),
    horaInicio: '08:30',
    horaFim: '11:30',
  };

  const PAGINA = {
    ...FAIXA,
    polo: 'Câmpus Asa Sul',
    sala: 'SALA 1 EAD',
  };

  describe('sanear', () => {
    it('dobra os acentos para ASCII', () => {
      expect(sanear('PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO')).toBe(
        'PRATICA PROFISSIONAL E ETICA EM NUTRICAO',
      );
    });

    it('troca por espaco o que o sistema de arquivos recusa', () => {
      // `/` seria lido como diretorio; `:` quebra no Windows.
      expect(sanear('TURMA 2026/1: A*B?')).toBe('TURMA 2026 1 A B');
    });

    it('corta nome longo demais para caber no caminho', () => {
      const gerado = sanear('X'.repeat(200));

      expect(gerado.length).toBeLessThanOrEqual(60);
    });

    it('nao termina em ponto — nome assim some no Windows', () => {
      expect(sanear('DISCIPLINA...')).toBe('DISCIPLINA');
    });
  });

  describe('horarioDaProva', () => {
    it('usa - na data e h na hora', () => {
      expect(horarioDaProva(FAIXA)).toBe('20-08-2026 08h30-11h30');
    });

    it('le a data como UTC — a coluna e @db.Date, gravada em meia-noite', () => {
      // Em America/Sao_Paulo (UTC-3) uma leitura local devolveria o dia 19.
      expect(
        horarioDaProva({ ...FAIXA, data: new Date('2026-08-20') }),
      ).toContain('20-08-2026');
    });
  });

  describe('nomeDaListaDePresenca', () => {
    it('leva horario, polo e sala', () => {
      expect(nomeDaListaDePresenca(PAGINA)).toBe(
        'Lista de presenca - 20-08-2026 08h30-11h30 - Campus Asa Sul - SALA 1 EAD.pdf',
      );
    });

    it('sai em ASCII puro — o Content-Disposition nao precisa do RFC 5987', () => {
      expect(nomeDaListaDePresenca(PAGINA)).toMatch(/^[\x20-\x7e]+$/);
    });

    it('o polo separa duas salas de mesmo nome em campi diferentes', () => {
      // Sala com o mesmo nome em dois polos e comum, e as duas folhas vao para
      // lugares fisicos diferentes: sem o polo no nome, uma sobrescreveria a
      // outra na pasta de downloads.
      expect(nomeDaListaDePresenca(PAGINA)).not.toBe(
        nomeDaListaDePresenca({ ...PAGINA, polo: 'Câmpus Taguatinga' }),
      );
    });
  });
});
