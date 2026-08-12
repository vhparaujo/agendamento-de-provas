import { BOM_UTF8 } from '../../agendamento/service/csv-relatorio';
import { CABECALHOS_GRUPOS_D2L, csvDeGrupos } from './csv-grupos-d2l';

describe('csvDeGrupos', () => {
  it('usa o cabecalho exato do arquivo de exemplo do Brightspace', () => {
    // Com acento: e o texto que o import compara para achar a coluna.
    expect(CABECALHOS_GRUPOS_D2L).toEqual([
      'Nome de usuário',
      'Código do Grupo',
    ]);
  });

  it('NAO comeca com BOM — os tres bytes grudariam no cabecalho', () => {
    const csv = csvDeGrupos(['UC25426847']);

    expect(csv.startsWith(BOM_UTF8)).toBe(false);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.startsWith('Nome de usuário')).toBe(true);
  });

  it('separa por virgula e quebra com CRLF, com o codigo do grupo vazio', () => {
    const csv = csvDeGrupos(['UC25426847', '0009552430']);

    expect(csv).toBe(
      'Nome de usuário,Código do Grupo\r\n' +
        'UC25426847,\r\n' +
        '0009552430,\r\n',
    );
  });

  it('funciona sem nenhuma matricula (so cabecalho)', () => {
    expect(csvDeGrupos([])).toBe('Nome de usuário,Código do Grupo\r\n');
  });

  it('poe entre aspas o campo que contem virgula, nao o que contem ;', () => {
    // O separador decide o escape: neste arquivo quem quebra a linha e a
    // virgula. No CSV da secretaria (`;`) e o contrario.
    expect(csvDeGrupos(['SILVA, MARIA'])).toContain('"SILVA, MARIA",');
    expect(csvDeGrupos(['A;B'])).toContain('\r\nA;B,');
  });

  it('mantem a neutralizacao de formula do montador compartilhado', () => {
    expect(csvDeGrupos(['=cmd|calc'])).toContain("'=cmd|calc");
  });
});
