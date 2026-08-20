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
  EventoAgendamento,
  Prisma,
  StatusAgendamento,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { dataBr, dataDaProva, montarCsv } from './csv-relatorio';
import { DisciplinasDoAlunoService } from './disciplinas-do-aluno.service';
import type { DisciplinaComNota } from './elegibilidade-de-nota.service';
import { AUTOR_ADMIN, descreverOferta, registrarHistorico } from './historico';
import {
  CONFIRMADO,
  escolherOfertaComLock,
  exigirUmaProvaPorFaixa,
  exigirVagaNaOferta,
  OPCOES_DA_TRANSACAO,
  travarAluno,
} from './lock-de-vagas';

export interface FiltroAgendamentos {
  poloId?: number;
  faixaId?: number;
  salaId?: number;
  modalidadeId?: number;
  periodoLetivoId?: string;
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
   * O que ela recusa e o mesmo que o remanejo recusa (outro polo, outra
   * modalidade, sala lotada, a mesma pessoa duas vezes no mesmo horario) mais o
   * que so faz sentido ao CRIAR: aluno que ja tem prova neste semestre (para
   * isso existe o remanejo) e situacao de curso que nao permite agendar — esta
   * ultima liberavel com `ignorarStatusCurso`, porque bloquear de vez trancaria
   * a secretaria no unico caso em que ela precisa da valvula de escape.
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
      throw new BadRequestException(
        'Informe `salaFaixaId` (sala exata) OU `faixaId` (deixa a alocacao escolher) — um dos dois.',
      );
    }

    const vinculo = await this.prisma.alunoImportado.findUnique({
      where: { id: dados.alunoId },
      include: { modalidade: true, polo: true },
    });

    if (!vinculo) {
      throw new NotFoundException(`Vinculo ${dados.alunoId} nao encontrado`);
    }

    const vigente = await this.periodo.periodoLetivoVigente();

    if (!vigente) {
      throw new BadRequestException(
        'Nenhum periodo de agendamento cadastrado: sem periodo letivo nao ha ' +
          'como saber de qual semestre e esta prova. Cadastre em /periodos.',
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
          `A situacao deste aluno no curso ${vinculo.curso} esta como ` +
            `"${vinculo.statusCurso}", que nao permite agendar prova. Se for o ` +
            'caso mesmo assim, reenvie com `ignorarStatusCurso: true`.',
        );
      }

      avisos.push(
        `Agendado apesar da situacao no curso ser "${vinculo.statusCurso}", ` +
          'que normalmente nao permite agendar.',
      );
    }

    // Conferido de novo dentro da transacao, sob lock. Aqui e so para a
    // mensagem: "use o remanejo" resolve o problema; "409" nao diz nada.
    //
    // O recorte inclui a RODADA, como no portal: quem ja fez a N2 pode e deve
    // ser agendado na substitutiva, e mandar a secretaria "usar o remanejo"
    // nesse caso a faria mover a prova ja realizada.
    const jaTem = await this.prisma.agendamento.findFirst({
      where: { alunoId: vinculo.id, periodoLetivoId, rodada, ...CONFIRMADO },
      select: { id: true },
    });

    if (jaTem) {
      throw new ConflictException(
        `Este aluno ja tem prova marcada para o curso ${vinculo.curso} nesta ` +
          `prova do semestre (${rodada}, agendamento ${jaTem.id}). Para mudar ` +
          'de sala ou horario, use o remanejo.',
      );
    }

    const alvo = await this.resolverDestino(dados, vinculo);

    avisos.push(...(await this.ressalvasDaFaixa(alvo.faixaId)));

    const fonte = await this.disciplinasParaOAdmin(
      { id: vinculo.id, matricula: vinculo.matricula },
      periodoLetivoId,
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
            `(${rodada}, agendamento ${existente.id}), enquanto esta tela ` +
            'estava aberta. Recarregue e use o remanejo se precisar mudar de horario.',
        );
      }

      // Vale para o admin tambem (decisao do cliente, 14/08/2026): uma prova por
      // pessoa em cada horario, mesmo quando as duas sao de cursos diferentes.
      await exigirUmaProvaPorFaixa(tx, {
        matricula: vinculo.matricula,
        faixaId: alvo.faixaId,
        periodoLetivoId,
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
              // Ver o schema: fotografia da nota, nula quando a janela nao
              // filtrou por nota.
              notaFinal: d.notaFinal,
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
    periodoLetivoId: string,
  ): Promise<{
    userIdD2L: string;
    disciplinas: DisciplinaComNota[];
    origem: OrigemDasDisciplinas;
    avisos: string[];
  }> {
    const anterior = await this.reservaAnterior(vinculo, periodoLetivoId);

    // A janela filtra por nota? Muda o que o fallback significa — ver o aviso
    // montado em `semBrightspace`.
    const vigente = await this.periodo.periodoLetivoVigente();
    const filtroDeNota = vigente?.filtroDeNota ?? null;

    /** Cai para a reserva anterior, ou recusa dizendo o porque de cada uma. */
    const semBrightspace = (motivo: string) => {
      if (!anterior) {
        throw new ConflictException(
          `${motivo} E este aluno nao tem nenhuma reserva anterior neste ` +
            'semestre de onde copiar as disciplinas — sem elas, a prova seria ' +
            'marcada sem cobrir disciplina nenhuma.',
        );
      }

      const avisos = [
        `${motivo} As disciplinas foram copiadas da reserva anterior deste ` +
          `aluno neste semestre (agendamento ${anterior.id}). Confira antes ` +
          'de liberar a prova no Brightspace.',
      ];

      // ⚠️ A reserva copiada NAO passou pela faixa de nota desta janela — em
      // geral ela e da prova regular, marcada quando nota nenhuma era
      // consultada. O portal recusaria este aluno em vez de degradar; aqui nao
      // ha como recusar sem travar o balcao com o aluno na frente, entao a
      // saida e dizer em voz alta o que a lista NAO garante.
      if (filtroDeNota) {
        avisos.push(
          'ATENCAO: esta janela so admite disciplina com nota final entre ' +
            `${filtroDeNota.minima} e ${filtroDeNota.maxima} (este ultimo ` +
            'excluido), e a lista copiada NAO foi conferida contra a nota — ' +
            'ela veio de outra reserva, nao do Brightspace. Confira as notas ' +
            'antes de confirmar, ou refaca quando a integracao voltar.',
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
        'A integracao com o Brightspace esta desligada (D2L_HABILITADO), e e ' +
          'ela quem sabe as disciplinas de quem nao agendou pelo portal.',
      );
    }

    try {
      const identidade = await this.d2l.identidadePorMatricula(
        vinculo.matricula,
      );

      if (identidade.situacao === 'SEM_CONTA') {
        return semBrightspace(
          `A matricula ${vinculo.matricula} nao existe no Brightspace.`,
        );
      }

      if (identidade.situacao === 'AMBIGUA') {
        return semBrightspace(
          `Ha ${identidade.quantos} contas no Brightspace com a matricula ` +
            `${vinculo.matricula}, e escolher uma nao e decisao do sistema.`,
        );
      }

      if (identidade.situacao === 'ID_INVALIDO') {
        return semBrightspace(
          `O UserId "${identidade.valor}" no Brightspace nao e numerico e ` +
            'seria recusado pela Valence.',
        );
      }

      const cruzamento = await this.disciplinasDoAluno.cruzarPorUserId(
        identidade.userIdD2L,
      );

      if (cruzamento.agendaveis.length === 0) {
        return semBrightspace(
          cruzamento.motivo ??
            `Nenhuma disciplina dele no periodo letivo ${periodoLetivoId} ` +
              'cruzou com o CSV de turmas com prova.',
        );
      }

      return {
        userIdD2L: identidade.userIdD2L,
        disciplinas: cruzamento.agendaveis,
        origem: 'BRIGHTSPACE',
        avisos: identidade.ativoNoD2L
          ? []
          : [
              'A conta deste aluno esta DESATIVADA no Brightspace: ele tem ' +
                'lugar na sala, mas do jeito que esta nao conseguiria abrir a ' +
                'prova. Abra chamado no suporte do LMS.',
            ],
      };
    } catch (erro) {
      // Rede, token vencido, 500 da Valence. Igual ao portal (`cairParaOLaunch`)
      // e ao contrario do compulsorio: aqui ha um humano esperando resposta, e
      // uma lista velha o deixa resolver o atendimento agora.
      return semBrightspace(
        'Nao foi possivel consultar o Brightspace agora ' +
          `(${erro instanceof Error ? erro.message : String(erro)}).`,
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
          select: { orgUnitId: true, nomeDisciplina: true, notaFinal: true },
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
        // A nota da reserva antiga vem junto e e RECOPIADA como esta: e a nota
        // que decidiu AQUELA reserva, e nao a de agora. Copiar sem ela apagaria
        // a unica explicacao existente; inventar uma nova exigiria consultar a
        // Valence — que e justamente o que nao respondeu quando se cai aqui.
        disciplinas: escolhida.disciplinas.map((d) => ({
          orgUnitId: d.orgUnitId,
          nomeDisciplina: d.nomeDisciplina,
          notaFinal: d.notaFinal === null ? null : Number(d.notaFinal),
        })),
      },
    };
  }

  /**
   * Faixa inativa ou com data passada AVISA, nao bloqueia.
   *
   * O portal recusa as duas, e com razao: o aluno escolhendo sozinho um horario
   * que ja passou so pode ser engano. Aqui quem escolhe e a secretaria, e os
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
        'Este horario esta INATIVO: ele nao aparece no portal do aluno.',
      );
    }

    if (faixa.data < hojeUtc()) {
      avisos.push(
        `A data deste horario (${faixa.data.toLocaleDateString('pt-BR', {
          timeZone: 'UTC',
        })}) ja passou.`,
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
   * viajaria para o campus errado), outra modalidade (a prova tem outra
   * duracao) e o horario em que a MESMA PESSOA ja tem a prova do outro curso
   * dela. Sao os tres erros que o remanejo poderia esconder.
   */
  async remanejar(
    id: number,
    destino: { salaFaixaId?: number; faixaId?: number },
    ator?: string,
  ): Promise<AgendamentoAdmin> {
    if (!destino.salaFaixaId === !destino.faixaId) {
      throw new BadRequestException(
        'Informe `salaFaixaId` (sala exata) OU `faixaId` (deixa a alocacao escolher) — um dos dois.',
      );
    }

    const atual = await this.prisma.agendamento.findUnique({
      where: { id },
      include: {
        aluno: { select: { id: true, modalidadeId: true, poloId: true } },
        salaFaixa: { select: { id: true, faixaId: true } },
      },
    });

    if (!atual) throw new NotFoundException(`Agendamento ${id} nao encontrado`);

    if (atual.status !== StatusAgendamento.CONFIRMADO) {
      throw new ConflictException(
        'Agendamento cancelado nao pode ser remanejado.',
      );
    }

    const alvo = await this.resolverDestino(destino, atual.aluno);

    if (alvo.salaFaixaId === atual.salaFaixa.id) {
      throw new ConflictException('O agendamento ja esta nesta sala.');
    }

    await this.prisma.$transaction(async (tx) => {
      await travarAluno(tx, atual.matricula);

      // Vale para o admin tambem (decisao do cliente, 14/08/2026): mover o aluno
      // para o horario da OUTRA prova dele criaria, em silencio, exatamente o
      // estado que o portal recusa — duas provas ao mesmo tempo para a mesma
      // pessoa. Nao trava a secretaria: basta mover primeiro a outra prova.
      await exigirUmaProvaPorFaixa(tx, {
        matricula: atual.matricula,
        faixaId: alvo.faixaId,
        periodoLetivoId: atual.periodoLetivoId,
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

    if (!atual) throw new NotFoundException(`Agendamento ${id} nao encontrado`);

    if (atual.status !== StatusAgendamento.CONFIRMADO) {
      throw new ConflictException('Este agendamento ja esta cancelado.');
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

    return { mensagem: `Agendamento ${id} cancelado. A vaga foi liberada.` };
  }

  /**
   * Quem mexeu neste agendamento, do mais recente para o mais antigo.
   *
   * E a tela que a secretaria abre quando o aluno reclama que mudaram a prova
   * dele: cada linha diz o que aconteceu, QUEM fez (o proprio aluno ou qual
   * administrador) e de que horario para qual.
   */
  async historico(id: number): Promise<EventoDoHistorico[]> {
    const existe = await this.prisma.agendamento.count({ where: { id } });

    if (existe === 0) {
      throw new NotFoundException(`Agendamento ${id} nao encontrado`);
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
          `Oferta ${destino.salaFaixaId} nao encontrada`,
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
      throw new NotFoundException(`Faixa ${destino.faixaId} nao encontrada`);
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
        `O destino e do polo "${local.poloNome}", que nao e o polo do aluno. ` +
          'Remanejar entre polos mandaria o aluno para o campus errado.',
      );
    }

    if (modalidade && modalidade.modalidadeId !== aluno.modalidadeId) {
      throw new BadRequestException(
        `Esta sala esta ofertada como "${modalidade.nome}", que nao e a modalidade ` +
          'do aluno. A duracao da prova seria outra.',
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
      throw new NotFoundException(`Agendamento ${id} nao encontrado`);
    }

    return montarAdmin(agendamento);
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
   * responde essa —, e sim "COM QUEM A SECRETARIA PRECISA FALAR". Por isso a
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
   *
   * Sem paginacao de proposito — quem exporta quer o arquivo inteiro. Sao ~7.500
   * vinculos, um arquivo de planilha, nao um dump.
   */
  async exportarCsv(filtro: FiltroAgendamentos): Promise<string> {
    const vigente = await this.periodo.periodoLetivoVigente();

    const periodoLetivoId = filtro.periodoLetivoId ?? vigente?.periodoLetivoId;

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
      filtro.rodada ?? (filtro.periodoLetivoId ? undefined : vigente?.rodada);

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
    // pergunta. Os filtros do ALUNO (polo, modalidade, busca) sao os unicos que
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
        modalidade: { select: { nome: true } },
        polo: { select: { nome: true } },
        agendamentos: {
          where: daProva,
          select: {
            createdAt: true,
            rodada: true,
            // A modalidade e o polo DA EPOCA da reserva, nao os de hoje — ver
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
      ];

      if (aluno.agendamentos.length === 0) {
        // Sem reserva nao ha fotografia, e o estado atual e a unica resposta —
        // que aqui tambem e a certa: quem ainda precisa agendar vai agendar
        // pela modalidade e pelo polo que tem HOJE.
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
          ],
        ];
      }

      /**
       * Modalidade e polo saem do AGENDAMENTO, nao do vinculo.
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
        ({ salaFaixa, createdAt, modalidade, polo, rodada: daLinha }) => [
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
      periodoLetivoId: filtro.periodoLetivoId,
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
  'Matricula',
  'Aluno',
  'E-mail',
  'Curso',
  'Modalidade',
  'Polo',
  'Rodada',
  'Data da prova',
  'Inicio',
  'Fim',
  'Sala',
  'Status',
  'Agendado em',
];

/**
 * Os dois unicos valores da coluna Status — e sao estes dois de proposito.
 *
 * O arquivo e trabalhado no Excel: quem vai cobrar filtra a coluna por "Não
 * Agendado" e liga. `CONFIRMADO`/`CANCELADO` (o enum do banco) obrigaria a
 * secretaria a saber que "cancelado" tambem significa "precisa agendar".
 */
const AGENDADO = 'Agendado';
const NAO_AGENDADO = 'Não Agendado';

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
