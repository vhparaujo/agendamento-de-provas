import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import { duracaoEmMinutos } from '../../components/horario.util';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import type { DisciplinaAgendavel } from '../../turma/service/turma.service';
import { escolherOferta, totalDisponivel } from './alocacao';
import { DisciplinasDoAlunoService } from './disciplinas-do-aluno.service';

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
}

export interface AgendamentoConfirmado {
  id: number;
  alunoId: number;
  matricula: string;
  curso: string;
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
   * apareceria, sem explicacao.
   */
  async listarFaixas(
    aluno: AlunoJwtPayload,
    alunoId?: number,
  ): Promise<FaixaDisponivel[]> {
    const vinculo = await this.exigirVinculo(aluno, alunoId);

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
      };
    });
  }

  /** As disciplinas que a prova vai cobrir — o aluno confere antes de confirmar. */
  async disciplinas(
    aluno: AlunoJwtPayload,
    alunoId?: number,
  ): Promise<DisciplinasDoVinculo> {
    const vinculo = await this.exigirVinculo(aluno, alunoId);
    const disciplinas = await this.disciplinasDoAluno.agendaveis(aluno);

    return {
      alunoId: vinculo.id,
      curso: vinculo.curso,
      disciplinas,
      podeAgendar: vinculo.ativo && disciplinas.length > 0,
      motivo: !vinculo.ativo
        ? motivoStatus(vinculo.curso, vinculo.statusCurso)
        : disciplinas.length === 0
          ? SEM_DISCIPLINA
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

    const periodo = await this.periodo.exigirAberto();

    const disciplinas = await this.disciplinasDoAluno.agendaveis(aluno);

    if (disciplinas.length === 0) {
      recusar(SEM_DISCIPLINA, 'nenhuma disciplina agendavel');
    }

    const faixa = await this.prisma.faixa.findUnique({
      where: { id: dados.faixaId },
      include: { polo: { select: { id: true, nome: true } } },
    });

    if (!faixa) {
      throw new NotFoundException(`Horario ${dados.faixaId} nao encontrado`);
    }

    // O polo vem do CSV, nao da escolha do aluno: agendar em outro campus seria
    // viajar para fazer prova no lugar errado.
    if (faixa.poloId !== vinculo.poloId) {
      recusar(
        `Este horario e do polo ${faixa.polo.nome}, e o seu curso e do polo ${vinculo.polo.nome}.`,
        `faixa do polo ${faixa.poloId}, aluno do polo ${vinculo.poloId}`,
      );
    }

    if (!faixa.ativo) {
      throw new ConflictException(
        'Este horario nao esta mais disponivel. Escolha outro.',
      );
    }

    if (faixa.data < hojeUtc()) {
      throw new ConflictException('Este horario ja passou. Escolha outro.');
    }

    const criado = await this.alocar({
      vinculoId: vinculo.id,
      matricula: vinculo.matricula,
      curso: vinculo.curso,
      modalidadeId: vinculo.modalidadeId,
      faixaId: faixa.id,
      userIdD2L: aluno.userIdD2L,
      periodoLetivoId: periodo.periodoLetivoId,
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

  /** Tudo que este RA ja marcou — os dois cursos, quando houver dois. */
  async meusAgendamentos(
    aluno: AlunoJwtPayload,
  ): Promise<AgendamentoConfirmado[]> {
    const agendamentos = await this.prisma.agendamento.findMany({
      where: {
        matricula: aluno.sub,
        alunoId: { in: aluno.vinculos.map((v) => v.alunoId) },
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
    faixaId: number;
    userIdD2L: string;
    periodoLetivoId: string;
    disciplinas: DisciplinaAgendavel[];
  }): Promise<{ id: number; salaFaixaId: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM aluno_importado WHERE id = ${dados.vinculoId} FOR UPDATE`;

        const jaAgendado = await tx.agendamento.findFirst({
          where: {
            alunoId: dados.vinculoId,
            periodoLetivoId: dados.periodoLetivoId,
            ...CONFIRMADO,
          },
          select: { id: true },
        });

        if (jaAgendado) {
          throw new ConflictException(
            `Voce ja tem prova marcada para o curso ${dados.curso} ` +
              `(agendamento ${jaAgendado.id}). Para trocar de horario, procure a secretaria academica.`,
          );
        }

        const travadas = await tx.$queryRaw<
          { id: number; ordem: number; vagas: number }[]
        >`
          SELECT id, ordem, vagas
            FROM sala_faixa
           WHERE faixaId = ${dados.faixaId}
             AND modalidadeId = ${dados.modalidadeId}
           ORDER BY ordem ASC
           FOR UPDATE`;

        if (travadas.length === 0) {
          throw new ConflictException(
            'Este horario nao atende a modalidade do seu curso.',
          );
        }

        const ocupacao = await tx.agendamento.groupBy({
          by: ['salaFaixaId'],
          where: {
            salaFaixaId: { in: travadas.map((o) => Number(o.id)) },
            ...CONFIRMADO,
          },
          _count: { _all: true },
        });

        const ocupadasPor = new Map(
          ocupacao.map((o) => [o.salaFaixaId, o._count._all]),
        );

        const escolhida = escolherOferta(
          travadas.map((o) => ({
            id: Number(o.id),
            ordem: Number(o.ordem),
            vagas: Number(o.vagas),
            ocupadas: ocupadasPor.get(Number(o.id)) ?? 0,
          })),
        );

        if (!escolhida) {
          throw new ConflictException(
            'As vagas deste horario acabaram de se esgotar. Escolha outro horario.',
          );
        }

        return tx.agendamento.create({
          data: {
            alunoId: dados.vinculoId,
            salaFaixaId: escolhida.id,
            matricula: dados.matricula,
            userIdD2L: dados.userIdD2L,
            periodoLetivoId: dados.periodoLetivoId,
            disciplinas: {
              create: dados.disciplinas.map((d) => ({
                orgUnitId: d.orgUnitId,
                nomeDisciplina: d.nomeDisciplina,
              })),
            },
            // A fila do special access nasce junto, na MESMA transacao: um
            // agendamento gravado sem a sua fila seria uma prova marcada que
            // nunca chega a ser liberada no Brightspace, e ninguem descobriria
            // ate o aluno tentar abrir o quiz. O consumidor e da etapa 7.
            syncs: {
              create: dados.disciplinas.map((d) => ({
                orgUnitId: d.orgUnitId,
              })),
            },
          },
          select: { id: true, salaFaixaId: true },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 15_000,
        maxWait: 10_000,
      },
    );
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

/** Cancelado nao ocupa vaga. Usado em toda contagem, para nao contar fantasma. */
const CONFIRMADO = { status: StatusAgendamento.CONFIRMADO } as const;

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

/**
 * Meia-noite de hoje em UTC. A coluna `data` da faixa e @db.Date (sem hora), e e
 * gravada em meia-noite UTC — comparar com um Date do fuso local descartaria o
 * dia de hoje em qualquer fuso a oeste de Greenwich.
 */
function hojeUtc(): Date {
  const agora = new Date();

  return new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()),
  );
}
