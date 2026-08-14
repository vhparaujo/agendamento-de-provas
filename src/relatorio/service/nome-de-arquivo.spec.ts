import {
  caminhoNoZip,
  horarioDaProva,
  identificacaoDaTurma,
  nomeDoArquivo,
  sanear,
} from './nome-de-arquivo';

/**
 * O nome do arquivo e a UNICA coisa que diz de que prova e de que turma a lista
 * e: o conteudo e so matriculas. Um nome errado nao da erro em lugar nenhum —
 * alguem importa a lista do horario errado no grupo errado e descobre no dia da
 * prova.
 */
describe('nome dos arquivos de grupo', () => {
  const FAIXA = {
    faixaId: 14,
    data: new Date('2026-08-20T00:00:00.000Z'),
    horaInicio: '08:30',
    horaFim: '11:30',
  };

  const TURMA = {
    orgUnitId: '445566',
    codigoTurma: 'GSPS0I10227',
    nomeDisciplina: 'HISTÓRIA E CULTURA DO CORPO',
  };

  describe('sanear', () => {
    it('dobra os acentos para ASCII', () => {
      expect(sanear('PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO')).toBe(
        'PRATICA PROFISSIONAL E ETICA EM NUTRICAO',
      );
    });

    it('troca por espaco o que o sistema de arquivos recusa', () => {
      // `/` viraria diretorio dentro do zip; `:` quebra no Windows.
      expect(sanear('TURMA 2026/1: A*B?')).toBe('TURMA 2026 1 A B');
    });

    it('corta nome longo demais para caber no caminho do zip', () => {
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

  describe('identificacaoDaTurma', () => {
    it('junta codigo da turma e disciplina', () => {
      expect(identificacaoDaTurma(TURMA)).toBe(
        'GSPS0I10227 - HISTORIA E CULTURA DO CORPO',
      );
    });

    it('cai no orgUnitId quando a turma nao esta no CSV', () => {
      // Acontece com TURMAS_FILTER_ENABLED=false, ou antes do primeiro launch
      // ter ensinado o orgUnitId. Um nome generico faria dois grupos diferentes
      // disputarem o mesmo arquivo.
      expect(identificacaoDaTurma({ ...TURMA, codigoTurma: null })).toBe(
        'orgUnit 445566 - HISTORIA E CULTURA DO CORPO',
      );
    });

    it('fica so com o codigo quando nao ha nome de disciplina', () => {
      expect(identificacaoDaTurma({ ...TURMA, nomeDisciplina: null })).toBe(
        'GSPS0I10227',
      );
    });
  });

  describe('nomeDoArquivo', () => {
    it('leva horario e turma, e nada mais', () => {
      expect(nomeDoArquivo(FAIXA, TURMA)).toBe(
        '20-08-2026 08h30-11h30 - GSPS0I10227 - HISTORIA E CULTURA DO CORPO.csv',
      );
    });

    it('sai em ASCII puro — o Content-Disposition nao precisa do RFC 5987', () => {
      expect(nomeDoArquivo(FAIXA, TURMA)).toMatch(/^[\x20-\x7e]+$/);
    });
  });

  describe('caminhoNoZip', () => {
    it('poe a turma como pasta e o horario como arquivo', () => {
      expect(caminhoNoZip({ ...FAIXA, ...TURMA }, new Set())).toBe(
        'GSPS0I10227 - HISTORIA E CULTURA DO CORPO/20-08-2026 08h30-11h30.csv',
      );
    });

    it('desempata pelo id quando duas faixas caem no mesmo caminho', () => {
      // Mesmo dia, mesmo horario, mesma turma, polos diferentes: o polo nao entra
      // no nome, entao o segundo arquivo sobrescreveria o primeiro em silencio.
      const usados = new Set<string>();

      const primeiro = caminhoNoZip({ ...FAIXA, ...TURMA }, usados);
      const segundo = caminhoNoZip({ ...FAIXA, ...TURMA, faixaId: 15 }, usados);

      expect(segundo).not.toBe(primeiro);
      expect(segundo).toContain('#15');
    });

    it('mantem os horarios da mesma turma na mesma pasta', () => {
      const usados = new Set<string>();

      const manha = caminhoNoZip({ ...FAIXA, ...TURMA }, usados);
      const tarde = caminhoNoZip(
        {
          ...FAIXA,
          ...TURMA,
          faixaId: 16,
          horaInicio: '14:00',
          horaFim: '17:00',
        },
        usados,
      );

      expect(manha.split('/')[0]).toBe(tarde.split('/')[0]);
    });
  });
});
