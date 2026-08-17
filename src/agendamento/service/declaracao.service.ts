import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import { PrismaService } from '../../database/prisma.service';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { CONFIRMADO } from './lock-de-vagas';
import { pdfDeDeclaracao } from './pdf-declaracao';

/**
 * ============================================================================
 * QUEM PODE BAIXAR A DECLARACAO, E QUANDO
 * ============================================================================
 * O desenho do papel esta em `pdf-declaracao.ts` (modulo puro). Aqui ficam as
 * DUAS perguntas que o PDF nao sabe responder — e que sao a razao de este
 * arquivo existir separado.
 *
 * ---------------------------------------------------------------------------
 * 1. SO DEPOIS DE O PRAZO ENCERRAR
 * ---------------------------------------------------------------------------
 * Regra do cliente, e ela tem consequencia pratica: enquanto o periodo esta
 * aberto o aluno pode trocar de horario e cancelar (regra 7). Uma declaracao
 * emitida ali afirma um dia e uma hora que o proprio portador pode mudar cinco
 * minutos depois — e quem recebeu o papel (empregador, escola, cartorio) nao
 * tem como conferir. Depois do fechamento, so a secretaria remaneja, e o que o
 * documento diz para de se mover sozinho.
 *
 * A checagem e `PeriodoService.exigirEncerrado()`, o espelho do `exigirAberto()`
 * que o agendamento usa. As duas leem o MESMO estado de propósito: se a
 * declaracao tivesse a propria nocao de "prazo acabou", as duas divergiriam na
 * primeira vez que alguem mexesse numa delas.
 *
 * ⚠️ `encerrado` NAO e `!aberto`. "Nao configurado" e "ainda nao abriu" tambem
 * sao `aberto: false`, e nenhum dos dois pode emitir declaracao — no primeiro
 * nao ha semestre, no segundo nao ha agendamento possivel. Ver `SituacaoPeriodo`.
 *
 * ---------------------------------------------------------------------------
 * 2. SO A PROPRIA PROVA, E SO A DO SEMESTRE VIGENTE
 * ---------------------------------------------------------------------------
 * O recorte da consulta e exatamente o de `meusAgendamentos` — matricula do
 * token, vinculo do token, periodo letivo vigente, status CONFIRMADO. E de
 * propósito: a declaracao existe para o que a tela lista, e um id que a tela nao
 * mostra nao pode virar documento. Sem o filtro por matricula, trocar o numero
 * na URL imprimiria a prova de outra pessoa com o nome dela.
 *
 * Cancelado nao emite: o papel afirma que o agendamento foi feito, e um
 * agendamento cancelado nao reserva cadeira nenhuma no dia.
 */
@Injectable()
export class DeclaracaoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periodo: PeriodoService,
  ) {}

  async declaracaoDoAluno(
    aluno: AlunoJwtPayload,
    agendamentoId: number,
  ): Promise<{ nomeArquivo: string; conteudo: Buffer }> {
    const { periodoLetivoId } = await this.periodo.exigirEncerrado();

    const agendamento = await this.prisma.agendamento.findFirst({
      where: {
        id: agendamentoId,
        matricula: aluno.sub,
        alunoId: { in: aluno.vinculos.map((v) => v.alunoId) },
        periodoLetivoId,
        ...CONFIRMADO,
      },
      select: {
        matricula: true,
        aluno: { select: { nome: true } },
        salaFaixa: {
          select: { faixa: { select: { data: true, horaInicio: true } } },
        },
      },
    });

    // 404 unico para "nao existe", "nao e seu" e "esta cancelado". Distinguir os
    // tres na resposta diria a quem trocasse o id na URL quais agendamentos
    // existem — e nenhuma das tres situacoes tem acao diferente para o aluno.
    if (!agendamento) {
      throw new NotFoundException(
        'Agendamento nao encontrado entre as suas provas confirmadas deste semestre.',
      );
    }

    /**
     * SEM NOME NAO HA DECLARACAO. `AlunoImportado.nome` e opcional no schema
     * (a coluna ALUNO pode vir vazia numa linha do CSV), e a saida obvia —
     * cair para a matricula — produziria "Declaramos que UC26425318 esta
     * matriculado(a) sob o RA UC26425318": um documento que nao nomeia
     * ninguem, entregue a um empregador. Recusar e pior para o aluno no
     * momento, mas e acionavel: a secretaria corrige a planilha e reimporta,
     * e a importacao e idempotente.
     */
    if (!agendamento.aluno.nome?.trim()) {
      throw new ConflictException(
        'Seu cadastro esta sem nome, e a declaracao precisa dele. Procure a ' +
          'secretaria academica para corrigir o cadastro.',
      );
    }

    const conteudo = await pdfDeDeclaracao({
      nome: agendamento.aluno.nome.trim(),
      matricula: agendamento.matricula,
      data: agendamento.salaFaixa.faixa.data,
      horario: agendamento.salaFaixa.faixa.horaInicio,
    });

    return { nomeArquivo: nomeDoArquivo(agendamento.matricula), conteudo };
  }
}

/**
 * `Declaracao de agendamento - UC26425318.pdf`.
 *
 * O RA e alfanumerico por construcao (ver o schema), mas a limpeza fica de pe:
 * este texto vai para o `Content-Disposition`, e um caractere fora do ASCII ali
 * exigiria o `filename*=UTF-8''` do RFC 5987 para nao chegar corrompido — a
 * mesma razao pela qual os nomes dos relatorios perdem os acentos.
 */
function nomeDoArquivo(matricula: string): string {
  return `Declaracao de agendamento - ${matricula.replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
}
