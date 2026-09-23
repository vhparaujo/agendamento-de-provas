import { inflateSync } from 'node:zlib';
import {
  ordemDaPilha,
  porNome,
  type AlunoDaLista,
  type SalaComLista,
} from './lista-presenca.service';
import { nomeDaListaDaPorta, nomeDaListaDePresenca } from './nome-de-arquivo';
import {
  pdfDeListasDePresenca,
  type ListaDePresenca,
} from './pdf-lista-presenca';

const aluno = (nome: string | null, matricula = 'UC1'): AlunoDaLista => ({
  matricula,
  nome,
});

const ordenar = (alunos: AlunoDaLista[]) =>
  [...alunos].sort(porNome).map((a) => a.nome ?? a.matricula);

describe('ordem dentro da folha', () => {
  it('e alfabetica por nome — e o que o fiscal tem para procurar', () => {
    expect(
      ordenar([
        aluno('VINÍCIUS MENDES'),
        aluno('ERIK MACEDO'),
        aluno('MATEUS'),
      ]),
    ).toEqual(['ERIK MACEDO', 'MATEUS', 'VINÍCIUS MENDES']);
  });

  it('respeita o acento do pt-BR: ÁLVARO vem antes de AMANDA', () => {
    // Por code point "Á" (U+00C1) cairia depois de todo o alfabeto, e o nome
    // sumiria no fim da folha exatamente para quem o procura em ordem.
    expect(ordenar([aluno('AMANDA'), aluno('ÁLVARO')])).toEqual([
      'ÁLVARO',
      'AMANDA',
    ]);
  });

  it('manda quem nao tem nome para o fim, desempatado pela matricula', () => {
    expect(
      ordenar([aluno(null, 'UC9'), aluno('ZULMIRA'), aluno(null, 'UC2')]),
    ).toEqual(['ZULMIRA', 'UC2', 'UC9']);
  });

  it('desempata dois homonimos pela matricula — a ordem tem que ser estavel', () => {
    expect(
      ordenar([aluno('ANA SILVA', 'UC9'), aluno('ANA SILVA', 'UC2')]),
    ).toEqual(['ANA SILVA', 'ANA SILVA']);

    expect(
      [...[aluno('ANA SILVA', 'UC9'), aluno('ANA SILVA', 'UC2')]]
        .sort(porNome)
        .map((a) => a.matricula),
    ).toEqual(['UC2', 'UC9']);
  });
});

describe('ordem da pilha de folhas', () => {
  const sala = (p: Partial<SalaComLista>): SalaComLista => ({
    salaFaixaId: 1,
    faixaId: 1,
    poloId: 1,
    polo: 'Câmpus Asa Sul',
    salaId: 1,
    sala: 'SALA 1',
    modalidade: 'EaD',
    data: new Date('2026-06-11T00:00:00.000Z'),
    horaInicio: '09:00',
    horaFim: '12:00',
    vagas: 40,
    totalAlunos: 3,
    nomeArquivo: 'x.pdf',
    nomeArquivoDaPorta: 'y.pdf',
    nomeArquivoDaIdentificacao: 'z.pdf',
    ...p,
  });

  it('sai por dia, horario, polo e sala — a ordem em que as folhas sao entregues', () => {
    const pilha = [
      sala({ sala: 'SALA 2' }),
      sala({ polo: 'Câmpus Taguatinga', sala: 'M114' }),
      sala({ horaInicio: '08:00' }),
      sala({ data: new Date('2026-06-10T00:00:00.000Z') }),
      sala({ sala: 'SALA 1' }),
    ];

    expect(
      pilha
        .sort(ordemDaPilha)
        .map(
          (s) => `${s.data.getUTCDate()} ${s.horaInicio} ${s.polo} ${s.sala}`,
        ),
    ).toEqual([
      '10 09:00 Câmpus Asa Sul SALA 1',
      '11 08:00 Câmpus Asa Sul SALA 1',
      '11 09:00 Câmpus Asa Sul SALA 1',
      '11 09:00 Câmpus Asa Sul SALA 2',
      '11 09:00 Câmpus Taguatinga M114',
    ]);
  });
});

describe('nome do arquivo da folha avulsa', () => {
  it('leva o polo, ao contrario do CSV de grupos — duas salas homonimas em campi diferentes', () => {
    const folha = {
      data: new Date('2026-06-11T00:00:00.000Z'),
      horaInicio: '09:00',
      horaFim: '12:00',
      sala: 'SALA 1 EAD',
    };

    expect(nomeDaListaDePresenca({ ...folha, polo: 'Câmpus Asa Sul' })).toBe(
      'Lista de presenca - 11-06-2026 09h00-12h00 - Campus Asa Sul - SALA 1 EAD.pdf',
    );

    expect(
      nomeDaListaDePresenca({ ...folha, polo: 'Câmpus Taguatinga' }),
    ).not.toBe(nomeDaListaDePresenca({ ...folha, polo: 'Câmpus Asa Sul' }));
  });

  it('a lista da porta tem outro prefixo — baixada junto, nao sobrescreve a de presenca', () => {
    const folha = {
      data: new Date('2026-06-11T00:00:00.000Z'),
      horaInicio: '09:00',
      horaFim: '12:00',
      sala: 'SALA 1 EAD',
      polo: 'Câmpus Asa Sul',
    };

    expect(nomeDaListaDaPorta(folha)).toBe(
      'Lista da porta - 11-06-2026 09h00-12h00 - Campus Asa Sul - SALA 1 EAD.pdf',
    );
  });
});

describe('o PDF', () => {
  const pagina = (alunos: number, p: Partial<ListaDePresenca> = {}) => ({
    polo: 'Câmpus Asa Sul',
    modalidade: 'EaD',
    sala: 'SALA 1 EAD',
    data: new Date('2026-06-11T00:00:00.000Z'),
    horaInicio: '09:00',
    horaFim: '12:00',
    alunos: Array.from({ length: alunos }, (_, i) => ({
      matricula: `UC2642${i}`,
      nome: `ALUNO ${i}`,
    })),
    ...p,
  });

  /** `/Count` do no raiz de paginas — o que um leitor de PDF mostra. */
  const paginas = (pdf: Buffer) =>
    Number(/\/Count\s+(\d+)/.exec(pdf.toString('latin1'))?.[1]);

  /**
   * O texto de cada pagina, ja descomprimido. O `pdfkit` escreve as strings em
   * HEXADECIMAL (`<53414c41...> TJ`), entao ler o PDF cru nao acha palavra
   * nenhuma — a conversao esta aqui para que o teste fale de texto, e nao de
   * bytes.
   */
  const textoDasPaginas = (pdf: Buffer): string[] => {
    const paginas: string[] = [];

    let i = 0;

    while ((i = pdf.indexOf('stream', i)) !== -1) {
      if (pdf.subarray(i - 3, i).toString('latin1') === 'end') {
        i += 6;
        continue;
      }

      let inicio = i + 6;
      while (pdf[inicio] === 0x0d || pdf[inicio] === 0x0a) inicio++;

      const fim = pdf.indexOf('endstream', inicio);

      try {
        const conteudo = inflateSync(pdf.subarray(inicio, fim)).toString(
          'latin1',
        );

        // ⚠️ O PNG do timbrado TAMBEM e um stream deflate, e inflar sai byte de
        // imagem. So o conteudo de pagina tem operador de texto (`BT` + `Tf`).
        if (/\bBT\b/.test(conteudo) && /\bTf\b/.test(conteudo)) {
          // Cada `<hex>` vira o texto que ele representa.
          paginas.push(
            conteudo.replace(/<([0-9a-f]+)>/g, (_, hex: string) =>
              Buffer.from(hex, 'hex').toString('latin1'),
            ),
          );
        }
      } catch {
        // Nao e um stream deflate.
      }

      i = fim + 9;
    }

    return paginas;
  };

  it('da uma pagina por sala, mesmo com pouca gente', async () => {
    // Duas salas nunca dividem folha: elas vao para dois fiscais diferentes.
    expect(paginas(await pdfDeListasDePresenca([pagina(3), pagina(1)]))).toBe(
      2,
    );
  });

  it('continua na pagina seguinte quando a sala nao cabe numa folha', async () => {
    // A area branca do timbrado comporta 19 linhas de nome curto. O numero em si
    // nao e promessa nenhuma — o que o teste trava e que a quebra EXISTE e que
    // ela nao e disparada uma linha cedo demais, deixando folha pela metade.
    //
    // ⚠️ Eram 20 ate a arte ganhar o bloco de endereco no pe, que subiu o rodape
    // impresso em 25,6pt. Se este teste comecar a falhar depois de alguem trocar
    // o `.png`, a causa provavel e essa: as medidas de `AREA_UTIL` sao da ARTE, e
    // arte nova pede remedicao — ver o LEIA-ME de `assets/`.
    expect(paginas(await pdfDeListasDePresenca([pagina(19)]))).toBe(1);
    expect(paginas(await pdfDeListasDePresenca([pagina(20)]))).toBe(2);
  });

  it('repete a identificacao da sala em toda pagina, e marca a continuacao', async () => {
    // A folha solta que nao diz de que sala ela e nao serve para nada: elas vao
    // empilhadas para o campus e sao distribuidas uma a uma. O `(cont.)` e o que
    // impede o fiscal de contar a mesma sala duas vezes.
    const texto = textoDasPaginas(await pdfDeListasDePresenca([pagina(25)]));

    const folhas = texto.filter((t) => t.includes('SALA 1 EAD'));

    expect(folhas).toHaveLength(2);
    expect(folhas[0]).not.toContain('cont.');
    expect(folhas[1]).toContain('cont.');
  });

  it('tem so RA, Nome e Assinatura — o espaco de assinar e o que importa', async () => {
    // `Nº` e `Formato` sairam para a Assinatura caber um nome completo. O formato
    // continua na folha, no cabecalho da sala, que e onde ele vale para todos.
    const [primeira] = textoDasPaginas(
      await pdfDeListasDePresenca([pagina(3)]),
    );

    expect(primeira).toContain('RA');
    expect(primeira).toContain('Nome');
    expect(primeira).toContain('Assinatura');
    expect(primeira).not.toContain('Formato');
    expect(primeira).not.toMatch(/N\xba/);
  });

  describe('a lista da porta', () => {
    it('tem Nº, RA e Nome — e nao tem Assinatura', async () => {
      // Ela vai colada do lado de fora: o aluno so confere que esta na sala.
      const [primeira] = textoDasPaginas(
        await pdfDeListasDePresenca([pagina(3)], 'porta'),
      );

      expect(primeira).toMatch(/N\xba/);
      expect(primeira).toContain('RA');
      expect(primeira).toContain('Nome');
      expect(primeira).not.toContain('Assinatura');
    });

    it('numera seguido de uma pagina para a outra', async () => {
      // A continuacao de uma sala grande nao recomeca no 1.
      const texto = textoDasPaginas(
        await pdfDeListasDePresenca([pagina(25)], 'porta'),
      );

      const [primeira, segunda] = texto.filter((t) => t.includes('SALA 1 EAD'));

      expect(primeira).toContain('ALUNO 0');
      expect(segunda).toContain('cont.');
      expect(segunda).toMatch(/\b25\b/);
    });

    it('mantem a identificacao e a paginacao da lista de presenca', async () => {
      expect(paginas(await pdfDeListasDePresenca([pagina(19)], 'porta'))).toBe(
        1,
      );
      expect(
        paginas(await pdfDeListasDePresenca([pagina(3), pagina(1)], 'porta')),
      ).toBe(2);
    });
  });

  it('nao desenha o titulo — ele vem impresso no timbrado', async () => {
    // Redesenha-lo por cima duplicaria o texto na folha.
    const [primeira] = textoDasPaginas(
      await pdfDeListasDePresenca([pagina(3)]),
    );

    expect(primeira).not.toContain('LISTA DE PRESEN');
    expect(primeira).toContain('Assinatura');
  });

  it('embute o timbrado UMA vez, e nao uma por pagina', async () => {
    // O `pdfkit` so deduplica imagem quando a origem e o CAMINHO do arquivo;
    // passando `Buffer` ele reembutiria as centenas de KB da arte em cada folha,
    // e um semestre de listas viraria um download de dezenas de MB.
    const uma = (await pdfDeListasDePresenca([pagina(1)])).length;
    const cinco = (
      await pdfDeListasDePresenca(Array.from({ length: 5 }, () => pagina(1)))
    ).length;

    // A arte passa de 400KB; quatro paginas a mais nao podem custar isso.
    expect(cinco - uma).toBeLessThan(20_000);
  });

  it('nao gera pagina em branco quando nao ha sala nenhuma', async () => {
    // `autoFirstPage: false` — sem isso o pdfkit abre uma folha vazia sozinho.
    expect(paginas(await pdfDeListasDePresenca([]))).toBe(0);
  });

  it('sai como PDF de verdade, com o cabecalho de arquivo', async () => {
    const pdf = await pdfDeListasDePresenca([pagina(3)]);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(0);
  });
});
