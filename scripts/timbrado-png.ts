import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename } from 'node:path';
import { deflateSync } from 'node:zlib';
import pngJs from 'png-js';

/**
 * O `png-js` vem junto com o `pdfkit` (e dependencia dele) e nao tem tipos.
 * Em vez de silenciar o `typescript-eslint` com `any`, declaro so a superficie
 * que este script usa — se a lib mudar a assinatura, o erro aparece aqui.
 */
interface ImagemPng {
  width: number;
  height: number;
}

interface PngJs {
  /** Devolve os pixels em RGBA, quatro bytes por pixel. */
  decode(caminho: string, pronto: (pixels: Buffer) => void): void;
  load(caminho: string): ImagemPng;
}

const PNG = pngJs as unknown as PngJs;

/**
 * ============================================================================
 * O TIMBRADO EM PNG — converte a arte da instituicao no asset que o PDF usa
 * ============================================================================
 * A instituicao entrega o timbrado em **PDF vetorial**. O `pdfkit` (o gerador de
 * todos os PDFs deste projeto) **nao embute PDF**: `doc.image()` aceita so JPEG
 * e PNG, e um PDF ali responde `Unknown image format`. Por isso a arte vira
 * raster — e este script e o caminho, para que a conversao seja reproduzivel e
 * nao folclore de quem a fez da primeira vez.
 *
 *   npm run timbrado -- "~/Downloads/LISTA DE PRESENCA.png" \
 *     src/relatorio/assets/modelo-lista-presenca.png
 *
 * ---------------------------------------------------------------------------
 * AS TRES DECISOES, E O QUE ACONTECE SE ALGUEM AS DESFIZER
 * ---------------------------------------------------------------------------
 * 1. **PDF de origem vira 300 dpi (2480px); PNG de origem entra como veio.**
 *    Rasterizar acima de 300 nao adianta — no PDF que a instituicao mandou
 *    primeiro, o selo Great Place to Work era um raster de ~130 dpi DENTRO
 *    dele, e a 600 so ampliava os proprios pixels. Ja um PNG de origem NAO e
 *    reamostrado: ampliar inventa pixel e entrega a mesma imagem borrada, tres
 *    vezes maior.
 *
 * 2. **Truecolor, NUNCA paleta de 256 cores.** Indexar corta o arquivo de
 *    ~730KB para ~315KB e e tentador. Mas as curvas do canto inferior direito
 *    sao fios de azul claro de menos de 1pt, que existem quase so no
 *    antialiasing: com a paleta reduzida os tons intermediarios caem para
 *    branco e AS CURVAS SAEM PONTILHADAS, como linha tracejada. No tamanho real
 *    o defeito nao aparece — so ampliando aquele canto.
 *
 * 3. **Sem canal alfa.** O `sips` deixa alfa no PNG; no PDF ele vira uma
 *    `SMask` separada, que engorda o arquivo a toa. A arte e achatada sobre
 *    branco aqui, e o resultado sai em `color type 2` (RGB puro).
 *
 * O `sips` e do proprio macOS — nao ha dependencia nova. Num runner Linux este
 * script nao roda, e nao precisa: o `.png` vai versionado no repositorio, e
 * regenera-lo e tarefa de quando a instituicao manda arte nova.
 */

/** 300 dpi numa A4 de 595,276pt de largura. Ver a decisao 1, acima. */
const LARGURA_EM_PIXELS = 2480;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const TABELA_CRC = (() => {
  const tabela: number[] = [];

  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }

  return tabela;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABELA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
}

function bloco(tipo: string, dados: Buffer): Buffer {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);

  const corpo = Buffer.concat([Buffer.from(tipo, 'latin1'), dados]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));

  return Buffer.concat([tamanho, corpo, crc]);
}

/**
 * RGBA com alfa -> PNG `color type 2` (RGB) achatado sobre branco.
 *
 * O filtro e Paeth em todas as linhas: testei a selecao adaptativa dos cinco
 * filtros do PNG e ela rendeu 200 bytes em 744KB nesta arte — o Paeth ja e o
 * otimo aqui, e a complexidade nao se paga.
 */
function comoPngSemAlfa(
  pixels: Buffer,
  largura: number,
  altura: number,
): Buffer {
  const BYTES = 3;
  const linha = largura * BYTES;

  const bruto = Buffer.alloc(altura * (1 + linha));
  const anterior = Buffer.alloc(linha);
  const atual = Buffer.alloc(linha);

  let destino = 0;

  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      const i = (y * largura + x) * 4;
      const alfa = pixels[i + 3] / 255;

      for (let canal = 0; canal < 3; canal++) {
        atual[x * 3 + canal] = Math.round(
          pixels[i + canal] * alfa + 255 * (1 - alfa),
        );
      }
    }

    bruto[destino++] = 4; // Paeth

    for (let k = 0; k < linha; k++) {
      const a = k >= BYTES ? atual[k - BYTES] : 0;
      const b = anterior[k];
      const c = k >= BYTES ? anterior[k - BYTES] : 0;

      bruto[destino++] = (atual[k] - paeth(a, b, c)) & 0xff;
    }

    atual.copy(anterior);
  }

  const cabecalho = Buffer.alloc(13);
  cabecalho.writeUInt32BE(largura, 0);
  cabecalho.writeUInt32BE(altura, 4);
  cabecalho[8] = 8; // bits por canal
  cabecalho[9] = 2; // color type 2 = RGB, sem alfa

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', cabecalho),
    bloco('IDAT', deflateSync(bruto, { level: 9, memLevel: 9 })),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

/** A largura em pontos de uma A4 — o denominador do dpi efetivo. */
const A4_EM_PONTOS = 595.276;

function main(): void {
  const [origem, destino] = process.argv.slice(2);

  if (!origem || !destino) {
    console.error(
      'uso: npm run timbrado -- <arte.pdf|arte.png> <src/.../modelo-....png>',
    );
    process.exit(1);
  }

  if (!existsSync(origem)) {
    console.error(`nao encontrei ${origem}`);
    process.exit(1);
  }

  const ehPdf = origem.toLowerCase().endsWith('.pdf');
  const temporario = `${destino}.bruto.png`;

  if (ehPdf) {
    // O `sips` rasteriza de verdade na largura pedida (nao amplia o render de
    // 72dpi): medido comparando a largura da transicao nas arestas vetoriais.
    execFileSync('sips', [
      '-s',
      'format',
      'png',
      '--resampleWidth',
      String(LARGURA_EM_PIXELS),
      origem,
      '--out',
      temporario,
    ]);
  } else {
    /**
     * ⚠️ PNG DE ORIGEM NAO E REAMOSTRADO. Passar a arte por um `--resampleWidth`
     * para "chegar aos 300 dpi" inventaria pixels que nao existem: o resultado
     * e a mesma imagem borrada e tres vezes maior. A resolucao de um PNG e a que
     * veio — quem quiser mais tem de pedir uma exportacao maior a quem desenhou.
     * Aqui ele so perde o alfa.
     */
    copyFileSync(origem, temporario);
  }

  PNG.decode(temporario, (pixels: Buffer) => {
    const imagem = PNG.load(temporario);

    writeFileSync(destino, comoPngSemAlfa(pixels, imagem.width, imagem.height));

    unlinkSync(temporario);

    const kb = Math.round(statSync(destino).size / 1024);
    const dpi = Math.round((imagem.width / A4_EM_PONTOS) * 72);

    console.log(
      `${basename(destino)}: ${imagem.width}x${imagem.height} (${dpi} dpi numa A4), ${kb} KB, RGB sem alfa`,
    );

    const proporcao = imagem.width / imagem.height;
    const desvio = Math.abs(proporcao - A4_EM_PONTOS / 841.89);

    if (desvio > 0.005) {
      console.warn(
        `⚠️  proporcao ${proporcao.toFixed(4)} nao e a da A4 (0,7071): a arte vai SAIR DISTORCIDA, porque o PDF a estica de canto a canto.`,
      );
    }

    if (dpi < 200) {
      console.warn(
        `⚠️  ${dpi} dpi e baixo para impressao. Se houver exportacao maior da arte, use-a: aqui nao da para recuperar detalhe.`,
      );
    }

    console.log(
      'confira AMPLIADO o canto inferior direito: as curvas finas nao podem sair pontilhadas.',
    );
  });
}

main();
