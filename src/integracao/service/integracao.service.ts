import { Injectable, NotFoundException } from '@nestjs/common';
import {
  INCLUDE_COMPLETO,
  montarConfirmado,
} from '../../agendamento/service/agendamento.service';
import { CONFIRMADO } from '../../agendamento/service/lock-de-vagas';
import { descricaoDaRodada } from '../../agendamento/service/rodada';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import {
  idsDaJanela,
  PeriodoService,
} from '../../periodo/service/periodo.service';
import { isoDeDataUtc } from '../../senha-quiz/service/relogio';
import { janelaDoAgendamento } from './janela-do-agendamento';

/** `null` = historico completo; `'atual'` = so a janela vigente. */
export type RecorteDoPeriodo = 'atual' | null;

interface Modalidade {
  codigo: string;
  nome: string;
  duracaoMinutos: number;
}

interface Local {
  id: number;
  nome: string;
}

/** Um curso do aluno, como veio do CSV. E o "Campus/Polo da Matricula" da tela. */
export interface VinculoIntegracao {
  alunoId: number;
  curso: string;
  statusCurso: string;
  ativo: boolean;
  modalidade: Modalidade;
  polo: Local;
}

/**
 * Uma janela de agendamento, UMA vez no topo da resposta — e nao repetida em
 * cada prova, que so aponta para ela pelo `periodoId`. O mesmo formato nas duas
 * rotas da integracao.
 */
export interface PeriodoIntegracao {
  id: number;
  rodada: string;
  rodadaDescricao: string;
  descricao: string | null;
  /** Os periodos letivos que a janela cobre — as duas grades. */
  periodoLetivoIds: string[];
  dataAbertura: Date | null;
  dataFechamento: Date;
  prazoEncerrado: boolean;
}

/**
 * Uma disciplina da prova. Os codigos saem da turma importada (CSV de turmas)
 * pelo `orgUnitId`, e ficam `null` quando a turma nao esta la ou o CSV nao
 * trouxe o codigo — a mesma "—" da tela de Turmas.
 */
export interface DisciplinaIntegracao {
  orgUnitId: string;
  nomeDisciplina: string | null;
  codigoTurma: string | null;
  codigoDisciplina: string | null;
}

/** Uma prova: so o que e da prova do aluno. A janela fica em `periodos[]`. */
export interface AgendamentoIntegracao {
  id: number;
  /** A janela da prova, em `periodos[]`. `null` so se a janela nao existe mais. */
  periodoId: number | null;
  alunoId: number;
  curso: string;
  status: string;
  /** O do formato do aluno: no mesmo periodo, EaD e Presencial diferem. */
  periodoLetivoId: string;
  /** "AAAA-MM-DD" — string, e nao Date, para ninguem ler o dia no fuso errado. */
  data: string;
  horaInicio: string;
  horaFim: string;
  formato: Modalidade;
  /** Onde a prova ACONTECE — o polo da faixa, nao o do cadastro. */
  polo: Local;
  sala: Local;
  disciplinas: DisciplinaIntegracao[];
  agendadoEm: Date;
  alocadoManual: boolean;
}

/** Uma prova na lista geral: a mesma, mais quem e o aluno. */
export interface AgendamentoDaListaIntegracao extends AgendamentoIntegracao {
  matricula: string;
  nome: string | null;
}

export interface AgendamentosDoAluno {
  matricula: string;
  nome: string | null;
  filtro: { periodo: RecorteDoPeriodo };
  vinculos: VinculoIntegracao[];
  periodos: PeriodoIntegracao[];
  agendamentos: AgendamentoIntegracao[];
}

/**
 * O recorte da lista geral. Sempre UM periodo: ou a janela vigente, ou um
 * periodo letivo escolhido (com ou sem rodada) — nunca o historico inteiro de
 * todos os alunos de uma vez.
 */
export type FiltroDaLista =
  | { periodo: 'atual' }
  | { periodo: null; periodoLetivoIds: string[]; rodada: string | null };

/** O recorte como foi APLICADO — no `atual`, ja resolvido para a janela vigente. */
export interface FiltroAplicado {
  periodo: 'atual' | null;
  periodoLetivoIds: string[];
  rodada: string | null;
}

export interface PaginaDeAgendamentosIntegracao {
  filtro: FiltroAplicado;
  periodos: PeriodoIntegracao[];
  total: number;
  pagina: number;
  porPagina: number;
  totalPaginas: number;
  itens: AgendamentoDaListaIntegracao[];
}

export const PADRAO_POR_PAGINA = 100;
export const MAXIMO_POR_PAGINA = 500;

/** O vigente, como `janelaVigente` devolve — `undefined` sem janela cadastrada. */
type Vigente = Awaited<ReturnType<PeriodoService['janelaVigente']>>;

const COM_MAPA = {
  letivosPorModalidade: { select: { periodoLetivoId: true } },
} satisfies Prisma.PeriodoAgendamentoInclude;

type JanelaLida = Prisma.PeriodoAgendamentoGetPayload<{
  include: typeof COM_MAPA;
}>;

/** A janela vigente, pelo par que a identifica (`criar` recusa a duplicata). */
const ehAVigente = (janela: JanelaLida, vigente: Vigente) =>
  !!vigente &&
  janela.rodada === vigente.rodada &&
  janela.periodoLetivoId === vigente.principal;

type AgendamentoLido = Prisma.AgendamentoGetPayload<{
  include: typeof INCLUDE_COMPLETO;
}>;

type CodigosDaTurma = Map<
  string,
  { codigoTurma: string; codigoDisciplina: string | null }
>;

/** O `INCLUDE_COMPLETO` com o nome do vinculo, que a lista geral precisa. */
const INCLUDE_DA_LISTA = {
  ...INCLUDE_COMPLETO,
  aluno: { select: { curso: true, nome: true } },
} satisfies Prisma.AgendamentoInclude;

/**
 * ============================================================================
 * OS DADOS DE AGENDAMENTO PARA O EMISSOR DA DECLARACAO
 * ============================================================================
 * A declaracao assinada passa a ser emitida por outro sistema da instituicao, e
 * este deixa de ser a fonte do documento para ser a fonte dos DADOS: tudo o que
 * a declaracao em PDF e a tela "Prova agendada" do portal mostram, por RA.
 *
 * O RECORTE e o historico inteiro da matricula, so provas CONFIRMADAS. Cancelada
 * nao reserva cadeira nenhuma, e declarar uma seria afirmar uma prova que nao
 * existe. `?periodo=atual` estreita para a janela vigente — o mesmo recorte de
 * `meusAgendamentos`, sem o filtro por vinculos do token (aqui nao ha token de
 * aluno: quem pergunta e um sistema, pela matricula).
 *
 * `prazoEncerrado` e a regra da declaracao entregue como DADO: com o prazo
 * aberto o aluno ainda troca de horario, e o documento afirmaria uma data que o
 * portador pode mudar. Toda janela que nao e a vigente conta como encerrada —
 * o aluno so mexe na rodada vigente (regra 7).
 *
 * AS DUAS ROTAS TEM O MESMO FORMATO: os dados da JANELA (rodada, datas,
 * `prazoEncerrado`) vem uma vez so, em `periodos[]`, e cada prova aponta para a
 * sua pelo `periodoId`. E uma lista, e nao um objeto, porque o historico de um
 * RA — ou a lista sem `rodada` — tem provas da N2 e da SUB, cada uma com o seu
 * prazo.
 */
@Injectable()
export class IntegracaoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periodo: PeriodoService,
  ) {}

  async agendamentosPorMatricula(
    matricula: string,
    recorte: RecorteDoPeriodo,
    agora: Date = new Date(),
  ): Promise<AgendamentosDoAluno> {
    // `id desc`: o vinculo importado por ultimo vem primeiro, e e dele que sai
    // o nome quando o CSV trouxer grafias diferentes entre os cursos.
    const vinculos = await this.prisma.alunoImportado.findMany({
      where: { matricula },
      include: { modalidade: true, polo: { select: { id: true, nome: true } } },
      orderBy: { id: 'desc' },
    });

    // 404 distinto de "sem prova" (200 com lista vazia) de proposito: quem
    // chama e um sistema confiavel, e para ele "este RA nao existe aqui" e
    // "existe e nao agendou" pedem acoes diferentes.
    if (vinculos.length === 0) {
      throw new NotFoundException(
        'Matricula nao encontrada entre os alunos importados.',
      );
    }

    const base = {
      matricula,
      nome: vinculos.map((v) => v.nome?.trim()).find(Boolean) ?? null,
      filtro: { periodo: recorte },
      vinculos: [...vinculos]
        .sort((a, b) => a.curso.localeCompare(b.curso, 'pt-BR'))
        .map((v) => ({
          alunoId: v.id,
          curso: v.curso,
          statusCurso: v.statusCurso,
          ativo: v.ativo,
          modalidade: {
            codigo: v.modalidade.codigo,
            nome: v.modalidade.nome,
            duracaoMinutos: v.modalidade.duracaoMinutos,
          },
          polo: v.polo,
        })),
    };
    const semProva = { ...base, periodos: [], agendamentos: [] };

    const vigente = await this.periodo.janelaVigente();

    // Sem janela cadastrada nao ha "periodo atual" — e nao ha o que devolver,
    // em vez de cair em silencio no historico inteiro.
    if (recorte === 'atual' && !vigente) return semProva;

    const agendamentos = await this.prisma.agendamento.findMany({
      where: {
        matricula,
        ...CONFIRMADO,
        ...(recorte === 'atual' && vigente
          ? {
              periodoLetivoId: { in: vigente.periodoLetivoIds },
              rodada: vigente.rodada,
            }
          : {}),
      },
      include: INCLUDE_COMPLETO,
      orderBy: [
        { salaFaixa: { faixa: { data: 'desc' } } },
        { salaFaixa: { faixa: { horaInicio: 'desc' } } },
      ],
    });

    if (agendamentos.length === 0) return semProva;

    const candidatas = await this.prisma.periodoAgendamento.findMany({
      where: {
        rodada: { in: [...new Set(agendamentos.map((a) => a.rodada))] },
      },
      include: COM_MAPA,
      orderBy: { createdAt: 'desc' },
    });

    // No topo, so as janelas que tem prova deste RA — da mais recente para a
    // mais antiga, como as provas.
    const usadas = new Set(
      agendamentos.map((a) => janelaDoAgendamento(a, candidatas)?.id),
    );
    const janelas = candidatas.filter((j) => usadas.has(j.id));

    const codigos = await this.codigosDasTurmas(agendamentos);

    return {
      ...base,
      periodos: await this.montarPeriodos(janelas, vigente, agora),
      agendamentos: agendamentos.map((a) =>
        montarAgendamento(a, janelas, codigos),
      ),
    };
  }

  /**
   * ==========================================================================
   * TODAS AS PROVAS DE UM PERIODO — para quem precisa da lista, e nao de um RA
   * ==========================================================================
   * O recorte e SEMPRE um periodo: a janela vigente (`atual`) ou um periodo
   * letivo escolhido. O historico inteiro de todos os alunos numa chamada so
   * nao e oferecido de proposito — e o que uma chave vazada mais gostaria de
   * levar, e nenhum consumidor precisa dele de uma vez.
   *
   * Pelo `periodoLetivoId`, a `rodada` e opcional: sem ela vem a N2 E a SUB do
   * semestre juntas. Mais de um id cobre as duas grades de uma janela (o
   * modulo do EaD e o semestre do Presencial).
   *
   * Paginada e em ordem estavel (data, horario, matricula, id), a mesma em que
   * a prova acontece: quem percorre as paginas nao ve item repetido nem pulado
   * enquanto ninguem agenda no meio.
   */
  async listarAgendamentos(
    filtro: FiltroDaLista,
    pagina: number,
    porPagina: number,
    agora: Date = new Date(),
  ): Promise<PaginaDeAgendamentosIntegracao> {
    const vigente = await this.periodo.janelaVigente();

    const aplicado: FiltroAplicado =
      filtro.periodo === 'atual'
        ? {
            periodo: 'atual',
            periodoLetivoIds: vigente?.periodoLetivoIds ?? [],
            rodada: vigente?.rodada ?? null,
          }
        : filtro;

    const vazia = {
      filtro: aplicado,
      periodos: [],
      total: 0,
      pagina,
      porPagina,
      totalPaginas: 1,
      itens: [],
    };

    // Sem janela cadastrada nao ha "periodo atual" — mesma leitura da consulta
    // por RA.
    if (filtro.periodo === 'atual' && !vigente) return vazia;

    const where = {
      ...CONFIRMADO,
      periodoLetivoId: { in: aplicado.periodoLetivoIds },
      ...(aplicado.rodada ? { rodada: aplicado.rodada } : {}),
    } satisfies Prisma.AgendamentoWhereInput;

    const [total, agendamentos, cadastradas] = await Promise.all([
      this.prisma.agendamento.count({ where }),
      this.prisma.agendamento.findMany({
        where,
        include: INCLUDE_DA_LISTA,
        orderBy: [
          { salaFaixa: { faixa: { data: 'asc' } } },
          { salaFaixa: { faixa: { horaInicio: 'asc' } } },
          { matricula: 'asc' },
          { id: 'asc' },
        ],
        skip: (pagina - 1) * porPagina,
        take: porPagina,
      }),
      // As janelas saem do RECORTE, e nao da pagina: o topo da resposta e o
      // mesmo em todas as paginas, e quem le so a primeira ja sabe os prazos.
      this.prisma.periodoAgendamento.findMany({
        where: {
          ...(aplicado.rodada ? { rodada: aplicado.rodada } : {}),
          OR: [
            { periodoLetivoId: { in: aplicado.periodoLetivoIds } },
            {
              letivosPorModalidade: {
                some: { periodoLetivoId: { in: aplicado.periodoLetivoIds } },
              },
            },
          ],
        },
        include: COM_MAPA,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // No `atual` o topo e a vigente e so ela: outra janela da mesma rodada pode
    // dividir o semestre do Presencial com ela, e nao e o periodo pedido.
    const janelas =
      filtro.periodo === 'atual'
        ? cadastradas.filter((j) => ehAVigente(j, vigente))
        : cadastradas;

    const codigos = await this.codigosDasTurmas(agendamentos);

    return {
      ...vazia,
      periodos: await this.montarPeriodos(janelas, vigente, agora),
      total,
      totalPaginas: Math.max(1, Math.ceil(total / porPagina)),
      itens: agendamentos.map((agendamento) => ({
        ...montarAgendamento(agendamento, janelas, codigos),
        matricula: agendamento.matricula,
        nome: agendamento.aluno.nome?.trim() || null,
      })),
    };
  }

  /**
   * Codigo da turma e da disciplina de cada `orgUnitId` das provas, numa
   * consulta so. Sao os de HOJE na turma importada, e nao fotografia: a reserva
   * nunca gravou os codigos, e o `orgUnitId` (unico na tabela) e o que liga as
   * duas.
   */
  private async codigosDasTurmas(
    agendamentos: AgendamentoLido[],
  ): Promise<CodigosDaTurma> {
    const orgUnitIds = [
      ...new Set(
        agendamentos.flatMap((a) => a.disciplinas.map((d) => d.orgUnitId)),
      ),
    ];

    if (orgUnitIds.length === 0) return new Map();

    const turmas = await this.prisma.turmaImportada.findMany({
      where: { orgUnitId: { in: orgUnitIds } },
      select: { orgUnitId: true, codigoTurma: true, codigoEad: true },
    });

    return new Map(
      turmas.map((t) => [
        t.orgUnitId!,
        { codigoTurma: t.codigoTurma, codigoDisciplina: t.codigoEad },
      ]),
    );
  }

  /** As janelas do topo da resposta, cada uma com o seu `prazoEncerrado`. */
  private async montarPeriodos(
    janelas: JanelaLida[],
    vigente: Vigente,
    agora: Date,
  ): Promise<PeriodoIntegracao[]> {
    // A situacao so e consultada se a vigente estiver entre elas — a mesma
    // `encerrado` que libera o botao da declaracao no portal, lida no mesmo
    // lugar, para as duas regras nunca divergirem. Toda outra janela esta
    // encerrada (regra 7).
    const vigenteEncerrada = janelas.some((j) => ehAVigente(j, vigente))
      ? (await this.periodo.situacaoAtual(agora)).encerrado
      : true;

    return janelas.map((janela) => ({
      id: janela.id,
      rodada: janela.rodada,
      rodadaDescricao: descricaoDaRodada(janela.rodada),
      descricao: janela.descricao,
      periodoLetivoIds: idsDaJanela(janela),
      dataAbertura: janela.dataAbertura,
      dataFechamento: janela.dataFechamento,
      prazoEncerrado: ehAVigente(janela, vigente) ? vigenteEncerrada : true,
    }));
  }
}

/** Uma prova no formato da integracao, apontando para a sua janela. */
function montarAgendamento(
  agendamento: AgendamentoLido,
  janelas: JanelaLida[],
  codigos: CodigosDaTurma,
): AgendamentoIntegracao {
  const confirmado = montarConfirmado(agendamento);

  return {
    id: confirmado.id,
    periodoId: janelaDoAgendamento(agendamento, janelas)?.id ?? null,
    alunoId: confirmado.alunoId,
    curso: confirmado.curso,
    status: confirmado.status,
    periodoLetivoId: agendamento.periodoLetivoId,
    data: isoDeDataUtc(confirmado.data),
    horaInicio: confirmado.horaInicio,
    horaFim: confirmado.horaFim,
    formato: confirmado.modalidade,
    polo: confirmado.polo,
    sala: confirmado.sala,
    disciplinas: confirmado.disciplinas.map((d) => ({
      orgUnitId: d.orgUnitId,
      nomeDisciplina: d.nomeDisciplina,
      codigoTurma: codigos.get(d.orgUnitId)?.codigoTurma ?? null,
      codigoDisciplina: codigos.get(d.orgUnitId)?.codigoDisciplina ?? null,
    })),
    agendadoEm: confirmado.criadoEm,
    alocadoManual: agendamento.alocadoManual,
  };
}
