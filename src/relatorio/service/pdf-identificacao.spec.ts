import { inflateSync } from 'node:zlib';
import { nomeDaIdentificacao } from './nome-de-arquivo';
import {
  pdfDeIdentificacao,
  type FolhaDeIdentificacao,
} from './pdf-identificacao';

const folha = (
  p: Partial<FolhaDeIdentificacao> = {},
): FolhaDeIdentificacao => ({
  polo: 'Polo Cruzeiro do Sul',
  data: new Date('2026-09-23T00:00:00.000Z'),
  horaInicio: '15:00',
  ...p,
});

/** `/Count` do no raiz de paginas — o que um leitor de PDF mostra. */
const paginas = (pdf: Buffer) =>
  Number(/\/Count\s+(\d+)/.exec(pdf.toString('latin1'))?.[1]);

/** O texto de cada pagina, ja descomprimido (ver `lista-presenca.spec.ts`). */
const textoDasPaginas = (pdf: Buffer): string[] => {
  const saida: string[] = [];
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

      if (/\bBT\b/.test(conteudo) && /\bTf\b/.test(conteudo)) {
        saida.push(
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

  return saida;
};

describe('folha de identificacao', () => {
  it('da uma pagina por horario', async () => {
    const pdf = await pdfDeIdentificacao([
      folha(),
      folha({ horaInicio: '19:00' }),
      folha({ data: new Date('2026-09-24T00:00:00.000Z') }),
    ]);

    expect(paginas(pdf)).toBe(3);
  });

  it('e deitada, no tamanho do modelo (960 x 540)', async () => {
    const pdf = (await pdfDeIdentificacao([folha()])).toString('latin1');

    expect(pdf).toMatch(/\/MediaBox \[0 0 960 540\]/);
  });

  it('traz o polo em maiusculas, o dia e so a hora de inicio', async () => {
    const [texto] = textoDasPaginas(await pdfDeIdentificacao([folha()]));

    // O kerning parte a palavra em pedacos (`[POLO CR 20 UZEIR ...] TJ`); o
    // numero entre eles e o ajuste de espaco, nao texto.
    const polo = /\[(POLO[^\]]*)\] TJ/
      .exec(texto)?.[1]
      .replace(/ -?\d+ ?/g, '');

    expect(polo).toBe('POLO CRUZEIRO DO SUL');
    expect(texto).toContain('23/09/2026');
    expect(texto).toContain('15:00');
  });

  it('nao gera pagina em branco quando nao ha horario nenhum', async () => {
    expect(paginas(await pdfDeIdentificacao([]))).toBe(0);
  });

  it('embute a marca UMA vez, e nao uma por pagina', async () => {
    const uma = (await pdfDeIdentificacao([folha()])).length;
    const cinco = (
      await pdfDeIdentificacao(Array.from({ length: 5 }, () => folha()))
    ).length;

    expect(cinco - uma).toBeLessThan(10_000);
  });

  it('cabe o nome de polo mais longo do cadastro sem abrir outra pagina', async () => {
    const pdf = await pdfDeIdentificacao([
      folha({ polo: 'Polo Rio de Janeiro - Jardim Botânico' }),
      folha({ polo: 'Polo Coronel Fabriciano - UNILESTE - Unidade Centro' }),
    ]);

    expect(paginas(pdf)).toBe(2);
  });
});

describe('nome do arquivo da folha de identificacao', () => {
  it('leva dia, hora de inicio e polo, sem acento', () => {
    expect(
      nomeDaIdentificacao({
        polo: 'Câmpus Asa Sul',
        data: new Date('2026-06-11T00:00:00.000Z'),
        horaInicio: '09:00',
      }),
    ).toBe('Identificacao - 11-06-2026 09h00 - Campus Asa Sul.pdf');
  });
});
