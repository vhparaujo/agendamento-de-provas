import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';

export type LinhaCsv = Record<string, string>;

/**
 * Os arquivos reais da UCB sao ISO-8859-1 (latin1) — ler como UTF-8 estraga todo
 * acento ("Câmpus Ceilândia" viraria lixo, e o polo deixaria de casar pelo nome).
 *
 * Mas a planilha pode ser reexportada em UTF-8 a qualquer momento, e ai o erro
 * seria o oposto. Entao detectamos: se os bytes formam UTF-8 valido COM
 * caracteres multibyte, e UTF-8; caso contrario, latin1. Arquivo so-ASCII da no
 * mesmo nos dois casos.
 */
export function decodificarCsv(buffer: Buffer): string {
  // BOM de UTF-8 e prova definitiva
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return buffer.subarray(3).toString('utf8');
  }

  const temByteAlto = buffer.some((b) => b >= 0x80);
  if (!temByteAlto) return buffer.toString('utf8');

  try {
    // fatal: rejeita sequencias invalidas em vez de trocar por U+FFFD
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

/**
 * Parse com cabecalho. `columns: true` usa a primeira linha como nome dos campos;
 * `bom` e `relax_column_count` evitam quebrar por detalhes de exportacao.
 */
export function lerCsv(buffer: Buffer): LinhaCsv[] {
  const texto = decodificarCsv(buffer);

  try {
    return parse(texto, {
      columns: (cabecalho: string[]) => cabecalho.map((c) => c.trim()),
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (erro) {
    throw new BadRequestException(
      `Nao foi possivel ler o CSV: ${erro instanceof Error ? erro.message : String(erro)}`,
    );
  }
}

/** Le uma coluna tolerando variacao de caixa e espacos no cabecalho. */
export function coluna(linha: LinhaCsv, nome: string): string {
  const direto = linha[nome];
  if (direto !== undefined) return direto.trim();

  const alvo = nome.trim().toLowerCase();
  for (const [chave, valor] of Object.entries(linha)) {
    if (chave.trim().toLowerCase() === alvo) return (valor ?? '').trim();
  }

  return '';
}

/** Confere que o arquivo tem as colunas esperadas antes de processar 7 mil linhas. */
export function exigirColunas(
  linhas: LinhaCsv[],
  obrigatorias: string[],
): void {
  if (linhas.length === 0) {
    throw new BadRequestException('CSV vazio (nenhuma linha de dados)');
  }

  const presentes = new Set(
    Object.keys(linhas[0]).map((c) => c.trim().toLowerCase()),
  );

  const faltando = obrigatorias.filter(
    (c) => !presentes.has(c.trim().toLowerCase()),
  );

  if (faltando.length > 0) {
    throw new BadRequestException(
      `Colunas ausentes no CSV: ${faltando.join(', ')}. ` +
        `Encontradas: ${Object.keys(linhas[0]).join(', ')}`,
    );
  }
}
