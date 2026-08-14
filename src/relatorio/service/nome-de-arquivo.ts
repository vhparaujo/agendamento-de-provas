import { dataDaProva } from '../../agendamento/service/csv-relatorio';

/**
 * ============================================================================
 * COMO OS ARQUIVOS DE GRUPO SE CHAMAM
 * ============================================================================
 * Um arquivo identifica DUAS coisas: o horario da prova e a turma. As duas
 * precisam aparecer no nome, porque e por ele que a pessoa acha o arquivo certo
 * na pasta de downloads — o conteudo e uma lista de matriculas, sem cabecalho
 * que diga de que prova e.
 *
 *   20-08-2026 08h30-11h30 - GSPS0I10227 - HISTORIA E CULTURA DO CORPO.csv
 *   \_________ o horario __/   \_ turma _/   \_______ disciplina _______/
 *
 * Dentro do zip a mesma identificacao vira PASTA, e o arquivo fica so com o
 * horario. E o formato que acompanha o trabalho real: a pessoa abre a turma no
 * Brightspace e importa, um a um, os horarios daquela turma — procurar arquivo
 * no meio de centenas soltos na raiz seria o gargalo.
 *
 *   GSPS0I10227 - HISTORIA E CULTURA DO CORPO/
 *       20-08-2026 08h30-11h30.csv
 *       20-08-2026 14h00-17h00.csv
 *
 * ---------------------------------------------------------------------------
 * POR QUE O NOME PERDE OS ACENTOS
 * ---------------------------------------------------------------------------
 * "HISTÓRIA" vira "HISTORIA" so no NOME; na tela e dentro do CSV o nome da
 * disciplina continua inteiro. Nome de arquivo atravessa lugares que tratam
 * codificacao de jeitos diferentes — o `Content-Disposition` (que precisaria do
 * `filename*=UTF-8''` do RFC 5987 para nao chegar corrompido), a tabela de
 * nomes do zip, e o proprio sistema de arquivos de quem baixa. Em ASCII puro
 * nao ha o que negociar em nenhum dos tres, e o custo e um acento que ninguem
 * procura ao abrir a pasta.
 */

/** `:` quebra no Windows; `/` e `\` viram diretorio dentro do zip. */
const INVALIDOS = /[\\/:*?"<>|]/g;

/** Fora do ASCII imprimivel: sobra do que a dobra de acento nao resolveu. */
const FORA_DO_ASCII = /[^\x20-\x7e]/g;

/**
 * Limite por segmento. Nomes de disciplina chegam longos ("PRATICAS
 * PROFISSIONAIS EM FISIOTERAPIA E ETICA") e o caminho dentro do zip e pasta +
 * arquivo: sem corte, o total passa dos 255 bytes que a maioria dos sistemas de
 * arquivos aceita por componente, e o unzip falha na hora de gravar.
 */
const LIMITE = 60;

/**
 * Texto pronto para virar nome de arquivo: sem acento, sem caractere proibido e
 * curto o suficiente para caber no caminho.
 */
export function sanear(texto: string): string {
  return (
    texto
      .normalize('NFD')
      // Os diacriticos que o NFD separou da letra base. Depois disto "ç" ja e "c".
      .replace(/[\u0300-\u036f]/g, '')
      .replace(INVALIDOS, ' ')
      .replace(FORA_DO_ASCII, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LIMITE)
      .trim()
      // Nome terminado em ponto e invalido no Windows e some sem aviso.
      .replace(/\.+$/, '')
  );
}

export interface TurmaDoArquivo {
  orgUnitId: string;
  /** Do CSV de turmas. Ausente enquanto o `orgUnitId` nao foi aprendido. */
  codigoTurma: string | null;
  nomeDisciplina: string | null;
}

export interface FaixaDoArquivo {
  data: Date;
  horaInicio: string;
  horaFim: string;
}

/**
 * `20-08-2026 08h30-11h30` — a parte do horario.
 *
 * `/` e `:` sao invalidos em nome de arquivo, entao a data usa `-` e a hora usa
 * `h`. Dispensa `sanear`: o resultado ja e so digito, `-`, `h` e espaco.
 */
export function horarioDaProva(faixa: FaixaDoArquivo): string {
  const dia = dataDaProva(faixa.data).replace(/\//g, '-');
  const inicio = faixa.horaInicio.replace(':', 'h');
  const fim = faixa.horaFim.replace(':', 'h');

  return `${dia} ${inicio}-${fim}`;
}

/**
 * `GSPS0I10227 - HISTORIA E CULTURA DO CORPO` — a parte da turma, usada tanto no
 * nome do arquivo avulso quanto como pasta dentro do zip.
 *
 * O `codigoTurma` vem do CSV de turmas, encontrado pelo `orgUnitId` que o portal
 * aprendeu no launch. Quando ele falta — turma que nunca teve launch, ou
 * `TURMAS_FILTER_ENABLED=false`, que libera disciplina sem cruzar com o CSV — o
 * `orgUnitId` entra no lugar: e feio, mas identifica sem ambiguidade, e um nome
 * generico faria dois grupos diferentes disputarem o mesmo arquivo.
 */
export function identificacaoDaTurma(turma: TurmaDoArquivo): string {
  const codigo = turma.codigoTurma
    ? sanear(turma.codigoTurma)
    : `orgUnit ${sanear(turma.orgUnitId)}`;

  const disciplina = turma.nomeDisciplina ? sanear(turma.nomeDisciplina) : '';

  return disciplina ? `${codigo} - ${disciplina}` : codigo;
}

/** O nome do arquivo baixado avulso, com horario e turma. */
export function nomeDoArquivo(
  faixa: FaixaDoArquivo,
  turma: TurmaDoArquivo,
): string {
  return `${horarioDaProva(faixa)} - ${identificacaoDaTurma(turma)}.csv`;
}

/**
 * `Lista de presenca - 11-06-2026 09h00-12h00 - Campus Asa Sul - SALA 1 EAD.pdf`
 *
 * Aqui o POLO entra no nome, ao contrario do CSV de grupos: as folhas de dois
 * campi no mesmo dia e horario vao para lugares fisicos diferentes, e quem
 * baixa precisa saber de qual campus e o arquivo antes de abrir. E tambem o que
 * torna o nome unico — sala com o mesmo nome em dois polos e comum.
 */
export function nomeDaListaDePresenca(
  pagina: FaixaDoArquivo & { polo: string; sala: string },
): string {
  const partes = [
    'Lista de presenca',
    horarioDaProva(pagina),
    sanear(pagina.polo),
    sanear(pagina.sala),
  ];

  return `${partes.join(' - ')}.pdf`;
}

/**
 * O caminho dentro do zip: uma pasta por turma, o horario como nome do arquivo.
 *
 * Duas faixas do MESMO dia e horario em polos diferentes sao o caso normal de
 * operacao (o polo nao entra em nenhum dos dois nomes, por decisao do cliente) e
 * cairiam no mesmo caminho — dentro de um zip o segundo arquivo sobrescreve o
 * primeiro em silencio. Da segunda em diante, o id da faixa desempata.
 */
export function caminhoNoZip(
  grupo: FaixaDoArquivo & TurmaDoArquivo & { faixaId: number },
  usados: Set<string>,
): string {
  const pasta = identificacaoDaTurma(grupo);
  const caminho = `${pasta}/${horarioDaProva(grupo)}.csv`;

  if (!usados.has(caminho)) {
    usados.add(caminho);
    return caminho;
  }

  return `${pasta}/${horarioDaProva(grupo)} #${grupo.faixaId}.csv`;
}
