import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  permiteAgendar,
  statusDesconhecido,
} from '../../enums/status-curso.enum';
import { StatusAgendamento } from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import {
  candidatasARenomeacao,
  chaveDoVinculo,
  Semelhanca,
} from './curso-renomeado';
import { coluna, exigirColunas, lerCsv, LinhaCsv } from './csv.util';
import { calcularSaidas, LIMITE_SAIDAS_PERCENTUAL } from './saidas-da-planilha';

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
 * Um vinculo que JA TINHA PROVA MARCADA e foi mexido por esta importacao de um
 * jeito que a reserva ja gravada NAO acompanha.
 *
 * Sao tres mudancas, e o que as junta aqui e serem todas silenciosas — a
 * importacao grava, e nada mais no sistema reclama:
 *
 *   formato . a prova passa a ter outra duracao, e o aluno segue alocado na
 *                sala antiga. O sintoma chega dias depois e disfarcado: o
 *                remanejo e recusado com "esta sala nao e do formato do aluno".
 *   polo ....... o aluno "muda de campus" e a reserva fica no campus anterior.
 *   status ..... o aluno PERDEU a elegibilidade (STATUS CURSO saiu de "Ativo")
 *                e continua ocupando a cadeira. Ele nao agenda nem troca mais,
 *                o compulsorio deixou de enxerga-lo — mas a prova marcada segue
 *                de pe, na lista de presenca e nos relatorios.
 *
 * NAO bloqueia a importacao de proposito: a planilha e a fonte de verdade, e
 * pode ser a correcao de um erro anterior. Quem decide o que fazer com a reserva
 * (remanejar, cancelar ou manter) e a administração — o que ela nao pode e nao
 * ficar sabendo.
 */
export interface AlteracaoComAgendamento {
  linha: number;
  matricula: string;
  nome: string;
  curso: string;
  /** Ausente quando o formato nao mudou. */
  modalidade?: Mudanca;
  /** Ausente quando o polo nao mudou. */
  polo?: Mudanca;
  /**
   * Presente so quando o vinculo PERDEU a elegibilidade nesta importacao —
   * `ativo` saindo de `true` para `false`. Os valores sao os STATUS CURSO
   * brutos ("Ativo" -> "Transf. Interna"), que e o que a administracao le na
   * planilha.
   *
   * GANHAR elegibilidade nao entra: voltar a poder agendar tendo prova marcada
   * nao deixa nada inconsistente. Trocar entre dois status que ja bloqueavam
   * ("Matricula Trancada" -> "Cancelado") tambem nao — o aluno ja estava barrado, e um
   * aviso que se repete a cada planilha e o que ensina o time a ignora-lo.
   */
  statusCurso?: Mudanca;
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
 * so. A mesclagem e uma decisao da administracao, em `POST /alunos/:id/mesclar`.
 */
export interface CursoRenomeado {
  linha: number;
  matricula: string;
  nome: string;
  /** A grafia nova, a que veio no arquivo. */
  curso: string;
  /** Id do vinculo recem-criado — o destino da mesclagem. */
  alunoId: number;
  /** Mais de uma = ambigua; a administracao escolhe, o sistema nao chuta. */
  candidatas: CandidataRenomeacao[];
}

/** Um vinculo que nao veio no CSV completo do formato. */
export interface VinculoForaDaPlanilha {
  alunoId: number;
  matricula: string;
  nome: string | null;
  curso: string;
  polo: string;
  statusCurso: string;
  /**
   * Reservas confirmadas no semestre vigente, como em
   * `alteracoesComAgendamento`. A prova NAO e cancelada: quem decide e a
   * administracao (decisao do cliente, 20/10/2026).
   */
  agendamentosConfirmados: number;
}

/**
 * O que a comparacao com o banco encontrou — e se aplicou. Ver
 * `saidas-da-planilha.ts`.
 */
export interface ResumoSaidas {
  /** false = simulacao, ou recusada pelo limite sem a segunda confirmacao. */
  aplicadas: boolean;
  /** So quando `aplicadas` e false e o motivo foi o limite. */
  bloqueadasPeloLimite: boolean;
  total: number;
  /** Vinculos do formato dentro da planilha, contando os deste arquivo. */
  base: number;
  percentual: number;
  limitePercentual: number;
  acimaDoLimite: boolean;
  /** Quem tem prova marcada vem primeiro: e quem pede decisao. */
  vinculos: VinculoForaDaPlanilha[];
}

/** O que o admin pediu sobre a comparacao com o banco. */
export interface OpcoesDeSaida {
  /** "Este arquivo e a lista completa do formato". Sem isto, nada e comparado. */
  listaCompleta: boolean;
  /** false = so mostra quem sairia (o padrao). */
  aplicarSaidas: boolean;
  /** Segunda confirmacao, exigida acima de `LIMITE_SAIDAS_PERCENTUAL`. */
  confirmarAcimaDoLimite: boolean;
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
  /** Trocas de formato/polo em quem ja tem prova marcada. Ver a interface. */
  alteracoesComAgendamento: AlteracaoComAgendamento[];
  /** Vinculos que nasceram duplicados por mudanca de grafia do curso. */
  cursosRenomeados: CursoRenomeado[];
  /**
   * Vinculos que estavam FORA DA PLANILHA e vieram neste arquivo — voltaram a
   * poder agendar (se o status permitir). Vale para arquivo parcial tambem.
   */
  voltaramParaAPlanilha: number;
  listaCompleta: boolean;
  /** null quando o arquivo nao foi marcado como lista completa. */
  saidas: ResumoSaidas | null;
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
    private readonly auditoria: AuditoriaService,
  ) {}

  async importar(
    arquivo: Express.Multer.File,
    codigoModalidade: string,
    importadoPor?: string,
    opcoes: OpcoesDeSaida = {
      listaCompleta: false,
      aplicarSaidas: false,
      confirmarAcimaDoLimite: false,
    },
  ): Promise<ResultadoImportacaoAlunos> {
    // Antes de qualquer escrita: aplicar saidas de um arquivo que ninguem
    // afirmou ser a lista inteira e exatamente o acidente que a caixa evita.
    if (opcoes.aplicarSaidas && !opcoes.listaCompleta) {
      throw new BadRequestException(
        'Só é possível marcar quem saiu da planilha quando o arquivo é a lista ' +
          'completa do formato. Marque "Este arquivo é a lista completa" e envie de novo.',
      );
    }

    const modalidade = await this.prisma.modalidade.findUnique({
      where: { codigo: codigoModalidade },
    });

    if (!modalidade) {
      throw new BadRequestException(
        `O formato ${codigoModalidade} não está cadastrado no sistema. Avise o suporte técnico.`,
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
    // So o semestre importa para o aviso: uma prova ja marcada e uma prova ja
    // marcada, seja ela da regular ou da substitutiva.
    // A importacao e de UM formato por vez (o admin escolhe a aba no
    // upload), entao da para resolver o periodo letivo exato desta planilha em
    // vez de olhar a janela inteira: o aviso fica mais preciso — a prova de um
    // aluno EaD nao interessa a uma importacao de presenciais.
    const periodoLetivoVigente = (
      await this.periodo.periodoLetivoDaModalidade(modalidade.codigo)
    )?.periodoLetivoId;

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
        listaCompleta: opcoes.listaCompleta,
      },
    });

    const rejeitadas: LinhaRejeitada[] = [];
    const alteracoesComAgendamento: AlteracaoComAgendamento[] = [];
    const cursosRenomeados: CursoRenomeado[] = [];
    const desconhecidos = new Map<string, number>();
    const semPolo = new Map<string, number>();
    const gravados = new Set<number>();
    const rasRejeitados = new Set<string>();
    let criados = 0;
    let atualizados = 0;
    let podemAgendar = 0;
    let voltaramParaAPlanilha = 0;

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
          if (r.rejeicao.matricula) rasRejeitados.add(r.rejeicao.matricula);
          if (r.campusNaoEncontrado) {
            semPolo.set(
              r.campusNaoEncontrado,
              (semPolo.get(r.campusNaoEncontrado) ?? 0) + 1,
            );
          }
          continue;
        }

        gravados.add(r.alunoId);
        if (r.criado) criados++;
        else atualizados++;
        if (r.voltouParaAPlanilha) voltaramParaAPlanilha++;
        if (r.podeAgendar) podemAgendar++;
        if (r.alteracao) alteracoesComAgendamento.push(r.alteracao);
        if (r.renomeacao) cursosRenomeados.push(r.renomeacao);
        if (r.statusDesconhecido) {
          desconhecidos.set(r.status, (desconhecidos.get(r.status) ?? 0) + 1);
        }
      }
    }

    const gravadas = criados + atualizados;

    const saidas = opcoes.listaCompleta
      ? await this.compararComOBanco({
          modalidadeId: modalidade.id,
          codigoModalidade,
          importacaoId: importacao.id,
          arquivo: arquivo.originalname,
          importadoPor,
          gravados,
          rasRejeitados,
          periodoLetivoVigente,
          nomeDoPolo,
          opcoes,
        })
      : null;

    this.logger.log(
      `Importacao de alunos (${codigoModalidade}) "${arquivo.originalname}": ` +
        `${gravadas} gravadas, ${rejeitadas.length} rejeitadas`,
    );

    // Sobe para WARN: mexer em quem ja tem prova marcada e o unico resultado
    // desta rota que pode exigir acao humana DEPOIS que a tela ja foi fechada.
    if (alteracoesComAgendamento.length > 0) {
      // As perdas de elegibilidade saem contadas a parte porque a acao e outra:
      // formato/polo pedem remanejo, e aqui a pergunta e se a pessoa fica
      // com a cadeira. Sem o numero, o log so diria "alguma coisa mudou".
      const perderamElegibilidade = alteracoesComAgendamento.filter(
        (a) => a.statusCurso,
      );

      this.logger.warn(
        `${alteracoesComAgendamento.length} vinculo(s) COM PROVA MARCADA foram ` +
          `alterados por "${arquivo.originalname}" ` +
          `(${perderamElegibilidade.length} perderam a elegibilidade pelo STATUS CURSO): ` +
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
      voltaramParaAPlanilha,
      listaCompleta: opcoes.listaCompleta,
      saidas,
    };
  }

  /**
   * A lista completa do formato contra o banco: quem nao veio no arquivo saiu
   * da universidade. Ver `saidas-da-planilha.ts` para a regra e as protecoes.
   *
   * Roda DEPOIS dos upserts, de proposito: "esta no arquivo" e o id que o
   * upsert gravou, e nao uma comparacao de texto (a collation do banco ignora
   * caixa e acento, a comparacao em memoria nao).
   *
   * Aplicar e o segundo passo. O primeiro envio so mostra a lista; a tela
   * reenvia o MESMO arquivo com `aplicarSaidas` — a importacao e idempotente,
   * e recalcular no segundo envio evita guardar a lista entre as duas chamadas.
   */
  private async compararComOBanco(ctx: {
    modalidadeId: number;
    codigoModalidade: string;
    importacaoId: number;
    arquivo: string;
    importadoPor?: string;
    gravados: Set<number>;
    rasRejeitados: Set<string>;
    periodoLetivoVigente?: string;
    nomeDoPolo: Map<number, string>;
    opcoes: OpcoesDeSaida;
  }): Promise<ResumoSaidas> {
    const doFormato = await this.prisma.alunoImportado.findMany({
      where: { modalidadeId: ctx.modalidadeId },
      select: { id: true, matricula: true, foraDaPlanilhaEm: true },
    });

    const calculo = calcularSaidas(doFormato, ctx.gravados, ctx.rasRejeitados);

    const bloqueadasPeloLimite =
      ctx.opcoes.aplicarSaidas &&
      calculo.acimaDoLimite &&
      !ctx.opcoes.confirmarAcimaDoLimite;

    const aplicar =
      ctx.opcoes.aplicarSaidas &&
      !bloqueadasPeloLimite &&
      calculo.ids.length > 0;

    const vinculos = await this.detalharSaidas(
      calculo.ids,
      ctx.periodoLetivoVigente,
      ctx.nomeDoPolo,
    );

    if (aplicar) {
      // `ativo` junto com a marca: e a coluna que portal, compulsorio e
      // estatisticas ja consultam, e nenhum deles precisa saber da marca.
      // O filtro repete `foraDaPlanilhaEm: null` para nao reescrever a data
      // de quem ja estava fora.
      await this.prisma.alunoImportado.updateMany({
        where: { id: { in: calculo.ids }, foraDaPlanilhaEm: null },
        data: {
          ativo: false,
          foraDaPlanilhaEm: new Date(),
          foraDaPlanilhaImportacaoId: ctx.importacaoId,
        },
      });

      await this.prisma.importacaoCsv.update({
        where: { id: ctx.importacaoId },
        data: { saidasMarcadas: calculo.ids.length },
      });

      const comProva = vinculos.filter((v) => v.agendamentosConfirmados > 0);

      this.auditoria.registrar('ALUNOS_FORA_DA_PLANILHA', {
        ator: ctx.importadoPor,
        detalhe:
          `importacao ${ctx.importacaoId} (${ctx.codigoModalidade}, "${ctx.arquivo}"): ` +
          `${calculo.ids.length} de ${calculo.base} vinculo(s) (${calculo.percentual}%) ` +
          `marcados como fora da planilha, ${comProva.length} com prova marcada` +
          (calculo.acimaDoLimite ? ', ACIMA DO LIMITE com confirmacao' : '') +
          `. ids: ${calculo.ids.join(',')}`,
      });

      // WARN pelo mesmo motivo de `alteracoesComAgendamento`: quem saiu com
      // prova marcada continua na lista de presenca ate alguem decidir.
      if (comProva.length > 0) {
        this.logger.warn(
          `${comProva.length} vinculo(s) FORA DA PLANILHA com prova marcada em ` +
            `"${ctx.arquivo}": ${comProva.map((v) => v.matricula).join(', ')}`,
        );
      }
    }

    return {
      aplicadas: aplicar,
      bloqueadasPeloLimite,
      total: calculo.ids.length,
      base: calculo.base,
      percentual: calculo.percentual,
      limitePercentual: LIMITE_SAIDAS_PERCENTUAL,
      acimaDoLimite: calculo.acimaDoLimite,
      vinculos,
    };
  }

  /** Nome, curso, polo e reservas de quem sai — com prova primeiro. */
  private async detalharSaidas(
    ids: number[],
    periodoLetivoVigente: string | undefined,
    nomeDoPolo: Map<number, string>,
  ): Promise<VinculoForaDaPlanilha[]> {
    if (ids.length === 0) return [];

    const [registros, reservas] = await Promise.all([
      this.prisma.alunoImportado.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          matricula: true,
          nome: true,
          curso: true,
          poloId: true,
          statusCurso: true,
        },
      }),
      this.prisma.agendamento.groupBy({
        by: ['alunoId'],
        where: {
          alunoId: { in: ids },
          status: StatusAgendamento.CONFIRMADO,
          // undefined = sem filtro (nenhum periodo cadastrado)
          periodoLetivoId: periodoLetivoVigente,
        },
        _count: { _all: true },
      }),
    ]);

    const porAluno = new Map(reservas.map((r) => [r.alunoId, r._count._all]));

    return registros
      .map((r) => ({
        alunoId: r.id,
        matricula: r.matricula,
        nome: r.nome,
        curso: r.curso,
        polo: nomeDoPolo.get(r.poloId) ?? `#${r.poloId}`,
        statusCurso: r.statusCurso,
        agendamentosConfirmados: porAluno.get(r.id) ?? 0,
      }))
      .sort(
        (a, b) =>
          b.agendamentosConfirmados - a.agendamentosConfirmados ||
          (a.nome ?? '').localeCompare(b.nome ?? '', 'pt-BR') ||
          a.matricula.localeCompare(b.matricula),
      );
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
        'CAMPUS vazio — não dá para definir o polo do aluno. ' +
          'Corrija a planilha e reenvie (reenviar não duplica ninguém).',
      );
    }

    const poloId = ctx.poloPorNome.get(campus);
    if (!poloId) {
      return rejeitar(
        `CAMPUS "${campus}" não corresponde a nenhum polo cadastrado`,
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
      // Estar no arquivo — completo ou parcial — e estar na planilha.
      foraDaPlanilhaEm: null,
      foraDaPlanilhaImportacaoId: null,
    };

    // Idempotente: reenviar o mesmo arquivo atualiza, nunca duplica.
    const existente = await this.prisma.alunoImportado.findUnique({
      where: { matricula_curso: { matricula, curso } },
      select: {
        id: true,
        modalidadeId: true,
        poloId: true,
        // `ativo` e `statusCurso` sao lidos so para o aviso de perda de
        // elegibilidade: e o estado ANTERIOR, e o upsert logo abaixo o apaga.
        ativo: true,
        statusCurso: true,
        foraDaPlanilhaEm: true,
      },
    });

    // ANTES do upsert: depois dele nao ha mais como saber o que era.
    const alteracao = existente
      ? await this.avisarSeMexeEmProvaMarcada(
          existente,
          {
            modalidadeId: ctx.modalidadeId,
            poloId,
            podeAgendar,
            statusCurso: status,
          },
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
      alunoId: gravado.id,
      criado: !existente,
      voltouParaAPlanilha: !!existente?.foraDaPlanilhaEm,
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
   * que nao chuta; a decisao e da administracao, em `POST /alunos/:id/mesclar`.
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
   * Os TRES campos que a importacao troca **por baixo de uma reserva ja
   * confirmada** sem que nada quebre na hora:
   *
   * - formato: a prova tem outra duracao, mas o aluno segue alocado na sala
   *   antiga. O sintoma aparece dias depois, disfarcado — o remanejo passa a ser
   *   recusado com "esta sala nao e do formato do aluno".
   * - polo: o aluno "muda de campus" e a reserva fica no campus anterior. O
   *   relatorio de agendamentos mostra o polo DA PROVA, entao la parece coerente.
   * - STATUS CURSO: o vinculo perde a elegibilidade e a cadeira continua dele.
   *   Este e o mais silencioso dos tres, porque nao produz nem sintoma tardio:
   *   `bloqueados` sobe um no resumo do upload e mais nada acontece. O aluno
   *   some do compulsorio, nao troca mais de horario pelo portal, e ainda assim
   *   aparece na lista de presenca do dia — ocupando vaga que a administração
   *   poderia estar dando a outra pessoa.
   *
   * ⚠️ A pergunta e "PERDEU a elegibilidade?", nao "o status mudou?" — a
   * comparacao e sobre `ativo` (o campo derivado), nunca sobre o texto do
   * status. "Matricula Trancada" -> "Cancelado" nao muda nada para o aluno e viraria
   * aviso em toda planilha; a regra de quais grafias bloqueiam ja mora num
   * lugar so (`status-curso.enum.ts`), e ler o texto aqui seria a segunda
   * copia dela.
   *
   * Nenhum dos tres e erro por si so: a planilha e a fonte de verdade e pode
   * estar corrigindo um cadastro errado. Por isso isto **avisa e nao bloqueia** —
   * o que nao pode e a administracao descobrir no dia da prova.
   *
   * A consulta extra so acontece quando algo de fato mudou, o que e raro: numa
   * reimportacao normal, nenhuma linha passa daqui.
   */
  private async avisarSeMexeEmProvaMarcada(
    existente: {
      id: number;
      modalidadeId: number;
      poloId: number;
      ativo: boolean;
      statusCurso: string;
    },
    novo: {
      modalidadeId: number;
      poloId: number;
      podeAgendar: boolean;
      statusCurso: string;
    },
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
    // Perda, nao mudanca: so o sentido `true -> false` deixa a reserva orfa de
    // um aluno elegivel. Ver o comentario da funcao.
    const perdeuElegibilidade = existente.ativo && !novo.podeAgendar;

    if (!mudouModalidade && !mudouPolo && !perdeuElegibilidade) {
      return undefined;
    }

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
      ...(perdeuElegibilidade
        ? {
            statusCurso: {
              de: existente.statusCurso,
              para: novo.statusCurso,
            },
          }
        : {}),
      agendamentosConfirmados,
    };
  }
}
