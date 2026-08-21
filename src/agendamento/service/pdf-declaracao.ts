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
 * O layout e o do TIMBRADO OFICIAL DA CATOLICA EAD para documentos online
 * (`assets/timbrado-ead.png`): a arte cobre a folha inteira — curvas azuis no
 * topo-esquerda e no rodape-direita, o selo Great Place to Work e a marca
 * Catolica EAD no alto a direita, e o endereco da unidade no pe. O texto so
 * ocupa a area branca no meio.
 *
 * A FRASE E O MESMO TEXTO DE SEMPRE. O que mudou foi so onde ele e como ele e
 * impresso; `textoDaDeclaracao` nao foi tocada, e o teste dela continua valendo
 * palavra por palavra.
 *
 * DUAS COISAS DO DOCUMENTO ANTIGO FICARAM DE FORA, por decisao do cliente: o QR
 * code e as duas linhas de validacao embaixo dele. Elas apontavam para o
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
 * A4 em pontos — a mesma medida da arte do timbrado, que foi desenhada para
 * esta folha e e impressa nela de canto a canto.
 */
const PAGINA = { largura: 595, altura: 842 };

/**
 * A MARGEM VEM DO PROPRIO TIMBRADO, e nao de um valor escolhido aqui: o
 * endereco no pe da arte comeca a 45,8pt da borda. Alinhar o texto com ele e o
 * que faz a folha parecer um documento so, em vez de um paragrafo solto por
 * cima de um papel timbrado.
 */
const MARGEM = 46;
const LARGURA_UTIL = PAGINA.largura - 2 * MARGEM;

/**
 * A FAIXA BRANCA UTIL fica entre ~100pt (onde termina a curva do topo) e ~630pt
 * (onde a curva do rodape comeca a invadir pela direita). Todo o texto cabe com
 * folga na parte de cima dela; os `topo` abaixo estao dentro desse intervalo de
 * proposito, e e ele que limita o quanto a assinatura pode descer.
 */
const LIMITE_INFERIOR = 620;

/**
 * O azul da marca, tirado da propria arte (a cor dominante das curvas e da
 * caixa do logotipo). O titulo o repete para amarrar o texto ao timbrado —
 * preto puro no meio de uma folha azul-marinho fica parecendo colado depois.
 */
const AZUL = '#283489';
const PRETO = '#000000';

const TITULO = {
  texto: 'DECLARAÇÃO DE AGENDAMENTO',
  tamanho: 14,
  /**
   * `topo` e o topo da caixa de linha, nao a base do texto: o `pdfkit` desenha
   * a partir dali. Trabalhamos com a base (mais facil de raciocinar quando se
   * quer um risco embaixo) e descontamos o ascender da Helvetica, 718/1000 do
   * corpo.
   */
  base: 200,
  /** O risco embaixo, na largura exata do texto. */
  folgaDaLinha: 5,
  espessura: 1,
};

const CORPO = {
  tamanho: 11,
  base: 248,
  /**
   * Justificado, e nao centralizado como na versao anterior: com a largura do
   * timbrado o paragrafo vira um bloco de texto de verdade, e bloco de texto
   * justificado e o que se espera de uma declaracao. O `pdfkit` deixa a ultima
   * linha alinhada a esquerda sozinho, que e o comportamento certo.
   */
  alinhamento: 'justify' as const,
  /**
   * Entrelinha de 18pt, base a base. A Helvetica 11 do `pdfkit` ja ocupa 12,72
   * (ascender + descender + gap da propria fonte), entao o que falta e o
   * `lineGap`.
   */
  espacoEntreLinhas: 18 - (1156 / 1000) * 11,
};

const ASSINATURA = {
  texto: 'UCB | UBEC - Católica',
  tamanho: 11,
  /**
   * A DISTANCIA ATE O FIM DO PARAGRAFO, e nao um `y` fixo na pagina.
   *
   * O documento antigo ancorava a assinatura numa altura fixa, e o tamanho do
   * espaco em branco acima dela mudava com o nome: "ANA SILVA" cabe em duas
   * linhas e sobrava um vao; "MATEUS DA SILVA ALARÇÃO CARNEIRO DE VASCONCELOS
   * FILHO" gasta tres e a assinatura quase encostava no texto — e, sem um piso,
   * seria impressa POR CIMA dele. Medindo a partir do fim do paragrafo, os dois
   * casos saem com o mesmo respiro e o piso deixa de ser necessario.
   */
  espacoAcima: 34,
};

/**
 * Helvetica das 14 fontes-padrao do PDF, com `WinAnsiEncoding` — cobre Latin-1
 * inteiro e, com ele, todo acento e cedilha do portugues ("DECLARAÇÃO",
 * "VINÍCIUS"), sem embutir arquivo de fonte no repositorio. Mesma escolha (e
 * mesmo limite) da lista de presenca.
 *
 * A arte do timbrado usa outra familia, mas ela vem embutida na imagem: e
 * pixel, nao texto, entao nao ha o que casar. Trocar a Helvetica por uma fonte
 * proxima exigiria versionar o arquivo `.ttf` e o direito de uso dele — custo
 * que so faz sentido se o cliente pedir.
 */
const REGULAR = 'Helvetica';
const NEGRITO = 'Helvetica-Bold';

type Doc = typeof PDFDocument extends new (...args: never[]) => infer T
  ? T
  : never;

/** O ascender da Helvetica, para converter base de texto em topo de caixa. */
function topoDaCaixa(base: number, tamanho: number): number {
  return base - (718 / 1000) * tamanho;
}

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

  // Primeiro de tudo: o resto da pagina e desenhado POR CIMA da arte.
  desenharTimbrado(doc);
  desenharTitulo(doc);

  doc
    .font(REGULAR)
    .fontSize(CORPO.tamanho)
    .fillColor(PRETO)
    .text(
      textoDaDeclaracao(dados),
      MARGEM,
      topoDaCaixa(CORPO.base, CORPO.tamanho),
      {
        width: LARGURA_UTIL,
        align: CORPO.alinhamento,
        lineGap: CORPO.espacoEntreLinhas,
      },
    );

  // `doc.y` e onde o paragrafo terminou. O teto e a area branca do timbrado:
  // um nome absurdamente longo nao pode empurrar a assinatura para dentro da
  // curva azul do rodape, onde ela ficaria ilegivel.
  const topoDaAssinatura = Math.min(
    doc.y + ASSINATURA.espacoAcima,
    LIMITE_INFERIOR,
  );

  doc
    .font(REGULAR)
    .fontSize(ASSINATURA.tamanho)
    .fillColor(PRETO)
    .text(ASSINATURA.texto, MARGEM, topoDaAssinatura, {
      width: LARGURA_UTIL,
      align: 'center',
    });

  doc.end();

  return pronto;
}

/**
 * A arte do timbrado, folha inteira, se o arquivo estiver la.
 *
 * OPCIONAL pelo mesmo motivo do logo da lista de presenca: o documento continua
 * valido sem ela — o que declara e o texto —, e derrubar o download por causa de
 * um `.png` ausente trocaria um papel imperfeito por papel nenhum. A diferenca e
 * que este arquivo VAI versionado no repositorio, porque e a identidade visual
 * que o cliente pediu; a tolerancia existe para o caso de o build nao te-lo
 * copiado.
 *
 * Vai esticada de canto a canto (`width`/`height`, e nao `fit`) porque a arte e
 * exatamente uma A4: no PDF de origem ela ocupa 593,4 x 839,7, e o 1,6pt que
 * falta e a folga do sangramento. Deixar `fit` a centralizaria com uma tira
 * branca em duas bordas, que numa arte de sangrar aparece na impressao.
 */
function desenharTimbrado(doc: Doc): void {
  const arte = carregarTimbrado();

  if (!arte) return;

  doc.image(arte, 0, 0, {
    width: PAGINA.largura,
    height: PAGINA.altura,
  });
}

/** O titulo centralizado e o risco embaixo dele, na largura exata do texto. */
function desenharTitulo(doc: Doc): void {
  doc
    .font(NEGRITO)
    .fontSize(TITULO.tamanho)
    .fillColor(AZUL)
    .text(TITULO.texto, MARGEM, topoDaCaixa(TITULO.base, TITULO.tamanho), {
      width: LARGURA_UTIL,
      align: 'center',
    });

  // Medido DEPOIS de `font`/`fontSize`: `widthOfString` responde para a fonte
  // corrente, e com a anterior o risco sairia de outro tamanho que o texto.
  const largura = doc.widthOfString(TITULO.texto);
  const x = (PAGINA.largura - largura) / 2;
  const y = TITULO.base + TITULO.folgaDaLinha;

  doc
    .lineWidth(TITULO.espessura)
    .strokeColor(AZUL)
    .moveTo(x, y)
    .lineTo(x + largura, y)
    .stroke();
}

// ------------------------------------------------------------------ timbrado

/**
 * `dist/` (build) e `src/` (dev, e tambem producao) — o `nest build` copia
 * `**\/*.png` para o `dist` (ver `nest-cli.json`), e a imagem Docker leva o `src`
 * inteiro. Procurar nos dois cobre os dois jeitos de a aplicacao subir.
 */
const CAMINHOS_DO_TIMBRADO = [
  join(__dirname, '..', 'assets', 'timbrado-ead.png'),
  join(process.cwd(), 'src', 'agendamento', 'assets', 'timbrado-ead.png'),
];

function carregarTimbrado(): Buffer | null {
  for (const caminho of CAMINHOS_DO_TIMBRADO) {
    if (existsSync(caminho)) return readFileSync(caminho);
  }

  return null;
}
