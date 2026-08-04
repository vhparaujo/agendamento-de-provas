import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { exigirColunas, lerCsv } from './csv.util';
import { COLUNA_OBRIGATORIA, mapRowToTurma } from './turma-csv.columns';

export interface ResultadoImportacaoTurmas {
  importacaoId: number;
  arquivo: string;
  totalLinhas: number;
  criadas: number;
  atualizadas: number;
  rejeitadas: { linha: number; motivo: string }[];
}

const LOTE = 20;

/**
 * Importacao das turmas reais (as que TERAO prova). Estrutura identica a de
 * alunos: auditoria em ImportacaoCsv e idempotencia — aqui pelo PAR
 * [codigoTurma, nomeDisciplina], que e o que identifica a turma.
 *
 * O mapeamento das colunas vive em turma-csv.columns.ts.
 */
@Injectable()
export class ImportacaoTurmasService {
  private readonly logger = new Logger(ImportacaoTurmasService.name);

  constructor(private readonly prisma: PrismaService) {}

  async importar(
    arquivo: Express.Multer.File,
    importadoPor?: string,
  ): Promise<ResultadoImportacaoTurmas> {
    const linhas = lerCsv(arquivo.buffer);
    exigirColunas(linhas, [COLUNA_OBRIGATORIA]);

    const importacao = await this.prisma.importacaoCsv.create({
      data: {
        tipo: 'TURMAS',
        nomeArquivo: arquivo.originalname,
        totalLinhas: linhas.length,
        importadoPor,
      },
    });

    const rejeitadas: { linha: number; motivo: string }[] = [];
    let criadas = 0;
    let atualizadas = 0;

    for (let inicio = 0; inicio < linhas.length; inicio += LOTE) {
      const lote = linhas.slice(inicio, inicio + LOTE);

      const resultados = await Promise.all(
        lote.map(async (linha, i) => {
          const numero = inicio + i + 1;
          const turma = mapRowToTurma(linha);

          if (!turma) {
            return {
              rejeicao: {
                linha: numero,
                motivo:
                  'codigo da turma ou nome da disciplina vazio — os dois sao ' +
                  'necessarios para identificar a turma',
              },
              criada: false,
            };
          }

          const chave = {
            codigoTurma_nomeDisciplina: {
              codigoTurma: turma.codigoTurma,
              nomeDisciplina: turma.nomeDisciplina,
            },
          };

          const existente = await this.prisma.turmaImportada.findUnique({
            where: chave,
            select: { id: true },
          });

          await this.prisma.turmaImportada.upsert({
            where: chave,
            update: {
              codigoEad: turma.codigoEad,
              curso: turma.curso,
              importacaoId: importacao.id,
            },
            create: { ...turma, importacaoId: importacao.id },
          });

          return { rejeicao: undefined, criada: !existente };
        }),
      );

      for (const r of resultados) {
        if (r.rejeicao) rejeitadas.push(r.rejeicao);
        else if (r.criada) criadas++;
        else atualizadas++;
      }
    }

    this.logger.log(
      `Importacao de turmas "${arquivo.originalname}": ${criadas + atualizadas} gravadas, ` +
        `${rejeitadas.length} rejeitadas`,
    );

    return {
      importacaoId: importacao.id,
      arquivo: arquivo.originalname,
      totalLinhas: linhas.length,
      criadas,
      atualizadas,
      rejeitadas,
    };
  }
}
