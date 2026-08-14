import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  permiteAgendar,
  statusDesconhecido,
} from '../../enums/status-curso.enum';
import { StatusAgendamento } from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import {
  candidatasARenomeacao,
  chaveDoVinculo,
  Semelhanca,
} from './curso-renomeado';
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

/** Um vinculo antigo que pode ser o mesmo curso escrito de outro jeito. */
export interface CandidataRenomeacao {
  /** Id do vinculo ANTIGO — e o que a rota de mesclagem absorve. */
  alunoId: number;
  /** A grafia anterior, como esta gravada. */
  curso: string;
  semelhanca: Semelhanca;
  modalidade: string;
  polo: string;
  /**
   * Reservas confirmadas presas no vinculo antigo, em QUALQUER periodo.
   *
   * Sem recorte de semestre de proposito, ao contrario de
   * `alteracoesComAgendamento`: a renomeacao costuma chegar justamente na
   * planilha do semestre novo, e ai a prova que ficaria orfa e a do semestre
   * ANTERIOR. Filtrar pelo vigente devolveria 0 exatamente no caso comum.
   */
  agendamentosConfirmados: number;
}

/**
 * Uma linha que CRIOU vinculo novo quando o mesmo RA ja tinha um vinculo de
 * curso parecido — e o vinculo antigo sumiu deste arquivo.
 *
 * O sintoma classico: "PSICOLOGIA" virou "Psicologia — Bacharelado" na planilha
 * do semestre seguinte. A chave `[matricula, curso]` mudou, o upsert nao achou
 * nada e criou uma segunda linha; a prova ja marcada continua pendurada na
 * primeira. Dai em diante o aluno aparece duas vezes na tela de atendimento,
 * sai como "Nao Agendado" na exportacao mesmo tendo agendado, e o compulsorio
 * o aloca de novo — uma segunda vaga para a mesma pessoa.
 *
 * NAO bloqueia e NAO mescla, pelo mesmo motivo de `alteracoesComAgendamento`:
 * dois vinculos no mesmo RA existem de verdade (2 em 7519 na base real), e
 * fundir dois cursos distintos misturaria as provas de dois cursos numa pessoa
 * so. A mesclagem e uma decisao da secretaria, em `POST /alunos/:id/mesclar`.
 */
export interface CursoRenomeado {
  linha: number;
  matricula: string;
  nome: string;
  /** A grafia nova, a que veio no arquivo. */
  curso: string;
  /** Id do vinculo recem-criado — o destino da mesclagem. */
  alunoId: number;
  /** Mais de uma = ambigua; a secretaria escolhe, o sistema nao chuta. */
  candidatas: CandidataRenomeacao[];
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
  /** Vinculos que nasceram duplicados por mudanca de grafia do curso. */
  cursosRenomeados: CursoRenomeado[];
}

/** Quantas linhas gravar em paralelo (o pool do MySQL tem 10 conexoes). */
const LOTE = 20;

/** Vinculo como ele estava ANTES desta importacao. Ver `vinculosPorRa`. */
interface VinculoAnterior {
  id: number;
  matricula: string;
  curso: string;
  modalidadeId: number;
  poloId: number;
}

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

    /**
     * Todos os vinculos que existem ANTES desta importacao, agrupados por RA.
     *
     * Uma consulta so, pelo mesmo motivo dos polos: a alternativa seria buscar
     * "os outros vinculos deste RA" a cada uma das ~7 mil linhas. Sao ~7,5 mil
     * registros de tres colunas — cabe folgado em memoria.
     *
     * E uma FOTOGRAFIA do estado anterior de proposito: as linhas criadas
     * durante esta importacao nao entram aqui, e nao devem entrar. Se as duas
     * grafias vierem no MESMO arquivo, a planilha esta afirmando que sao dois
     * vinculos — nao ha renomeacao a reportar.
     */
    const vinculosAntes = await this.prisma.alunoImportado.findMany({
      select: {
        id: true,
        matricula: true,
        curso: true,
        modalidadeId: true,
        poloId: true,
      },
    });

    const vinculosPorRa = new Map<string, VinculoAnterior[]>();
    for (const vinculo of vinculosAntes) {
      const ra = vinculo.matricula.toUpperCase();
      const lista = vinculosPorRa.get(ra);
      if (lista) lista.push(vinculo);
      else vinculosPorRa.set(ra, [vinculo]);
    }

    /**
     * Os pares [RA, curso] presentes NESTE arquivo. E o que distingue um curso
     * renomeado (a grafia antiga sumiu da planilha) de um aluno com dois cursos
     * (as duas grafias continuam la).
     */
    const noArquivo = new Set(
      linhas.map((linha) =>
        chaveDoVinculo(
          coluna(linha, ALUNO_CSV_COLUNAS.matricula).toUpperCase(),
          coluna(linha, ALUNO_CSV_COLUNAS.curso),
        ),
      ),
    );

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
    const cursosRenomeados: CursoRenomeado[] = [];
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
            vinculosPorRa,
            noArquivo,
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
        if (r.renomeacao) cursosRenomeados.push(r.renomeacao);
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

    // Tambem WARN: um vinculo duplicado nao quebra nada na hora e sai da tela
    // junto com a resposta do upload. O que ele faz e cobrar prova de quem ja
    // agendou e dar uma segunda vaga a mesma pessoa no compulsorio — semanas
    // depois, sem ligacao aparente com a importacao que o criou.
    if (cursosRenomeados.length > 0) {
      const comProva = cursosRenomeados.filter((c) =>
        c.candidatas.some((v) => v.agendamentosConfirmados > 0),
      );

      this.logger.warn(
        `${cursosRenomeados.length} vinculo(s) criados por MUDANCA DE GRAFIA do curso em ` +
          `"${arquivo.originalname}" (${comProva.length} com prova marcada no vinculo antigo): ` +
          cursosRenomeados.map((c) => c.matricula).join(', '),
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
      cursosRenomeados,
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
      vinculosPorRa: Map<string, VinculoAnterior[]>;
      noArquivo: Set<string>;
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

    const gravado = await this.prisma.alunoImportado.upsert({
      where: { matricula_curso: { matricula, curso } },
      update: dados,
      create: { matricula, curso, ...dados },
      select: { id: true },
    });

    // So faz sentido em vinculo NOVO: se o upsert encontrou a linha, a grafia
    // do curso e a mesma de antes e nao ha duplicata para reportar.
    const renomeacao = existente
      ? undefined
      : await this.avisarSeDuplicouPorGrafia(
          { alunoId: gravado.id, matricula, nome, curso, linha: numero },
          ctx,
        );

    return {
      tipo: 'gravada' as const,
      criado: !existente,
      podeAgendar,
      status,
      statusDesconhecido: statusDesconhecido(status),
      alteracao,
      renomeacao,
    };
  }

  /**
   * O vinculo nasceu novo — mas o mesmo RA ja tinha um curso de grafia parecida,
   * e aquele curso NAO aparece neste arquivo. Isso e uma renomeacao, e o que
   * acabou de ser criado e uma segunda linha para a mesma pessoa.
   *
   * Por que so avisa: dois vinculos no mesmo RA existem de verdade, e mesclar
   * por semelhanca de nome fundiria dois cursos distintos numa pessoa so —
   * misturando as provas dos dois. A comparacao esta em `curso-renomeado.ts`,
   * que nao chuta; a decisao e da secretaria, em `POST /alunos/:id/mesclar`.
   *
   * O custo e uma consulta por CANDIDATA, e candidata e raro: numa importacao
   * normal nenhuma linha chega aqui, e numa primeira importacao o banco esta
   * vazio e o mapa nao devolve nada.
   */
  private async avisarSeDuplicouPorGrafia(
    novo: {
      alunoId: number;
      matricula: string;
      nome: string;
      curso: string;
      linha: number;
    },
    ctx: {
      nomeDaModalidade: Map<number, string>;
      nomeDoPolo: Map<number, string>;
      vinculosPorRa: Map<string, VinculoAnterior[]>;
      noArquivo: Set<string>;
    },
  ): Promise<CursoRenomeado | undefined> {
    const anteriores = ctx.vinculosPorRa.get(novo.matricula);
    if (!anteriores || anteriores.length === 0) return undefined;

    const candidatas = candidatasARenomeacao(novo.curso, anteriores, (v) =>
      ctx.noArquivo.has(chaveDoVinculo(novo.matricula, v.curso)),
    );

    if (candidatas.length === 0) return undefined;

    const nome = (mapa: Map<number, string>, id: number) =>
      mapa.get(id) ?? `#${id}`;

    return {
      linha: novo.linha,
      matricula: novo.matricula,
      nome: novo.nome,
      curso: novo.curso,
      alunoId: novo.alunoId,
      candidatas: await Promise.all(
        candidatas.map(async ({ vinculo, semelhanca }) => ({
          alunoId: vinculo.id,
          curso: vinculo.curso,
          semelhanca,
          modalidade: nome(ctx.nomeDaModalidade, vinculo.modalidadeId),
          polo: nome(ctx.nomeDoPolo, vinculo.poloId),
          agendamentosConfirmados: await this.prisma.agendamento.count({
            where: {
              alunoId: vinculo.id,
              status: StatusAgendamento.CONFIRMADO,
            },
          }),
        })),
      ),
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
