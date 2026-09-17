import { dataDaProva } from '../../agendamento/service/csv-relatorio';

/**
 * ============================================================================
 * COMO A LISTA DE PRESENCA SE CHAMA
 * ============================================================================
 * O nome identifica a folha antes de ela ser aberta, porque quem baixa varias
 * de uma vez precisa saber qual e qual na pasta de downloads:
 *
 *   Lista de presenca - 11-06-2026 09h00-12h00 - Campus Asa Sul - SALA 1 EAD.pdf
 *   \______ o que e _____/ \____ o horario ____/ \___ polo ___/ \__ sala __/
 *
 * ---------------------------------------------------------------------------
 * POR QUE O NOME PERDE OS ACENTOS
 * ---------------------------------------------------------------------------
 * "Taguatinga Norte" vira "Taguatinga Norte" e "Educacao Fisica" perde o til so
 * no NOME; na tela e dentro do PDF o texto continua inteiro, com acento. Nome
 * de arquivo atravessa lugares que tratam
 * codificacao de jeitos diferentes — o `Content-Disposition` (que precisaria do
 * `filename*=UTF-8''` do RFC 5987 para nao chegar corrompido) e o proprio
 * sistema de arquivos de quem baixa. Em ASCII puro nao ha o que negociar em
 * nenhum dos dois, e o custo e um acento que ninguem procura ao abrir a pasta.
 */

/** `:` quebra no Windows; `/` e `\` seriam lidos como diretorio. */
const INVALIDOS = /[\\/:*?"<>|]/g;

/** Fora do ASCII imprimivel: sobra do que a dobra de acento nao resolveu. */
const FORA_DO_ASCII = /[^\x20-\x7e]/g;

/**
 * Limite por segmento. Nome de polo e de sala chegam longos, e o nome final
 * junta quatro partes: sem corte, o total passa dos 255 bytes que a maioria dos
 * sistemas de arquivos aceita por componente, e a gravacao falha.
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
 * `Lista de presenca - 11-06-2026 09h00-12h00 - Campus Asa Sul - SALA 1 EAD.pdf`
 *
 * O POLO entra no nome porque as folhas de dois campi no mesmo dia e horario vao
 * para lugares fisicos diferentes, e quem baixa precisa saber de qual campus e o
 * arquivo antes de abrir. E tambem o que torna o nome unico — sala com o mesmo
 * nome em dois polos e comum.
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
