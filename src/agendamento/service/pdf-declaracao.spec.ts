import { pdfDeDeclaracao, textoDaDeclaracao } from './pdf-declaracao';

/**
 * O modulo do PDF e puro, entao o teste e da FRASE e do arquivo — nao do banco.
 * A regra de quem pode baixar (prazo encerrado, prova sua, confirmada) vive em
 * `declaracao.service.ts` e e coberta pelo e2e do portal.
 */

const BASE = {
  nome: 'LAYDSON ABEL SILVA SANTOS',
  matricula: 'UC26425318',
  data: new Date(Date.UTC(2026, 5, 12)),
  horario: '15:01',
};

describe('textoDaDeclaracao', () => {
  it('monta a frase com nome, RA, data por extenso e horario', () => {
    expect(textoDaDeclaracao(BASE)).toBe(
      'Declaramos, para os devidos fins, que LAYDSON ABEL SILVA SANTOS está ' +
        'matriculado(a) sob o RA UC26425318 e realizou o agendamento para ' +
        'realização da prova presencial no dia 12 de junho de 2026 às 15:01',
    );
  });

  /**
   * A GUARDA QUE MAIS IMPORTA. `Faixa.data` e `@db.Date` e chega meia-noite UTC;
   * ler as partes no fuso local (`getDate`, `getMonth`) recuaria um dia em
   * qualquer fuso a oeste de Greenwich — Brasilia inclusive. A declaracao diria
   * 11 de junho para uma prova do dia 12, impressa e assinada, e o erro so
   * apareceria no dia. Este teste falha se alguem trocar os `getUTC*`.
   */
  it('le a data em UTC, sem recuar um dia no fuso de Brasilia', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Sao_Paulo';

    try {
      expect(textoDaDeclaracao(BASE)).toContain('no dia 12 de junho de 2026');
    } finally {
      process.env.TZ = tz;
    }
  });

  it('nomeia todos os meses em portugues, sem depender do ICU do Node', () => {
    const meses = Array.from({ length: 12 }, (_, i) =>
      textoDaDeclaracao({ ...BASE, data: new Date(Date.UTC(2026, i, 1)) }),
    );

    expect(meses.map((t) => /no dia 1 de (\S+) de/.exec(t)?.[1])).toEqual([
      'janeiro',
      'fevereiro',
      'março',
      'abril',
      'maio',
      'junho',
      'julho',
      'agosto',
      'setembro',
      'outubro',
      'novembro',
      'dezembro',
    ]);
  });
});

describe('pdfDeDeclaracao', () => {
  it('devolve um PDF de uma pagina', async () => {
    const pdf = await pdfDeDeclaracao(BASE);

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Count 1');
  });

  /**
   * Nome longo ganha uma linha no paragrafo, e a assinatura desce junto — ela e
   * medida a partir do fim do texto, nao de um `y` fixo. O defeito que isso
   * evita (assinatura impressa POR CIMA do texto que assina) nao quebra o PDF,
   * so aparece a olho; aqui o teste cobre a geracao, e o layout se confere no
   * papel.
   */
  it('nao quebra com nome longo, que empurra a assinatura para baixo', async () => {
    const pdf = await pdfDeDeclaracao({
      ...BASE,
      nome: 'MATEUS DA SILVA ALARÇÃO CARNEIRO DE ALBUQUERQUE VINÍCIUS GONÇALVES',
    });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  /**
   * Acento e cedilha atravessam a Helvetica com `WinAnsiEncoding` — Latin-1
   * inteiro. Se um dia entrar caractere fora dele, e aqui que aparece.
   */
  it('aceita acento e cedilha no nome', async () => {
    await expect(
      pdfDeDeclaracao({ ...BASE, nome: 'VINÍCIUS ALARÇÃO' }),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
