import { existsSync } from 'node:fs';
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
 * campus e sao distribuidas uma a uma. Por isso as duas linhas de identificacao
 * se repetem em TODA pagina, inclusive na continuacao de uma sala grande, com
 * `(cont.)` para que ninguem conte a mesma sala duas vezes.
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
 * O TIMBRADO MANDA NA GEOMETRIA
 * ---------------------------------------------------------------------------
 * Desde 22/09/2026 a folha e o MODELO DESENHADO PELA INSTITUICAO
 * (`assets/modelo-lista-presenca.png`), irma do papel da declaracao: banda azul
 * na lateral esquerda, marca Catolica EAD no alto a esquerda, selo Great Place
 * to Work no alto a direita, curvas no canto inferior direito e, no pe, o bloco
 * de emissao mais o ENDERECO da instituicao. Ele ja traz o TITULO "LISTA DE PRESENCA" impresso, na fonte da
 * marca — por isso este modulo nao desenha mais titulo nenhum: redesenha-lo por
 * cima duplicaria o texto, e reescreve-lo em Helvetica ao lado do titulo da arte
 * faria a folha parecer montada em dois lugares.
 *
 * O que a arte NAO diz e o que identifica a folha (sala, campus, formato, dia e
 * horario), e e so isso que o `pdfkit` imprime aqui, alem da tabela.
 *
 * ⚠️ A ARTE OCUPA O TOPO E O PE DA PAGINA, e as medidas abaixo sao todas tiradas
 * dela (ver `AREA_UTIL`). A area branca que sobra vai do risco do titulo ao
 * bloco de emissao — cerca de 445pt de altura contra os 700pt do layout antigo,
 * que usava a folha inteira. Na pratica cabem ~19 alunos por pagina em vez de
 * ~30; uma sala de 40 lugares sai em tres folhas.
 *
 * ---------------------------------------------------------------------------
 * O TIMBRADO E OPCIONAL, DE PROPOSITO
 * ---------------------------------------------------------------------------
 * A arte e lida se existir, e ignorada se nao. O documento e util sem ela — a
 * identificacao e a tabela ja dizem tudo que o fiscal precisa —, e fazer o
 * relatorio inteiro falhar por causa de um arquivo de imagem ausente seria
 * trocar um documento imperfeito por documento nenhum. A diferenca para o logo
 * antigo e que este arquivo VAI versionado no repositorio, porque e a identidade
 * visual que o cliente pediu; a tolerancia existe para o caso de o build nao
 * te-lo copiado.
 *
 * ⚠️ Sem a arte a folha sai tambem SEM TITULO, e nao apenas sem o papel: ele
 * mora nela. E mais uma razao para o `.png` estar sempre no lugar, nao para o
 * download falhar quando ele nao estiver.
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

/**
 * A4 nas medidas EXATAS da arte (`MediaBox` do PDF de origem), e nao os 595x842
 * arredondados. Como todas as coordenadas abaixo foram medidas na propria arte,
 * arredondar a pagina deslocaria o texto em relacao a ela. Mesma escolha de
 * `pdf-declaracao.ts`.
 */
const PAGINA = { largura: 595.276, altura: 841.89 };

/**
 * A MARGEM E A COLUNA DE TEXTO DO PROPRIO TIMBRADO: o titulo impresso, o risco
 * embaixo dele e o endereco no pe comecam todos a 69pt da borda, e a coluna
 * deles termina a 525pt (as duas linhas centralizadas da arte tem centro em
 * 297,2pt, que e o meio exato desse intervalo). Alinhar a tabela com eles e o
 * que faz a folha parecer um documento so, em vez de uma tabela solta por cima
 * de um papel timbrado.
 *
 * Ela e maior que os 40pt do layout antigo porque esta arte tem a banda azul na
 * lateral esquerda (0 a 44,2pt): a tabela comeca depois dela, nao em cima.
 */
const MARGEM = 69;

/**
 * A FAIXA BRANCA UTIL, medida na arte:
 *
 * - `topo`: o risco do titulo termina em 191,5pt; a identificacao comeca abaixo.
 * - `base`: o bloco de emissao do pe comeca em 708,1pt.
 * - as curvas do canto inferior direito entram a partir de 629pt, mas nunca a
 *   esquerda de 530pt — 5pt a direita da borda da tabela. E por isso que a
 *   largura util nao pode crescer para a direita, mesmo havendo papel ali.
 *
 * ⚠️ `base` ERA 733,7pt ATE A ARTE DE 22/09/2026 ganhar o BLOCO DE ENDERECO no
 * pe ("QS 07 - Lote 01 - EPCT ... ucb.catolica.edu.br", de 750,6 a 829,3pt). O
 * bloco empurrou as duas linhas de emissao 25,6pt para cima, e com elas o teto
 * da tabela. Sao ~25pt de area util a menos — na pratica uma linha de aluno por
 * folha. Quem trocar a arte de novo tem de remedir isto: nada no codigo percebe
 * que o rodape desceu, e a tabela passaria a escrever por cima dele.
 */
const AREA_UTIL = { topo: 191.5, base: 708.1 };

/**
 * O QUE A LINHA DE TOTAL PRECISA no pe da tabela: o respiro ate ela, a altura do
 * texto, e a folga ate o bloco de emissao impresso na arte. Sem reservar isso, a
 * sala que enchesse a pagina escreveria o total por cima da arte.
 */
const ESPACO_DO_TOTAL = 26;

/** A ultima linha de base que a tabela pode ocupar. */
const LIMITE_DAS_LINHAS = AREA_UTIL.base - ESPACO_DO_TOTAL;

/**
 * As colunas, na ordem, com a largura de cada. A soma tem que dar a largura util
 * (525 - 69 = 456pt); e por isso que elas sao declaradas juntas, num lugar so —
 * mexer numa sem mexer noutra desalinharia a moldura da tabela do conteudo dela.
 *
 * ⚠️ SAO 59pt MAIS ESTREITAS QUE NO LAYOUT ANTIGO, porque a banda azul da arte
 * comeu a margem esquerda. O corte saiu quase todo de `Nº` e `RA`, que sobravam
 * (um RA e "UC26420": 38pt de texto em 85pt de coluna), para que `Nome` perdesse
 * so 15pt — e o nome que quebra em duas linhas e encompridar a folha — e
 * `Formato` continuasse cabendo "Semipresencial" (61,5pt) numa linha so.
 */
const COLUNAS = [
  { titulo: 'Nº', largura: 24 },
  { titulo: 'RA', largura: 62 },
  { titulo: 'Nome', largura: 200 },
  { titulo: 'Formato', largura: 70 },
  { titulo: 'Assinatura', largura: 100 },
] as const;

/** Onde uma mao consegue assinar. Nao e o tamanho da fonte. */
const ALTURA_MINIMA = 22;

/** Respiro dentro da celula, para o texto nao encostar na borda. */
const PADDING = 4;

const FONTE_TEXTO = 9;

/**
 * A IDENTIFICACAO DA FOLHA, em DUAS linhas e nao em tres como antes: o titulo
 * saiu (a arte ja o traz) e cada linha economizada e uma linha de aluno a mais
 * na pagina.
 *
 * - `sala`, em cima e em negrito, porque e o que o fiscal procura na pilha;
 * - `quando`, embaixo, com formato, dia e horario na mesma linha.
 *
 * As bases sao contadas A PARTIR DO RISCO do titulo impresso (`AREA_UTIL.topo`),
 * e nao de um numero solto: 20pt ate a primeira, 16pt entre elas, e a tabela
 * comeca 12pt depois da segunda.
 */
const IDENTIFICACAO = {
  sala: { base: AREA_UTIL.topo + 20, tamanho: 11 },
  quando: { base: AREA_UTIL.topo + 36, tamanho: 10 },
  /** Onde a tabela comeca, logo abaixo das duas linhas. */
  topoDaTabela: AREA_UTIL.topo + 48,
};

/** Cinza do cabecalho da tabela — o mesmo da planilha de origem. */
const FUNDO_DO_CABECALHO = '#d9d9d9';
const BORDA = '#000000';

/** Azul da marca, lido da propria arte — usado so na linha da sala. */
const AZUL = '#1f3f80';

const LARGURA_DA_TABELA = COLUNAS.reduce((soma, c) => soma + c.largura, 0);

// -------------------------------------------------------------------- fontes

/**
 * Helvetica das 14 fontes-padrao do PDF, com `WinAnsiEncoding` — que cobre
 * Latin-1 inteiro e, com ele, todo acento do portugues ("VINÍCIUS",
 * "ALARÇÃO", "Câmpus"). E o que dispensa embutir um arquivo de fonte no
 * repositorio; se algum dia o documento precisar de um caractere fora do
 * Latin-1, ai sim entra uma TTF.
 *
 * A arte usa outra familia, mas ela vem embutida na imagem: e pixel, nao texto,
 * entao nao ha o que casar. Mesma escolha (e mesmo limite) da declaracao.
 */
const REGULAR = 'Helvetica';
const NEGRITO = 'Helvetica-Bold';

/** O ascender da Helvetica, para converter base de texto em topo de caixa. */
function topoDaCaixa(base: number, tamanho: number): number {
  return base - (718 / 1000) * tamanho;
}

// ------------------------------------------------------------------ desenho

type Doc = typeof PDFDocument extends new (...args: never[]) => infer T
  ? T
  : never;

/**
 * O PDF inteiro: uma pagina (ou mais) por sala, na ordem em que vierem.
 *
 * Devolve `Buffer` e nao stream porque o consumidor e um download HTTP de
 * arquivo pequeno (centenas de KB), e o `StreamableFile` do Nest precisa do
 * tamanho para o `Content-Length` — sem ele o navegador nao mostra progresso.
 */
export function pdfDeListasDePresenca(
  listas: ListaDePresenca[],
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGINA.largura, PAGINA.altura],
    margin: 0,
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

  const arte = caminhoDoModelo();

  for (const lista of listas) desenharLista(doc, lista, arte);

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
  arte: string | null,
): void {
  abrirPagina(doc, lista, arte, false);

  let y = desenharCabecalhoDaTabela(doc, IDENTIFICACAO.topoDaTabela);

  lista.alunos.forEach((aluno, indice) => {
    const altura = alturaDaLinha(doc, aluno);

    // A quebra e decidida ANTES de desenhar: uma linha cortada ao meio pela
    // borda da pagina deixaria uma assinatura sem nome do outro lado.
    if (y + altura > LIMITE_DAS_LINHAS) {
      abrirPagina(doc, lista, arte, true);
      y = desenharCabecalhoDaTabela(doc, IDENTIFICACAO.topoDaTabela);
    }

    y = desenharLinha(doc, y, altura, [
      String(indice + 1),
      aluno.matricula,
      aluno.nome ?? '—',
      aluno.modalidade,
      '',
    ]);
  });

  desenharTotal(doc, y, lista);
}

/**
 * Folha nova: o timbrado por baixo e, por cima dele, as duas linhas que
 * identificam a sala — repetidas em TODA pagina, inclusive nas continuacoes.
 */
function abrirPagina(
  doc: Doc,
  lista: ListaDePresenca,
  arte: string | null,
  continuacao: boolean,
): void {
  doc.addPage();

  desenharModelo(doc, arte);
  desenharIdentificacao(doc, lista, continuacao);
}

/**
 * A arte do timbrado, folha inteira.
 *
 * Vai esticada de canto a canto (`width`/`height`, e nao `fit`) porque a arte e
 * exatamente uma A4, na mesma medida de `PAGINA`. Deixar `fit` a centralizaria
 * com uma tira branca em duas bordas, que numa arte de sangrar aparece na
 * impressao.
 *
 * ⚠️ O ARGUMENTO E O CAMINHO, E NAO O `Buffer` — e isso que faz a imagem entrar
 * UMA vez no arquivo. O `pdfkit` guarda um `_imageRegistry` indexado pela
 * `string` de origem: com o caminho ele le e embute o PNG na primeira pagina e
 * reaproveita o mesmo XObject nas outras. Passando `Buffer` ele nao tem chave
 * para indexar, e um semestre de listas sairia com 370KB de arte REPETIDOS em
 * cada uma das centenas de paginas.
 */
function desenharModelo(doc: Doc, arte: string | null): void {
  if (!arte) return;

  doc.image(arte, 0, 0, {
    width: PAGINA.largura,
    height: PAGINA.altura,
  });
}

/**
 * As duas linhas que dizem de que folha se trata, logo abaixo do titulo impresso
 * na arte.
 *
 * ⚠️ `height` de uma linha so, com `ellipsis`. `Sala.nome` e `Polo.nome` sao
 * cadastro livre: sem teto, um nome absurdamente longo quebraria para uma
 * segunda linha e escreveria por cima da linha de baixo — ou, pior, por cima do
 * cabecalho da tabela. Uma reticencia visivel e um defeito que alguem reporta;
 * duas linhas sobrepostas parecem tinta borrada na impressao.
 */
function desenharIdentificacao(
  doc: Doc,
  lista: ListaDePresenca,
  continuacao: boolean,
): void {
  const largura = LARGURA_DA_TABELA;
  const { sala, quando } = IDENTIFICACAO;

  doc
    .font(NEGRITO)
    .fontSize(sala.tamanho)
    .fillColor(AZUL)
    .text(
      `${lista.sala} — ${lista.polo}${continuacao ? ' (cont.)' : ''}`,
      MARGEM,
      topoDaCaixa(sala.base, sala.tamanho),
      { width: largura, height: sala.tamanho * 1.2, ellipsis: true },
    );

  doc
    .font(REGULAR)
    .fontSize(quando.tamanho)
    .fillColor(BORDA)
    .text(
      `${lista.modalidade}  ·  ${dataDaProva(lista.data)}  ·  ${lista.horaInicio} às ${lista.horaFim}`,
      MARGEM,
      topoDaCaixa(quando.base, quando.tamanho),
      { width: largura, height: quando.tamanho * 1.2, ellipsis: true },
    );
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
 *
 * Fica logo abaixo da tabela, e nao numa altura fixa no pe: numa sala de tres
 * alunos ele ficaria a meia folha de distancia da ultima linha, solto no meio do
 * branco. O espaco de que ele precisa ja esta descontado de `LIMITE_DAS_LINHAS`,
 * entao ele nunca alcanca o texto de emissao impresso na arte.
 */
function desenharTotal(doc: Doc, y: number, lista: ListaDePresenca): void {
  doc
    .font(REGULAR)
    .fontSize(FONTE_TEXTO)
    .fillColor('#555555')
    .text(`Total: ${lista.alunos.length} aluno(s) nesta sala.`, MARGEM, y + 6, {
      width: LARGURA_DA_TABELA,
      align: 'right',
    });
}

// -------------------------------------------------------------------- modelo

/**
 * `dist/` (build) e `src/` (dev, e tambem producao) — o `nest build` copia
 * `**\/*.png` para o `dist` (ver `nest-cli.json`), e a imagem Docker leva o `src`
 * inteiro. Procurar nos dois cobre os dois jeitos de a aplicacao subir.
 */
const CAMINHOS_DO_MODELO = [
  join(__dirname, '..', 'assets', 'modelo-lista-presenca.png'),
  join(
    process.cwd(),
    'src',
    'relatorio',
    'assets',
    'modelo-lista-presenca.png',
  ),
];

/**
 * O CAMINHO, e nao o conteudo — ver `desenharModelo`. Resolvido uma vez por
 * documento: sao centenas de paginas num semestre, e um `existsSync` por pagina
 * seria I/O sincrono dentro do laco.
 */
function caminhoDoModelo(): string | null {
  for (const caminho of CAMINHOS_DO_MODELO) {
    if (existsSync(caminho)) return caminho;
  }

  return null;
}
