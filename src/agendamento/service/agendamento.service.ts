import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import { duracaoEmMinutos } from '../../components/horario.util';
import { hojeUtc } from '../../components/utc.util';
import { PrismaService } from '../../database/prisma.service';
import {
  EventoAgendamento,
  Prisma,
  StatusAgendamento,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import type { DisciplinaComNota } from './elegibilidade-de-nota.service';
import { totalDisponivel } from './alocacao';
import { AUTOR_ALUNO, descreverOferta, registrarHistorico } from './historico';
import { DisciplinasDoAlunoService } from './disciplinas-do-aluno.service';
import {
  CONFIRMADO,
  escolherOfertaComLock,
  exigirUmaProvaPorFaixa,
  OPCOES_DA_TRANSACAO,
  travarAluno,
} from './lock-de-vagas';

/**
 * Uma opcao de horario como o ALUNO a enxerga: dia, hora e se ainda ha vaga.
 *
 * De proposito nao ha sala aqui. A sala e resultado da alocacao no momento em
 * que ele confirma — mostrar antes daria a entender que da para escolher, e
 * qualquer numero por sala ficaria desatualizado no segundo seguinte.
 */
export interface FaixaDisponivel {
  faixaId: number;
  data: Date;
  horaInicio: string;
  horaFim: string;
  duracaoMinutos: number;
  polo: { id: number; nome: string };
  vagas: number;
  disponiveis: number;
  temVaga: boolean;
  /**
   * A MESMA PESSOA ja tem prova neste horario — pelo outro curso dela, ou pela
   * rodada anterior deste mesmo curso (a N2, quando o que esta aberto e a SUB).
   * Tem vaga, mas ela nao pode ocupar: sao provas diferentes e nao da para fazer
   * as duas ao mesmo tempo.
   */
  conflitaComOutraProva: boolean;
}

export interface AgendamentoConfirmado {
  id: number;
  alunoId: number;
  matricula: string;
  curso: string;
  /** Qual prova do semestre e esta ("N2", "SUB"...) — a rodada da reserva. */
  rodada: string;
  status: string;
  data: Date;
  horaInicio: string;
  horaFim: string;
  polo: { id: number; nome: string };
  sala: { id: number; nome: string };
  modalidade: { codigo: string; nome: string; duracaoMinutos: number };
  disciplinas: { orgUnitId: string; nomeDisciplina: string | null }[];
  criadoEm: Date;
}

export interface DisciplinasDoVinculo {
  alunoId: number;
  curso: string;
  disciplinas: { orgUnitId: string; nomeDisciplina: string | null }[];
  podeAgendar: boolean;
  motivo?: string;
}

@Injectable()
export class AgendamentoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periodo: PeriodoService,
    private readonly disciplinasDoAluno: DisciplinasDoAlunoService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * O que o aluno pode escolher: faixas do POLO dele, que ofertam a MODALIDADE
   * dele, ativas e ainda por acontecer.
   *
   * Faixas lotadas continuam na lista com `temVaga: false`. Some-las seria pior
   * para quem esta olhando: o horario que o colega comentou simplesmente nao
   * apareceria, sem explicacao. Mesma escolha para o horario em que a pessoa ja
   * tem prova (pelo outro curso, ou pela rodada anterior): ele volta com
   * `conflitaComOutraProva`, e a tela diz por que aquele nao serve — em vez de o
   * aluno descobrir no clique de confirmar.
   */
  async listarFaixas(
    aluno: AlunoJwtPayload,
    alunoId?: number,
  ): Promise<FaixaDisponivel[]> {
    const vinculo = await this.exigirVinculo(aluno, alunoId);

    const ocupadasPelaOutraProva =
      await this.faixasBloqueadasParaOVinculo(vinculo);

    const faixas = await this.prisma.faixa.findMany({
      where: {
        poloId: vinculo.poloId,
        ativo: true,
        data: { gte: hojeUtc() },
        salaFaixas: { some: { modalidadeId: vinculo.modalidadeId } },
      },
      orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
      include: {
        polo: { select: { id: true, nome: true } },
        salaFaixas: {
          // So as salas da modalidade DELE: uma faixa pode ofertar EaD e Modular
          // ao mesmo tempo, e as vagas de uma nao valem para a outra.
          where: { modalidadeId: vinculo.modalidadeId },
          select: {
            id: true,
            ordem: true,
            vagas: true,
            _count: { select: { agendamentos: { where: CONFIRMADO } } },
          },
        },
      },
    });

    return faixas.map((faixa) => {
      const ofertas = faixa.salaFaixas.map((sf) => ({
        id: sf.id,
        ordem: sf.ordem,
        vagas: sf.vagas,
        ocupadas: sf._count.agendamentos,
      }));

      const disponiveis = totalDisponivel(ofertas);

      return {
        faixaId: faixa.id,
        data: faixa.data,
        horaInicio: faixa.horaInicio,
        horaFim: faixa.horaFim,
        duracaoMinutos: duracaoEmMinutos(faixa.horaInicio, faixa.horaFim),
        polo: faixa.polo,
        vagas: ofertas.reduce((total, o) => total + o.vagas, 0),
        disponiveis,
        temVaga: disponiveis > 0,
        // Separado de `temVaga` de proposito: a vaga existe, o que falta e o
        // aluno. Juntar os dois faria a tela dizer "lotado" para um horario que
        // esta vazio, e ele reclamaria — com razao.
        conflitaComOutraProva: ocupadasPelaOutraProva.has(faixa.id),
      };
    });
  }

  /**
   * As faixas em que a MESMA PESSOA ja tem prova que impede esta.
   *
   * Sao exatamente as que `exigirUmaProvaPorFaixa` vai recusar na confirmacao;
   * aqui elas viram aviso na tela. O espelho tem que ser EXATO nos dois
   * sentidos: uma faixa a menos deixa o aluno descobrir o problema no clique de
   * confirmar, e uma faixa a mais esconde dele um horario que ele podia ter.
   *
   * Por isso o recorte e `matricula + os periodos letivos da JANELA` e **nao
   * filtra por rodada** — igual ao lock, e pela mesma razao: quem fez a N2 as
   * 08:30 nao faz a SUB as 08:30, sao duas provas e ninguem esta em dois lugares
   * ao mesmo tempo. Filtrar por rodada aqui faria a tela oferecer o horario que
   * a confirmacao recusa.
   *
   * Os periodos letivos vao no PLURAL pelo mesmo motivo que no lock: a outra
   * prova do mesmo RA pode estar num vinculo de outra modalidade, gravada sob o
   * outro org unit. Recortar por um so faria a tela oferecer um horario que a
   * confirmacao recusa — a metade errada do espelho.
   *
   * A UNICA exclusao e a reserva do proprio vinculo NA RODADA VIGENTE: e a que
   * esta sendo trocada, e ela nao pode conflitar consigo mesma (trocar para o
   * mesmo horario ja tem recusa propria, com mensagem melhor). A da rodada
   * ANTERIOR do mesmo vinculo continua contando — ela e uma prova de verdade,
   * ocupando aquele horario.
   */
  private async faixasBloqueadasParaOVinculo(vinculo: {
    id: number;
    matricula: string;
  }): Promise<Set<number>> {
    const janela = await this.periodo.janelaVigente();

    if (!janela) return new Set();

    const outras = await this.prisma.agendamento.findMany({
      where: {
        matricula: vinculo.matricula,
        periodoLetivoId: { in: janela.periodoLetivoIds },
        NOT: { alunoId: vinculo.id, rodada: janela.rodada },
        ...CONFIRMADO,
      },
      select: { salaFaixa: { select: { faixaId: true } } },
    });

    return new Set(outras.map((a) => a.salaFaixa.faixaId));
  }

  /** As disciplinas que a prova vai cobrir — o aluno confere antes de confirmar. */
  async disciplinas(
    aluno: AlunoJwtPayload,
    alunoId?: number,
  ): Promise<DisciplinasDoVinculo> {
    const vinculo = await this.exigirVinculo(aluno, alunoId);

    // A lista e do VINCULO, e nao do RA: a modalidade dele escolhe o periodo
    // letivo do Brightspace. Um aluno com um vinculo EaD e um Presencial ve
    // listas diferentes em cada um, como deve ser — sao duas grades.
    const { agendaveis, motivo } = await this.disciplinasDoAluno.cruzar(
      aluno,
      vinculo.modalidade.codigo,
    );

    return {
      alunoId: vinculo.id,
      curso: vinculo.curso,
      // A `notaFinal` que veio do cruzamento NAO sai daqui: nota e assunto do
      // Brightspace e da secretaria, e o portal so precisa dizer QUAIS
      // disciplinas a prova cobre. Devolve-la poria a nota de cada materia numa
      // resposta que a tela nem usa — superficie de suporte que ninguem pediu.
      // Ela continua indo para o banco em `AgendamentoDisciplina.notaFinal`.
      disciplinas: agendaveis.map((d) => ({
        orgUnitId: d.orgUnitId,
        nomeDisciplina: d.nomeDisciplina,
      })),
      podeAgendar: vinculo.ativo && agendaveis.length > 0,
      motivo: !vinculo.ativo
        ? motivoStatus(vinculo.curso, vinculo.statusCurso)
        : agendaveis.length === 0
          ? // O motivo especifico (turma divergente, semestre sem disciplina,
            // curso que nao bate) diz mais que a frase generica. Ela fica de
            // reserva para quando o cruzamento nao souber explicar.
            (motivo ?? SEM_DISCIPLINA)
          : undefined,
    };
  }

  /**
   * ==========================================================================
   * AGENDAR — a operacao que nao pode errar
   * ==========================================================================
   * Ordem das checagens escolhida para dar a mensagem MAIS UTIL primeiro: nao
   * adianta dizer "vagas esgotadas" para quem na verdade esta com a matricula
   * cancelada, nem "periodo fechado" para quem nem disciplina com prova tem.
   */
  async agendar(
    aluno: AlunoJwtPayload,
    dados: { alunoId?: number; faixaId: number },
  ): Promise<AgendamentoConfirmado> {
    const vinculo = await this.exigirVinculo(aluno, dados.alunoId);

    const recusar = (motivo: string, detalhe: string): never => {
      this.auditoria.registrar('AGENDAMENTO_RECUSADO', {
        ator: aluno.sub,
        detalhe: `vinculo ${vinculo.id}, faixa ${dados.faixaId}: ${detalhe}`,
      });
      throw new ForbiddenException(motivo);
    };

    if (!vinculo.ativo) {
      recusar(
        motivoStatus(vinculo.curso, vinculo.statusCurso),
        `status curso "${vinculo.statusCurso}" nao permite agendar`,
      );
    }

    // A modalidade do vinculo decide QUAL periodo letivo do Brightspace vale
    // para este aluno: EaD/Semi/Modular andam por modulo, Presencial por
    // semestre, e os dois org units estao vivos ao mesmo tempo.
    const periodo = await this.periodo.exigirAberto(vinculo.modalidade.codigo);

    const cruzamento = await this.disciplinasDoAluno.cruzar(
      aluno,
      vinculo.modalidade.codigo,
    );
    const disciplinas = cruzamento.agendaveis;

    if (disciplinas.length === 0) {
      recusar(
        cruzamento.motivo ?? SEM_DISCIPLINA,
        'nenhuma disciplina agendavel',
      );
    }

    const faixa = await this.exigirFaixaValida(dados.faixaId, vinculo, recusar);

    const criado = await this.alocar({
      vinculoId: vinculo.id,
      matricula: vinculo.matricula,
      curso: vinculo.curso,
      modalidadeId: vinculo.modalidadeId,
      poloId: vinculo.poloId,
      faixaId: faixa.id,
      userIdD2L: aluno.userIdD2L,
      periodoLetivoId: periodo.periodoLetivoId,
      periodoLetivoIds: periodo.periodoLetivoIds,
      rodada: periodo.rodada,
      disciplinas,
    });

    this.auditoria.registrar('AGENDAMENTO_CRIADO', {
      ator: vinculo.matricula,
      detalhe:
        `agendamento ${criado.id}, vinculo ${vinculo.id}, faixa ${faixa.id}, ` +
        `sala_faixa ${criado.salaFaixaId}, ${disciplinas.length} disciplina(s)`,
    });

    return this.buscar(criado.id);
  }

  /**
   * ==========================================================================
   * TROCAR DE HORARIO — sem passar por "cancela e tenta de novo"
   * ==========================================================================
   * A operacao e ATOMICA de proposito. Se o aluno cancelasse primeiro e so
   * depois escolhesse, poderia perder a vaga que tinha e descobrir que a nova
   * lotou no meio do caminho — ficando sem nenhuma. Aqui, ou ele sai com o
   * horario novo, ou continua exatamente com o que tinha.
   */
  async trocar(
    aluno: AlunoJwtPayload,
    agendamentoId: number,
    faixaId: number,
  ): Promise<AgendamentoConfirmado> {
    const atual = await this.exigirAgendamentoDoAluno(aluno, agendamentoId);
    const vinculo = await this.exigirVinculo(aluno, atual.alunoId);

    // A troca e um agendamento novo aos olhos da regra: fora do prazo, nao ha
    // troca. Quem perdeu o prazo procura a secretaria, que remaneja.
    const periodo = await this.periodo.exigirAberto(vinculo.modalidade.codigo);

    const faixa = await this.exigirFaixaValida(faixaId, vinculo);

    if (atual.salaFaixa.faixaId === faixaId) {
      throw new ConflictException(
        'Voce ja esta neste horario. Escolha um horario diferente.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await travarAluno(tx, vinculo.matricula);

      // A troca e um agendamento novo aos olhos da regra: trocar nao pode ser a
      // porta para cair no horario da outra prova do mesmo RA.
      // A janela inteira, e nao `atual.periodoLetivoId`: a outra prova do mesmo
      // RA pode estar num vinculo de outra modalidade, gravada sob o outro org
      // unit. Ver a nota em `exigirUmaProvaPorFaixa`.
      await exigirUmaProvaPorFaixa(tx, {
        matricula: vinculo.matricula,
        faixaId: faixa.id,
        periodoLetivoIds: periodo.periodoLetivoIds,
        exceto: agendamentoId,
      });

      const de = await descreverOferta(tx, atual.salaFaixaId);

      const escolhida = await escolherOfertaComLock(
        tx,
        faixa.id,
        vinculo.modalidadeId,
        agendamentoId,
      );

      await tx.agendamento.update({
        where: { id: agendamentoId },
        data: { salaFaixaId: escolhida.id, alocadoManual: false },
      });

      // FOI O PROPRIO ALUNO. E este registro que responde a reclamacao de
      // "mudaram minha prova sem avisar".
      await registrarHistorico(tx, {
        agendamentoId,
        evento: EventoAgendamento.TROCADO,
        autor: AUTOR_ALUNO(vinculo.matricula),
        de,
        para: await descreverOferta(tx, escolhida.id),
      });

      // A prova mudou de hora: o que ja tiver sido enviado precisa ser reescrito
      // quando a integracao existir.
      await tx.syncD2L.updateMany({
        where: { agendamentoId },
        data: { status: 'PENDENTE', tentativas: 0, ultimoErro: null },
      });
    }, OPCOES_DA_TRANSACAO);

    this.auditoria.registrar('AGENDAMENTO_REMANEJADO', {
      ator: vinculo.matricula,
      detalhe: `agendamento ${agendamentoId}: faixa ${atual.salaFaixa.faixaId} -> ${faixaId} (troca pelo aluno)`,
    });

    return this.buscar(agendamentoId);
  }

  /*
   * NAO existe `cancelar` pelo aluno (removido em 17/08/2026, junto com
   * `DELETE /portal/agendamentos/:id`). Cancelar devolve a vaga e deixa a pessoa
   * SEM prova; num periodo lotando, a vaga sai em segundos e quem so queria
   * mudar de dia fica de fora. O aluno troca de horario (atomico, nunca o deixa
   * sem nada); desmarcar e da secretaria, em `AgendamentoAdminService.cancelar`,
   * que grava o e-mail de quem cancelou no historico.
   */

  /**
   * A prova que ele tem marcada AGORA — um por curso, quando houver dois.
   *
   * So o periodo vigente. O aluno nao ve historico de semestres anteriores: o
   * portal existe para ele saber onde e quando e a prova desta vez, e uma lista
   * com provas antigas so cria confusao (e, antes desta trava, permitia cancelar
   * uma prova que ja tinha acontecido).
   *
   * O filtro NAO exige o periodo aberto: depois do prazo fechado ele continua
   * precisando ver onde e quando fazer a prova. Fechar tranca a escolha, nao a
   * consulta.
   *
   * "Vigente" e o par `periodoLetivoId + rodada`, nao o semestre sozinho: quando
   * a janela aberta e a da substitutiva, a tela mostra a prova da SUB. A N2
   * daquele mesmo semestre ja aconteceu, e listar as duas juntas faria o aluno
   * ir na data errada — o mesmo motivo pelo qual o semestre passado nao aparece.
   */
  async meusAgendamentos(
    aluno: AlunoJwtPayload,
  ): Promise<AgendamentoConfirmado[]> {
    // A JANELA inteira, e nao o periodo de uma modalidade: quem tem um vinculo
    // EaD e um Presencial tem duas provas nesta mesma janela, gravadas sob org
    // units diferentes. Filtrar por um so esconderia dele metade das provas —
    // e ele iria embora sem saber de uma delas.
    const janela = await this.periodo.janelaVigente();

    if (!janela) return [];

    const agendamentos = await this.prisma.agendamento.findMany({
      where: {
        matricula: aluno.sub,
        alunoId: { in: aluno.vinculos.map((v) => v.alunoId) },
        periodoLetivoId: { in: janela.periodoLetivoIds },
        rodada: janela.rodada,
        ...CONFIRMADO,
      },
      include: INCLUDE_COMPLETO,
      orderBy: { createdAt: 'desc' },
    });

    return agendamentos.map(montarConfirmado);
  }

  /**
   * ==========================================================================
   * A TRANSACAO QUE IMPEDE OVERBOOKING
   * ==========================================================================
   * Duas confirmacoes simultaneas na ultima vaga precisam terminar com UMA
   * marcada e a outra recusada — nunca com as duas marcadas. Contar fora da
   * transacao daria exatamente o contrario: as duas leriam "39 de 40" e as duas
   * gravariam.
   *
   * Como funciona:
   *
   * 1. `SELECT ... FOR UPDATE` no VINCULO. Serializa o mesmo aluno consigo mesmo
   *    (duplo clique, duas abas), inclusive quando as duas requisicoes apontam
   *    para faixas diferentes — caso que o lock das salas nao pegaria.
   * 2. `SELECT ... FOR UPDATE` nas ofertas da faixa+modalidade. E o portao: toda
   *    confirmacao para aquelas salas passa por aqui, uma de cada vez.
   * 3. So DEPOIS do portao a contagem e feita.
   *
   * READ COMMITTED e escolha deliberada, nao descuido:
   *
   * - garante que a contagem do passo 3 enxerga o que foi commitado ATE AGORA
   *   (em REPEATABLE READ, o snapshot da transacao pode ser anterior ao lock, e
   *   a contagem viria velha — exatamente o bug que estamos evitando);
   * - nao usa gap lock, entao duas confirmacoes em faixas diferentes nao travam
   *   uma na outra nem correm risco de deadlock.
   *
   * A ordem dos locks e sempre a mesma (vinculo -> salas -> agendamento), o que
   * impede ciclo de deadlock entre duas transacoes concorrentes.
   */
  private async alocar(dados: {
    vinculoId: number;
    matricula: string;
    curso: string;
    modalidadeId: number;
    /** Do VINCULO. Vai gravado na reserva como fotografia — ver o schema. */
    poloId: number;
    faixaId: number;
    userIdD2L: string;
    /**
     * O periodo letivo DESTE vinculo, resolvido pela modalidade dele. E o que
     * vai gravado na reserva como fotografia.
     */
    periodoLetivoId: string;
    /**
     * Os periodos letivos da JANELA. So a trava por PESSOA usa — ela precisa
     * enxergar a prova que o mesmo RA marcou por um vinculo de outra
     * modalidade, gravada sob outro org unit.
     */
    periodoLetivoIds: string[];
    /** Do periodo VIGENTE. Vai gravada na reserva como fotografia — ver o schema. */
    rodada: string;
    disciplinas: DisciplinaComNota[];
  }): Promise<{ id: number; salaFaixaId: number }> {
    return this.prisma.$transaction(async (tx) => {
      await travarAluno(tx, dados.matricula);

      // O limite e por VINCULO **e por RODADA**: uma prova por curso em cada
      // prova do semestre. Sem a rodada na conta — como era antes dela — quem
      // agendou a N2 seria recusado ao tentar marcar a substitutiva, que e
      // exatamente a segunda prova que ele precisa fazer.
      const jaAgendado = await tx.agendamento.findFirst({
        where: {
          alunoId: dados.vinculoId,
          periodoLetivoId: dados.periodoLetivoId,
          rodada: dados.rodada,
          ...CONFIRMADO,
        },
        select: { id: true },
      });

      if (jaAgendado) {
        throw new ConflictException(
          `Voce ja tem prova marcada para o curso ${dados.curso} nesta prova ` +
            `(${dados.rodada}, agendamento ${jaAgendado.id}). Use a troca de ` +
            'horario para mudar.',
        );
      }

      // O limite acima e por VINCULO + RODADA ("uma prova por curso em cada
      // prova do semestre"); este e por PESSOA ("uma prova por horario"), e de
      // proposito NAO olha a rodada: quem fez a N2 as 08:30 nao faz a SUB as
      // 08:30 tambem. Um RA com dois cursos passa pelo primeiro e precisa parar
      // no segundo — inclusive quando os dois cursos sao de MODALIDADES
      // diferentes, e por isso aqui vao os ids da janela e nao o do vinculo.
      await exigirUmaProvaPorFaixa(tx, {
        matricula: dados.matricula,
        faixaId: dados.faixaId,
        periodoLetivoIds: dados.periodoLetivoIds,
      });

      const escolhida = await escolherOfertaComLock(
        tx,
        dados.faixaId,
        dados.modalidadeId,
      );

      const criado = await tx.agendamento.create({
        data: {
          alunoId: dados.vinculoId,
          salaFaixaId: escolhida.id,
          matricula: dados.matricula,
          userIdD2L: dados.userIdD2L,
          periodoLetivoId: dados.periodoLetivoId,
          // Qual prova do semestre e esta. Fotografia, como as duas abaixo: o
          // admin pode renomear a rodada da janela depois, e a reserva continua
          // dizendo em qual prova ela foi feita.
          rodada: dados.rodada,
          // Do vinculo, nao da oferta: sao iguais por construcao (a alocacao so
          // aceita oferta da modalidade do aluno, e o portal recusa faixa de
          // outro polo), mas o que a coluna documenta e o ALUNO na data da
          // reserva — a proxima importacao pode mudar os dois.
          modalidadeId: dados.modalidadeId,
          poloId: dados.poloId,
          disciplinas: {
            create: dados.disciplinas.map((d) => ({
              orgUnitId: d.orgUnitId,
              nomeDisciplina: d.nomeDisciplina,
              // A nota que decidiu a elegibilidade, quando a janela filtrou por
              // nota. Nula na N2, em que nenhuma foi consultada. Ver o schema.
              notaFinal: d.notaFinal,
            })),
          },
          // A fila de liberacao nasce junto, na MESMA transacao: um agendamento
          // gravado sem a sua fila seria uma prova marcada que nunca chega a ser
          // liberada, e ninguem descobriria ate o aluno tentar abrir o quiz.
          // A integracao com o D2L esta adiada; a fila fica esperando.
          syncs: {
            create: dados.disciplinas.map((d) => ({ orgUnitId: d.orgUnitId })),
          },
        },
        select: { id: true, salaFaixaId: true },
      });

      await registrarHistorico(tx, {
        agendamentoId: criado.id,
        evento: EventoAgendamento.CRIADO,
        autor: AUTOR_ALUNO(dados.matricula),
        para: await descreverOferta(tx, criado.salaFaixaId),
      });

      return criado;
    }, OPCOES_DA_TRANSACAO);
  }

  /**
   * A faixa serve para ESTE vinculo? Mesmas regras no agendar e no trocar — se
   * fossem duas listas, a troca viraria um caminho para burlar o que o
   * agendamento recusa.
   */
  private async exigirFaixaValida(
    faixaId: number,
    vinculo: { poloId: number; polo: { nome: string } },
    recusar?: (motivo: string, detalhe: string) => never,
  ) {
    const faixa = await this.prisma.faixa.findUnique({
      where: { id: faixaId },
      include: { polo: { select: { id: true, nome: true } } },
    });

    if (!faixa) {
      throw new NotFoundException(`Horario ${faixaId} nao encontrado`);
    }

    // O polo vem do CSV, nao da escolha do aluno: agendar em outro campus seria
    // viajar para fazer prova no lugar errado.
    if (faixa.poloId !== vinculo.poloId) {
      const motivo = `Este horario e do polo ${faixa.polo.nome}, e o seu curso e do polo ${vinculo.polo.nome}.`;

      if (recusar) {
        recusar(
          motivo,
          `faixa do polo ${faixa.poloId}, aluno do polo ${vinculo.poloId}`,
        );
      }

      throw new ForbiddenException(motivo);
    }

    if (!faixa.ativo) {
      throw new ConflictException(
        'Este horario nao esta mais disponivel. Escolha outro.',
      );
    }

    if (faixa.data < hojeUtc()) {
      throw new ConflictException('Este horario ja passou. Escolha outro.');
    }

    return faixa;
  }

  /**
   * O agendamento e mesmo deste aluno? Confere pelos vinculos do token, e nao
   * pela matricula sozinha — e a mesma porta que o `exigirVinculo` guarda.
   */
  private async exigirAgendamentoDoAluno(
    aluno: AlunoJwtPayload,
    agendamentoId: number,
  ) {
    const agendamento = await this.prisma.agendamento.findUnique({
      where: { id: agendamentoId },
      include: { salaFaixa: { select: { faixaId: true } } },
    });

    if (!agendamento) {
      throw new NotFoundException(
        `Agendamento ${agendamentoId} nao encontrado`,
      );
    }

    const ehDele =
      agendamento.matricula === aluno.sub &&
      aluno.vinculos.some((v) => v.alunoId === agendamento.alunoId);

    if (!ehDele) {
      this.auditoria.registrar('AGENDAMENTO_RECUSADO', {
        ator: aluno.sub,
        detalhe: `tentou mexer no agendamento ${agendamentoId}, que e de outra matricula`,
      });

      throw new ForbiddenException('Este agendamento nao e seu.');
    }

    if (agendamento.status !== StatusAgendamento.CONFIRMADO) {
      throw new ConflictException(
        'Este agendamento ja foi cancelado. Marque um horario novo.',
      );
    }

    // Semestre anterior nao se mexe. Sem esta trava, abrir o periodo novo daria
    // ao aluno a chance de cancelar uma prova que ele JA FEZ — apagando-a da
    // lista do relatorio como se nunca tivesse existido.
    //
    // A comparacao e "esta prova pertence a JANELA vigente?", e a rodada nao e
    // detalhe: aberta a janela da substitutiva, a prova da N2 do MESMO semestre
    // ja aconteceu e cai no mesmo caso — comparar so o semestre a deixaria
    // alteravel, que e o que esta trava existe para impedir.
    //
    // O periodo letivo entra como PERTENCIMENTO (`includes`), e nao como
    // igualdade: a mesma janela cobre a grade modular e a semestral, e a prova
    // do presencial esta gravada sob o org unit dele. Comparar com um id so
    // congelaria as provas de metade da universidade — elas passariam a
    // responder "prova anterior" e o aluno nao conseguiria mais trocar de
    // horario dentro do prazo.
    const janela = await this.periodo.janelaVigente();

    if (
      !janela ||
      !janela.periodoLetivoIds.includes(agendamento.periodoLetivoId) ||
      agendamento.rodada !== janela.rodada
    ) {
      throw new NotFoundException(
        'Este agendamento e de uma prova anterior e nao pode mais ser alterado.',
      );
    }

    return agendamento;
  }

  private async buscar(id: number): Promise<AgendamentoConfirmado> {
    const agendamento = await this.prisma.agendamento.findUnique({
      where: { id },
      include: INCLUDE_COMPLETO,
    });

    if (!agendamento) {
      throw new NotFoundException(`Agendamento ${id} nao encontrado`);
    }

    return montarConfirmado(agendamento);
  }

  /**
   * O portao de autorizacao de TODAS as rotas do portal.
   *
   * O token diz de quem sao os vinculos; o BANCO diz o que cada vinculo e. Nunca
   * o contrario: modalidade e polo vindos do token ficariam congelados no
   * momento do launch, e uma reimportacao do CSV entre o login e o agendamento
   * mandaria o aluno para a sala errada.
   */
  private async exigirVinculo(aluno: AlunoJwtPayload, alunoId?: number) {
    const escolhido = alunoId ?? this.vinculoUnico(aluno);

    // Sem isto, bastaria trocar o alunoId no corpo da requisicao para agendar no
    // lugar de outro aluno com um token legitimo.
    if (!aluno.vinculos.some((v) => v.alunoId === escolhido)) {
      this.auditoria.registrar('AGENDAMENTO_RECUSADO', {
        ator: aluno.sub,
        detalhe: `vinculo ${escolhido} nao pertence ao token`,
      });

      throw new ForbiddenException(
        'Este curso nao pertence a sua matricula. Entre pelo link de agendamento dentro da disciplina.',
      );
    }

    const vinculo = await this.prisma.alunoImportado.findUnique({
      where: { id: escolhido },
      include: { modalidade: true, polo: true },
    });

    if (!vinculo) {
      throw new NotFoundException(
        'Seu cadastro nao foi encontrado na base importada. Procure a secretaria academica.',
      );
    }

    // Defesa em profundidade: os ids sao estaveis (a importacao faz upsert por
    // [matricula, curso]), mas se uma linha fosse apagada e recriada, um token
    // ainda valido apontaria para o vinculo de OUTRA pessoa.
    if (vinculo.matricula !== aluno.sub) {
      this.auditoria.registrar('AGENDAMENTO_RECUSADO', {
        ator: aluno.sub,
        detalhe: `vinculo ${escolhido} pertence a outra matricula`,
      });

      throw new ForbiddenException(
        'Seu cadastro mudou desde que voce entrou. Abra o link de agendamento novamente.',
      );
    }

    return vinculo;
  }

  private vinculoUnico(aluno: AlunoJwtPayload): number {
    if (aluno.vinculos.length === 1) return aluno.vinculos[0].alunoId;

    throw new BadRequestException(
      'Voce tem mais de um curso. Informe `alunoId` para dizer de qual curso e esta prova ' +
        '(os vinculos vem na resposta do launch).',
    );
  }
}

const SEM_DISCIPLINA =
  'Nenhuma disciplina sua tem prova cadastrada neste periodo. ' +
  'Se voce tem prova, procure a secretaria academica.';

function motivoStatus(curso: string, statusCurso: string): string {
  return (
    `Sua situacao no curso ${curso} esta como "${statusCurso}", que nao permite ` +
    'agendar prova. Procure a secretaria academica.'
  );
}

const INCLUDE_COMPLETO = {
  aluno: { select: { curso: true } },
  disciplinas: { select: { orgUnitId: true, nomeDisciplina: true } },
  salaFaixa: {
    include: {
      modalidade: true,
      sala: { select: { id: true, nome: true } },
      faixa: {
        include: { polo: { select: { id: true, nome: true } } },
      },
    },
  },
} satisfies Prisma.AgendamentoInclude;

type AgendamentoCompleto = {
  id: number;
  alunoId: number;
  matricula: string;
  rodada: string;
  status: string;
  createdAt: Date;
  aluno: { curso: string };
  disciplinas: { orgUnitId: string; nomeDisciplina: string | null }[];
  salaFaixa: {
    modalidade: { codigo: string; nome: string; duracaoMinutos: number };
    sala: { id: number; nome: string };
    faixa: {
      data: Date;
      horaInicio: string;
      horaFim: string;
      polo: { id: number; nome: string };
    };
  };
};

function montarConfirmado(
  agendamento: AgendamentoCompleto,
): AgendamentoConfirmado {
  const { salaFaixa } = agendamento;

  return {
    id: agendamento.id,
    alunoId: agendamento.alunoId,
    matricula: agendamento.matricula,
    curso: agendamento.aluno.curso,
    rodada: agendamento.rodada,
    status: agendamento.status,
    data: salaFaixa.faixa.data,
    horaInicio: salaFaixa.faixa.horaInicio,
    horaFim: salaFaixa.faixa.horaFim,
    polo: salaFaixa.faixa.polo,
    sala: salaFaixa.sala,
    modalidade: {
      codigo: salaFaixa.modalidade.codigo,
      nome: salaFaixa.modalidade.nome,
      duracaoMinutos: salaFaixa.modalidade.duracaoMinutos,
    },
    disciplinas: agendamento.disciplinas,
    criadoEm: agendamento.createdAt,
  };
}
