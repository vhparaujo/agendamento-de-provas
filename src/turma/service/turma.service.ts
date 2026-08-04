import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import {
  escolherTurma,
  normalizarCodigo,
  TurmaCandidata,
  TurmaDoLaunch,
} from './turma-match';

export interface DisciplinaAgendavel {
  /** Identificador no D2L, vindo do launch. Gravado no agendamento. */
  orgUnitId: string;
  nomeDisciplina: string | null;
}

export interface ResultadoDoCruzamento {
  agendaveis: DisciplinaAgendavel[];
  /** Por que nao passou. Ausente quando encontrou. */
  motivo?: string;
}

@Injectable()
export class TurmaService {
  private readonly logger = new Logger(TurmaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * ==========================================================================
   * A TURMA DE ONDE O ALUNO CLICOU TEM PROVA?
   * ==========================================================================
   * O cruzamento da especificacao (secao 3.3): a disciplina do aluno so e
   * agendavel se estiver no CSV de turmas reais.
   *
   * A busca e por **codigo + nome**, nao por orgUnitId, porque o CSV nao traz
   * orgUnitId — e porque o codigo sozinho nao identifica a turma: ele se repete
   * entre ofertas. O codigo filtra; o nome decide. Regra em `turma-match.ts`.
   *
   * Quando o resultado nao e conclusivo (nome divergente, empate), **nada e
   * liberado** e o motivo vai para o log. Chutar aqui significaria marcar prova
   * para a disciplina errada.
   */
  async filtrarAgendaveis(
    contexto: TurmaDoLaunch | undefined,
  ): Promise<ResultadoDoCruzamento> {
    if (!contexto?.orgUnitId) {
      return {
        agendaveis: [],
        motivo: 'O launch nao identificou a turma de origem.',
      };
    }

    // Filtro desligado: qualquer turma serve. So use conscientemente.
    if (!this.filtroAtivo()) {
      return {
        agendaveis: [
          {
            orgUnitId: contexto.orgUnitId,
            nomeDisciplina: contexto.titulo ?? null,
          },
        ],
      };
    }

    const candidatas = await this.candidatas(contexto);
    const escolha = escolherTurma(contexto, candidatas);

    if (escolha.situacao !== 'ENCONTRADA') {
      // Nao e erro do aluno: e planilha desatualizada, grafia diferente ou
      // turma repetida. Quem resolve e a secretaria, entao o motivo precisa
      // aparecer em algum lugar consultavel.
      this.logger.warn(
        `Turma nao liberada (${escolha.situacao}) para codigo="${contexto.codigo ?? ''}" ` +
          `nome="${contexto.titulo ?? ''}" orgUnitId=${contexto.orgUnitId}: ${escolha.motivo}`,
      );

      return { agendaveis: [], motivo: escolha.motivo };
    }

    await this.aprenderOrgUnitId(escolha.turma, contexto.orgUnitId);

    return {
      agendaveis: [
        {
          orgUnitId: contexto.orgUnitId,
          // O nome do CSV manda: e o que a secretaria reconhece no relatorio.
          nomeDisciplina: escolha.turma.nomeDisciplina,
        },
      ],
    };
  }

  /**
   * Busca pelo codigo. Se o launch nao trouxe codigo, tenta pelo orgUnitId — que
   * so acha algo depois de a turma ter sido aprendida ou resolvida pela API.
   */
  private async candidatas(contexto: TurmaDoLaunch): Promise<TurmaCandidata[]> {
    const codigo = normalizarCodigo(contexto.codigo);

    const turmas = await this.prisma.turmaImportada.findMany({
      where: codigo
        ? { codigoTurma: codigo }
        : { orgUnitId: contexto.orgUnitId ?? undefined },
      select: {
        id: true,
        codigoTurma: true,
        nomeDisciplina: true,
        codigoEad: true,
        orgUnitId: true,
      },
    });

    return turmas;
  }

  /**
   * Grava o orgUnitId aprendido no launch, quando a turma ainda nao o tinha.
   *
   * O CSV nunca traz esse id, e descobri-lo pela API e trabalho da integracao
   * adiada. Mas todo aluno que entra por uma turma nos ENTREGA o id dela de
   * graca. Ao longo do periodo de agendamento a tabela se completa sozinha, e a
   * integracao chega com o trabalho quase pronto.
   *
   * Nunca sobrescreve: um id ja gravado foi confirmado antes.
   */
  private async aprenderOrgUnitId(
    turma: TurmaCandidata,
    orgUnitId: string,
  ): Promise<void> {
    if (turma.orgUnitId) return;

    try {
      await this.prisma.turmaImportada.update({
        where: { id: turma.id },
        data: { orgUnitId },
      });
    } catch {
      // Corrida entre dois launches, ou o id ja pertence a outra linha. Nao e
      // motivo para derrubar o agendamento: o cruzamento ja foi decidido.
      this.logger.debug(
        `Nao foi possivel gravar orgUnitId=${orgUnitId} na turma ${turma.id}`,
      );
    }
  }

  /**
   * O filtro de turmas esta valendo?
   *
   * `TURMAS_FILTER_ENABLED=true` (DEFAULT SEGURO): so e agendavel o que estiver
   * na tabela de turmas. Com a tabela vazia, NADA e agendavel — de proposito: e
   * melhor ninguem agendar do que liberar prova para a disciplina errada.
   *
   * `false`: o filtro nao restringe nada. So use conscientemente.
   */
  filtroAtivo(): boolean {
    return this.config.get<string>('TURMAS_FILTER_ENABLED') !== 'false';
  }

  /** Quantas turmas existem — usado para avisar que a tabela esta vazia. */
  async total(): Promise<number> {
    return this.prisma.turmaImportada.count();
  }
}
