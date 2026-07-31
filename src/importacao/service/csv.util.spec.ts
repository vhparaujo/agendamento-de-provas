import { BadRequestException } from '@nestjs/common';
import { coluna, decodificarCsv, exigirColunas, lerCsv } from './csv.util';

describe('leitura de CSV', () => {
  describe('deteccao de codificacao', () => {
    // O caso que importa: "Câmpus Ceilândia" e a chave de casamento do polo.
    // Ler com a codificacao errada quebraria o vinculo aluno -> polo.
    const ACENTUADO = 'Câmpus Ceilândia,Goianésia,Japão';

    it('le arquivo ISO-8859-1 (o formato dos arquivos reais)', () => {
      expect(decodificarCsv(Buffer.from(ACENTUADO, 'latin1'))).toBe(ACENTUADO);
    });

    it('le arquivo UTF-8 (caso a planilha seja reexportada)', () => {
      expect(decodificarCsv(Buffer.from(ACENTUADO, 'utf8'))).toBe(ACENTUADO);
    });

    it('le UTF-8 com BOM', () => {
      const comBom = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(ACENTUADO, 'utf8'),
      ]);

      expect(decodificarCsv(comBom)).toBe(ACENTUADO);
    });

    it('nao altera conteudo puramente ASCII', () => {
      expect(decodificarCsv(Buffer.from('RA,ALUNO\n123,JOAO', 'utf8'))).toBe(
        'RA,ALUNO\n123,JOAO',
      );
    });
  });

  describe('parse', () => {
    const csv = Buffer.from(
      'CAMPUS,RA,ALUNO\nCâmpus Gama,UC123,MARIA\n',
      'latin1',
    );

    it('usa a primeira linha como cabecalho', () => {
      const linhas = lerCsv(csv);

      expect(linhas).toHaveLength(1);
      expect(linhas[0].RA).toBe('UC123');
      expect(linhas[0].CAMPUS).toBe('Câmpus Gama');
    });

    it('preserva zeros a esquerda do RA (nao vira numero)', () => {
      const linhas = lerCsv(Buffer.from('RA\n0009552430\n'));

      expect(linhas[0].RA).toBe('0009552430');
    });

    it('respeita campos entre aspas com virgula dentro', () => {
      const linhas = lerCsv(
        Buffer.from('RA,CURSO\nUC1,"ADMINISTRACAO, GESTAO"\n'),
      );

      expect(linhas[0].CURSO).toBe('ADMINISTRACAO, GESTAO');
    });
  });

  describe('coluna()', () => {
    const linha = { 'STATUS CURSO': 'Ativo', RA: 'UC1' };

    it('tolera diferenca de caixa e espacos no cabecalho', () => {
      expect(coluna(linha, 'status curso')).toBe('Ativo');
      expect(coluna(linha, '  RA ')).toBe('UC1');
    });

    it('devolve string vazia para coluna ausente', () => {
      expect(coluna(linha, 'INEXISTENTE')).toBe('');
    });
  });

  describe('exigirColunas()', () => {
    it('aponta quais colunas faltam, com as que existem', () => {
      const linhas = lerCsv(Buffer.from('RA,ALUNO\nUC1,MARIA\n'));

      expect(() => exigirColunas(linhas, ['RA', 'CAMPUS'])).toThrow(/CAMPUS/);
    });

    it('aceita quando todas estao presentes', () => {
      const linhas = lerCsv(Buffer.from('RA,CAMPUS\nUC1,Polo Gama\n'));

      expect(() => exigirColunas(linhas, ['RA', 'CAMPUS'])).not.toThrow();
    });

    it('recusa CSV sem linha de dados', () => {
      expect(() => exigirColunas([], ['RA'])).toThrow(BadRequestException);
    });
  });
});
