import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  permiteAgendar,
  statusDesconhecido,
} from '../../enums/status-curso.enum';
import { coluna, exigirColunas, lerCsv, LinhaCsv } from './csv.util';

/** Cabecalhos reais do CSV de alunos (confirmados nos 3 arquivos). */
export const ALUNO_CSV_COLUNAS = {
  matricula: 'RA',
  nome: 'ALUNO',
  email: 'EMAIL INSTITUCIONAL',
  curso: 'CURSO',
  status: 'STATUS CURSO',
  polo: 'CAMPUS',
  // CENTRO DE CUSTO existe no arquivo e e ignorado de proposito.
} as const;

export interface LinhaRejeitada {
  linha: number; // numero da linha no arquivo (1 = primeira apos o cabecalho)
  matricula: string;
  /**
   * Nome, curso e campus vao junto do RA porque quem corrige a planilha procura
   * pelo aluno, nao pelo numero da linha — e a linha rejeitada pode ser
   * justamente a que esta com o RA vazio.
   */
  nome: string;
  curso: string;
  campus: string;
  motivo: string;
}

export interface ResultadoImportacaoAlunos {
  importacaoId: number;
  arquivo: string;
  modalidade: string;
  totalLinhas: number;
  criados: number;
  atualizados: number;
  podemAgendar: number;
  bloqueados: number;
  rejeitadas: LinhaRejeitada[];
  /** Status fora das duas listas conhecidas — alguem precisa classificar. */
  statusDesconhecidos: { status: string; ocorrencias: number }[];
  /** Valores de CAMPUS que nao casaram com nenhum polo do seed. */
  polosNaoEncontrados: { campus: string; ocorrencias: number }[];
}

/** Quantas linhas gravar em paralelo (o pool do MySQL tem 10 conexoes). */
const LOTE = 20;

@Injectable()
export class ImportacaoAlunosService {
  private readonly logger = new Logger(ImportacaoAlunosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async importar(
    arquivo: Express.Multer.File,
    codigoModalidade: string,
    importadoPor?: string,
  ): Promise<ResultadoImportacaoAlunos> {
    const modalidade = await this.prisma.modalidade.findUnique({
      where: { codigo: codigoModalidade },
    });

    if (!modalidade) {
      throw new BadRequestException(
        `Modalidade ${codigoModalidade} nao existe. Rode o seed de modalidades.`,
      );
    }

    const linhas = lerCsv(arquivo.buffer);
    exigirColunas(linhas, Object.values(ALUNO_CSV_COLUNAS));

    // Todos os polos de uma vez: 7 mil consultas por nome seriam absurdas.
    const polos = await this.prisma.polo.findMany();
    const poloPorNome = new Map(polos.map((p) => [p.nome.trim(), p.id]));

    const importacao = await this.prisma.importacaoCsv.create({
      data: {
        tipo: 'ALUNOS',
        nomeArquivo: arquivo.originalname,
        totalLinhas: linhas.length,
        importadoPor,
      },
    });

    const rejeitadas: LinhaRejeitada[] = [];
    const desconhecidos = new Map<string, number>();
    const semPolo = new Map<string, number>();
    let criados = 0;
    let atualizados = 0;
    let podemAgendar = 0;

    for (let inicio = 0; inicio < linhas.length; inicio += LOTE) {
      const lote = linhas.slice(inicio, inicio + LOTE);

      const resultados = await Promise.all(
        lote.map((linha, i) =>
          this.gravarLinha(linha, inicio + i + 1, {
            modalidadeId: modalidade.id,
            importacaoId: importacao.id,
            poloPorNome,
          }),
        ),
      );

      for (const r of resultados) {
        if (r.tipo === 'rejeitada') {
          rejeitadas.push(r.rejeicao);
          if (r.campusNaoEncontrado) {
            semPolo.set(
              r.campusNaoEncontrado,
              (semPolo.get(r.campusNaoEncontrado) ?? 0) + 1,
            );
          }
          continue;
        }

        if (r.criado) criados++;
        else atualizados++;
        if (r.podeAgendar) podemAgendar++;
        if (r.statusDesconhecido) {
          desconhecidos.set(r.status, (desconhecidos.get(r.status) ?? 0) + 1);
        }
      }
    }

    const gravadas = criados + atualizados;

    this.logger.log(
      `Importacao de alunos (${codigoModalidade}) "${arquivo.originalname}": ` +
        `${gravadas} gravadas, ${rejeitadas.length} rejeitadas`,
    );

    return {
      importacaoId: importacao.id,
      arquivo: arquivo.originalname,
      modalidade: modalidade.codigo,
      totalLinhas: linhas.length,
      criados,
      atualizados,
      podemAgendar,
      bloqueados: gravadas - podemAgendar,
      rejeitadas,
      statusDesconhecidos: [...desconhecidos].map(([status, ocorrencias]) => ({
        status,
        ocorrencias,
      })),
      polosNaoEncontrados: [...semPolo].map(([campus, ocorrencias]) => ({
        campus,
        ocorrencias,
      })),
    };
  }

  private async gravarLinha(
    linha: LinhaCsv,
    numero: number,
    ctx: {
      modalidadeId: number;
      importacaoId: number;
      poloPorNome: Map<string, number>;
    },
  ) {
    const matricula = coluna(linha, ALUNO_CSV_COLUNAS.matricula).toUpperCase();
    const nome = coluna(linha, ALUNO_CSV_COLUNAS.nome);
    const curso = coluna(linha, ALUNO_CSV_COLUNAS.curso);
    const campus = coluna(linha, ALUNO_CSV_COLUNAS.polo);
    const status = coluna(linha, ALUNO_CSV_COLUNAS.status);

    const rejeitar = (motivo: string, campusNaoEncontrado?: string) =>
      ({
        tipo: 'rejeitada' as const,
        rejeicao: { linha: numero, matricula, nome, curso, campus, motivo },
        campusNaoEncontrado,
      }) as const;

    if (!matricula) return rejeitar('RA vazio');

    // curso faz parte da chave do vinculo: sem ele nao da para identificar a linha
    if (!curso) return rejeitar('CURSO vazio');

    if (!campus) {
      return rejeitar(
        'CAMPUS vazio — nao da para definir o polo do aluno. ' +
          'Corrija a planilha e reenvie (a importacao e idempotente).',
      );
    }

    const poloId = ctx.poloPorNome.get(campus);
    if (!poloId) {
      return rejeitar(
        `CAMPUS "${campus}" nao corresponde a nenhum polo cadastrado`,
        campus,
      );
    }

    const podeAgendar = permiteAgendar(status);

    const dados = {
      nome: coluna(linha, ALUNO_CSV_COLUNAS.nome) || null,
      email: coluna(linha, ALUNO_CSV_COLUNAS.email) || null,
      statusCurso: status,
      ativo: podeAgendar,
      modalidadeId: ctx.modalidadeId,
      poloId,
      importacaoId: ctx.importacaoId,
    };

    // Idempotente: reenviar o mesmo arquivo atualiza, nunca duplica.
    const existente = await this.prisma.alunoImportado.findUnique({
      where: { matricula_curso: { matricula, curso } },
      select: { id: true },
    });

    await this.prisma.alunoImportado.upsert({
      where: { matricula_curso: { matricula, curso } },
      update: dados,
      create: { matricula, curso, ...dados },
    });

    return {
      tipo: 'gravada' as const,
      criado: !existente,
      podeAgendar,
      status,
      statusDesconhecido: statusDesconhecido(status),
    };
  }
}
