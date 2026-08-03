import {
  BOM_UTF8,
  celula,
  dataBr,
  dataDaProva,
  montarCsv,
} from './csv-relatorio';

describe('celula', () => {
  it('deixa texto simples intacto', () => {
    expect(celula('JOAO DA SILVA')).toBe('JOAO DA SILVA');
  });

  it('trata null e undefined como vazio', () => {
    expect(celula(null)).toBe('');
    expect(celula(undefined)).toBe('');
  });

  it('poe entre aspas quando ha ponto e virgula', () => {
    // Sem isto, "NUTRICAO; LICENCIATURA" viraria duas colunas.
    expect(celula('NUTRICAO; LICENCIATURA')).toBe('"NUTRICAO; LICENCIATURA"');
  });

  it('duplica aspas internas (RFC 4180)', () => {
    expect(celula('Sala "A"')).toBe('"Sala ""A"""');
  });

  it('poe entre aspas quando ha quebra de linha', () => {
    expect(celula('linha1\nlinha2')).toBe('"linha1\nlinha2"');
  });

  describe('injecao de formula (CSV injection)', () => {
    // Os nomes vem de planilhas de terceiros. Aberta no Excel, uma celula
    // comecando com "=" EXECUTA no computador de quem abriu o relatorio.
    it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tX', '\rX'])(
      'neutraliza %j',
      (entrada) => {
        expect(celula(entrada).replace(/^"|"$/g, '')).toMatch(/^'/);
      },
    );

    it('neutraliza o caso classico de execucao de comando', () => {
      const ataque = "=cmd|' /C calc'!A0";

      // aspas simples na frente => o Excel trata como texto
      expect(celula(ataque)).toMatch(/^"?'=cmd/);
    });

    it('nao mexe em numero negativo ja formatado como texto comum', () => {
      // "-1" comeca com "-" e E neutralizado: preferimos um apostrofo visivel
      // no editor a uma formula executavel. O relatorio nao tem coluna numerica
      // negativa, entao o custo e zero.
      expect(celula('-1')).toBe("'-1");
    });
  });
});

describe('montarCsv', () => {
  it('comeca com BOM UTF-8 para o Excel nao estragar os acentos', () => {
    const csv = montarCsv(['Polo'], [['Câmpus Ceilândia']]);

    expect(csv.startsWith(BOM_UTF8)).toBe(true);
    expect(csv).toContain('Câmpus Ceilândia');
  });

  it('separa por ponto e virgula e quebra com CRLF', () => {
    const csv = montarCsv(['A', 'B'], [['1', '2']]);

    expect(csv).toBe(`${BOM_UTF8}A;B\r\n1;2\r\n`);
  });

  it('funciona sem nenhuma linha (so cabecalho)', () => {
    expect(montarCsv(['A', 'B'], [])).toBe(`${BOM_UTF8}A;B\r\n`);
  });
});

describe('formatacao de datas', () => {
  it('mostra a data da prova no fuso da coluna (@db.Date e UTC)', () => {
    // Sem timeZone UTC, "2026-08-20" viraria 19/08 em Brasilia.
    expect(dataDaProva(new Date('2026-08-20T00:00:00.000Z'))).toBe(
      '20/08/2026',
    );
  });

  it('mostra data e hora de criacao no fuso de Brasilia', () => {
    expect(dataBr(new Date('2026-08-20T14:30:00.000Z'), true)).toBe(
      '20/08/2026, 11:30',
    );
  });

  it('devolve vazio para data ausente', () => {
    expect(dataBr(null)).toBe('');
  });
});
