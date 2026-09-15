import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { montarCsv } from '../../agendamento/service/csv-relatorio';
import { PrismaService } from '../../database/prisma.service';
import { D2lGruposService } from '../../d2l/service/d2l-grupos.service';
import {
  NaoEncontradoNoBrightspace,
  RecusaDoBrightspace,
} from '../../d2l/service/d2l-http.service';
import type { OpcoesDeRitmo } from '../../d2l/service/d2l-quizzes.service';
import {
  Prisma,
  ResultadoGruposD2L,
  StatusAgendamento,
  StatusExecucao,
  TipoExecucaoGruposD2L,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { normalizarNomeDeGrupo } from '../../senha-quiz/service/grupo';
import { ModalidadeDaTurmaService } from '../../senha-quiz/service/modalidade-da-turma.service';
import { isoDeDataUtc } from '../../senha-quiz/service/relogio';
import { carregarRitmoDosGrupos } from '../config/grupos-d2l.config';
import {
  BLOCOS_DE_GRUPOS,
  BlocoDeGrupos,
  blocoDaModalidade,
  blocoDaTurma,
  codigoDoGrupo,
  DEFINICAO_DO_BLOCO,
  MODALIDADES_COM_GRUPO,
} from './bloco';
import { IntervaloDeDias, intervaloDeDias } from './intervalo';
import { planejarGrupos, planejarInscricoes } from './plano';
import { ehPendencia } from './resultado';

/**
 * ============================================================================
 * OS DOIS LOTES: CRIAR CATEGORIAS E GRUPOS, E INSCREVER OS ALUNOS
 * ============================================================================
 * Dois botoes, duas execucoes — pedido do cliente, para que um clique nao
 * acumule as requisicoes dos dois. A ordem de uso e criar e depois inscrever;
 * inscrever numa turma sem a categoria vira pendencia, nunca criacao implicita.
 *
 * Mesma forma do compulsorio: a rota responde na hora com o id, o lote roda em
 * segundo plano gravando o andamento a cada turma, e a tela pergunta.
 *
 * **Simulacao faz as LEITURAS e nenhuma escrita.** E o que responde "quantas
 * inscricoes sairiam?" com o estado real do Brightspace, e nao com uma estimativa.
 *
 * ⚠️ **Nada mudou = nenhuma chamada.** Cada execucao grava uma assinatura do que
 * quis aplicar (nomes, turmas e, na inscricao, quem vai para qual grupo). Se a
 * ultima execucao REAL terminou sem pendencia com a mesma assinatura, o botao
 * responde "nada a fazer" sem abrir o lote — e o "se nenhum grupo novo foi
 * criado, nada acontece" que o cliente pediu. `forcar` confere no Brightspace
 * mesmo assim, para quando alguem mexeu direto la.
 *
 * O recorte e a JANELA VIGENTE inteira (`periodoLetivoIds` + `rodada`) e o
 * intervalo de dias de prova da tela, nos tres blocos (EaD, Semi/Modular e
 * Presencial).
 */

/** Silencio maior que isto = lote morto. Mesmo criterio do compulsorio. */
const SILENCIO_ATE_MORRER_MS = 5 * 60_000;

/** A criacao de categoria e assincrona: quanto esperar, e quantas vezes. */
const ESPERA_DA_CATEGORIA_MS = 2_000;
const TENTATIVAS_DA_CATEGORIA = 15;

export interface OpcoesDoLoteDeGrupos {
  tipo: TipoExecucaoGruposD2L;
  simulacao: boolean;
  de: string;
  ate: string;
  forcar: boolean;
  /**
   * So esta turma. Existe para o PRIMEIRO uso real: a simulacao nao exercita a
   * criacao de categoria, e soltar um comportamento nunca visto em 150 turmas de
   * uma vez transformaria qualquer surpresa em 150 surpresas.
   */
  orgUnitId: string | null;
}

export interface ExecucaoGruposIniciada {
  /** Nulo quando nao havia nada a fazer e nenhuma execucao foi aberta. */
  id: number | null;
  simulacao: boolean;
  totalTurmas: number;
  nadaAFazer: boolean;
  mensagem: string | null;
}

export interface AndamentoDosGruposD2L {
  id: number;
  tipo: TipoExecucaoGruposD2L;
  status: StatusExecucao;
  simulacao: boolean;
  interrompida: boolean;
  periodoLetivoIds: string;
  rodada: string;
  de: string;
  ate: string;
  iniciadoPor: string;
  totalTurmas: number;
  turmasProcessadas: number;
  categoriasCriadas: number;
  gruposCriados: number;
  gruposRenomeados: number;
  inscricoes: number;
  remocoes: number;
  jaInscritos: number;
  pendencias: number;
  resultados: Partial<Record<ResultadoGruposD2L, number>>;
  erro: string | null;
  iniciadoEm: Date;
  concluidoEm: Date | null;
  atualizadoEm: Date;
}

interface TurmaDoLote {
  orgUnitId: string;
  codigoTurma: string | null;
  nomeDisciplina: string | null;
  /** Nulo = ambigua (EaD misturado com Semi/Modular sem desempate). */
  bloco: BlocoDeGrupos | null;
  ambiguidade: string | null;
}

interface ReservaNaTurma {
  matricula: string;
  userIdD2L: string;
  status: StatusAgendamento;
  modalidadeCodigo: string;
  data: string;
  horaInicio: string;
  horaFim: string;
}

type FaltaDeSessao = 'HORARIO_SEM_JANELA' | 'SEM_GRUPO_NO_DIA';

interface ContextoDoLote {
  periodoLetivoIds: string[];
  rodada: string;
  intervalo: IntervaloDeDias;
  /** Os nomes de cada bloco, em ordem de dia e horario, sem repetir. */
  nomesPorBloco: Map<BlocoDeGrupos, string[]>;
  turmas: TurmaDoLote[];
  reservasPorTurma: Map<string, ReservaNaTurma[]>;
  /** O grupo daquela sessao para aquela modalidade — ou por que nao ha. */
  grupoDaSessao(
    reserva: ReservaNaTurma,
  ): { nome: string } | { falta: FaltaDeSessao };
}

type ItemNovo = Omit<Prisma.ItemGruposD2LCreateManyInput, 'execucaoId'>;

interface Contadores {
  categoriasCriadas: number;
  gruposCriados: number;
  gruposRenomeados: number;
  inscricoes: number;
  remocoes: number;
  jaInscritos: number;
  pendencias: number;
}

@Injectable()
export class GruposD2lService {
  private readonly logger = new Logger(GruposD2lService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly d2l: D2lGruposService,
    private readonly periodo: PeriodoService,
    private readonly modalidades: ModalidadeDaTurmaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async iniciar(
    opcoes: OpcoesDoLoteDeGrupos,
    adminEmail: string,
  ): Promise<ExecucaoGruposIniciada> {
    if (!this.d2l.habilitado()) {
      throw new BadRequestException(
        'Criar grupos e inscrever alunos dependem da integracao com o ' +
          'Brightspace (D2L_HABILITADO=true, com a autorizacao OAuth feita).',
      );
    }

    const emAndamento = await this.emAndamento();

    if (emAndamento) {
      throw new ConflictException(
        `A execucao ${emAndamento.id} ainda esta rodando ` +
          `(${emAndamento.turmasProcessadas} de ${emAndamento.totalTurmas} turmas). ` +
          'Espere terminar: as duas acoes batem no mesmo Brightspace.',
      );
    }

    const vigente = await this.periodo.janelaVigente();

    if (!vigente) {
      throw new BadRequestException(
        'Nenhum periodo de agendamento cadastrado. Sem ele nao ha como saber ' +
          'de qual prova sao os alunos.',
      );
    }

    const intervalo = intervaloDeDias(opcoes.de, opcoes.ate);
    const contexto = await this.montarContexto(
      vigente.periodoLetivoIds,
      vigente.rodada,
      intervalo,
    );

    // A assinatura e calculada DEPOIS do filtro, entao a execucao de uma turma
    // nunca e confundida com a de todas pelo "nada mudou".
    if (opcoes.orgUnitId) {
      contexto.turmas = contexto.turmas.filter(
        (t) => t.orgUnitId === opcoes.orgUnitId,
      );

      if (contexto.turmas.length === 0) {
        throw new BadRequestException(
          `A turma ${opcoes.orgUnitId} nao entra no lote: ela nao tem prova ` +
            'confirmada de EaD, Semipresencial, Modular ou Presencial entre ' +
            `${diaBr(intervalo.de)} e ${diaBr(intervalo.ate)} na rodada ${vigente.rodada}.`,
        );
      }
    }

    const criar = opcoes.tipo === TipoExecucaoGruposD2L.CRIAR_GRUPOS;
    const totalDeNomes = [...contexto.nomesPorBloco.values()].reduce(
      (soma, nomes) => soma + nomes.length,
      0,
    );

    if (criar && totalDeNomes === 0) {
      throw new BadRequestException(
        `Nenhum nome de grupo cadastrado entre ${diaBr(intervalo.de)} e ` +
          `${diaBr(intervalo.ate)}. Cadastre os grupos de EaD e de Semi/Modular antes.`,
      );
    }

    if (contexto.turmas.length === 0) {
      throw new BadRequestException(
        'Nenhuma turma EaD, Semipresencial, Modular ou Presencial tem prova confirmada ' +
          `entre ${diaBr(intervalo.de)} e ${diaBr(intervalo.ate)} na rodada ` +
          `${vigente.rodada}.`,
      );
    }

    const assinatura = assinar(opcoes.tipo, contexto);

    if (!opcoes.forcar) {
      const nada = await this.nadaMudou(opcoes.tipo, assinatura);

      if (nada) {
        return {
          id: null,
          simulacao: opcoes.simulacao,
          totalTurmas: contexto.turmas.length,
          nadaAFazer: true,
          mensagem:
            `Nada mudou desde a execucao ${nada.id} (${dataHoraBr(nada.concluidoEm)}): ` +
            (criar
              ? `as ${contexto.turmas.length} turma(s) ja receberam os ${totalDeNomes} grupo(s).`
              : `os alunos das ${contexto.turmas.length} turma(s) ja foram inscritos nos grupos atuais.`) +
            ' Nenhuma chamada foi feita ao Brightspace. Use "conferir mesmo assim" ' +
            'se alguem alterou algo direto no Brightspace.',
        };
      }
    }

    const execucao = await this.prisma.execucaoGruposD2L.create({
      data: {
        tipo: opcoes.tipo,
        simulacao: opcoes.simulacao,
        periodoLetivoIds: contexto.periodoLetivoIds.join(','),
        rodada: contexto.rodada,
        de: intervalo.deData,
        ate: intervalo.ateData,
        iniciadoPor: adminEmail,
        assinatura,
        totalTurmas: contexto.turmas.length,
      },
      select: { id: true },
    });

    this.auditoria.registrar('GRUPOS_D2L_INICIADO', {
      ator: adminEmail,
      detalhe:
        `execucao ${execucao.id}, ${opcoes.tipo}, ` +
        `${opcoes.simulacao ? 'SIMULACAO' : 'GRAVANDO'}, ` +
        `${contexto.turmas.length} turma(s), ${intervalo.de} a ${intervalo.ate}, ` +
        `rodada ${contexto.rodada}` +
        (opcoes.forcar ? ', forcada' : '') +
        (opcoes.orgUnitId ? `, so a turma ${opcoes.orgUnitId}` : ''),
    });

    void this.executar(execucao.id, opcoes, contexto, adminEmail);

    return {
      id: execucao.id,
      simulacao: opcoes.simulacao,
      totalTurmas: contexto.turmas.length,
      nadaAFazer: false,
      mensagem: null,
    };
  }

  async consultar(id: number): Promise<AndamentoDosGruposD2L> {
    const execucao = await this.prisma.execucaoGruposD2L.findUnique({
      where: { id },
    });

    if (!execucao) throw new NotFoundException(`Execucao ${id} nao encontrada`);

    const porResultado = await this.prisma.itemGruposD2L.groupBy({
      by: ['resultado'],
      where: { execucaoId: id },
      _count: { _all: true },
    });

    return {
      id: execucao.id,
      tipo: execucao.tipo,
      status: execucao.status,
      simulacao: execucao.simulacao,
      interrompida: this.pareceMorta(execucao),
      periodoLetivoIds: execucao.periodoLetivoIds,
      rodada: execucao.rodada,
      de: isoDeDataUtc(execucao.de),
      ate: isoDeDataUtc(execucao.ate),
      iniciadoPor: execucao.iniciadoPor,
      totalTurmas: execucao.totalTurmas,
      turmasProcessadas: execucao.turmasProcessadas,
      categoriasCriadas: execucao.categoriasCriadas,
      gruposCriados: execucao.gruposCriados,
      gruposRenomeados: execucao.gruposRenomeados,
      inscricoes: execucao.inscricoes,
      remocoes: execucao.remocoes,
      jaInscritos: execucao.jaInscritos,
      pendencias: execucao.pendencias,
      resultados: Object.fromEntries(
        porResultado.map((linha) => [linha.resultado, linha._count._all]),
      ),
      erro: execucao.erro,
      iniciadoEm: execucao.iniciadoEm,
      concluidoEm: execucao.concluidoEm,
      atualizadoEm: execucao.atualizadoEm,
    };
  }

  /**
   * O relatorio da execucao, com as PENDENCIAS primeiro: sao a fila de trabalho,
   * e as inscricoes que deram certo sao milhares de linhas que ninguem le.
   *
   * Formato do Excel pt-BR (`;` + BOM), como o do compulsorio — quem abre e
   * pessoa, nao o import do Brightspace.
   */
  async relatorioCsv(
    id: number,
  ): Promise<{ nomeArquivo: string; conteudo: string }> {
    const execucao = await this.prisma.execucaoGruposD2L.findUnique({
      where: { id },
      select: { id: true, tipo: true },
    });

    if (!execucao) throw new NotFoundException(`Execucao ${id} nao encontrada`);

    const itens = await this.prisma.itemGruposD2L.findMany({
      where: { execucaoId: id },
      orderBy: { id: 'asc' },
    });

    itens.sort(
      (a, b) =>
        Number(ehPendencia(b.resultado)) - Number(ehPendencia(a.resultado)) ||
        a.resultado.localeCompare(b.resultado) ||
        (a.codigoTurma ?? a.orgUnitId).localeCompare(
          b.codigoTurma ?? b.orgUnitId,
        ) ||
        (a.nomeGrupo ?? '').localeCompare(b.nomeGrupo ?? '') ||
        (a.matricula ?? '').localeCompare(b.matricula ?? ''),
    );

    const conteudo = montarCsv(
      [
        'Turma',
        'Disciplina',
        'orgUnitId',
        'Grupo',
        'Matricula',
        'UserId D2L',
        'Resultado',
        'Pendencia',
        'O que aconteceu',
      ],
      itens.map((item) => [
        item.codigoTurma,
        item.nomeDisciplina,
        item.orgUnitId,
        item.nomeGrupo,
        item.matricula,
        item.userIdD2L,
        item.resultado,
        ehPendencia(item.resultado) ? 'Sim' : 'Nao',
        item.detalhe,
      ]),
    );

    const hoje = new Date()
      .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      .replace(/\//g, '-');

    const acao =
      execucao.tipo === TipoExecucaoGruposD2L.CRIAR_GRUPOS
        ? 'criacao de grupos'
        : 'inscricao nos grupos';

    return {
      nomeArquivo: `Grupos D2L - ${acao} ${hoje} (execucao ${id}).csv`,
      conteudo,
    };
  }

  /** A execucao viva, se houver. Enterra a morta, como o compulsorio. */
  async emAndamento() {
    const candidata = await this.prisma.execucaoGruposD2L.findFirst({
      where: { status: StatusExecucao.EM_ANDAMENTO },
      orderBy: { id: 'desc' },
    });

    if (!candidata) return null;

    if (this.pareceMorta(candidata)) {
      await this.prisma.execucaoGruposD2L.update({
        where: { id: candidata.id },
        data: {
          status: StatusExecucao.FALHOU,
          erro:
            'O processo foi interrompido durante a execucao (reinicio do ' +
            'servidor?). O que ja foi feito no Brightspace permanece; rodar de ' +
            'novo continua de onde parou, porque o lote so escreve o que falta.',
          concluidoEm: new Date(),
        },
      });

      return null;
    }

    return candidata;
  }

  // ------------------------------------------------------------------ interno

  private pareceMorta(execucao: {
    status: StatusExecucao;
    atualizadoEm: Date;
  }): boolean {
    return (
      execucao.status === StatusExecucao.EM_ANDAMENTO &&
      Date.now() - execucao.atualizadoEm.getTime() > SILENCIO_ATE_MORRER_MS
    );
  }

  private async nadaMudou(tipo: TipoExecucaoGruposD2L, assinatura: string) {
    const anterior = await this.prisma.execucaoGruposD2L.findFirst({
      where: { tipo, simulacao: false, status: StatusExecucao.CONCLUIDA },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        assinatura: true,
        pendencias: true,
        concluidoEm: true,
      },
    });

    return anterior?.assinatura === assinatura && anterior.pendencias === 0
      ? anterior
      : null;
  }

  /**
   * Tudo que vem do BANCO, lido uma vez antes de o lote comecar. Durante o lote
   * so a rede e consultada — e o mesmo motivo do compulsorio: um remanejo no
   * meio nao pode fazer metade das turmas usar um estado e metade outro.
   */
  private async montarContexto(
    periodoLetivoIds: string[],
    rodada: string,
    intervalo: IntervaloDeDias,
  ): Promise<ContextoDoLote> {
    const noIntervalo = { gte: intervalo.deData, lte: intervalo.ateData };

    const janelas = await this.prisma.janelaDeProva.findMany({
      where: {
        ativo: true,
        modalidade: { codigo: { in: [...MODALIDADES_COM_GRUPO] } },
      },
      select: {
        id: true,
        horaInicio: true,
        horaFim: true,
        modalidade: { select: { codigo: true } },
      },
    });

    const janelaDaSessao = new Map(
      janelas.map((j) => [
        `${j.modalidade.codigo}|${j.horaInicio}|${j.horaFim}`,
        j,
      ]),
    );
    const janelaPorId = new Map(janelas.map((j) => [j.id, j]));

    const celulas = await this.prisma.grupoDaJanela.findMany({
      where: {
        data: noIntervalo,
        janelaDeProvaId: { in: janelas.map((j) => j.id) },
      },
      select: { data: true, janelaDeProvaId: true, nomeGrupo: true },
    });

    const nomeDaCelula = new Map(
      celulas.map((c) => [
        `${isoDeDataUtc(c.data)}#${c.janelaDeProvaId}`,
        c.nomeGrupo,
      ]),
    );

    const nomesPorBloco = new Map<BlocoDeGrupos, string[]>(
      BLOCOS_DE_GRUPOS.map((bloco) => [bloco, []]),
    );
    const vistos = new Set<string>();

    for (const celula of [...celulas].sort(
      (a, b) =>
        a.data.getTime() - b.data.getTime() ||
        (janelaPorId.get(a.janelaDeProvaId)?.horaInicio ?? '').localeCompare(
          janelaPorId.get(b.janelaDeProvaId)?.horaInicio ?? '',
        ),
    )) {
      const bloco = blocoDaModalidade(
        janelaPorId.get(celula.janelaDeProvaId)?.modalidade.codigo,
      );
      const chave = `${bloco}|${normalizarNomeDeGrupo(celula.nomeGrupo)}`;

      if (!bloco || vistos.has(chave)) continue;
      vistos.add(chave);
      nomesPorBloco.get(bloco)!.push(celula.nomeGrupo);
    }

    // As CANCELADAS entram: sao elas que dizem quem tirar de um grupo quando o
    // admin cancela uma prova depois do prazo.
    const linhas = await this.prisma.agendamentoDisciplina.findMany({
      where: {
        agendamento: {
          status: {
            in: [StatusAgendamento.CONFIRMADO, StatusAgendamento.CANCELADO],
          },
          periodoLetivoId: { in: periodoLetivoIds },
          rodada,
          modalidade: { codigo: { in: [...MODALIDADES_COM_GRUPO] } },
          salaFaixa: { faixa: { data: noIntervalo } },
        },
      },
      select: {
        orgUnitId: true,
        nomeDisciplina: true,
        agendamento: {
          select: {
            matricula: true,
            userIdD2L: true,
            status: true,
            modalidade: { select: { codigo: true } },
            salaFaixa: {
              select: {
                faixa: {
                  select: { data: true, horaInicio: true, horaFim: true },
                },
              },
            },
          },
        },
      },
      orderBy: [{ orgUnitId: 'asc' }, { agendamento: { matricula: 'asc' } }],
    });

    const reservasPorTurma = new Map<string, ReservaNaTurma[]>();
    const nomeDaDisciplina = new Map<string, string | null>();
    const comConfirmada = new Set<string>();

    for (const linha of linhas) {
      const { agendamento } = linha;
      const { faixa } = agendamento.salaFaixa;

      const reservas = reservasPorTurma.get(linha.orgUnitId) ?? [];
      reservas.push({
        matricula: agendamento.matricula,
        userIdD2L: agendamento.userIdD2L,
        status: agendamento.status,
        modalidadeCodigo: agendamento.modalidade.codigo,
        data: isoDeDataUtc(faixa.data),
        horaInicio: faixa.horaInicio,
        horaFim: faixa.horaFim,
      });
      reservasPorTurma.set(linha.orgUnitId, reservas);

      if (!nomeDaDisciplina.has(linha.orgUnitId)) {
        nomeDaDisciplina.set(linha.orgUnitId, linha.nomeDisciplina);
      }
      if (agendamento.status === StatusAgendamento.CONFIRMADO) {
        comConfirmada.add(linha.orgUnitId);
      }
    }

    const mapa = await this.modalidades.resolver(periodoLetivoIds, rodada);

    const doCsv = await this.prisma.turmaImportada.findMany({
      where: { orgUnitId: { in: [...comConfirmada] } },
      select: { orgUnitId: true, codigoTurma: true, nomeDisciplina: true },
    });
    const turmaDoCsv = new Map(doCsv.map((t) => [t.orgUnitId!, t]));

    const turmas: TurmaDoLote[] = [];

    for (const orgUnitId of comConfirmada) {
      const decisao = blocoDaTurma(mapa.de(orgUnitId));
      if (decisao.situacao === 'FORA') continue;

      turmas.push({
        orgUnitId,
        codigoTurma: turmaDoCsv.get(orgUnitId)?.codigoTurma ?? null,
        nomeDisciplina:
          turmaDoCsv.get(orgUnitId)?.nomeDisciplina ??
          nomeDaDisciplina.get(orgUnitId) ??
          null,
        bloco: decisao.situacao === 'BLOCO' ? decisao.bloco : null,
        ambiguidade: decisao.situacao === 'AMBIGUA' ? decisao.detalhe : null,
      });
    }

    turmas.sort((a, b) =>
      (a.codigoTurma ?? a.orgUnitId).localeCompare(
        b.codigoTurma ?? b.orgUnitId,
        'pt-BR',
      ),
    );

    return {
      periodoLetivoIds: [...periodoLetivoIds].sort(),
      rodada,
      intervalo,
      nomesPorBloco,
      turmas,
      reservasPorTurma,
      grupoDaSessao: (reserva) => {
        const janela = janelaDaSessao.get(
          `${reserva.modalidadeCodigo}|${reserva.horaInicio}|${reserva.horaFim}`,
        );
        if (!janela) return { falta: 'HORARIO_SEM_JANELA' };

        const nome = nomeDaCelula.get(`${reserva.data}#${janela.id}`);
        return nome ? { nome } : { falta: 'SEM_GRUPO_NO_DIA' };
      },
    };
  }

  private async executar(
    execucaoId: number,
    opcoes: OpcoesDoLoteDeGrupos,
    contexto: ContextoDoLote,
    adminEmail: string,
  ): Promise<void> {
    const ritmo = carregarRitmoDosGrupos(this.config);
    const contadores: Contadores = {
      categoriasCriadas: 0,
      gruposCriados: 0,
      gruposRenomeados: 0,
      inscricoes: 0,
      remocoes: 0,
      jaInscritos: 0,
      pendencias: 0,
    };

    try {
      for (const [indice, turma] of contexto.turmas.entries()) {
        const itens: ItemNovo[] = [];

        // Uma turma que falha nao derruba as outras: vira item, e o lote segue.
        try {
          if (opcoes.tipo === TipoExecucaoGruposD2L.CRIAR_GRUPOS) {
            await this.criarNaTurma(
              turma,
              contexto,
              opcoes.simulacao,
              ritmo,
              itens,
              contadores,
            );
          } else {
            await this.inscreverNaTurma(
              turma,
              contexto,
              opcoes.simulacao,
              ritmo,
              itens,
              contadores,
            );
          }
        } catch (erro) {
          itens.push(
            item(turma, ResultadoGruposD2L.FALHA_NA_API, {
              detalhe: motivo(erro),
            }),
          );
        }

        contadores.pendencias += itens.filter((i) =>
          ehPendencia(i.resultado),
        ).length;

        if (itens.length > 0) {
          await this.prisma.itemGruposD2L.createMany({
            data: itens.map((i) => ({ ...i, execucaoId })),
          });
        }

        await this.prisma.execucaoGruposD2L.update({
          where: { id: execucaoId },
          data: { turmasProcessadas: indice + 1, ...contadores },
        });
      }

      await this.prisma.execucaoGruposD2L.update({
        where: { id: execucaoId },
        data: { status: StatusExecucao.CONCLUIDA, concluidoEm: new Date() },
      });

      this.auditoria.registrar('GRUPOS_D2L_CONCLUIDO', {
        ator: adminEmail,
        detalhe:
          `execucao ${execucaoId}, ${opcoes.tipo}: ` +
          `${contadores.categoriasCriadas} categoria(s), ${contadores.gruposCriados} ` +
          `grupo(s) criado(s), ${contadores.gruposRenomeados} renomeado(s), ` +
          `${contadores.inscricoes} inscricao(oes), ${contadores.remocoes} remocao(oes), ` +
          `${contadores.pendencias} pendencia(s)`,
      });
    } catch (erro) {
      const texto = motivo(erro);

      this.logger.error(`Execucao de grupos ${execucaoId} falhou: ${texto}`);

      await this.prisma.execucaoGruposD2L
        .update({
          where: { id: execucaoId },
          data: {
            status: StatusExecucao.FALHOU,
            erro: texto,
            concluidoEm: new Date(),
          },
        })
        .catch(() => undefined);

      this.auditoria.registrar('GRUPOS_D2L_FALHOU', {
        ator: adminEmail,
        detalhe: `execucao ${execucaoId}: ${texto}`,
      });
    }
  }

  /**
   * Garante a categoria do bloco e TODOS os nomes do bloco na turma.
   *
   * Todos, e nao so os das sessoes em que a turma tem aluno: a troca de condicao
   * do quiz procura o grupo da sessao em TODA turma da modalidade, e uma turma
   * sem aquele grupo viraria `GRUPO_NAO_ENCONTRADO` no disparo (decisao do
   * cliente: "toda turma tem todos os grupos").
   */
  private async criarNaTurma(
    turma: TurmaDoLote,
    contexto: ContextoDoLote,
    simulacao: boolean,
    ritmo: OpcoesDeRitmo,
    itens: ItemNovo[],
    contadores: Contadores,
  ): Promise<void> {
    if (!turma.bloco) {
      itens.push(
        item(turma, ResultadoGruposD2L.TURMA_AMBIGUA, {
          detalhe: turma.ambiguidade,
        }),
      );
      return;
    }

    const definicao = DEFINICAO_DO_BLOCO[turma.bloco];
    const desejados = contexto.nomesPorBloco.get(turma.bloco) ?? [];

    // Bloco sem nenhum nome no intervalo: nao ha o que criar nesta turma — e
    // criar a categoria vazia so deixaria grupos genericos para tras.
    if (desejados.length === 0) return;

    const achada = await this.acharCategoria(
      turma,
      definicao.categoria,
      ritmo,
      itens,
    );
    if (achada === 'DUPLICADA') return;

    let categoriaId = achada;

    if (categoriaId === null) {
      itens.push(
        item(turma, ResultadoGruposD2L.CATEGORIA_CRIADA, {
          detalhe: `Categoria "${definicao.categoria}".`,
        }),
      );
      contadores.categoriasCriadas += 1;

      if (simulacao) {
        for (const nome of desejados) {
          itens.push(
            item(turma, ResultadoGruposD2L.GRUPO_CRIADO, { nomeGrupo: nome }),
          );
          contadores.gruposCriados += 1;
        }
        return;
      }

      const criada = await this.d2l.criarCategoria(
        turma.orgUnitId,
        definicao.categoria,
        desejados.length,
        ritmo,
      );

      if (
        !criada.concluida &&
        !(await this.esperarCategoria(turma, criada.categoriaId, ritmo))
      ) {
        itens.push(
          item(turma, ResultadoGruposD2L.CATEGORIA_EM_PROCESSAMENTO, {
            detalhe:
              `A categoria foi criada (id ${criada.categoriaId}), mas o Brightspace ` +
              `ainda a processava depois de ${(TENTATIVAS_DA_CATEGORIA * ESPERA_DA_CATEGORIA_MS) / 1000}s. ` +
              'Rode "Criar categorias e grupos" de novo em alguns minutos: os grupos ' +
              'genericos dela serao renomeados.',
          }),
        );
        return;
      }

      categoriaId = criada.categoriaId;
    }

    const existentes = await this.d2l.listarGrupos(
      turma.orgUnitId,
      categoriaId,
      ritmo,
    );
    const plano = planejarGrupos(desejados, existentes);

    for (const renomeio of plano.renomear) {
      try {
        if (!simulacao) {
          await this.d2l.renomearGrupo(
            turma.orgUnitId,
            categoriaId,
            renomeio.GroupId,
            { nome: renomeio.para, codigo: codigoDoGrupo(renomeio.para) },
            ritmo,
          );
        }

        itens.push(
          item(turma, ResultadoGruposD2L.GRUPO_RENOMEADO, {
            nomeGrupo: renomeio.para,
            detalhe: `Grupo vazio "${renomeio.de}" (#${renomeio.GroupId}) reaproveitado.`,
          }),
        );
        contadores.gruposRenomeados += 1;
      } catch (erro) {
        itens.push(
          item(turma, classificarEscrita(erro), {
            nomeGrupo: renomeio.para,
            detalhe: `Ao renomear "${renomeio.de}" (#${renomeio.GroupId}): ${motivo(erro)}`,
          }),
        );
      }
    }

    for (const nome of plano.criar) {
      try {
        if (!simulacao) {
          await this.d2l.criarGrupo(
            turma.orgUnitId,
            categoriaId,
            { nome, codigo: codigoDoGrupo(nome) },
            ritmo,
          );
        }

        itens.push(
          item(turma, ResultadoGruposD2L.GRUPO_CRIADO, { nomeGrupo: nome }),
        );
        contadores.gruposCriados += 1;
      } catch (erro) {
        itens.push(
          item(turma, classificarEscrita(erro), {
            nomeGrupo: nome,
            detalhe: `Ao criar o grupo: ${motivo(erro)}`,
          }),
        );
      }
    }

    for (const grupo of plano.sobrando) {
      itens.push(
        item(turma, ResultadoGruposD2L.GRUPO_SOBRANDO, {
          nomeGrupo: grupo.Name,
          detalhe:
            `Tem ${grupo.Enrollments.length} inscrito(s) e nao esta na lista de ` +
            `${definicao.nome}. Nao foi tocado.`,
        }),
      );
    }
  }

  /**
   * Coloca cada aluno no grupo da sessao dele e tira do grupo antigo quem foi
   * remanejado ou cancelado depois do prazo.
   *
   * O grupo de cada reserva sai da mesma cadeia que o disparo do quiz usa:
   * horario da faixa -> janela da modalidade (horario EXATO) -> celula do dia.
   */
  private async inscreverNaTurma(
    turma: TurmaDoLote,
    contexto: ContextoDoLote,
    simulacao: boolean,
    ritmo: OpcoesDeRitmo,
    itens: ItemNovo[],
    contadores: Contadores,
  ): Promise<void> {
    if (!turma.bloco) {
      itens.push(
        item(turma, ResultadoGruposD2L.TURMA_AMBIGUA, {
          detalhe: turma.ambiguidade,
        }),
      );
      return;
    }

    const definicao = DEFINICAO_DO_BLOCO[turma.bloco];
    const desejado = new Map<number, Set<string>>();
    const matriculaDe = new Map<number, string>();
    const comPendencia = new Set<number>();
    const cancelados = new Set<number>();
    const pendenciasVistas = new Set<string>();

    const pendencia = (
      resultado: ResultadoGruposD2L,
      reserva: ReservaNaTurma,
      detalhe: string,
    ) => {
      const chave = `${resultado}|${reserva.matricula}|${reserva.data}|${reserva.horaInicio}`;
      if (pendenciasVistas.has(chave)) return;
      pendenciasVistas.add(chave);

      itens.push(
        item(turma, resultado, {
          matricula: reserva.matricula,
          userIdD2L: reserva.userIdD2L,
          detalhe,
        }),
      );
    };

    for (const reserva of contexto.reservasPorTurma.get(turma.orgUnitId) ??
      []) {
      const userId = Number(reserva.userIdD2L);

      if (!Number.isInteger(userId) || userId <= 0) {
        pendencia(
          ResultadoGruposD2L.USER_ID_INVALIDO,
          reserva,
          `O agendamento guarda o UserId "${reserva.userIdD2L}", que nao e numerico. ` +
            'A inscricao exige o id numerico do Brightspace.',
        );
        continue;
      }

      matriculaDe.set(userId, reserva.matricula);

      if (reserva.status === StatusAgendamento.CANCELADO) {
        cancelados.add(userId);
        continue;
      }

      const sessao = `${diaBr(reserva.data)} ${reserva.horaInicio}-${reserva.horaFim}`;

      if (blocoDaModalidade(reserva.modalidadeCodigo) !== turma.bloco) {
        comPendencia.add(userId);
        pendencia(
          ResultadoGruposD2L.ALUNO_DE_OUTRA_MODALIDADE,
          reserva,
          `O aluno e ${reserva.modalidadeCodigo} (${sessao}), mas a turma recebe os ` +
            `grupos de ${definicao.nome}. O questionario tem uma janela so — confira ` +
            'o desempate da turma na aba "Senhas e datas".',
        );
        continue;
      }

      const grupo = contexto.grupoDaSessao(reserva);

      if ('falta' in grupo) {
        comPendencia.add(userId);
        pendencia(
          ResultadoGruposD2L[grupo.falta],
          reserva,
          grupo.falta === 'HORARIO_SEM_JANELA'
            ? `A faixa ${sessao} nao tem janela de ${reserva.modalidadeCodigo} com o ` +
                'mesmo horario. Resolva a pendencia de horario na tela de grupos.'
            : `Nenhum grupo cadastrado para ${sessao} em ${definicao.nome}.`,
        );
        continue;
      }

      desejado.set(userId, (desejado.get(userId) ?? new Set()).add(grupo.nome));
    }

    if (desejado.size === 0 && cancelados.size === 0) return;

    const achada = await this.acharCategoria(
      turma,
      definicao.categoria,
      ritmo,
      itens,
    );
    if (achada === 'DUPLICADA') return;

    if (achada === null) {
      if (desejado.size > 0) {
        itens.push(
          item(turma, ResultadoGruposD2L.CATEGORIA_AUSENTE, {
            detalhe:
              `A turma nao tem a categoria "${definicao.categoria}". Rode "Criar ` +
              `categorias e grupos" antes — ${desejado.size} aluno(s) esperam grupo nela.`,
          }),
        );
      }
      return;
    }

    const grupos = await this.d2l.listarGrupos(turma.orgUnitId, achada, ritmo);

    const plano = planejarInscricoes({
      grupos,
      desejado,
      removiveis: new Set(
        [...desejado.keys(), ...cancelados].filter(
          (userId) => !comPendencia.has(userId),
        ),
      ),
    });

    contadores.jaInscritos += plano.jaInscritos;

    for (const falta of plano.semGrupo) {
      itens.push(
        item(turma, ResultadoGruposD2L.GRUPO_NAO_ENCONTRADO, {
          nomeGrupo: falta.nomeGrupo,
          matricula: matriculaDe.get(falta.userId),
          userIdD2L: String(falta.userId),
          detalhe: falta.duplicado
            ? `Ha mais de um grupo "${falta.nomeGrupo}" na categoria. Apague o ` +
              'duplicado no Brightspace: escolher um no chute poderia por o aluno ' +
              'no grupo que a condicao do quiz nao aponta.'
            : `O grupo nao existe na categoria "${definicao.categoria}". Rode ` +
              '"Criar categorias e grupos". O aluno continua onde estava.',
        }),
      );
    }

    for (const movimento of plano.adicionar) {
      try {
        if (!simulacao) {
          await this.d2l.inscrever(
            turma.orgUnitId,
            achada,
            movimento.GroupId,
            movimento.userId,
            ritmo,
          );
        }

        itens.push(
          item(turma, ResultadoGruposD2L.ALUNO_INSCRITO, {
            nomeGrupo: movimento.nomeGrupo,
            matricula: matriculaDe.get(movimento.userId),
            userIdD2L: String(movimento.userId),
          }),
        );
        contadores.inscricoes += 1;
      } catch (erro) {
        itens.push(
          item(turma, classificarInscricao(erro), {
            nomeGrupo: movimento.nomeGrupo,
            matricula: matriculaDe.get(movimento.userId),
            userIdD2L: String(movimento.userId),
            detalhe: motivoDaInscricao(erro),
          }),
        );
      }
    }

    for (const movimento of plano.remover) {
      const novos = [...(desejado.get(movimento.userId) ?? [])];

      try {
        if (!simulacao) {
          await this.d2l.desinscrever(
            turma.orgUnitId,
            achada,
            movimento.GroupId,
            movimento.userId,
            ritmo,
          );
        }

        itens.push(
          item(turma, ResultadoGruposD2L.ALUNO_REMOVIDO, {
            nomeGrupo: movimento.nomeGrupo,
            matricula: matriculaDe.get(movimento.userId),
            userIdD2L: String(movimento.userId),
            detalhe: novos.length
              ? `Remanejado: agora no grupo "${novos.join('", "')}".`
              : 'A prova desta turma foi cancelada.',
          }),
        );
        contadores.remocoes += 1;
      } catch (erro) {
        itens.push(
          item(turma, classificarEscrita(erro), {
            nomeGrupo: movimento.nomeGrupo,
            matricula: matriculaDe.get(movimento.userId),
            userIdD2L: String(movimento.userId),
            detalhe: `Ao remover do grupo: ${motivo(erro)}`,
          }),
        );
      }
    }
  }

  /**
   * O id da categoria do bloco na turma, `null` se nao existe, ou `'DUPLICADA'`
   * (ja registrada como item). Comparacao normalizada, como a dos grupos.
   */
  private async acharCategoria(
    turma: TurmaDoLote,
    nome: string,
    ritmo: OpcoesDeRitmo,
    itens: ItemNovo[],
  ): Promise<number | null | 'DUPLICADA'> {
    const categorias = await this.d2l.listarCategorias(turma.orgUnitId, ritmo);
    const alvo = normalizarNomeDeGrupo(nome);

    const achadas = categorias.filter(
      (c) => normalizarNomeDeGrupo(c.Name) === alvo,
    );

    if (achadas.length > 1) {
      itens.push(
        item(turma, ResultadoGruposD2L.CATEGORIA_DUPLICADA, {
          detalhe:
            `A turma tem ${achadas.length} categorias "${nome}" ` +
            `(ids ${achadas.map((c) => c.GroupCategoryId).join(', ')}). Apague a ` +
            'que sobra no Brightspace e rode de novo.',
        }),
      );
      return 'DUPLICADA';
    }

    const id = Number(achadas[0]?.GroupCategoryId);
    return achadas.length === 1 && Number.isInteger(id) ? id : null;
  }

  private async esperarCategoria(
    turma: TurmaDoLote,
    categoriaId: number,
    ritmo: OpcoesDeRitmo,
  ): Promise<boolean> {
    for (
      let tentativa = 0;
      tentativa < TENTATIVAS_DA_CATEGORIA;
      tentativa += 1
    ) {
      await new Promise((resolver) =>
        setTimeout(resolver, ESPERA_DA_CATEGORIA_MS),
      );

      if (
        await this.d2l.categoriaConcluida(turma.orgUnitId, categoriaId, ritmo)
      ) {
        return true;
      }
    }

    return false;
  }
}

function item(
  turma: TurmaDoLote,
  resultado: ResultadoGruposD2L,
  extra: {
    nomeGrupo?: string | null;
    matricula?: string | null;
    userIdD2L?: string | null;
    detalhe?: string | null;
  } = {},
): ItemNovo {
  return {
    orgUnitId: turma.orgUnitId,
    codigoTurma: turma.codigoTurma,
    nomeDisciplina: turma.nomeDisciplina,
    resultado,
    nomeGrupo: extra.nomeGrupo ?? null,
    matricula: extra.matricula ?? null,
    userIdD2L: extra.userIdD2L ?? null,
    detalhe: extra.detalhe ?? null,
  };
}

/**
 * O que o lote quis aplicar, em hash. Nao entra nada do Brightspace — so do
 * banco —, e e por isso que ela pode ser calculada sem chamada nenhuma.
 */
function assinar(
  tipo: TipoExecucaoGruposD2L,
  contexto: ContextoDoLote,
): string {
  const partes: Record<string, unknown> = {
    tipo,
    periodos: contexto.periodoLetivoIds,
    rodada: contexto.rodada,
    de: contexto.intervalo.de,
    ate: contexto.intervalo.ate,
    nomes: BLOCOS_DE_GRUPOS.map((bloco) => [
      bloco,
      contexto.nomesPorBloco.get(bloco),
    ]),
    turmas: contexto.turmas
      .map((t) => `${t.orgUnitId}:${t.bloco ?? 'AMBIGUA'}`)
      .sort(),
  };

  if (tipo === TipoExecucaoGruposD2L.INSCREVER_ALUNOS) {
    partes.reservas = contexto.turmas
      .flatMap((t) =>
        (contexto.reservasPorTurma.get(t.orgUnitId) ?? []).map(
          (r) =>
            `${t.orgUnitId}|${r.userIdD2L}|${r.status}|${r.modalidadeCodigo}|` +
            `${r.data}|${r.horaInicio}|${r.horaFim}`,
        ),
      )
      .sort();
  }

  return createHash('sha256').update(JSON.stringify(partes)).digest('hex');
}

/** 409 e o unico recusado "esperado" numa escrita de grupo; o resto e falha. */
function classificarEscrita(erro: unknown): ResultadoGruposD2L {
  return erro instanceof RecusaDoBrightspace && erro.statusHttp === 409
    ? ResultadoGruposD2L.CONFLITO_NO_GRUPO
    : ResultadoGruposD2L.FALHA_NA_API;
}

function classificarInscricao(erro: unknown): ResultadoGruposD2L {
  return erro instanceof NaoEncontradoNoBrightspace
    ? ResultadoGruposD2L.ALUNO_NAO_ENCONTRADO
    : classificarEscrita(erro);
}

function motivoDaInscricao(erro: unknown): string {
  if (erro instanceof NaoEncontradoNoBrightspace) {
    return (
      'O Brightspace nao encontrou o usuario neste grupo (404). O mais comum: o ' +
      'aluno nao esta matriculado nesta turma do Brightspace, ou a conta foi ' +
      'removida.'
    );
  }

  if (erro instanceof RecusaDoBrightspace && erro.statusHttp === 409) {
    return (
      'O Brightspace recusou com 409: o grupo atingiu a capacidade maxima, ou a ' +
      'categoria ainda esta sendo processada. Rode de novo em alguns minutos.'
    );
  }

  return motivo(erro);
}

/** Truncado: `detalhe` e para ler. O 403 ganha a dica do escopo. */
function motivo(erro: unknown): string {
  const texto = (erro instanceof Error ? erro.message : String(erro)).slice(
    0,
    400,
  );

  if (erro instanceof RecusaDoBrightspace && erro.statusHttp === 403) {
    return (
      `${texto} — Confira se groups:group:create, groups:enrollment:create e ` +
      'groups:enrollment:delete estao no D2L_SCOPES e se a autorizacao foi ' +
      'refeita (npm run d2l:autorizar).'
    );
  }

  return texto;
}

function diaBr(iso: string): string {
  const [ano, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${ano}`;
}

function dataHoraBr(instante: Date | null): string {
  return instante
    ? instante.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : 'data desconhecida';
}
