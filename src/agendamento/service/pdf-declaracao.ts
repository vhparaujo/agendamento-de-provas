import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';

/**
 * ============================================================================
 * A DECLARACAO DE AGENDAMENTO — O PAPEL QUE O ALUNO LEVA PARA O TRABALHO
 * ============================================================================
 * Uma folha, um paragrafo: quem e a pessoa, sob que RA, e para que dia e hora
 * ela marcou a prova presencial. E o documento que se entrega ao empregador para
 * justificar a ausencia, entao a frase inteira precisa caber numa leitura e nao
 * pode depender de nada que so o sistema entende (id de faixa, nome de sala,
 * codigo de polo).
 *
 * O layout e o da DECLARACAO DE PROVA do sistema anterior (Avalia/Grupo A),
 * reproduzido de proposito: e o papel que a secretaria e os alunos ja reconhecem.
 * As coordenadas abaixo saem do PDF original, convertidas para o sistema do
 * `pdfkit` (origem no topo-esquerda, e nao no rodape).
 *
 * DUAS COISAS DO ORIGINAL FICARAM DE FORA, por decisao do cliente: o QR code e
 * as duas linhas de validacao embaixo dele. Elas apontavam para o
 * `ValidacaoCertificados` do fornecedor antigo, que nao existe deste lado — um
 * QR que leva a lugar nenhum e pior que nenhum QR, porque convida a conferir.
 * Se um dia houver validacao propria, o espaco esta livre e a assinatura desta
 * funcao nao muda.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ELE E UM MODULO PURO
 * ---------------------------------------------------------------------------
 * Recebe dados e devolve `Buffer`, sem Prisma e sem Nest — a mesma separacao de
 * `pdf-lista-presenca.ts`. E o que permite testar a frase e o layout sem banco:
 * a regra que realmente importa (quem pode baixar, e quando) fica em
 * `declaracao.service.ts`, e nao se mistura com desenho de PDF.
 */

/** Tudo que a folha precisa dizer. Nada aqui vem do cliente. */
export interface DeclaracaoDeAgendamento {
  /** Nome do aluno como esta no CSV. Sem ele nao ha declaracao — ver o service. */
  nome: string;
  matricula: string;
  /** Dia da prova. Coluna `@db.Date`: meia-noite UTC, lida em UTC. */
  data: Date;
  /** Hora de inicio da prova, "HH:MM". */
  horario: string;
}

// ----------------------------------------------------------------- geometria

/**
 * A4 em pontos, e as coordenadas do documento original — todas ja em
 * topo-esquerda (`842 - y_do_pdf_original`). Ficam juntas aqui porque so fazem
 * sentido umas em relacao as outras: mexer no titulo sem mexer no sublinhado
 * deixaria o risco flutuando no meio da pagina.
 */
const PAGINA = { largura: 595, altura: 842 };

/** Canto superior esquerdo, do jeito que o original o posiciona. */
const LOGO = { x: 32, y: 29.04, largura: 100, altura: 28.96 };

const TITULO = {
  texto: 'DECLARAÇÃO DE AGENDAMENTO',
  tamanho: 13,
  /**
   * `topo` e o topo da caixa de linha, nao a base do texto: o `pdfkit` desenha
   * a partir dali. O original tem a base em 141,73 do topo, e a Helvetica sobe
   * 718/1000 do corpo acima dela — dai o desconto.
   */
  topo: 141.73 - (718 / 1000) * 13,
  /** O risco embaixo, na largura exata do texto. */
  linhaY: 143.35,
  espessura: 0.75,
};

const CORPO = {
  tamanho: 11,
  topo: 175.09 - (718 / 1000) * 11,
  /**
   * A largura em que o paragrafo quebra — a mesma da linha mais larga do
   * original (595 menos as margens de 32,51 que o iText usou ali). Ela e o que
   * mantem a quebra depois de "RA", como no documento que a secretaria conhece.
   */
  largura: 530,
  /**
   * As duas linhas do original distam 16,49pt de base a base. A Helvetica 11 do
   * `pdfkit` ja ocupa 12,72 (ascender + descender + gap da propria fonte), entao
   * o que falta e o `lineGap`.
   */
  espacoEntreLinhas: 16.49 - (1156 / 1000) * 11,
};

const RODAPE = {
  texto: 'UCB | UBEC - Católica',
  tamanho: 11,
  topo: 232.06 - (718 / 1000) * 11,
  /**
   * O minimo entre o fim do paragrafo e a assinatura, quando o paragrafo passa
   * do ponto em que o original a colocava.
   *
   * A posicao fixa reproduz o documento antigo para o caso comum, mas ela e
   * comum, nao garantida: nome longo ("MATEUS DA SILVA ALARÇÃO CARNEIRO") ganha
   * uma linha, e ancorar a assinatura num `y` fixo a faria ser impressa POR CIMA
   * do texto que ela assina. Com o piso, o caso comum fica identico ao original
   * e o caso longo empurra a assinatura para baixo.
   */
  folgaMinima: 12,
};

const PRETO = '#000000';

/**
 * Helvetica das 14 fontes-padrao do PDF, com `WinAnsiEncoding` — cobre Latin-1
 * inteiro e, com ele, todo acento e cedilha do portugues ("DECLARAÇÃO",
 * "VINÍCIUS"), sem embutir arquivo de fonte no repositorio. Mesma escolha (e
 * mesmo limite) da lista de presenca.
 *
 * O titulo do original e Helvetica normal desenhada com contorno (`2 Tr`), um
 * negrito falso do iText. Aqui ele e a Helvetica-Bold de verdade: o resultado
 * impresso e o mesmo peso visual, sem depender de largura de traco.
 */
const REGULAR = 'Helvetica';
const NEGRITO = 'Helvetica-Bold';

type Doc = typeof PDFDocument extends new (...args: never[]) => infer T
  ? T
  : never;

// -------------------------------------------------------------------- a frase

const MESES = [
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
] as const;

/**
 * A data por extenso, LIDA EM UTC.
 *
 * A coluna `Faixa.data` e `@db.Date` e chega como meia-noite UTC; ler as partes
 * no fuso local adiantaria um dia em qualquer fuso a oeste de Greenwich — que e
 * o caso de Brasilia. A declaracao diria 11 de junho para uma prova do dia 12.
 * Mesmo motivo (e mesma leitura) de `dataDaProva` e `hojeUtc`.
 *
 * Os meses sao uma lista, e nao `toLocaleDateString('pt-BR', { month: 'long' })`,
 * porque este texto vai impresso e assinado: ele nao pode mudar de grafia porque
 * a imagem do Node subiu de versao ou veio sem os dados completos do ICU.
 */
function dataPorExtenso(data: Date): string {
  return `${data.getUTCDate()} de ${MESES[data.getUTCMonth()]} de ${data.getUTCFullYear()}`;
}

/**
 * A frase inteira, exportada para que o teste a leia sem abrir o PDF.
 *
 * "realizou o agendamento" no passado e proposital: a declaracao so existe
 * depois de o prazo encerrar, quando a escolha ja aconteceu e nao muda mais.
 */
export function textoDaDeclaracao(dados: DeclaracaoDeAgendamento): string {
  return (
    `Declaramos, para os devidos fins, que ${dados.nome} está matriculado(a) sob o RA ` +
    `${dados.matricula} e realizou o agendamento para realização da prova presencial ` +
    `no dia ${dataPorExtenso(dados.data)} às ${dados.horario}`
  );
}

// ------------------------------------------------------------------- desenho

/**
 * A folha, em `Buffer`.
 *
 * `Buffer` e nao stream pelo mesmo motivo da lista de presenca: e um download
 * HTTP de poucos KB, e o `StreamableFile` do Nest precisa do tamanho para o
 * `Content-Length`.
 */
export function pdfDeDeclaracao(
  dados: DeclaracaoDeAgendamento,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGINA.largura, PAGINA.altura],
    margin: 0,
    info: { Title: 'Declaração de agendamento' },
  });

  const pedacos: Buffer[] = [];
  const pronto = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (pedaco: Buffer) => pedacos.push(pedaco));
    doc.on('end', () => resolve(Buffer.concat(pedacos)));
    doc.on('error', reject);
  });

  desenharLogo(doc);
  desenharTitulo(doc);

  doc
    .font(REGULAR)
    .fontSize(CORPO.tamanho)
    .fillColor(PRETO)
    .text(textoDaDeclaracao(dados), meio(CORPO.largura), CORPO.topo, {
      width: CORPO.largura,
      align: 'center',
      lineGap: CORPO.espacoEntreLinhas,
    });

  // `doc.y` e onde o paragrafo terminou. Ver `folgaMinima`.
  const topoDoRodape = Math.max(RODAPE.topo, doc.y + RODAPE.folgaMinima);

  doc
    .font(REGULAR)
    .fontSize(RODAPE.tamanho)
    .text(RODAPE.texto, 0, topoDoRodape, {
      width: PAGINA.largura,
      align: 'center',
    });

  doc.end();

  return pronto;
}

/**
 * A marca no canto, se o arquivo estiver la.
 *
 * OPCIONAL pelo mesmo motivo do logo da lista de presenca: o documento continua
 * valido sem ela — o que declara e o texto —, e derrubar o download por causa de
 * um `.png` ausente trocaria um papel imperfeito por papel nenhum. A diferenca e
 * que este arquivo VAI versionado no repositorio, porque o cliente pediu a marca
 * explicitamente; a tolerancia existe para o caso de o build nao te-lo copiado.
 */
function desenharLogo(doc: Doc): void {
  const logo = carregarLogo();

  if (!logo) return;

  // `fit` e nao `width`: se um dia trocarem o arquivo por outro de proporcao
  // diferente, ele encolhe dentro da caixa em vez de distorcer ou invadir o
  // titulo.
  doc.image(logo, LOGO.x, LOGO.y, { fit: [LOGO.largura, LOGO.altura] });
}

/** O titulo centralizado e o risco embaixo dele, na largura exata do texto. */
function desenharTitulo(doc: Doc): void {
  doc
    .font(NEGRITO)
    .fontSize(TITULO.tamanho)
    .fillColor(PRETO)
    .text(TITULO.texto, 0, TITULO.topo, {
      width: PAGINA.largura,
      align: 'center',
    });

  // Medido DEPOIS de `font`/`fontSize`: `widthOfString` responde para a fonte
  // corrente, e com a anterior o risco sairia de outro tamanho que o texto.
  const largura = doc.widthOfString(TITULO.texto);
  const x = meio(largura);

  doc
    .lineWidth(TITULO.espessura)
    .strokeColor(PRETO)
    .moveTo(x, TITULO.linhaY)
    .lineTo(x + largura, TITULO.linhaY)
    .stroke();
}

/** O x que centraliza uma caixa desta largura na pagina. */
function meio(largura: number): number {
  return (PAGINA.largura - largura) / 2;
}

// ---------------------------------------------------------------------- logo

/**
 * `dist/` (build) e `src/` (dev, e tambem producao) — o `nest build` copia
 * `**\/*.png` para o `dist` (ver `nest-cli.json`), e a imagem Docker leva o `src`
 * inteiro. Procurar nos dois cobre os dois jeitos de a aplicacao subir.
 */
const CAMINHOS_DO_LOGO = [
  join(__dirname, '..', 'assets', 'logo-catolica.png'),
  join(process.cwd(), 'src', 'agendamento', 'assets', 'logo-catolica.png'),
];

function carregarLogo(): Buffer | null {
  for (const caminho of CAMINHOS_DO_LOGO) {
    if (existsSync(caminho)) return readFileSync(caminho);
  }

  return null;
}
