import {
  pdfDeDeclaracao,
  pedacosDaDeclaracao,
  textoDaDeclaracao,
  textoDaEmissao,
} from './pdf-declaracao';

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
  // 12/09/2026 10:00 em Brasilia.
  emitidaEm: new Date('2026-09-12T13:00:00.000Z'),
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

describe('textoDaEmissao', () => {
  it('escreve a cidade, o dia da semana e a data por extenso', () => {
    expect(textoDaEmissao(BASE.emitidaEm)).toBe(
      'Brasília, sábado, 12 de setembro de 2026',
    );
  });

  /**
   * O ESPELHO DA GUARDA DE UTC, ao contrario. `emitidaEm` e um instante, e das
   * 21h a meia-noite de Brasilia o UTC ja esta no dia seguinte. Ler as partes em
   * UTC dataria a declaracao de sabado a noite como domingo. Este teste falha se
   * alguem trocar `agoraNaOperacao` por `getUTC*` direto no instante.
   */
  it('usa o dia de Brasilia, e nao o do UTC, a noite', () => {
    // 13/09 01:30 UTC = 12/09 22:30 em Brasilia.
    expect(textoDaEmissao(new Date('2026-09-13T01:30:00.000Z'))).toBe(
      'Brasília, sábado, 12 de setembro de 2026',
    );
  });

  it('nomeia todos os dias da semana em portugues', () => {
    // 13/09/2026 e domingo; meio-dia UTC fica no mesmo dia em Brasilia.
    const dias = Array.from({ length: 7 }, (_, i) =>
      textoDaEmissao(new Date(Date.UTC(2026, 8, 13 + i, 12))),
    );

    expect(dias.map((t) => t.split(', ')[1])).toEqual([
      'domingo',
      'segunda-feira',
      'terça-feira',
      'quarta-feira',
      'quinta-feira',
      'sexta-feira',
      'sábado',
    ]);
  });
});

describe('pedacosDaDeclaracao', () => {
  it('destaca o nome, o RA e a data — e nada alem deles', () => {
    const negrito = pedacosDaDeclaracao(BASE)
      .filter((pedaco) => pedaco.negrito)
      .map((pedaco) => pedaco.texto.trim());

    expect(negrito).toEqual([
      'LAYDSON ABEL SILVA SANTOS',
      'UC26425318',
      '12 de junho de 2026 às 15:01',
    ]);
  });

  /**
   * O `pdfkit` APARA O BRANCO DO INICIO de um trecho continuado. Um pedaco que
   * comece com espaco perde a separacao e a frase sai com as palavras coladas —
   * "SANTOSestá matriculado(a)", num documento que vai impresso e assinado. Por
   * isso o espaco de cada emenda mora no FIM do pedaco de cima, e este teste
   * falha se alguem o mover de volta ao editar a frase.
   */
  it('nunca comeca um pedaco com espaco, que o pdfkit comeria', () => {
    const comecamComBranco = pedacosDaDeclaracao(BASE)
      .map((pedaco) => pedaco.texto)
      .filter((texto) => /^\s/.test(texto));

    expect(comecamComBranco).toEqual([]);
  });

  /**
   * A frase e a SOMA dos pedacos, e nao uma segunda copia do texto: com duas
   * listas de palavras, mexer no negrito passaria a poder mudar o que a
   * declaracao diz — e a divergencia so apareceria no papel.
   */
  it('soma exatamente a frase que `textoDaDeclaracao` devolve', () => {
    const somado = pedacosDaDeclaracao(BASE)
      .map((pedaco) => pedaco.texto)
      .join('');

    expect(somado).toBe(textoDaDeclaracao(BASE));
  });
});

describe('pdfDeDeclaracao', () => {
  it('devolve um PDF de uma pagina', async () => {
    const pdf = await pdfDeDeclaracao(BASE);

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Count 1');
  });

  /**
   * Nome longo ganha uma linha no paragrafo, que cresce para baixo dentro da
   * area branca do modelo. O defeito que isso evita (texto impresso POR CIMA da
   * assinatura, que agora vem na arte) nao quebra o PDF, so aparece a olho;
   * aqui o teste cobre a geracao, e o layout se confere no papel.
   */
  it('nao quebra com nome longo, que empurra o paragrafo para baixo', async () => {
    const pdf = await pdfDeDeclaracao({
      ...BASE,
      nome: 'MATEUS DA SILVA ALARÇÃO CARNEIRO DE ALBUQUERQUE VINÍCIUS GONÇALVES',
    });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  /**
   * A DECLARACAO E UMA FOLHA, E TEM DE CONTINUAR SENDO UMA.
   *
   * `AlunoImportado.nome` vem do CSV e nao tem limite de tamanho. Sem o `height`
   * na caixa de texto, o `pdfkit` escreveria por cima da assinatura impressa na
   * arte e, passando do pe da pagina, abriria uma SEGUNDA PAGINA — em branco,
   * sem o modelo, com o fim da frase solto nela. Este teste falha se alguem
   * tirar o teto (ou o `ellipsis` que marca onde o texto parou).
   */
  it('cabe numa pagina so, mesmo com um nome absurdo', async () => {
    const pdf = await pdfDeDeclaracao({
      ...BASE,
      nome: 'ANA '.repeat(600).trim(),
    });

    expect(pdf.toString('latin1')).toContain('/Count 1');
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
