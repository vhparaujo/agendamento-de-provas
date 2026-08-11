import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  permiteAgendar,
  statusDesconhecido,
} from '../../enums/status-curso.enum';
import { StatusAgendamento } from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
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

/** De -> para de um campo que mudou. Nomes, nao ids: quem le e humano. */
export interface Mudanca {
  de: string;
  para: string;
}

/**
 * Um vinculo que JA TINHA PROVA MARCADA e teve modalidade ou polo trocados por
 * esta importacao.
 *
 * Existe porque essas duas trocas nao aparecem sozinhas. A reserva continua
 * apontando para a sala antiga: o aluno segue alocado num horario de outra
 * duracao (modalidade) ou em outro campus (polo), e nada no sistema reclama.
 * O sintoma tipico chega dias depois e disfarcado — o remanejo passa a ser
 * recusado com "esta sala nao e da modalidade do aluno".
 *
 * NAO bloqueia a importacao de proposito: a planilha e a fonte de verdade, e
 * pode ser a correcao de um erro anterior. Quem decide o que fazer com a reserva
 * (remanejar ou cancelar) e a secretaria — o que ela nao pode e nao ficar sabendo.
 */
export interface AlteracaoComAgendamento {
  linha: number;
  matricula: string;
  nome: string;
  curso: string;
  /** Ausente quando so o polo mudou. */
  modalidade?: Mudanca;
  /** Ausente quando so a modalidade mudou. */
  polo?: Mudanca;
  /** Reservas confirmadas do vinculo — no semestre vigente, quando ha um. */
  agendamentosConfirmados: number;
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
  /** Trocas de modalidade/polo em quem ja tem prova marcada. Ver a interface. */
  alteracoesComAgendamento: AlteracaoComAgendamento[];
}

/** Quantas linhas gravar em paralelo (o pool do MySQL tem 10 conexoes). */
const LOTE = 20;

@Injectable()
export class ImportacaoAlunosService {
  private readonly logger = new Logger(ImportacaoAlunosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly periodo: PeriodoService,
  ) {}

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

    // Para o aviso de troca com prova marcada: id -> nome, porque quem le o
    // relatorio precisa de "EaD -> Modular", nao de "1 -> 3".
    const modalidades = await this.prisma.modalidade.findMany();
    const nomeDaModalidade = new Map(modalidades.map((m) => [m.id, m.nome]));
    const nomeDoPolo = new Map(polos.map((p) => [p.id, p.nome]));

    /**
     * Restringe o aviso ao semestre vigente: prova de semestre passado ja
     * aconteceu, e avisar sobre ela seria ruido — aviso que sempre aparece e
     * aviso que todo mundo aprende a ignorar.
     *
     * `undefined` (nenhum periodo cadastrado) vira "sem filtro", de propósito:
     * na duvida, avisa demais em vez de calar.
     */
    const periodoLetivoVigente = await this.periodo.periodoLetivoVigente();

    const importacao = await this.prisma.importacaoCsv.create({
      data: {
        tipo: 'ALUNOS',
        nomeArquivo: arquivo.originalname,
        totalLinhas: linhas.length,
        importadoPor,
      },
    });

    const rejeitadas: LinhaRejeitada[] = [];
    const alteracoesComAgendamento: AlteracaoComAgendamento[] = [];
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
            nomeDaModalidade,
            nomeDoPolo,
            periodoLetivoVigente,
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
        if (r.alteracao) alteracoesComAgendamento.push(r.alteracao);
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

    // Sobe para WARN: mexer em quem ja tem prova marcada e o unico resultado
    // desta rota que pode exigir acao humana DEPOIS que a tela ja foi fechada.
    if (alteracoesComAgendamento.length > 0) {
      this.logger.warn(
        `${alteracoesComAgendamento.length} vinculo(s) COM PROVA MARCADA tiveram ` +
          `modalidade ou polo alterados por "${arquivo.originalname}": ` +
          alteracoesComAgendamento.map((a) => a.matricula).join(', '),
      );
    }

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
      alteracoesComAgendamento,
    };
  }

  private async gravarLinha(
    linha: LinhaCsv,
    numero: number,
    ctx: {
      modalidadeId: number;
      importacaoId: number;
      poloPorNome: Map<string, number>;
      nomeDaModalidade: Map<number, string>;
      nomeDoPolo: Map<number, string>;
      periodoLetivoVigente?: string;
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
      select: { id: true, modalidadeId: true, poloId: true },
    });

    // ANTES do upsert: depois dele nao ha mais como saber o que era.
    const alteracao = existente
      ? await this.avisarSeMexeEmProvaMarcada(
          existente,
          { modalidadeId: ctx.modalidadeId, poloId },
          { linha: numero, matricula, nome, curso },
          ctx,
        )
      : undefined;

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
      alteracao,
    };
  }

  /**
   * Modalidade e polo sao os dois campos que a importacao troca **por baixo de
   * uma reserva ja confirmada** sem que nada quebre na hora:
   *
   * - modalidade: a prova tem outra duracao, mas o aluno segue alocado na sala
   *   antiga. O sintoma aparece dias depois, disfarcado — o remanejo passa a ser
   *   recusado com "esta sala nao e da modalidade do aluno".
   * - polo: o aluno "muda de campus" e a reserva fica no campus anterior. O
   *   relatorio de agendamentos mostra o polo DA PROVA, entao la parece coerente.
   *
   * Nenhum dos dois e erro por si so: a planilha e a fonte de verdade e pode
   * estar corrigindo um cadastro errado. Por isso isto **avisa e nao bloqueia** —
   * o que nao pode e a secretaria descobrir no dia da prova.
   *
   * A consulta extra so acontece quando algo de fato mudou, o que e raro: numa
   * reimportacao normal, nenhuma linha passa daqui.
   */
  private async avisarSeMexeEmProvaMarcada(
    existente: { id: number; modalidadeId: number; poloId: number },
    novo: { modalidadeId: number; poloId: number },
    identificacao: {
      linha: number;
      matricula: string;
      nome: string;
      curso: string;
    },
    ctx: {
      nomeDaModalidade: Map<number, string>;
      nomeDoPolo: Map<number, string>;
      periodoLetivoVigente?: string;
    },
  ): Promise<AlteracaoComAgendamento | undefined> {
    const mudouModalidade = existente.modalidadeId !== novo.modalidadeId;
    const mudouPolo = existente.poloId !== novo.poloId;

    if (!mudouModalidade && !mudouPolo) return undefined;

    const agendamentosConfirmados = await this.prisma.agendamento.count({
      where: {
        alunoId: existente.id,
        status: StatusAgendamento.CONFIRMADO,
        // undefined = sem filtro (nenhum periodo cadastrado)
        periodoLetivoId: ctx.periodoLetivoVigente,
      },
    });

    // Mudou, mas nao ha reserva para ficar inconsistente: nada a avisar.
    if (agendamentosConfirmados === 0) return undefined;

    const nome = (mapa: Map<number, string>, id: number) =>
      mapa.get(id) ?? `#${id}`;

    return {
      ...identificacao,
      ...(mudouModalidade
        ? {
            modalidade: {
              de: nome(ctx.nomeDaModalidade, existente.modalidadeId),
              para: nome(ctx.nomeDaModalidade, novo.modalidadeId),
            },
          }
        : {}),
      ...(mudouPolo
        ? {
            polo: {
              de: nome(ctx.nomeDoPolo, existente.poloId),
              para: nome(ctx.nomeDoPolo, novo.poloId),
            },
          }
        : {}),
      agendamentosConfirmados,
    };
  }
}
