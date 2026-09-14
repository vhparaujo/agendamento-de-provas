import { Injectable, NotFoundException } from '@nestjs/common';
import {
  INCLUDE_COMPLETO,
  montarConfirmado,
} from '../../agendamento/service/agendamento.service';
import { CONFIRMADO } from '../../agendamento/service/lock-de-vagas';
import { descricaoDaRodada } from '../../agendamento/service/rodada';
import { PrismaService } from '../../database/prisma.service';
import { PeriodoService } from '../../periodo/service/periodo.service';
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

/** A janela de agendamento em que a prova foi marcada. */
export interface PeriodoDoAgendamento {
  descricao: string | null;
  dataAbertura: Date | null;
  dataFechamento: Date;
  prazoEncerrado: boolean;
}

export interface AgendamentoIntegracao {
  id: number;
  alunoId: number;
  curso: string;
  status: string;
  rodada: string;
  rodadaDescricao: string;
  periodoLetivoId: string;
  periodo: PeriodoDoAgendamento | null;
  /** "AAAA-MM-DD" — string, e nao Date, para ninguem ler o dia no fuso errado. */
  data: string;
  horaInicio: string;
  horaFim: string;
  formato: Modalidade;
  /** Onde a prova ACONTECE — o polo da faixa, nao o do cadastro. */
  polo: Local;
  sala: Local;
  disciplinas: { orgUnitId: string; nomeDisciplina: string | null }[];
  agendadoEm: Date;
  alocadoManual: boolean;
}

export interface AgendamentosDoAluno {
  matricula: string;
  nome: string | null;
  filtro: { periodo: RecorteDoPeriodo };
  vinculos: VinculoIntegracao[];
  agendamentos: AgendamentoIntegracao[];
}

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

    const vigente = await this.periodo.janelaVigente();

    // Sem janela cadastrada nao ha "periodo atual" — e nao ha o que devolver,
    // em vez de cair em silencio no historico inteiro.
    if (recorte === 'atual' && !vigente) return { ...base, agendamentos: [] };

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

    if (agendamentos.length === 0) return { ...base, agendamentos: [] };

    const janelas = await this.prisma.periodoAgendamento.findMany({
      where: {
        rodada: { in: [...new Set(agendamentos.map((a) => a.rodada))] },
      },
      include: { letivosPorModalidade: { select: { periodoLetivoId: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const naJanelaVigente = (a: { periodoLetivoId: string; rodada: string }) =>
      !!vigente &&
      a.rodada === vigente.rodada &&
      vigente.periodoLetivoIds.includes(a.periodoLetivoId);

    // A situacao so e consultada se alguma prova for da janela vigente — a
    // mesma `encerrado` que libera o botao da declaracao no portal, lida no
    // mesmo lugar, para as duas regras nunca divergirem.
    const vigenteEncerrada = agendamentos.some(naJanelaVigente)
      ? (await this.periodo.situacaoAtual(agora)).encerrado
      : true;

    return {
      ...base,
      agendamentos: agendamentos.map((agendamento) => {
        const confirmado = montarConfirmado(agendamento);
        const janela = janelaDoAgendamento(agendamento, janelas);

        return {
          id: confirmado.id,
          alunoId: confirmado.alunoId,
          curso: confirmado.curso,
          status: confirmado.status,
          rodada: confirmado.rodada,
          rodadaDescricao: descricaoDaRodada(confirmado.rodada),
          periodoLetivoId: agendamento.periodoLetivoId,
          periodo: janela
            ? {
                descricao: janela.descricao,
                dataAbertura: janela.dataAbertura,
                dataFechamento: janela.dataFechamento,
                prazoEncerrado: naJanelaVigente(agendamento)
                  ? vigenteEncerrada
                  : true,
              }
            : null,
          data: isoDeDataUtc(confirmado.data),
          horaInicio: confirmado.horaInicio,
          horaFim: confirmado.horaFim,
          formato: confirmado.modalidade,
          polo: confirmado.polo,
          sala: confirmado.sala,
          disciplinas: confirmado.disciplinas,
          agendadoEm: confirmado.criadoEm,
          alocadoManual: agendamento.alocadoManual,
        };
      }),
    };
  }
}
