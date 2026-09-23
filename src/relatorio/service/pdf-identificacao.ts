import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { dataDaProva } from '../../agendamento/service/csv-relatorio';

/**
 * ============================================================================
 * A FOLHA DE IDENTIFICACAO — O CARTAZ DO HORARIO
 * ============================================================================
 * Uma pagina DEITADA por horario de prova: so o POLO, o DIA e a HORA de inicio,
 * em letra grande, para ser lida de longe. Reproduz o modelo da instituicao
 * ("07_ FOLHA DE IDENTIFICACAO", um slide 16:9 de 960x540pt): marca Catolica
 * EAD no alto a esquerda e as tres linhas centralizadas.
 *
 * O recorte e a FAIXA (polo + dia + horario), e nao a sala: o modelo nao traz
 * sala nenhuma, e as salas de um mesmo horario receberiam folhas identicas.
 *
 * Nao confunda com as listas (`pdf-lista-presenca.ts`): elas dizem QUEM esta na
 * sala; esta diz so QUE prova acontece ali.
 */

/** Um horario de prova — uma pagina. */
export interface FolhaDeIdentificacao {
  polo: string;
  data: Date;
  horaInicio: string;
}

// ----------------------------------------------------------------- geometria

/**
 * As medidas sao as do MODELO, lidas do PDF de origem (coordenadas do topo da
 * pagina). Mudar o tamanho da pagina sem refaze-las desalinha tudo.
 */
const PAGINA = { largura: 960, altura: 540 };

/** A marca, no mesmo lugar e tamanho do modelo (200 x 79pt). */
const LOGO = { x: 19.94, y: 9.32, largura: 200.12, altura: 79.05 };

/**
 * A linha de base de cada texto e o tamanho da fonte no modelo.
 *
 * `umaLinha`, `duasLinhas` e `minimo` nao estao no modelo: sao os limites para
 * nome de polo que nao cabe a 65pt. Ver `desenharPolo`.
 */
const POLO = {
  base: 205.63,
  tamanho: 65,
  umaLinha: 48,
  duasLinhas: 56,
  minimo: 36,
};
const DATA = { base: 327.62, tamanho: 56 };
const HORA = { base: 391.34, tamanho: 56 };

/**
 * A largura que o nome do polo pode ocupar. O modelo nao diz — o nome dele cabe
 * folgado —, mas nomes como "POLO RIO DE JANEIRO - JARDIM BOTANICO" nao cabem
 * numa linha a 65pt. Ver `desenharPolo`.
 */
const LARGURA_DO_TEXTO = PAGINA.largura - 2 * 60;

/**
 * Helvetica no lugar da Aptos do modelo: as 14 fontes-padrao do PDF dispensam
 * embutir arquivo de fonte e cobrem todo acento do portugues. Mesma escolha da
 * lista de presenca.
 */
const REGULAR = 'Helvetica';
const NEGRITO = 'Helvetica-Bold';

/** O ascender da Helvetica, para converter base de texto em topo de caixa. */
function topoDaCaixa(base: number, tamanho: number): number {
  return base - (718 / 1000) * tamanho;
}

type Doc = typeof PDFDocument extends new (...args: never[]) => infer T
  ? T
  : never;

/** O PDF inteiro: uma pagina por horario, na ordem em que vierem. */
export function pdfDeIdentificacao(
  folhas: FolhaDeIdentificacao[],
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGINA.largura, PAGINA.altura],
    margin: 0,
    autoFirstPage: false,
    info: { Title: 'Folha de identificação' },
  });

  const pedacos: Buffer[] = [];
  const pronto = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (pedaco: Buffer) => pedacos.push(pedaco));
    doc.on('end', () => resolve(Buffer.concat(pedacos)));
    doc.on('error', reject);
  });

  const logo = caminhoDoLogo();

  for (const folha of folhas) desenharFolha(doc, folha, logo);

  doc.end();

  return pronto;
}

function desenharFolha(
  doc: Doc,
  folha: FolhaDeIdentificacao,
  logo: string | null,
): void {
  doc.addPage();

  // Pelo CAMINHO, e nao pelo `Buffer`: e o que faz o `pdfkit` embutir a imagem
  // uma vez so e reaproveita-la em todas as paginas (ver `desenharModelo` da
  // lista de presenca).
  if (logo) {
    doc.image(logo, LOGO.x, LOGO.y, {
      width: LOGO.largura,
      height: LOGO.altura,
    });
  }

  doc.fillColor('#000000');

  desenharPolo(doc, folha.polo.toLocaleUpperCase('pt-BR'));
  centralizar(doc, REGULAR, DATA, dataDaProva(folha.data));
  centralizar(doc, REGULAR, HORA, folha.horaInicio);
}

/**
 * O nome do polo, em MAIUSCULAS como no modelo. O cadastro ja traz o "Polo" /
 * "Campus" no nome, entao nada e acrescentado.
 *
 * Nome comprido primeiro ENCOLHE (ate `POLO.umaLinha`) para continuar numa
 * linha so. Se nem assim couber, quebra em DUAS linhas, na maior fonte que
 * caiba nelas (ate `POLO.duasLinhas`), crescendo para CIMA — a ultima linha
 * fica onde o modelo pos a unica, e a data e a hora nao saem do lugar.
 */
function desenharPolo(doc: Doc, texto: string): void {
  doc.font(NEGRITO);

  const cabe = (tamanho: number, linhas: number) => {
    doc.fontSize(tamanho);

    return (
      doc.heightOfString(texto, { width: LARGURA_DO_TEXTO }) <=
      doc.currentLineHeight() * linhas + 1
    );
  };

  let tamanho = POLO.tamanho;

  while (tamanho > POLO.umaLinha && !cabe(tamanho, 1)) tamanho--;

  if (!cabe(tamanho, 1)) {
    tamanho = POLO.duasLinhas;
    while (tamanho > POLO.minimo && !cabe(tamanho, 2)) tamanho--;
  }

  doc.fontSize(tamanho);

  const altura = doc.heightOfString(texto, { width: LARGURA_DO_TEXTO });
  const umaLinha = doc.currentLineHeight();

  doc.text(
    texto,
    (PAGINA.largura - LARGURA_DO_TEXTO) / 2,
    topoDaCaixa(POLO.base, tamanho) - (altura - umaLinha),
    { width: LARGURA_DO_TEXTO, align: 'center' },
  );
}

function centralizar(
  doc: Doc,
  fonte: string,
  linha: { base: number; tamanho: number },
  texto: string,
): void {
  doc
    .font(fonte)
    .fontSize(linha.tamanho)
    .text(texto, 0, topoDaCaixa(linha.base, linha.tamanho), {
      width: PAGINA.largura,
      align: 'center',
      lineBreak: false,
    });
}

// ---------------------------------------------------------------------- logo

/**
 * `dist/` (build) e `src/` (dev) — mesmo motivo do timbrado da lista de
 * presenca. Sem o arquivo a folha sai sem a marca, mas sai: polo, dia e hora ja
 * sao tudo que ela precisa dizer.
 */
const CAMINHOS_DO_LOGO = [
  join(__dirname, '..', 'assets', 'logo-catolica-ead.png'),
  join(process.cwd(), 'src', 'relatorio', 'assets', 'logo-catolica-ead.png'),
];

function caminhoDoLogo(): string | null {
  for (const caminho of CAMINHOS_DO_LOGO) {
    if (existsSync(caminho)) return caminho;
  }

  return null;
}
