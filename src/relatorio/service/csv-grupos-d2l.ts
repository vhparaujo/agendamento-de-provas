import { montarCsv } from '../../agendamento/service/csv-relatorio';

/**
 * ============================================================================
 * CSV DE GRUPOS PARA O BRIGHTSPACE — O FORMATO E O OPOSTO DO OUTRO
 * ============================================================================
 * Este arquivo NAO e lido por pessoa no Excel: ele e enviado ao *Groups Import*
 * do Brightspace, que espera VIRGULA e UTF-8 puro. Sao exatamente as duas
 * escolhas contrarias as do CSV da administracao (`;` + BOM, em
 * `agendamento/service/csv-relatorio.ts`), e trocar uma pela outra quebra em
 * silencio:
 *
 * - com `;`, o D2L le a linha inteira como um campo so e nao acha as colunas;
 * - com BOM, os tres bytes grudam no inicio do cabecalho e `Nome de usuário`
 *   deixa de casar com o nome da coluna esperada.
 *
 * O cabecalho e copiado do arquivo de exemplo do proprio Brightspace
 * (`Groups_Import_Sample_File.csv`), com acento e tudo — e o texto que o import
 * compara.
 */

/**
 * Sao so estas duas colunas, de proposito.
 *
 * O exemplo do Brightspace traz cinco (`ACTION`, `Nome de usuário`,
 * `ID Definido da Organização`, `Nome do Grupo`, `Código do Grupo`), mas as
 * outras tres nao tem origem no nosso banco: quem monta o grupo preenche o
 * codigo a mao depois de criar o grupo no D2L. Emitir colunas vazias que ninguem
 * preenche so daria a impressao de que o sistema deveria saber o valor.
 */
export const CABECALHOS_GRUPOS_D2L = ['Nome de usuário', 'Código do Grupo'];

/**
 * Uma linha por matricula, com o codigo do grupo VAZIO — preenchido a mao.
 */
export function csvDeGrupos(matriculas: string[]): string {
  return montarCsv(
    CABECALHOS_GRUPOS_D2L,
    matriculas.map((matricula) => [matricula, '']),
    { separador: ',', bom: false },
  );
}
