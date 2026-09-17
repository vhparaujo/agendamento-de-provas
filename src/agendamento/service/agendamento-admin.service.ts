import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hojeUtc } from '../../components/utc.util';
import { PrismaService } from '../../database/prisma.service';
import { D2lEnrollmentsService } from '../../d2l/service/d2l-enrollments.service';
import {
  AutorDaAlteracao,
  EventoAgendamento,
  Prisma,
  StatusAgendamento,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { FUSO_DA_OPERACAO } from '../../senha-quiz/service/relogio';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { dataBr, dataDaProva, montarCsv } from './csv-relatorio';
import { DisciplinasDoAlunoService } from './disciplinas-do-aluno.service';
import type { DisciplinaComNota } from './elegibilidade-de-nota.service';
import {
  AUTOR_ADMIN,
  descreverOferta,
  IDENTIFICACAO_COMPULSORIO,
  registrarHistorico,
} from './historico';
import {
  CONFIRMADO,
  escolherOfertaComLock,
  exigirUmaProvaPorFaixa,
  exigirVagaNaOferta,
  OPCOES_DA_TRANSACAO,
  travarAluno,
} from './lock-de-vagas';

const AGENDAMENTO_NAO_ENCONTRADO =
  'Agendamento não encontrado. Atualize a página e tente de novo.';

export interface FiltroAgendamentos {
  poloId?: number;
  faixaId?: number;
  salaId?: number;
  modalidadeId?: number;
  /**
   * O(s) periodo(s) letivo(s) do recorte. Vazio = a janela vigente inteira.
   *
   * PLURAL porque uma janela cobre mais de um org unit ao mesmo tempo: os
   * modulares sob o periodo do modulo e os presenciais sob o do semestre.
   * Filtrar por um so faria a outra metade sair como "Nao Agendado" e entrar na
   * cobranca depois de ja ter feito a prova. A tela manda a janela inteira; um
   * id sozinho continua valendo, e recorta exatamente aquela grade.
   */
  periodoLetivoId?: string[];
  /** Qual prova do semestre ("N2", "SUB"...). Sem ele, vem as duas juntas. */
  rodada?: string;
  /** Data da prova (AAAA-MM-DD). */
  de?: string;
  ate?: string;
  /** Busca por matricula, nome ou curso. */
  busca?: string;
  status?: StatusAgendamento;
  pagina?: number;
  porPagina?: number;
}

export interface AgendamentoAdmin {
  id: number;
  matricula: string;
  nome: string | null;
  email: string | null;
  curso: string;
  statusCurso: string;
  modalidade: string;
  polo: string;
  data: Date;
  horaInicio: string;
  horaFim: string;
  sala: string;
  status: string;
  alocadoManual: boolean;
  periodoLetivoId: string;
  rodada: string;
  disciplinas: { orgUnitId: string; nomeDisciplina: string | null }[];
  criadoEm: Date;
}

export interface PaginaDeAgendamentos {
  total: number;
  pagina: number;
  porPagina: number;
  totalPaginas: number;
  itens: AgendamentoAdmin[];
}

export interface EventoDoHistorico {
  id: number;
  evento: string;
  /** ALUNO ou ADMIN — quem fez a alteracao. */
  autorTipo: string;
  /** Matricula do aluno ou e-mail do administrador. */
  autor: string;
  de: string | null;
  para: string | null;
  quando: Date;
}

/**
 * De onde saiu a lista de disciplinas de um agendamento feito pelo admin.
 *
 * `RESERVA_ANTERIOR` nao e um plano B qualquer: e a fotografia que a PROPRIA
 * reserva anterior daquele aluno, no MESMO semestre, ja guardava — ver
 * `disciplinasParaOAdmin`.
 */
export type OrigemDasDisciplinas = 'BRIGHTSPACE' | 'RESERVA_ANTERIOR';

export interface AgendamentoPeloAdmin {
  agendamento: AgendamentoAdmin;
  origemDasDisciplinas: OrigemDasDisciplinas;
  /** Ressalvas que NAO impediram o agendamento. Vazio quando nao ha nenhuma. */
  avisos: string[];
}

export interface LinhaDoResumo {
  poloId: number;
  polo: string;
  faixaId: number;
  data: Date;
  horaInicio: string;
  horaFim: string;
  salaId: number;
  sala: string;
  modalidade: string;
  vagas: number;
  ocupadas: number;
  disponiveis: number;
}

/** Quem criou a reserva — ver `origemDaReserva`. */
export type OrigemDaReserva = 'ALUNO' | 'COMPULSORIO' | 'ADMIN';

export interface AdesaoDaModalidade {
  modalidadeId: number;
  modalidade: string;
  /** Vinculos ativos deste formato. */
  total: number;
  /** Quantos deles tem prova confirmada na rodada vigente. */
  agendados: number;
}

export interface EstatisticasDaJanela {
  /** A rodada vigente, ou `null` sem periodo cadastrado (tudo zera). */
  rodada: string | null;
  totalVinculos: number;
  agendados: number;
  porModalidade: AdesaoDaModalidade[];
  porOrigem: {
    aluno: number;
    compulsorio: number;
    admin: number;
    /** Reservas anteriores ao historico: sem evento CRIADO, sem autor. */
    semRegistro: number;
  };
  /**
   * Reservas confirmadas de vinculos que HOJE estao inativos (trancou depois
   * de agendar). Ficam fora da conta acima, que e sobre quem pode fazer prova,
   * mas aparecem aqui para o numero nao divergir em silencio do "Confirmados"
   * do periodo.
   */
  agendadosInativos: number;
  /** Reservas confirmadas por dia de CRIACAO (fuso da operacao), por origem. */
  porDia: AgendamentosDoDia[];
}

export interface AgendamentosDoDia {
  /** AAAA-MM-DD, no fuso da operacao. */
  dia: string;
  aluno: number;
  compulsorio: number;
  admin: number;
  semRegistro: number;
}

const PADRAO_POR_PAGINA = 50;
const MAXIMO_POR_PAGINA = 200;

@Injectable()
export class AgendamentoAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly periodo: PeriodoService,
    private readonly d2l: D2lEnrollmentsService,
    private readonly disciplinasDoAluno: DisciplinasDoAlunoService,
  ) {}

  /**
   * ==========================================================================
   * AGENDAR NO LUGAR DE UM ALUNO — o atendimento de balcao
   * ==========================================================================
   * O compulsorio agenda por TODO MUNDO que nao agendou, e o recorte mais fino
   * dele e o polo. Esta rota e a outra ponta: UMA pessoa, uma decisao, tomada
   * com o aluno na frente.
   *
   * E ela que fecha a fila de trabalho do relatorio de excecoes. Ate aqui, os
   * motivos diziam o que fazer (`SEM_VAGA` -> abrir sala) mas a unica acao
   * disponivel depois de abrir a sala era redisparar o lote do polo inteiro:
   * `PATCH /remanejar` exige um agendamento que ja exista, e nao cria nenhum.
   *
   * TUDO fica registrado como ADMIN, e nao como aluno:
   *
   * - `HistoricoAgendamento` grava `CRIADO` com o e-mail de quem clicou. E a
   *   resposta para "eu nunca marquei essa prova" — que aqui e VERDADE.
   * - `alocadoManual: true` sempre, inclusive quando a alocacao escolheu a
   *   sala: o que a coluna diz e "isto nao saiu do portal do aluno".
   *
   * O admin NAO depende do periodo estar aberto — como no remanejo, agendar
   * depois do fechamento e justamente o caso de uso.
   *
   * O que ela recusa e o mesmo que o remanejo recusa (outro polo, outro
   * formato, sala lotada, a mesma pessoa duas vezes no mesmo horario) mais o
   * que so faz sentido ao CRIAR: aluno que ja tem prova neste semestre (para
   * isso existe o remanejo) e situacao de curso que nao permite agendar — esta
   * ultima liberavel com `ignorarStatusCurso`, porque bloquear de vez trancaria
   * a administracao no unico caso em que ela precisa da valvula de escape.
   */
  async agendarPeloAdmin(
    dados: {
      alunoId: number;
      salaFaixaId?: number;
      faixaId?: number;
      ignorarStatusCurso?: boolean;
    },
    ator?: string,
  ): Promise<AgendamentoPeloAdmin> {
    if (!dados.salaFaixaId === !dados.faixaId) {
      throw new BadRequestException('Escolha o horário ou a sala de destino.');
    }

    const vinculo = await this.prisma.alunoImportado.findUnique({
      where: { id: dados.alunoId },
      include: { modalidade: true, polo: true },
    });

    if (!vinculo) {
      throw new NotFoundException(
        'Aluno não encontrado. Atualize a página e tente de novo.',
      );
    }

    // Duas leituras porque sao duas perguntas: o periodo letivo DESTE vinculo
    // (pelo formato dele, e o que vai gravado na reserva) e a janela inteira
    // (que a trava por pessoa usa — a outra prova do mesmo RA pode estar num
    // vinculo de outro formato, sob outro org unit).
    const vigente = await this.periodo.periodoLetivoDaModalidade(
      vinculo.modalidade.codigo,
    );
    const janela = await this.periodo.janelaVigente();

    if (!vigente || !janela) {
      throw new BadRequestException(
        'Nenhum período de agendamento cadastrado: sem ele não há como saber ' +
          'de qual semestre é esta prova. Cadastre um período na tela de Períodos.',
      );
    }

    const { periodoLetivoId, rodada } = vigente;

    const avisos: string[] = [];

    // Nao ha "avisa e nao bloqueia" possivel antes de gravar: ou a prova entra,
    // ou nao. Por isso a recusa e o padrao e a liberacao e explicita — o admin
    // que reenvia com `ignorarStatusCurso` esta tomando a decisao por escrito.
    if (!vinculo.ativo) {
      if (!dados.ignorarStatusCurso) {
        throw new ConflictException(
          `A situação deste aluno no curso ${vinculo.curso} está como ` +
            `"${vinculo.statusCurso}", que não permite agendar prova. Se for o ` +
            'caso mesmo assim, marque "Agendar mesmo assim" e confirme de novo.',
        );
      }

      avisos.push(
        `Agendado apesar da situação no curso ser "${vinculo.statusCurso}", ` +
          'que normalmente não permite agendar.',
      );
    }

    // Conferido de novo dentro da transacao, sob lock. Aqui e so para a
    // mensagem: "use o remanejo" resolve o problema; "409" nao diz nada.
    //
    // O recorte inclui a RODADA, como no portal: quem ja fez a N2 pode e deve
    // ser agendado na substitutiva, e mandar a administracao "usar o remanejo"
    // nesse caso a faria mover a prova ja realizada.
    const jaTem = await this.prisma.agendamento.findFirst({
      where: { alunoId: vinculo.id, periodoLetivoId, rodada, ...CONFIRMADO },
      select: { id: true },
    });

    if (jaTem) {
      throw new ConflictException(
        `Este aluno já tem prova marcada para o curso ${vinculo.curso} nesta ` +
          `prova do semestre (${rodada}, agendamento #${jaTem.id}). Para mudar ` +
          'de sala ou horário, use o remanejo.',
      );
    }

    const alvo = await this.resolverDestino(dados, vinculo);

    avisos.push(...(await this.ressalvasDaFaixa(alvo.faixaId)));

    const fonte = await this.disciplinasParaOAdmin(
      { id: vinculo.id, matricula: vinculo.matricula },
      periodoLetivoId,
      vinculo.modalidade.codigo,
    );

    avisos.push(...fonte.avisos);

    const criado = await this.prisma.$transaction(async (tx) => {
      await travarAluno(tx, vinculo.matricula);

      // Entre a checagem la em cima e agora, o proprio aluno pode ter agendado
      // pelo portal — ou outro atendente pode ter feito exatamente isto.
      const existente = await tx.agendamento.findFirst({
        where: { alunoId: vinculo.id, periodoLetivoId, rodada, ...CONFIRMADO },
        select: { id: true },
      });

      if (existente) {
        throw new ConflictException(
          `Este aluno acabou de receber prova nesta prova do semestre ` +
            `(${rodada}, agendamento #${existente.id}), enquanto esta tela ` +
            'estava aberta. Atualize a página e use o remanejo se precisar mudar de horário.',
        );
      }

      // Vale para o admin tambem (decisao do cliente, 14/08/2026): uma prova por
      // pessoa em cada horario, mesmo quando as duas sao de cursos diferentes.
      await exigirUmaProvaPorFaixa(tx, {
        matricula: vinculo.matricula,
        faixaId: alvo.faixaId,
        periodoLetivoIds: janela.periodoLetivoIds,
      });

      const salaFaixaId =
        alvo.salaFaixaId ??
        (await escolherOfertaComLock(tx, alvo.faixaId, vinculo.modalidadeId))
          .id;

      if (alvo.salaFaixaId) {
        await exigirVagaNaOferta(tx, alvo.salaFaixaId);
      }

      const agendamento = await tx.agendamento.create({
        data: {
          alunoId: vinculo.id,
          salaFaixaId,
          matricula: vinculo.matricula,
          userIdD2L: fonte.userIdD2L,
          periodoLetivoId,
          // Qual prova do semestre e esta, tirada do periodo vigente — o admin
          // nao escolhe a rodada, pelo mesmo motivo que nao escolhe o semestre.
          rodada,
          // Fotografia do vinculo na data da reserva — ver o schema.
          modalidadeId: vinculo.modalidadeId,
          poloId: vinculo.poloId,
          // SEMPRE, inclusive quando a alocacao escolheu a sala: o que a coluna
          // diz nao e "quem escolheu a sala", e sim "isto nao saiu do portal".
          alocadoManual: true,
          disciplinas: {
            create: fonte.disciplinas.map((d) => ({
              orgUnitId: d.orgUnitId,
              nomeDisciplina: d.nomeDisciplina,
              // Ver o schema: fotografia das notas, nulas quando a janela nao
              // filtrou por nota. Vem da Valence ou recopiadas da reserva
              // anterior — e `notaN1` fica nula tambem quando a reserva copiada
              // e anterior a 08/09/2026, decidida por uma regra que nao a olhava.
              notaFinal: d.notaFinal,
              notaN1: d.notaN1,
            })),
          },
          // A fila de liberacao nasce na MESMA transacao, como no portal: um
          // agendamento sem ela e prova marcada que nunca chega a ser liberada.
          syncs: {
            create: fonte.disciplinas.map((d) => ({ orgUnitId: d.orgUnitId })),
          },
        },
        select: { id: true, salaFaixaId: true },
      });

      await registrarHistorico(tx, {
        agendamentoId: agendamento.id,
        evento: EventoAgendamento.CRIADO,
        // ADMIN, com o e-mail. Quando o aluno perguntar no balcao por que tem
        // prova marcada sem ter marcado, esta linha e a resposta.
        autor: AUTOR_ADMIN(ator),
        para: await descreverOferta(tx, agendamento.salaFaixaId),
      });

      return agendamento;
    }, OPCOES_DA_TRANSACAO);

    this.auditoria.registrar('AGENDAMENTO_CRIADO', {
      ator,
      detalhe:
        `agendamento ${criado.id} criado pelo administrador para o vinculo ` +
        `${vinculo.id} (${vinculo.matricula}), sala_faixa ${criado.salaFaixaId}, ` +
        `${fonte.disciplinas.length} disciplina(s) via ${fonte.origem}` +
        (dados.ignorarStatusCurso && !vinculo.ativo
          ? `, com statusCurso "${vinculo.statusCurso}" ignorado`
          : ''),
    });

    return {
      agendamento: await this.buscar(criado.id),
      origemDasDisciplinas: fonte.origem,
      avisos,
    };
  }

  /**
   * ==========================================================================
   * QUAIS DISCIPLINAS ESTA PROVA COBRE, sem launch e sem aluno na frente
   * ==========================================================================
   * O portal descobre isso pelo JWT do launch; o compulsorio, pelo UserId que
   * `identidadePorMatricula` resolve. Aqui nao ha token nenhum — e o
   * `userIdD2L` do agendamento e coluna obrigatoria, entao "criar sem
   * disciplina" nem existe como saida.
   *
   * Sao duas fontes, nesta ordem:
   *
   * 1. **A Valence**, quando `D2L_HABILITADO` — a lista de agora, que e a certa.
   * 2. **A reserva ANTERIOR do mesmo aluno no MESMO semestre**, inclusive
   *    cancelada. Nao e um chute: e a fotografia que aquele agendamento gravou,
   *    do mesmo periodo letivo, com o `userIdD2L` que veio do launch dele.
   *
   * A segunda existe porque cobre justamente o caso mais comum do balcao —
   * `CANCELOU_E_NAO_REMARCOU`, o motivo que o compulsorio deixa de fora de
   * proposito — e porque funciona com a integracao desligada, que e o default.
   *
   * O que ela NAO faz e substituir a Valence quando a Valence responde: uma
   * lista velha e melhor que nenhuma, e pior que a atual.
   */
  private async disciplinasParaOAdmin(
    vinculo: { id: number; matricula: string },
    /** O periodo letivo JA resolvido pelo formato — ver `agendarPeloAdmin`. */
    periodoLetivoId: string,
    modalidadeCodigo: string,
  ): Promise<{
    userIdD2L: string;
    disciplinas: DisciplinaComNota[];
    origem: OrigemDasDisciplinas;
    avisos: string[];
  }> {
    const anterior = await this.reservaAnterior(vinculo, periodoLetivoId);

    // A janela filtra por nota? Muda o que o fallback significa — ver o aviso
    // montado em `semBrightspace`. O criterio de nota e da JANELA, igual para
    // todos os formatos, entao `janelaVigente()` responde e evita uma
    // segunda resolucao por formato que nao mudaria nada.
    const janela = await this.periodo.janelaVigente();
    const filtroDeNota = janela?.filtroDeNota ?? null;

    /** Cai para a reserva anterior, ou recusa dizendo o porque de cada uma. */
    const semBrightspace = (motivo: string) => {
      if (!anterior) {
        throw new ConflictException(
          `${motivo} E este aluno não tem nenhuma reserva anterior neste ` +
            'semestre de onde copiar as disciplinas — sem elas, a prova seria ' +
            'marcada sem cobrir disciplina nenhuma.',
        );
      }

      const avisos = [
        `${motivo} As disciplinas foram copiadas da reserva anterior deste ` +
          `aluno neste semestre (agendamento #${anterior.id}). Confira antes ` +
          'de liberar a prova no AVA.',
      ];

      // ⚠️ A reserva copiada NAO passou pelos criterios desta janela — em
      // geral ela e da prova regular, marcada quando nota nenhuma era
      // consultada. O portal recusaria este aluno em vez de degradar; aqui nao
      // ha como recusar sem travar o balcao com o aluno na frente, entao a
      // saida e dizer em voz alta o que a lista NAO garante.
      if (filtroDeNota) {
        avisos.push(
          'ATENÇÃO: esta janela só admite disciplina com N1 de pelo menos ' +
            `${filtroDeNota.minimaN1} e nota final abaixo de ` +
            `${filtroDeNota.maximaFinal}, e a lista copiada NÃO foi conferida ` +
            'contra as notas — ela veio de outra reserva, não do AVA. ' +
            'Confira as notas antes de confirmar, ou refaça quando a ' +
            'integração com o AVA voltar.',
        );
      }

      return {
        ...anterior.dados,
        origem: 'RESERVA_ANTERIOR' as const,
        avisos,
      };
    };

    if (!this.d2l.habilitado()) {
      return semBrightspace(
        'A integração com o AVA está desligada neste servidor, e é ' +
          'ela quem sabe as disciplinas de quem não agendou pelo portal.',
      );
    }

    try {
      const identidade = await this.d2l.identidadePorMatricula(
        vinculo.matricula,
      );

      if (identidade.situacao === 'SEM_CONTA') {
        return semBrightspace(
          `A matrícula ${vinculo.matricula} não existe no AVA.`,
        );
      }

      if (identidade.situacao === 'AMBIGUA') {
        return semBrightspace(
          `Há ${identidade.quantos} contas no AVA com a matrícula ` +
            `${vinculo.matricula}, e o sistema não escolhe entre elas.`,
        );
      }

      if (identidade.situacao === 'ID_INVALIDO') {
        return semBrightspace(
          `A conta desta matrícula no AVA tem um identificador inválido ` +
            `("${identidade.valor}"). Abra chamado no suporte do AVA.`,
        );
      }

      const cruzamento = await this.disciplinasDoAluno.cruzarPorUserId(
        identidade.userIdD2L,
        modalidadeCodigo,
      );

      if (cruzamento.agendaveis.length === 0) {
        return semBrightspace(
          cruzamento.motivo ??
            `Nenhuma disciplina deste aluno no período letivo ${periodoLetivoId} ` +
              'está na planilha de turmas com prova.',
        );
      }

      return {
        userIdD2L: identidade.userIdD2L,
        disciplinas: cruzamento.agendaveis,
        origem: 'BRIGHTSPACE',
        avisos: identidade.ativoNoD2L
          ? []
          : [
              'A conta deste aluno está DESATIVADA no AVA: ele tem ' +
                'lugar na sala, mas do jeito que está não conseguiria abrir a ' +
                'prova. Abra chamado no suporte do AVA.',
            ],
      };
    } catch (erro) {
      // Rede, token vencido, 500 da Valence. Igual ao portal (`cairParaOLaunch`)
      // e ao contrario do compulsorio: aqui ha um humano esperando resposta, e
      // uma lista velha o deixa resolver o atendimento agora.
      return semBrightspace(
        'Não foi possível consultar o AVA agora ' +
          `(detalhe técnico: ${erro instanceof Error ? erro.message : String(erro)}).`,
      );
    }
  }

  /**
   * A reserva mais recente daquela PESSOA neste semestre, CANCELADA inclusive.
   *
   * A cancelada e o ponto: quem cancelou e nao remarcou e quem mais aparece no
   * balcao, e a reserva dele guarda exatamente o que precisamos — o `userIdD2L`
   * que veio do launch e as disciplinas daquele semestre.
   *
   * A busca e por **matricula**, e nao pelo vinculo, com o vinculo apenas como
   * desempate. E a mesma razao pela qual o compulsorio consulta a Valence uma
   * vez por RA: as disciplinas vem da PESSOA — turma nao pertence a um curso —,
   * entao a reserva do outro curso dela e uma fonte igualmente valida, e a unica
   * disponivel para o segundo vinculo de quem tem dois.
   *
   * Reserva sem disciplina nenhuma nao serve: seria marcar prova que nao cobre
   * nada. Por isso o filtro nao e "a mais recente", e sim "a mais recente que
   * tem o que copiar".
   *
   * ⚠️ **NAO filtra por rodada, de proposito.** A reserva da N2 e fonte valida
   * para a SUB: as disciplinas do semestre sao as mesmas e o `userIdD2L` veio do
   * mesmo launch. Filtrar por rodada deixaria a substitutiva sem fonte nenhuma
   * justamente na primeira vez que ela abrisse — que e quando o balcao mais
   * precisa dela, com a integracao desligada.
   *
   * ⚠️ **Mas filtra por UM `periodoLetivoId` — o do vinculo que esta sendo
   * atendido —, e nao pela janela inteira.** Aqui a decisao e o OPOSTO da das
   * travas por pessoa, e de proposito: as disciplinas de um vinculo EaD saem da
   * arvore do modulo e as de um Presencial saem da arvore do semestre. Copiar a
   * reserva do outro vinculo atravessaria as duas grades e marcaria a prova
   * cobrindo as disciplinas ERRADAS — em silencio, porque a lista viria cheia e
   * plausivel. Quem tem dois vinculos no MESMO formato continua emprestando
   * um para o outro, que e o caso que este metodo existe para servir.
   */
  private async reservaAnterior(
    vinculo: { id: number; matricula: string },
    periodoLetivoId: string,
  ): Promise<{
    id: number;
    dados: { userIdD2L: string; disciplinas: DisciplinaComNota[] };
  } | null> {
    const anteriores = await this.prisma.agendamento.findMany({
      where: { matricula: vinculo.matricula, periodoLetivoId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        alunoId: true,
        userIdD2L: true,
        disciplinas: {
          select: {
            orgUnitId: true,
            nomeDisciplina: true,
            notaFinal: true,
            notaN1: true,
          },
        },
      },
    });

    const uteis = anteriores.filter((a) => a.disciplinas.length > 0);

    const escolhida = uteis.find((a) => a.alunoId === vinculo.id) ?? uteis[0];

    if (!escolhida) return null;

    return {
      id: escolhida.id,
      dados: {
        userIdD2L: escolhida.userIdD2L,
        // As notas da reserva antiga vem junto e sao RECOPIADAS como estao: sao
        // as que decidiram AQUELA reserva, e nao as de agora. Copiar sem elas
        // apagaria a unica explicacao existente; inventar novas exigiria
        // consultar a Valence — que e justamente o que nao respondeu quando se
        // cai aqui. `notaN1` vem nula das reservas anteriores a 08/09/2026,
        // decididas por uma regra que nao olhava a N1.
        disciplinas: escolhida.disciplinas.map((d) => ({
          orgUnitId: d.orgUnitId,
          nomeDisciplina: d.nomeDisciplina,
          notaFinal: d.notaFinal === null ? null : Number(d.notaFinal),
          notaN1: d.notaN1 === null ? null : Number(d.notaN1),
        })),
      },
    };
  }

  /**
   * Faixa inativa ou com data passada AVISA, nao bloqueia.
   *
   * O portal recusa as duas, e com razao: o aluno escolhendo sozinho um horario
   * que ja passou so pode ser engano. Aqui quem escolhe e a administracao, e os
   * dois casos tem uso real — registrar quem fez a prova sem estar na lista, ou
   * usar uma faixa que foi desativada para sair do portal. Recusar seria
   * decidir no lugar dela; ficar calado esconderia um erro de digitacao.
   */
  private async ressalvasDaFaixa(faixaId: number): Promise<string[]> {
    const faixa = await this.prisma.faixa.findUnique({
      where: { id: faixaId },
      select: { data: true, ativo: true },
    });

    if (!faixa) return [];

    const avisos: string[] = [];

    if (!faixa.ativo) {
      avisos.push(
        'Este horário está INATIVO: ele não aparece no portal do aluno.',
      );
    }

    if (faixa.data < hojeUtc()) {
      avisos.push(
        `A data deste horário (${faixa.data.toLocaleDateString('pt-BR', {
          timeZone: 'UTC',
        })}) já passou.`,
      );
    }

    return avisos;
  }

  /**
   * ==========================================================================
   * REMANEJO — a valvula de escape do sistema
   * ==========================================================================
   * A alocacao automatica e so o padrao. Quando a realidade nao cabe nela (sala
   * interditada, aluno com necessidade especifica, prazo perdido), o admin move
   * a mao — e o registro passa a dizer `alocadoManual: true`, para ninguem
   * depois achar que a regra sequencial produziu aquilo.
   *
   * Ao contrario do aluno, o admin NAO depende do periodo estar aberto: consertar
   * depois do fechamento e justamente o caso de uso.
   *
   * Duas formas:
   * - `salaFaixaId` — o admin escolhe a sala exata;
   * - `faixaId` — muda de horario e deixa a alocacao sequencial escolher a sala.
   *
   * O que NAO se pode remanejar, em nenhuma das duas: outro polo (o aluno
   * viajaria para o campus errado), outro formato (a prova tem outra
   * duracao) e o horario em que a MESMA PESSOA ja tem a prova do outro curso
   * dela. Sao os tres erros que o remanejo poderia esconder.
   */
  async remanejar(
    id: number,
    destino: { salaFaixaId?: number; faixaId?: number },
    ator?: string,
  ): Promise<AgendamentoAdmin> {
    if (!destino.salaFaixaId === !destino.faixaId) {
      throw new BadRequestException('Escolha o horário ou a sala de destino.');
    }

    const atual = await this.prisma.agendamento.findUnique({
      where: { id },
      include: {
        aluno: { select: { id: true, modalidadeId: true, poloId: true } },
        salaFaixa: { select: { id: true, faixaId: true } },
      },
    });

    if (!atual) throw new NotFoundException(AGENDAMENTO_NAO_ENCONTRADO);

    if (atual.status !== StatusAgendamento.CONFIRMADO) {
      throw new ConflictException(
        'Agendamento cancelado não pode ser remanejado.',
      );
    }

    const alvo = await this.resolverDestino(destino, atual.aluno);

    if (alvo.salaFaixaId === atual.salaFaixa.id) {
      throw new ConflictException('O agendamento já está nesta sala.');
    }

    // Sem janela cadastrada nao ha o que remanejar contra: cai no periodo
    // letivo da propria reserva, que e o recorte de antes do mapa. E o unico
    // caminho em que a trava por pessoa nao enxerga a grade vizinha, e ele so
    // acontece com o cadastro apagado — estado que `remover` ja recusa quando
    // ha reserva.
    const janela = (await this.periodo.janelaVigente()) ?? {
      periodoLetivoIds: [atual.periodoLetivoId],
    };

    await this.prisma.$transaction(async (tx) => {
      await travarAluno(tx, atual.matricula);

      // Vale para o admin tambem (decisao do cliente, 14/08/2026): mover o aluno
      // para o horario da OUTRA prova dele criaria, em silencio, exatamente o
      // estado que o portal recusa — duas provas ao mesmo tempo para a mesma
      // pessoa. Nao trava a administracao: basta mover primeiro a outra prova.
      await exigirUmaProvaPorFaixa(tx, {
        matricula: atual.matricula,
        faixaId: alvo.faixaId,
        // A janela inteira, e nao o periodo desta reserva: a outra prova do
        // mesmo RA pode estar num vinculo de outro formato, gravada sob
        // outro org unit. Ver a nota em `exigirUmaProvaPorFaixa`.
        periodoLetivoIds: janela.periodoLetivoIds,
        exceto: id,
      });

      const de = await descreverOferta(tx, atual.salaFaixa.id);

      const salaFaixaId =
        alvo.salaFaixaId ??
        (
          await escolherOfertaComLock(
            tx,
            alvo.faixaId,
            atual.aluno.modalidadeId,
            id,
          )
        ).id;

      if (alvo.salaFaixaId) {
        await exigirVagaNaOferta(tx, alvo.salaFaixaId, id);
      }

      await tx.agendamento.update({
        where: { id },
        data: { salaFaixaId, alocadoManual: true },
      });

      // O horario pode ter mudado: o que ja tiver sido liberado precisa ser
      // reescrito quando a integracao com o D2L existir.
      await tx.syncD2L.updateMany({
        where: { agendamentoId: id },
        data: { status: 'PENDENTE', tentativas: 0, ultimoErro: null },
      });

      // FOI O ADMINISTRADOR, e fica gravado com o e-mail dele. E o outro lado da
      // mesma prova: se o aluno reclamar que nao foi ele, isto responde.
      await registrarHistorico(tx, {
        agendamentoId: id,
        evento: EventoAgendamento.REMANEJADO,
        autor: AUTOR_ADMIN(ator),
        de,
        para: await descreverOferta(tx, salaFaixaId),
      });
    }, OPCOES_DA_TRANSACAO);

    this.auditoria.registrar('AGENDAMENTO_REMANEJADO', {
      ator,
      detalhe: `agendamento ${id}: oferta ${atual.salaFaixa.id} -> ${alvo.salaFaixaId ?? `faixa ${alvo.faixaId}`} (remanejo administrativo)`,
    });

    return this.buscar(id);
  }

  /**
   * Cancela pelo lado administrativo. Vira CANCELADO, nunca some: quem aparecer
   * no dia sem estar na lista precisa ser explicavel.
   */
  async cancelar(id: number, ator?: string): Promise<{ mensagem: string }> {
    const atual = await this.prisma.agendamento.findUnique({
      where: { id },
      select: { id: true, matricula: true, status: true, salaFaixaId: true },
    });

    if (!atual) throw new NotFoundException(AGENDAMENTO_NAO_ENCONTRADO);

    if (atual.status !== StatusAgendamento.CONFIRMADO) {
      throw new ConflictException('Este agendamento já está cancelado.');
    }

    await this.prisma.$transaction(async (tx) => {
      const de = await descreverOferta(tx, atual.salaFaixaId);

      await tx.agendamento.update({
        where: { id },
        data: { status: StatusAgendamento.CANCELADO },
      });

      await tx.syncD2L.deleteMany({ where: { agendamentoId: id } });

      await registrarHistorico(tx, {
        agendamentoId: id,
        evento: EventoAgendamento.CANCELADO,
        autor: AUTOR_ADMIN(ator),
        de,
      });
    });

    this.auditoria.registrar('AGENDAMENTO_CANCELADO', {
      ator,
      detalhe: `agendamento ${id} (${atual.matricula}) cancelado pelo administrador`,
    });

    return { mensagem: `Agendamento #${id} cancelado. A vaga foi liberada.` };
  }

  /**
   * Quem mexeu neste agendamento, do mais recente para o mais antigo.
   *
   * E a tela que a administracao abre quando o aluno reclama que mudaram a prova
   * dele: cada linha diz o que aconteceu, QUEM fez (o proprio aluno ou qual
   * administrador) e de que horario para qual.
   */
  async historico(id: number): Promise<EventoDoHistorico[]> {
    const existe = await this.prisma.agendamento.count({ where: { id } });

    if (existe === 0) {
      throw new NotFoundException(AGENDAMENTO_NAO_ENCONTRADO);
    }

    const linhas = await this.prisma.historicoAgendamento.findMany({
      where: { agendamentoId: id },
      orderBy: { createdAt: 'desc' },
    });

    return linhas.map((l) => ({
      id: l.id,
      evento: l.evento,
      autorTipo: l.autorTipo,
      autor: l.autor,
      de: l.de,
      para: l.para,
      quando: l.createdAt,
    }));
  }

  /**
   * Valida o destino contra o vinculo do aluno ANTES da transacao, para a
   * mensagem de erro poder explicar o problema em vez de so recusar.
   */
  private async resolverDestino(
    destino: { salaFaixaId?: number; faixaId?: number },
    aluno: { modalidadeId: number; poloId: number },
  ): Promise<{ salaFaixaId?: number; faixaId: number }> {
    if (destino.salaFaixaId) {
      const oferta = await this.prisma.salaFaixa.findUnique({
        where: { id: destino.salaFaixaId },
        include: {
          modalidade: { select: { nome: true } },
          faixa: { include: { polo: { select: { nome: true } } } },
        },
      });

      if (!oferta) {
        throw new NotFoundException(
          'Sala não encontrada neste horário. Atualize a página e tente de novo.',
        );
      }

      this.exigirCompativel(
        { poloId: oferta.faixa.poloId, poloNome: oferta.faixa.polo.nome },
        { modalidadeId: oferta.modalidadeId, nome: oferta.modalidade.nome },
        aluno,
      );

      return { salaFaixaId: oferta.id, faixaId: oferta.faixaId };
    }

    const faixa = await this.prisma.faixa.findUnique({
      where: { id: destino.faixaId },
      include: { polo: { select: { nome: true } } },
    });

    if (!faixa) {
      throw new NotFoundException(
        'Horário não encontrado. Atualize a página e tente de novo.',
      );
    }

    this.exigirCompativel(
      { poloId: faixa.poloId, poloNome: faixa.polo.nome },
      undefined,
      aluno,
    );

    return { faixaId: faixa.id };
  }

  private exigirCompativel(
    local: { poloId: number; poloNome: string },
    modalidade: { modalidadeId: number; nome: string } | undefined,
    aluno: { modalidadeId: number; poloId: number },
  ): void {
    if (local.poloId !== aluno.poloId) {
      throw new BadRequestException(
        `O destino é do polo "${local.poloNome}", que não é o polo do aluno. ` +
          'Remanejar entre polos mandaria o aluno para o campus errado.',
      );
    }

    if (modalidade && modalidade.modalidadeId !== aluno.modalidadeId) {
      throw new BadRequestException(
        `Neste horário a sala é do formato "${modalidade.nome}", que não é o ` +
          'formato do aluno. A duração da prova seria outra.',
      );
    }
  }

  /**
   * Consulta paginada. A paginacao nao e enfeite: sao ~7.500 vinculos, e uma
   * listagem sem limite derrubaria a tela do admin e a memoria do processo.
   */
  async listar(filtro: FiltroAgendamentos): Promise<PaginaDeAgendamentos> {
    const where = this.montarWhere(filtro);

    const porPagina = Math.min(
      Math.max(filtro.porPagina ?? PADRAO_POR_PAGINA, 1),
      MAXIMO_POR_PAGINA,
    );
    const pagina = Math.max(filtro.pagina ?? 1, 1);

    const [total, registros] = await Promise.all([
      this.prisma.agendamento.count({ where }),
      this.prisma.agendamento.findMany({
        where,
        include: INCLUDE_ADMIN,
        orderBy: [
          { salaFaixa: { faixa: { data: 'asc' } } },
          { salaFaixa: { faixa: { horaInicio: 'asc' } } },
          { salaFaixa: { ordem: 'asc' } },
          { matricula: 'asc' },
        ],
        skip: (pagina - 1) * porPagina,
        take: porPagina,
      }),
    ]);

    return {
      total,
      pagina,
      porPagina,
      totalPaginas: Math.max(1, Math.ceil(total / porPagina)),
      itens: registros.map(montarAdmin),
    };
  }

  async buscar(id: number): Promise<AgendamentoAdmin> {
    const agendamento = await this.prisma.agendamento.findUnique({
      where: { id },
      include: INCLUDE_ADMIN,
    });

    if (!agendamento) {
      throw new NotFoundException(AGENDAMENTO_NAO_ENCONTRADO);
    }

    return montarAdmin(agendamento);
  }

  /**
   * ==========================================================================
   * COMO ESTA INDO O AGENDAMENTO — a tela de Inicio
   * ==========================================================================
   * As perguntas da administracao durante a janela: quantos ja agendaram, em
   * qual formato esta faltando gente, quanto disso o aluno fez sozinho
   * versus o compulsorio, e em que ritmo.
   *
   * A BASE sao os vinculos ATIVOS — os mesmos que o compulsorio considera
   * elegiveis. Trancado ou cancelado nao pode agendar, e conta-lo no total
   * deixaria a adesao eternamente abaixo de 100% sem ninguem para cobrar.
   *
   * Formato e polo aqui sao os de HOJE (`AlunoImportado`), e nao a
   * fotografia do agendamento: a pergunta e "quanto da base atual ja tem
   * prova", e numerador e denominador precisam cortar pelo mesmo campo.
   *
   * O recorte e a janela vigente inteira + a rodada, como na exportacao: sem a
   * rodada, quem fez a N2 contaria como agendado durante a substitutiva.
   */
  async estatisticas(filtro: {
    poloId?: number;
  }): Promise<EstatisticasDaJanela> {
    const janela = await this.periodo.janelaVigente();

    const [modalidades, vinculos] = await Promise.all([
      this.prisma.modalidade.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, nome: true },
      }),
      this.prisma.alunoImportado.groupBy({
        by: ['modalidadeId'],
        where: { ativo: true, poloId: filtro.poloId },
        _count: { _all: true },
      }),
    ]);

    // Sem periodo cadastrado ninguem tem prova "da rodada vigente".
    const reservas = janela
      ? await this.prisma.agendamento.findMany({
          where: {
            status: StatusAgendamento.CONFIRMADO,
            periodoLetivoId: { in: janela.periodoLetivoIds },
            rodada: janela.rodada,
            aluno: { poloId: filtro.poloId },
          },
          select: {
            alunoId: true,
            createdAt: true,
            aluno: { select: { ativo: true, modalidadeId: true } },
            historico: {
              where: { evento: EventoAgendamento.CRIADO },
              select: { autorTipo: true, autor: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        })
      : [];

    // A regra e uma prova por vinculo em cada rodada; o Map so garante que uma
    // duplicata, se um dia existir, nao infle a adesao acima de 100%.
    const porVinculo = new Map(reservas.map((r) => [r.alunoId, r]));

    const agendadosPorModalidade = new Map<number, number>();
    const porOrigem = { aluno: 0, compulsorio: 0, admin: 0, semRegistro: 0 };
    const porDia = new Map<string, AgendamentosDoDia>();
    let agendadosInativos = 0;

    for (const reserva of porVinculo.values()) {
      if (!reserva.aluno.ativo) {
        agendadosInativos++;
        continue;
      }

      somar(agendadosPorModalidade, reserva.aluno.modalidadeId, 1);

      const campo =
        CAMPO_DA_ORIGEM[
          origemDaReserva(reserva.historico[0]) ?? 'SEM_REGISTRO'
        ];

      porOrigem[campo]++;

      const dia = diaDaOperacao(reserva.createdAt);
      const doDia = porDia.get(dia) ?? {
        dia,
        aluno: 0,
        compulsorio: 0,
        admin: 0,
        semRegistro: 0,
      };
      doDia[campo]++;
      porDia.set(dia, doDia);
    }

    const totalPorModalidade = new Map(
      vinculos.map((v) => [v.modalidadeId, v._count._all]),
    );

    const porModalidade = modalidades
      .map((m) => ({
        modalidadeId: m.id,
        modalidade: m.nome,
        total: totalPorModalidade.get(m.id) ?? 0,
        agendados: agendadosPorModalidade.get(m.id) ?? 0,
      }))
      // Formato sem nenhum vinculo so ocuparia espaco com "0 de 0".
      .filter((m) => m.total > 0);

    return {
      rodada: janela?.rodada ?? null,
      totalVinculos: porModalidade.reduce((s, m) => s + m.total, 0),
      agendados: porModalidade.reduce((s, m) => s + m.agendados, 0),
      porModalidade,
      porOrigem,
      agendadosInativos,
      porDia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    };
  }

  /**
   * Ocupacao por sala, que e a pergunta operacional do dia da prova: quantas
   * pessoas em cada sala, e quais salas nem precisam ser abertas.
   */
  async resumo(filtro: FiltroAgendamentos): Promise<LinhaDoResumo[]> {
    const ofertas = await this.prisma.salaFaixa.findMany({
      where: {
        faixa: {
          poloId: filtro.poloId,
          id: filtro.faixaId,
          data: janelaDeDatas(filtro),
        },
        salaId: filtro.salaId,
        modalidadeId: filtro.modalidadeId,
      },
      include: {
        sala: { select: { id: true, nome: true } },
        modalidade: { select: { nome: true } },
        faixa: {
          include: { polo: { select: { id: true, nome: true } } },
        },
        _count: {
          select: {
            agendamentos: { where: { status: StatusAgendamento.CONFIRMADO } },
          },
        },
      },
      orderBy: [
        { faixa: { data: 'asc' } },
        { faixa: { horaInicio: 'asc' } },
        { ordem: 'asc' },
      ],
    });

    return ofertas.map((o) => ({
      poloId: o.faixa.polo.id,
      polo: o.faixa.polo.nome,
      faixaId: o.faixaId,
      data: o.faixa.data,
      horaInicio: o.faixa.horaInicio,
      horaFim: o.faixa.horaFim,
      salaId: o.sala.id,
      sala: o.sala.nome,
      modalidade: o.modalidade.nome,
      vagas: o.vagas,
      ocupadas: o._count.agendamentos,
      disponiveis: Math.max(0, o.vagas - o._count.agendamentos),
    }));
  }

  /**
   * ==========================================================================
   * A EXPORTACAO E DE ALUNOS, NAO DE AGENDAMENTOS
   * ==========================================================================
   * A pergunta que este arquivo responde nao e "quem marcou prova" — a tela ja
   * responde essa —, e sim "COM QUEM A ADMINISTRAÇÃO PRECISA FALAR". Por isso a
   * base sao os vinculos importados, TODOS eles, e o agendamento entra como
   * coluna: quem nao agendou aparece com as colunas da prova vazias e
   * `Status = Não Agendado`, que e exatamente a lista de quem sera cobrado.
   *
   * Duas consequencias que nao sao acidente:
   *
   * - **Cancelado conta como "Não Agendado".** Quem cancelou e nao remarcou
   *   precisa ser contatado igual a quem nunca entrou no portal. Por isso o
   *   `status` da URL nao vale aqui: a coluna e derivada, nao filtrada.
   * - **O recorte e UMA PROVA: `periodoLetivoId` + `rodada`** (os da URL ou os
   *   do periodo vigente). Sem o semestre, quem tem prova no semestre passado
   *   apareceria como "agendado"; sem a rodada, quem fez a N2 apareceria como
   *   "agendado" durante a substitutiva. Os dois casos tiram da cobranca gente
   *   que precisa ser cobrada.
   * - **Sem `periodoLetivoId` na URL, o recorte e a JANELA INTEIRA** — os dois
   *   org units que ela cobre. A cobranca e uma lista so, e ela mistura EaD e
   *   Presencial: filtrar por um periodo letivo faria os presenciais, gravados
   *   sob o outro org unit, sairem TODOS como "Não Agendado" e entrarem na
   *   cobranca depois de ja terem feito a prova.
   *
   * Sem paginacao de proposito — quem exporta quer o arquivo inteiro. Sao ~7.500
   * vinculos, um arquivo de planilha, nao um dump.
   */
  async exportarCsv(filtro: FiltroAgendamentos): Promise<string> {
    const janela = await this.periodo.janelaVigente();

    // Os ids fixados na URL, ou a janela vigente inteira.
    const periodoLetivoId = filtro.periodoLetivoId?.length
      ? { in: filtro.periodoLetivoId }
      : janela
        ? { in: janela.periodoLetivoIds }
        : undefined;

    /**
     * A rodada entra no recorte pela MESMA razao que o periodo letivo: sem ela,
     * quem agendou a N2 sairia como "Agendado" durante a substitutiva e ficaria
     * de fora da cobranca — o erro exato que o recorte por semestre evita.
     *
     * Quando o admin fixa um `periodoLetivoId` na URL sem dizer a rodada, o
     * arquivo traz o semestre INTEIRO (as duas provas). Ai a pergunta e outra —
     * "o que aconteceu naquele semestre" —, e recortar por uma rodada que ele
     * nao pediu esconderia metade da resposta.
     */
    const rodada =
      filtro.rodada ??
      (filtro.periodoLetivoId?.length ? undefined : janela?.rodada);

    const daProva: Prisma.AgendamentoWhereInput = {
      status: StatusAgendamento.CONFIRMADO,
      periodoLetivoId,
      rodada,
      salaFaixa: {
        salaId: filtro.salaId,
        faixaId: filtro.faixaId,
        faixa: { data: janelaDeDatas(filtro) },
      },
    };

    // Filtrar por faixa, sala ou data e pedir a lista DAQUELA prova ("quem vai
    // estar na sala 3 no dia 12"), e ai quem nao tem prova ali nao faz parte da
    // pergunta. Os filtros do ALUNO (polo, formato, busca) sao os unicos que
    // continuam trazendo quem nao agendou.
    const recorteDeProva = Boolean(
      filtro.faixaId || filtro.salaId || filtro.de || filtro.ate,
    );

    const busca = filtro.busca?.trim();

    const alunos = await this.prisma.alunoImportado.findMany({
      where: {
        poloId: filtro.poloId,
        modalidadeId: filtro.modalidadeId,
        ...(busca
          ? {
              OR: [
                { matricula: { contains: busca } },
                { nome: { contains: busca } },
                { email: { contains: busca } },
                { curso: { contains: busca } },
              ],
            }
          : {}),
        ...(recorteDeProva ? { agendamentos: { some: daProva } } : {}),
      },
      select: {
        matricula: true,
        nome: true,
        email: true,
        curso: true,
        statusCurso: true,
        modalidade: { select: { nome: true } },
        polo: { select: { nome: true } },
        agendamentos: {
          where: daProva,
          select: {
            createdAt: true,
            rodada: true,
            // Quem criou a reserva: o evento CRIADO e gravado na mesma transacao
            // do agendamento, entao existe um por reserva.
            historico: {
              where: { evento: EventoAgendamento.CRIADO },
              select: { autorTipo: true, autor: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
            // O formato e o polo DA EPOCA da reserva, nao os de hoje — ver
            // `dadosDoAluno` abaixo.
            modalidade: { select: { nome: true } },
            polo: { select: { nome: true } },
            salaFaixa: {
              select: {
                sala: { select: { nome: true } },
                faixa: {
                  select: { data: true, horaInicio: true, horaFim: true },
                },
              },
            },
          },
          orderBy: { salaFaixa: { faixa: { data: 'asc' } } },
        },
      },
      // Polo primeiro: a cobranca e distribuida por campus.
      orderBy: [
        { polo: { nome: 'asc' } },
        { nome: 'asc' },
        { matricula: 'asc' },
        { curso: 'asc' },
      ],
    });

    const linhas = alunos.flatMap((aluno) => {
      const identificacao = [
        aluno.matricula,
        aluno.nome,
        aluno.email,
        aluno.curso,
        // Valor BRUTO do CSV importado ("Ativo", "Trancado"...), e o de HOJE:
        // a pergunta da cobranca e se ainda vale a pena ligar para a pessoa.
        aluno.statusCurso,
      ];

      if (aluno.agendamentos.length === 0) {
        // Sem reserva nao ha fotografia, e o estado atual e a unica resposta —
        // que aqui tambem e a certa: quem ainda precisa agendar vai agendar
        // pelo formato e pelo polo que tem HOJE.
        return [
          [
            ...identificacao,
            aluno.modalidade.nome,
            aluno.polo.nome,
            // Sem prova nao ha rodada: a coluna diz de qual prova do semestre e
            // a linha, e quem nao agendou nao esta em nenhuma delas.
            null,
            null,
            null,
            null,
            null,
            NAO_AGENDADO,
            null,
            // Quem ainda nao agendou nao foi agendado por ninguem. Baixar o
            // arquivo antes do compulsorio deixa a coluna vazia para ele.
            null,
          ],
        ];
      }

      /**
       * Formato e polo saem do AGENDAMENTO, nao do vinculo.
       *
       * `AlunoImportado` guarda so o estado atual, e a importacao sobrescreve os
       * dois campos. Lendo de la, uma prova de 2026/1 feita como EaD aparecia
       * como "Modular" depois que o aluno mudou de curso — na mesma linha da
       * data e da sala corretas, que sao as da prova de verdade. Duas colunas da
       * mesma linha discordando sobre o mesmo fato.
       *
       * A regra e um agendamento por vinculo em cada rodada, e o recorte desta
       * consulta ja fixa a rodada — entao aqui e um so. Ainda assim, se houver
       * mais de um, cada um vira uma linha em vez de sumir do arquivo.
       */
      return aluno.agendamentos.map(
        ({
          salaFaixa,
          createdAt,
          modalidade,
          polo,
          rodada: daLinha,
          historico,
        }) => [
          ...identificacao,
          modalidade.nome,
          polo.nome,
          daLinha,
          dataDaProva(salaFaixa.faixa.data),
          salaFaixa.faixa.horaInicio,
          salaFaixa.faixa.horaFim,
          salaFaixa.sala.nome,
          AGENDADO,
          dataBr(createdAt, true),
          quemAgendou(historico[0]),
        ],
      );
    });

    return montarCsv(CABECALHOS_EXPORTACAO, linhas);
  }

  /** Nome do arquivo com a data — dois relatorios do mesmo dia nao se confundem. */
  nomeDoArquivo(prefixo = 'Lista Agendamento'): string {
    const agora = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

    return `${prefixo}-${agora}.csv`;
  }

  private montarWhere(
    filtro: FiltroAgendamentos,
  ): Prisma.AgendamentoWhereInput {
    const busca = filtro.busca?.trim();

    return {
      // Sem filtro explicito, mostra so os CONFIRMADOS: um cancelado na lista
      // do dia da prova faria alguem procurar um aluno que nao vem.
      status: filtro.status ?? StatusAgendamento.CONFIRMADO,
      // Sem periodo na URL a listagem NAO recorta por periodo letivo — e o
      // comportamento de sempre ("tudo que existe", filtrado pelo resto). Com
      // ele, recorta pelos ids pedidos, que podem ser as duas grades de uma
      // janela so.
      periodoLetivoId: filtro.periodoLetivoId?.length
        ? { in: filtro.periodoLetivoId }
        : undefined,
      rodada: filtro.rodada,
      salaFaixa: {
        salaId: filtro.salaId,
        modalidadeId: filtro.modalidadeId,
        faixaId: filtro.faixaId,
        faixa: {
          poloId: filtro.poloId,
          data: janelaDeDatas(filtro),
        },
      },
      ...(busca
        ? {
            OR: [
              { matricula: { contains: busca } },
              { aluno: { nome: { contains: busca } } },
              { aluno: { curso: { contains: busca } } },
            ],
          }
        : {}),
    };
  }
}

const CABECALHOS_EXPORTACAO = [
  'Matrícula',
  'Aluno',
  'E-mail',
  'Curso',
  'Situação do Curso',
  'Formato',
  'Polo',
  'Rodada',
  'Data da prova',
  'Início',
  'Fim',
  'Sala',
  'Status',
  'Agendado em',
  'Agendado por',
];

/**
 * Os dois unicos valores da coluna Status — e sao estes dois de proposito.
 *
 * O arquivo e trabalhado no Excel: quem vai cobrar filtra a coluna por "Não
 * Agendado" e liga. `CONFIRMADO`/`CANCELADO` (o enum do banco) obrigaria a
 * administracao a saber que "cancelado" tambem significa "precisa agendar".
 */
const AGENDADO = 'Agendado';
const NAO_AGENDADO = 'Não Agendado';

/**
 * A coluna "Agendado por": quem CRIOU a reserva, lido do evento `CRIADO` do
 * historico.
 *
 * `alocadoManual` nao serve para isto: o remanejo tambem o liga, e uma reserva
 * feita pelo aluno e depois movida pela administracao sairia como "nao foi ele".
 *
 * Tres valores, e nao dois: alem do aluno e do lote compulsorio, a administracao
 * agenda uma pessoa no balcao ("Agendar aluno"). Juntar esse caso ao
 * compulsorio diria que o lote rodou para quem foi atendido pessoalmente.
 *
 * Sem o evento (reserva anterior ao historico), a coluna fica vazia em vez de
 * chutar.
 */
function quemAgendou(
  criado: { autorTipo: AutorDaAlteracao; autor: string } | undefined,
): string | null {
  const origem = origemDaReserva(criado);

  if (!origem) return null;

  return { ALUNO: 'Aluno', COMPULSORIO: 'Compulsório', ADMIN: 'Admin' }[origem];
}

/**
 * A classificacao por tras de `quemAgendou`, compartilhada com as estatisticas
 * do Inicio: a coluna do CSV e o grafico precisam contar do mesmo jeito.
 */
function origemDaReserva(
  criado: { autorTipo: AutorDaAlteracao; autor: string } | undefined,
): OrigemDaReserva | null {
  if (!criado) return null;

  if (criado.autorTipo === AutorDaAlteracao.ALUNO) return 'ALUNO';

  return criado.autor === IDENTIFICACAO_COMPULSORIO ? 'COMPULSORIO' : 'ADMIN';
}

const CAMPO_DA_ORIGEM = {
  ALUNO: 'aluno',
  COMPULSORIO: 'compulsorio',
  ADMIN: 'admin',
  SEM_REGISTRO: 'semRegistro',
} as const;

function somar<K>(mapa: Map<K, number>, chave: K, valor: number): void {
  mapa.set(chave, (mapa.get(chave) ?? 0) + valor);
}

/**
 * O dia em que a reserva foi criada, no fuso da operacao.
 *
 * Um formatador so, e nao `agoraNaOperacao` por reserva: sao milhares de
 * linhas, e construir um `Intl.DateTimeFormat` custa mais que formatar. Ler o
 * dia em UTC jogaria para amanha tudo que foi agendado depois das 21h.
 */
const DIA_DA_OPERACAO = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_DA_OPERACAO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const diaDaOperacao = (instante: Date) => DIA_DA_OPERACAO.format(instante);

/**
 * Recorte de datas da prova, compartilhado com o modulo de relatorios: e a
 * mesma pergunta ("as provas entre tal e tal dia") e precisa tratar o `@db.Date`
 * do mesmo jeito nos dois lugares, ou os dois relatorios discordariam na virada
 * do dia.
 */
export function janelaDeDatas(filtro: { de?: string; ate?: string }) {
  if (!filtro.de && !filtro.ate) return undefined;

  return {
    gte: filtro.de ? paraData(filtro.de) : undefined,
    lte: filtro.ate ? paraData(filtro.ate) : undefined,
  };
}

/** A coluna e @db.Date: meia-noite UTC, para nao deslizar um dia no fuso local. */
function paraData(data: string): Date {
  return new Date(`${data}T00:00:00.000Z`);
}

const INCLUDE_ADMIN = {
  aluno: {
    select: {
      nome: true,
      email: true,
      curso: true,
      statusCurso: true,
      modalidade: { select: { nome: true } },
    },
  },
  disciplinas: { select: { orgUnitId: true, nomeDisciplina: true } },
  salaFaixa: {
    include: {
      sala: { select: { nome: true } },
      faixa: { include: { polo: { select: { nome: true } } } },
    },
  },
} satisfies Prisma.AgendamentoInclude;

type RegistroAdmin = {
  id: number;
  matricula: string;
  status: string;
  alocadoManual: boolean;
  periodoLetivoId: string;
  rodada: string;
  createdAt: Date;
  aluno: {
    nome: string | null;
    email: string | null;
    curso: string;
    statusCurso: string;
    modalidade: { nome: string };
  };
  disciplinas: { orgUnitId: string; nomeDisciplina: string | null }[];
  salaFaixa: {
    sala: { nome: string };
    faixa: {
      data: Date;
      horaInicio: string;
      horaFim: string;
      polo: { nome: string };
    };
  };
};

function montarAdmin(registro: RegistroAdmin): AgendamentoAdmin {
  const { salaFaixa, aluno } = registro;

  return {
    id: registro.id,
    matricula: registro.matricula,
    nome: aluno.nome,
    email: aluno.email,
    curso: aluno.curso,
    statusCurso: aluno.statusCurso,
    modalidade: aluno.modalidade.nome,
    polo: salaFaixa.faixa.polo.nome,
    data: salaFaixa.faixa.data,
    horaInicio: salaFaixa.faixa.horaInicio,
    horaFim: salaFaixa.faixa.horaFim,
    sala: salaFaixa.sala.nome,
    status: registro.status,
    alocadoManual: registro.alocadoManual,
    periodoLetivoId: registro.periodoLetivoId,
    rodada: registro.rodada,
    disciplinas: registro.disciplinas,
    criadoEm: registro.createdAt,
  };
}
