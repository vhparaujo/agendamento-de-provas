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
 * O layout e o MODELO DA DECLARACAO desenhado pela instituicao
 * (`assets/modelo-declaracao.png`): banda azul na lateral esquerda, marca
 * Catolica EAD no alto a esquerda, selo Great Place to Work no alto a direita,
 * curvas no rodape a direita e o endereco da unidade no pe.
 *
 * ---------------------------------------------------------------------------
 * O QUE ESTA ARTE TRAZ DE DIFERENTE: O TITULO E A ASSINATURA VEM NELA
 * ---------------------------------------------------------------------------
 * O timbrado anterior era so o papel — titulo e assinatura eram desenhados aqui,
 * em Helvetica. Este modelo ja traz os dois impressos, na fonte da marca:
 *
 *   - "DECLARACAO", em azul, alinhado a esquerda, com o risco embaixo;
 *   - o bloco de assinatura ("Universidade Catolica de Brasilia" + "Documento
 *     emitido automaticamente pelo Sistema de Agendamento"), centralizado.
 *
 * Por isso este modulo nao os desenha mais: redesenha-los por cima duplicaria o
 * texto, e reescreve-los em Helvetica ao lado de um titulo na fonte da marca
 * faria a folha parecer montada em dois lugares — que e exatamente o que ela e.
 * O `pdfkit` imprime UMA coisa nesta pagina: o paragrafo.
 *
 * A FRASE E O MESMO TEXTO DE SEMPRE. Mudou onde e como ela e impressa;
 * `textoDaDeclaracao` nao foi tocada, e o teste dela continua valendo palavra
 * por palavra.
 *
 * O QR code e as duas linhas de validacao do documento antigo continuam de fora,
 * por decisao do cliente: apontavam para o `ValidacaoCertificados` do fornecedor
 * anterior, que nao existe deste lado — um QR que leva a lugar nenhum e pior que
 * nenhum QR, porque convida a conferir.
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
 * A4 nas medidas EXATAS da arte (`MediaBox` do PDF de origem), e nao os 595x842
 * arredondados de antes. Como todas as coordenadas abaixo foram medidas na
 * propria arte, arredondar a pagina deslocaria o texto em relacao a ela.
 */
const PAGINA = { largura: 595.276, altura: 841.89 };

/**
 * A MARGEM E A COLUNA DE TEXTO DO PROPRIO MODELO: o titulo, o risco embaixo dele
 * e o endereco no pe comecam todos a 68,1pt da borda. Alinhar o paragrafo com
 * eles e o que faz a folha parecer um documento so, em vez de um texto solto por
 * cima de um papel timbrado.
 *
 * Ela e maior que os 46pt do timbrado antigo porque esta arte tem a banda azul
 * na lateral esquerda (0 a 43,7pt): o texto comeca depois dela, nao em cima.
 */
const MARGEM = 68;
const LARGURA_UTIL = PAGINA.largura - 2 * MARGEM;

/**
 * A FAIXA BRANCA UTIL vai do risco do titulo (termina em 220,4pt) ao topo do
 * bloco de assinatura (comeca em 527,1pt) — nesse intervalo a arte nao tem nada
 * fora da banda lateral, e e nele que o paragrafo tem de caber inteiro.
 */
const LIMITE_INFERIOR = 520;

const CORPO = {
  tamanho: 11,
  /**
   * A primeira LINHA DE BASE, 44pt abaixo do risco do titulo — o mesmo respiro
   * que o layout anterior tinha entre os dois.
   */
  base: 264,
  /**
   * ALINHADO A ESQUERDA, E NAO JUSTIFICADO — foi o preco do negrito no meio da
   * frase, pago de propria vontade.
   *
   * O `pdfkit` justifica CADA trecho continuado por conta propria: ele reparte a
   * sobra da linha entre os espacos daquele trecho, sem enxergar os vizinhos.
   * Numa linha que atravessa uma emenda (e o nome do aluno garante que a
   * primeira sempre atravessa), o pedaco em negrito sai com espaco normal e o
   * seguinte recebe a sobra inteira — "está     matriculado(a)", um rio de
   * branco no meio da unica frase do documento.
   *
   * Entre uma margem direita irregular e um paragrafo esburacado, a irregular e
   * a que ninguem estranha: e como sai qualquer carta. A ultima linha ja saia
   * assim de todo jeito.
   */
  alinhamento: 'left' as const,
  /**
   * Entrelinha de 18pt, base a base. A Helvetica 11 do `pdfkit` ja ocupa 12,72
   * (ascender + descender + gap da propria fonte), entao o que falta e o
   * `lineGap`.
   */
  espacoEntreLinhas: 18 - (1156 / 1000) * 11,
};

/**
 * Helvetica das 14 fontes-padrao do PDF, com `WinAnsiEncoding` — cobre Latin-1
 * inteiro e, com ele, todo acento e cedilha do portugues ("declaração",
 * "VINÍCIUS"), sem embutir arquivo de fonte no repositorio. Mesma escolha (e
 * mesmo limite) da lista de presenca.
 *
 * A arte usa outra familia, mas ela vem embutida na imagem: e pixel, nao texto,
 * entao nao ha o que casar. Trocar a Helvetica por uma fonte proxima exigiria
 * versionar o arquivo `.ttf` e o direito de uso dele — custo que so faz sentido
 * se o cliente pedir.
 */
const REGULAR = 'Helvetica';
const NEGRITO = 'Helvetica-Bold';
const PRETO = '#000000';

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

/** Um trecho da frase e o peso com que ele e impresso. */
export interface PedacoDaDeclaracao {
  texto: string;
  negrito: boolean;
}

/**
 * A FRASE EM PEDACOS, porque tres deles saem em NEGRITO.
 *
 * Quem le a declaracao no balcao do RH procura tres coisas — de quem e, sob que
 * RA, e para quando. Sao justamente os tres campos que vem de fora (o CSV e a
 * faixa); todo o resto da frase e formula. O negrito os separa da formula sem
 * mudar uma palavra do que esta escrito.
 *
 * ⚠️ O HORARIO ENTRA JUNTO COM A DATA, no mesmo pedaco. Sao a mesma informacao
 * para quem justifica uma ausencia ("12 de junho de 2026 às 15:01"), e destacar
 * so o dia deixaria a hora — a metade que decide se a pessoa perde a manha ou a
 * tarde — em peso menor, no meio da mesma oracao.
 *
 * ⚠️ O ESPACO DE CADA EMENDA FICA NO FIM DO PEDACO DE CIMA, nunca no comeco do
 * de baixo (`\`${dados.nome} \`` e nao `' está matriculado(a)'`). O `pdfkit`
 * apara o branco do inicio de um trecho continuado, e a frase sai com as
 * palavras coladas — "SANTOSestá". Como o espaco tambem entra em
 * `textoDaDeclaracao`, mover a emenda de lado nao muda a frase, so quem a
 * imprime.
 *
 * "realizou o agendamento" no passado e proposital: a declaracao so existe
 * depois de o prazo encerrar, quando a escolha ja aconteceu e nao muda mais.
 */
export function pedacosDaDeclaracao(
  dados: DeclaracaoDeAgendamento,
): PedacoDaDeclaracao[] {
  return [
    { texto: 'Declaramos, para os devidos fins, que ', negrito: false },
    { texto: `${dados.nome} `, negrito: true },
    { texto: 'está matriculado(a) sob o RA ', negrito: false },
    { texto: `${dados.matricula} `, negrito: true },
    {
      texto:
        'e realizou o agendamento para realização da prova presencial no dia ',
      negrito: false,
    },
    {
      texto: `${dataPorExtenso(dados.data)} às ${dados.horario}`,
      negrito: true,
    },
  ];
}

/**
 * A frase inteira, exportada para que o teste a leia sem abrir o PDF.
 *
 * E A SOMA DOS PEDACOS, e nao uma segunda copia do texto: com duas listas de
 * palavras, mexer no negrito de um trecho passaria a poder mudar a frase que o
 * teste protege — e a divergencia so apareceria no papel, ja assinado. Assim ha
 * um texto so, e o negrito nao alcanca o que ele diz.
 */
export function textoDaDeclaracao(dados: DeclaracaoDeAgendamento): string {
  return pedacosDaDeclaracao(dados)
    .map((pedaco) => pedaco.texto)
    .join('');
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

  // Primeiro de tudo: o paragrafo e escrito POR CIMA da arte.
  desenharModelo(doc);

  const topo = topoDaCaixa(CORPO.base, CORPO.tamanho);
  const pedacosDaFrase = pedacosDaDeclaracao(dados);

  doc.fontSize(CORPO.tamanho).fillColor(PRETO);

  /**
   * UM `text()` POR PEDACO, amarrados por `continued`.
   *
   * `continued: true` diz ao `pdfkit` que o proximo trecho segue na MESMA linha,
   * de onde este parou — e nao num paragrafo novo. E o que permite trocar a
   * fonte no meio da frase sem quebrar a linha, e o que faz a quebra e a
   * justificacao continuarem sendo do paragrafo inteiro, e nao de cada pedaco.
   *
   * As opcoes vao repetidas em todas as chamadas de proposito: o `pdfkit` guarda
   * as da primeira, mas depender disso deixaria a largura e o teto do paragrafo
   * escritos num lugar so por acidente de implementacao. So o ultimo pedaco fecha
   * o texto (`continued: false`) — sem isso o paragrafo fica aberto e a proxima
   * coisa desenhada na pagina entraria coladinha nele.
   */
  pedacosDaFrase.forEach((pedaco, i) => {
    const ultimo = i === pedacosDaFrase.length - 1;

    doc.font(pedaco.negrito ? NEGRITO : REGULAR);

    const opcoes = {
      continued: !ultimo,
      width: LARGURA_UTIL,
      /**
       * O TETO EXISTE PARA QUE A FOLHA CONTINUE SENDO UMA FOLHA.
       *
       * `AlunoImportado.nome` vem do CSV e nao tem limite de tamanho. Sem
       * `height`, um nome absurdo faria o `pdfkit` seguir escrevendo por cima da
       * assinatura impressa na arte e, passando do pe da pagina, ABRIR UMA
       * SEGUNDA PAGINA — em branco, sem o modelo, com o fim da frase solto nela.
       * Com o teto, o texto para na area branca e o `ellipsis` marca onde parou:
       * uma reticencia visivel e um defeito que alguem reporta; uma pagina 2 em
       * branco parece o documento normal.
       */
      height: LIMITE_INFERIOR - topo,
      ellipsis: true,
      align: CORPO.alinhamento,
      lineGap: CORPO.espacoEntreLinhas,
    };

    // O primeiro posiciona a caixa; os outros continuam de onde ele parou.
    if (i === 0) doc.text(pedaco.texto, MARGEM, topo, opcoes);
    else doc.text(pedaco.texto, opcoes);
  });

  doc.end();

  return pronto;
}

/**
 * A arte do modelo, folha inteira, se o arquivo estiver la.
 *
 * OPCIONAL pelo mesmo motivo do logo da lista de presenca: o documento continua
 * valido sem ela — o que declara e o texto —, e derrubar o download por causa de
 * um `.png` ausente trocaria um papel imperfeito por papel nenhum. A diferenca e
 * que este arquivo VAI versionado no repositorio, porque e a identidade visual
 * que o cliente pediu; a tolerancia existe para o caso de o build nao te-lo
 * copiado.
 *
 * ⚠️ Sem ela a folha sai SEM TITULO E SEM ASSINATURA, e nao apenas sem o papel:
 * os dois moram na arte. E mais uma razao para o `.png` estar sempre no lugar,
 * nao para o download falhar quando ele nao estiver.
 *
 * Vai esticada de canto a canto (`width`/`height`, e nao `fit`) porque a arte e
 * exatamente uma A4, na mesma medida de `PAGINA`. Deixar `fit` a centralizaria
 * com uma tira branca em duas bordas, que numa arte de sangrar aparece na
 * impressao.
 */
function desenharModelo(doc: Doc): void {
  const arte = carregarModelo();

  if (!arte) return;

  doc.image(arte, 0, 0, {
    width: PAGINA.largura,
    height: PAGINA.altura,
  });
}

// -------------------------------------------------------------------- modelo

/**
 * `dist/` (build) e `src/` (dev, e tambem producao) — o `nest build` copia
 * `**\/*.png` para o `dist` (ver `nest-cli.json`), e a imagem Docker leva o `src`
 * inteiro. Procurar nos dois cobre os dois jeitos de a aplicacao subir.
 */
const CAMINHOS_DO_MODELO = [
  join(__dirname, '..', 'assets', 'modelo-declaracao.png'),
  join(process.cwd(), 'src', 'agendamento', 'assets', 'modelo-declaracao.png'),
];

function carregarModelo(): Buffer | null {
  for (const caminho of CAMINHOS_DO_MODELO) {
    if (existsSync(caminho)) return readFileSync(caminho);
  }

  return null;
}
