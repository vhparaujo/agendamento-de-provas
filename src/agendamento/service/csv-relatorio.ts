/**
 * ============================================================================
 * GERACAO DO CSV DE RELATORIO
 * ============================================================================
 * O arquivo e aberto no Excel por gente da secretaria, num Windows em pt-BR.
 * Tres detalhes decidem se ele abre certo ou vira uma coluna so de lixo:
 *
 * 1. SEPARADOR `;` — o Excel em pt-BR usa ponto e virgula. Com virgula, a
 *    planilha inteira cai numa coluna unica e alguem precisa reimportar na mao.
 * 2. BOM UTF-8 — sem ele o Excel assume a codificacao do sistema (Windows-1252)
 *    e "Câmpus Ceilândia" chega como "CÃ¢mpus CeilÃ¢ndia".
 * 3. CRLF — a quebra de linha que o Excel espera.
 *
 * O separador tambem e a razao de escapar aspas conforme o RFC 4180: campo com
 * `;`, aspas ou quebra de linha vai entre aspas, e aspas internas viram duplas.
 */

export const BOM_UTF8 = '﻿';
const SEPARADOR = ';';
const QUEBRA = '\r\n';

/**
 * Caracteres que fazem o Excel/LibreOffice tratar a celula como FORMULA.
 *
 * Isto e uma vulnerabilidade real (CSV/formula injection), nao teoria: os nomes
 * e cursos vem de planilhas enviadas por terceiros, e nada impede uma celula
 * comecando com `=`. Aberta no Excel, `=HYPERLINK(...)` ou `=cmd|...` executa no
 * computador de quem abriu o relatorio — com os privilegios daquela pessoa.
 *
 * Sanitizar na IMPORTACAO seria errado (corromperia o dado gravado); a defesa
 * correta e na saida, aqui.
 */
const INICIO_DE_FORMULA = /^[=+\-@\t\r]/;

function neutralizar(valor: string): string {
  // A aspa simples e a convencao do proprio Excel para "isto e texto": ela nao
  // aparece na celula, mas impede a interpretacao como formula.
  return INICIO_DE_FORMULA.test(valor) ? `'${valor}` : valor;
}

/**
 * O que pode virar celula. O tipo e estreito de proposito: aceitar `unknown`
 * deixaria um objeto passar e sair como "[object Object]" no meio do relatorio,
 * sem erro nenhum.
 */
export type Celula = string | number | boolean | null | undefined;

/** Uma celula pronta para o CSV: neutralizada e, se precisar, entre aspas. */
export function celula(valor: Celula): string {
  if (valor === null || valor === undefined) return '';

  const texto = neutralizar(String(valor));

  if (/["\r\n;]/.test(texto)) {
    return `"${texto.replace(/"/g, '""')}"`;
  }

  return texto;
}

export function montarCsv(cabecalhos: string[], linhas: Celula[][]): string {
  const conteudo = [cabecalhos, ...linhas]
    .map((linha) => linha.map(celula).join(SEPARADOR))
    .join(QUEBRA);

  // A quebra final evita que alguns leitores descartem a ultima linha.
  return `${BOM_UTF8}${conteudo}${QUEBRA}`;
}

/**
 * Data no formato que a secretaria le, no fuso de Brasilia.
 *
 * Nao usamos ISO aqui de proposito: o relatorio e para pessoa, nao para maquina.
 * A exportacao guarda `criadoEm` com hora porque "quem agendou primeiro" e a
 * pergunta que aparece quando duas pessoas reclamam da mesma vaga.
 */
export function dataBr(
  valor: Date | null | undefined,
  comHora = false,
): string {
  if (!valor) return '';

  return valor.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    ...(comHora ? { timeStyle: 'short' } : {}),
  });
}

/** Só a data (a coluna da faixa e @db.Date, gravada em meia-noite UTC). */
export function dataDaProva(valor: Date): string {
  return valor.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}
