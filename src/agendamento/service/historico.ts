import {
  AutorDaAlteracao,
  EventoAgendamento,
} from '../../generated/prisma/client';
import { Transacao } from './lock-de-vagas';

export interface AutorDaOperacao {
  tipo: AutorDaAlteracao;
  /** Matricula, para aluno; e-mail, para admin. Fotografia, nao FK. */
  identificacao: string;
}

/**
 * ============================================================================
 * QUEM MEXEU NO AGENDAMENTO
 * ============================================================================
 * Serve para uma conversa concreta no balcao: o aluno diz que mudaram a prova
 * dele de horario, e a secretaria precisa mostrar quem mudou — ele proprio ou um
 * administrador.
 *
 * Por isso o registro e gravado na MESMA transacao da alteracao. Fora dela, uma
 * falha entre "mudou" e "registrou" produziria exatamente o caso que o historico
 * existe para evitar: uma alteracao sem autor.
 */
export async function registrarHistorico(
  tx: Transacao,
  dados: {
    agendamentoId: number;
    evento: EventoAgendamento;
    autor: AutorDaOperacao;
    de?: string | null;
    para?: string | null;
  },
): Promise<void> {
  await tx.historicoAgendamento.create({
    data: {
      agendamentoId: dados.agendamentoId,
      evento: dados.evento,
      autorTipo: dados.autor.tipo,
      autor: dados.autor.identificacao,
      de: dados.de ?? null,
      para: dados.para ?? null,
    },
  });
}

/**
 * A oferta em uma linha legivel: "M114 · 20/08/2026 08:30-11:30".
 *
 * Texto, e nao ids, porque o historico e lido por pessoa meses depois. Guardar
 * `salaFaixaId: 55` obrigaria a reconstruir o que aquilo significava.
 */
export async function descreverOferta(
  tx: Transacao,
  salaFaixaId: number,
): Promise<string> {
  const oferta = await tx.salaFaixa.findUnique({
    where: { id: salaFaixaId },
    select: {
      sala: { select: { nome: true } },
      faixa: { select: { data: true, horaInicio: true, horaFim: true } },
    },
  });

  if (!oferta) return `oferta ${salaFaixaId} (removida)`;

  const dia = oferta.faixa.data.toLocaleDateString('pt-BR', {
    timeZone: 'UTC',
  });

  return `${oferta.sala.nome} · ${dia} ${oferta.faixa.horaInicio}-${oferta.faixa.horaFim}`;
}

export const AUTOR_ALUNO = (matricula: string): AutorDaOperacao => ({
  tipo: AutorDaAlteracao.ALUNO,
  identificacao: matricula,
});

export const AUTOR_ADMIN = (email = 'administrador'): AutorDaOperacao => ({
  tipo: AutorDaAlteracao.ADMIN,
  identificacao: email,
});

/**
 * O "e-mail" que o lote compulsorio grava no historico.
 *
 * Constante, e nao string solta nos dois lados, porque a exportacao LE este
 * valor para separar "agendado pelo compulsorio" de "agendado pela secretaria
 * no balcao" — os dois sao `ADMIN`, e so a identificacao os distingue.
 */
export const IDENTIFICACAO_COMPULSORIO = 'compulsorio';
