import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { dataDaProva } from '../../agendamento/service/csv-relatorio';

/**
 * ============================================================================
 * A LISTA DE PRESENCA — O PAPEL QUE VAI PARA A MAO DO FISCAL
 * ============================================================================
 * Uma pagina por SALA de aplicacao: quem esta agendado naquela sala, naquele
 * horario, naquele polo. E o unico documento do sistema que sai impresso e volta
 * escrito a mao, e isso dita cada escolha de layout aqui.
 *
 * O CABECALHO E A IDENTIDADE DA PAGINA. Uma folha solta que nao diz de que sala,
 * dia e horario ela e nao serve para nada — as folhas vao empilhadas para o
 * campus e sao distribuidas uma a uma. Por isso as tres linhas se repetem em
 * TODA pagina, inclusive na continuacao de uma sala grande, com `(cont.)` para
 * que ninguem conte a mesma sala duas vezes.
 *
 * A COLUNA `Assinatura` E O MOTIVO DO DOCUMENTO. Ela e uma celula vazia com
 * borda: a propria linha da tabela e a linha em que se assina. Por isso a altura
 * minima da linha nao acompanha o tamanho da fonte, e sim o espaco que uma mao
 * precisa (`ALTURA_MINIMA`) — uma tabela compacta caberia em menos paginas e
 * seria impossivel de assinar.
 *
 * NAO HA LINHA EM BRANCO NO FIM. A tabela termina no ultimo aluno alocado: a
 * lista e a relacao de quem TEM lugar naquela sala, e uma linha vazia convida a
 * escrever nela o nome de quem nao deveria estar ali.
 *
 * ---------------------------------------------------------------------------
 * O LOGO E OPCIONAL, DE PROPOSITO
 * ---------------------------------------------------------------------------
 * `src/relatorio/assets/logo.png` e lido se existir, e ignorado se nao. O
 * documento e util sem ele — o cabecalho de texto ja identifica a pagina —, e
 * fazer o relatorio inteiro falhar por causa de um arquivo de imagem ausente
 * seria trocar um documento imperfeito por documento nenhum. Para incluir a
 * marca, basta colocar o arquivo no caminho; nada mais muda.
 *
 * O caminho e resolvido a partir de `__dirname` E da raiz do projeto porque o
 * `nest build` copia so `.ts` compilado para `dist/`: em producao o arquivo fica
 * em `src/relatorio/assets/`, ao lado do codigo-fonte, e nao em `dist/`.
 */

/** Uma pessoa na lista — uma linha da tabela, uma assinatura. */
export interface AlunoNaLista {
  matricula: string;
  nome: string | null;
  /** Do agendamento (fotografia), nao do vinculo de hoje. */
  modalidade: string;
}

/** Tudo que uma pagina precisa dizer sobre si mesma. */
export interface ListaDePresenca {
  polo: string;
  /** Da oferta (`SalaFaixa`): o formato em que a sala esta travada. */
  modalidade: string;
  sala: string;
  data: Date;
  horaInicio: string;
  horaFim: string;
  /**
   * Uma linha por PESSOA, ja sem repetidos — quem deduplica e o service. O
   * mesmo RA duas vezes faria o fiscal chamar a mesma pessoa duas vezes.
   */
  alunos: AlunoNaLista[];
}

// ----------------------------------------------------------------- geometria

/** A4 retrato, em pontos. Margem generosa: a folha e furada e presa. */
const MARGEM = 40;

/**
 * As colunas, na ordem, com a largura de cada. A soma tem que dar a largura util
 * (A4 = 595,28pt menos as duas margens); e por isso que elas sao declaradas
 * juntas, num lugar so — mexer numa sem mexer noutra desalinharia a moldura da
 * tabela do conteudo dela.
 */
const COLUNAS = [
  { titulo: 'Nº', largura: 26 },
  { titulo: 'RA', largura: 85 },
  { titulo: 'Nome', largura: 215 },
  { titulo: 'Formato', largura: 74 },
  { titulo: 'Assinatura', largura: 115 },
] as const;

/** Onde uma mao consegue assinar. Nao e o tamanho da fonte. */
const ALTURA_MINIMA = 22;

/** Respiro dentro da celula, para o texto nao encostar na borda. */
const PADDING = 4;

const FONTE_TEXTO = 9;
const FONTE_TITULO = 12;

/** Cinza do cabecalho da tabela — o mesmo da planilha de origem. */
const FUNDO_DO_CABECALHO = '#d9d9d9';
const BORDA = '#000000';

const LARGURA_DA_TABELA = COLUNAS.reduce((soma, c) => soma + c.largura, 0);

/** Onde o logo cabe sem empurrar o titulo centralizado. */
const LOGO = { largura: 130, altura: 34 };

// -------------------------------------------------------------------- fontes

/**
 * Helvetica das 14 fontes-padrao do PDF, com `WinAnsiEncoding` — que cobre
 * Latin-1 inteiro e, com ele, todo acento do portugues ("VINÍCIUS",
 * "ALARÇÃO", "Câmpus"). E o que dispensa embutir um arquivo de fonte no
 * repositorio; se algum dia o documento precisar de um caractere fora do
 * Latin-1, ai sim entra uma TTF.
 */
const REGULAR = 'Helvetica';
const NEGRITO = 'Helvetica-Bold';

// ------------------------------------------------------------------ desenho

type Doc = typeof PDFDocument extends new (...args: never[]) => infer T
  ? T
  : never;

/**
 * O PDF inteiro: uma pagina (ou mais) por sala, na ordem em que vierem.
 *
 * Devolve `Buffer` e nao stream porque o consumidor e um download HTTP de
 * arquivo pequeno (dezenas de KB), e o `StreamableFile` do Nest precisa do
 * tamanho para o `Content-Length` — sem ele o navegador nao mostra progresso.
 */
export function pdfDeListasDePresenca(
  listas: ListaDePresenca[],
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGEM,
    // Sem isto o pdfkit abre uma pagina em branco antes da primeira sala.
    autoFirstPage: false,
    info: { Title: 'Lista de presença' },
  });

  const pedacos: Buffer[] = [];
  const pronto = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (pedaco: Buffer) => pedacos.push(pedaco));
    doc.on('end', () => resolve(Buffer.concat(pedacos)));
    doc.on('error', reject);
  });

  const logo = carregarLogo();

  for (const lista of listas) desenharLista(doc, lista, logo);

  doc.end();

  return pronto;
}

/**
 * Uma sala. Abre pagina propria SEMPRE: duas salas na mesma folha nao podem ser
 * separadas para ir a dois fiscais diferentes, que e exatamente o que se faz com
 * este documento.
 */
function desenharLista(
  doc: Doc,
  lista: ListaDePresenca,
  logo: Buffer | null,
): void {
  doc.addPage();

  let y = desenharCabecalho(doc, lista, logo, false);
  y = desenharCabecalhoDaTabela(doc, y);

  const limite = doc.page.height - MARGEM;

  lista.alunos.forEach((aluno, indice) => {
    const altura = alturaDaLinha(doc, aluno);

    // A quebra e decidida ANTES de desenhar: uma linha cortada ao meio pela
    // borda da pagina deixaria uma assinatura sem nome do outro lado.
    if (y + altura > limite) {
      doc.addPage();
      y = desenharCabecalho(doc, lista, logo, true);
      y = desenharCabecalhoDaTabela(doc, y);
    }

    y = desenharLinha(doc, y, altura, [
      String(indice + 1),
      aluno.matricula,
      aluno.nome ?? '—',
      aluno.modalidade,
      '',
    ]);
  });

  desenharRodape(doc, y, lista);
}

/**
 * As tres linhas que identificam a folha, repetidas em toda pagina da sala.
 *
 * Devolve o `y` onde a tabela pode comecar.
 */
function desenharCabecalho(
  doc: Doc,
  lista: ListaDePresenca,
  logo: Buffer | null,
  continuacao: boolean,
): number {
  const topo = MARGEM;

  // `fit` e nao `width`: o logo entra no canto sem distorcer, seja qual for a
  // proporcao do arquivo que colocarem em `assets/`.
  if (logo) {
    doc.image(logo, MARGEM, topo, { fit: [LOGO.largura, LOGO.altura] });
  }

  const largura = doc.page.width - MARGEM * 2;

  doc
    .font(NEGRITO)
    .fontSize(FONTE_TITULO)
    .fillColor(BORDA)
    .text(`${lista.modalidade}    ${lista.polo}`, MARGEM, topo, {
      width: largura,
      align: 'center',
    })
    .text(
      `${dataDaProva(lista.data)} ${lista.horaInicio} - ${lista.horaFim}`,
      MARGEM,
      doc.y,
      { width: largura, align: 'center' },
    )
    .text(lista.sala + (continuacao ? ' (cont.)' : ''), MARGEM, doc.y, {
      width: largura,
      align: 'center',
    });

  // O logo pode ser mais alto que o bloco de texto; a tabela comeca abaixo do
  // que for maior, senao ela sobe por cima da imagem.
  return Math.max(doc.y, topo + (logo ? LOGO.altura : 0)) + 20;
}

function desenharCabecalhoDaTabela(doc: Doc, y: number): number {
  const altura = ALTURA_MINIMA;

  doc.rect(MARGEM, y, LARGURA_DA_TABELA, altura).fill(FUNDO_DO_CABECALHO);

  doc.font(NEGRITO).fontSize(FONTE_TEXTO).fillColor(BORDA);

  let x = MARGEM;

  for (const coluna of COLUNAS) {
    doc.text(coluna.titulo, x, y + PADDING + 2, {
      width: coluna.largura,
      align: 'center',
    });

    x += coluna.largura;
  }

  desenharMoldura(doc, y, altura);

  return y + altura;
}

function desenharLinha(
  doc: Doc,
  y: number,
  altura: number,
  celulas: readonly string[],
): number {
  doc.font(REGULAR).fontSize(FONTE_TEXTO).fillColor(BORDA);

  let x = MARGEM;

  COLUNAS.forEach((coluna, indice) => {
    const texto = celulas[indice];

    // Tudo alinhado a esquerda (o default): a coluna do meio quebra em duas
    // linhas quando o nome e longo, e centralizar so ela desalinharia a leitura
    // vertical que o fiscal faz descendo a folha.
    if (texto) {
      doc.text(texto, x + PADDING, y + PADDING, {
        width: coluna.largura - PADDING * 2,
      });
    }

    x += coluna.largura;
  });

  desenharMoldura(doc, y, altura);

  return y + altura;
}

/**
 * Quanto a linha precisa medir. E o maior entre o espaco de assinar e o que o
 * nome ocupa depois de quebrar em duas linhas — nome longo ("MATEUS DA SILVA
 * ALARÇÃO CARNEIRO") nao pode sair cortado, e e por ele que se confere quem
 * assinou.
 */
function alturaDaLinha(doc: Doc, aluno: AlunoNaLista): number {
  const coluna = COLUNAS[2];

  const alturaDoNome = doc
    .font(REGULAR)
    .fontSize(FONTE_TEXTO)
    .heightOfString(aluno.nome ?? '—', {
      width: coluna.largura - PADDING * 2,
    });

  return Math.max(ALTURA_MINIMA, alturaDoNome + PADDING * 2);
}

/** As bordas de uma faixa horizontal: o retangulo externo e os divisores. */
function desenharMoldura(doc: Doc, y: number, altura: number): void {
  doc.lineWidth(0.5).strokeColor(BORDA);

  doc.rect(MARGEM, y, LARGURA_DA_TABELA, altura).stroke();

  let x = MARGEM;

  // O ultimo divisor coincidiria com a borda direita do retangulo.
  for (const coluna of COLUNAS.slice(0, -1)) {
    x += coluna.largura;
    doc
      .moveTo(x, y)
      .lineTo(x, y + altura)
      .stroke();
  }
}

/**
 * O total, no fim da ultima pagina da sala. E o numero que o fiscal usa para
 * conferir a sala contra a folha antes de devolve-la a administracao.
 */
function desenharRodape(doc: Doc, y: number, lista: ListaDePresenca): void {
  doc
    .font(REGULAR)
    .fontSize(FONTE_TEXTO)
    .fillColor('#555555')
    .text(`Total: ${lista.alunos.length} aluno(s) nesta sala.`, MARGEM, y + 8, {
      width: LARGURA_DA_TABELA,
      align: 'right',
    });
}

// ---------------------------------------------------------------------- logo

/**
 * Lido do disco UMA vez por documento e nao a cada pagina: sao centenas de
 * paginas num semestre, e reler o arquivo em cada uma seria I/O sincrono dentro
 * do laco. O `pdfkit` ja deduplica a imagem embutida no PDF.
 */
function carregarLogo(): Buffer | null {
  for (const caminho of CAMINHOS_DO_LOGO) {
    if (existsSync(caminho)) return readFileSync(caminho);
  }

  return null;
}

/**
 * `dist/` (build) e `src/` (dev e producao) — o `nest build` nao copia arquivos
 * que nao sejam `.ts`, entao em producao o `.png` continua sob `src/`.
 */
const CAMINHOS_DO_LOGO = [
  join(__dirname, '..', 'assets', 'logo.png'),
  join(process.cwd(), 'src', 'relatorio', 'assets', 'logo.png'),
];
