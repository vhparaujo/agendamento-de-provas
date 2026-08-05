import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import {
  candidatasDe,
  escolherTurma,
  normalizarCodigo,
  TurmaCandidata,
  TurmaDoLaunch,
} from './turma-match';

export interface DisciplinaAgendavel {
  /** Identificador no D2L, vindo do launch ou dos enrollments. Gravado no agendamento. */
  orgUnitId: string;
  nomeDisciplina: string | null;
  /**
   * Curso dono da disciplina, como esta no CSV de turmas. E o que permite dizer
   * de qual VINCULO e cada disciplina quando o aluno tem mais de um curso — ver
   * `DisciplinasDoAlunoService`. `null` quando o CSV nao trouxe a coluna.
   */
  curso: string | null;
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
   * QUAIS DESTAS TURMAS TEM PROVA?
   * ==========================================================================
   * O cruzamento da especificacao (secao 3.3): a disciplina do aluno so e
   * agendavel se estiver no CSV de turmas reais.
   *
   * Recebe uma LISTA porque ha duas fontes possiveis, e as duas usam este mesmo
   * cruzamento: a turma de onde o aluno clicou (claim `context` do LTI, lista de
   * um) ou todas as ofertas dele no periodo letivo (enrollments da Valence).
   * Quem escolhe a fonte e o `DisciplinasDoAlunoService`.
   *
   * A busca e por **codigo + nome**, nao por orgUnitId, porque o CSV nao traz
   * orgUnitId — e porque o codigo sozinho nao identifica a turma: ele se repete
   * entre ofertas. O codigo filtra; o nome decide. Regra em `turma-match.ts`.
   *
   * Cada turma e decidida SOZINHA: uma inconclusiva nao derruba as outras. Mas
   * quando o resultado nao e conclusivo (nome divergente, empate), aquela turma
   * **nao e liberada** e o motivo vai para o log. Chutar aqui significaria
   * marcar prova para a disciplina errada.
   */
  async filtrarAgendaveis(
    contextos: TurmaDoLaunch[] | undefined,
  ): Promise<ResultadoDoCruzamento> {
    const turmas = (contextos ?? []).filter((c) => c?.orgUnitId);

    if (turmas.length === 0) {
      // Este texto vai para a TELA do aluno (o portal usa `motivo` como
      // mensagem), entao ele diz o que fazer em vez de nomear o claim que
      // faltou. O detalhe tecnico fica no log de quem investiga.
      return {
        agendaveis: [],
        motivo:
          'Nao foi possivel identificar a disciplina de onde voce entrou. ' +
          'Abra o link de agendamento de dentro da disciplina no Brightspace.',
      };
    }

    // Filtro desligado: qualquer turma serve. So use conscientemente.
    if (!this.filtroAtivo()) {
      return {
        agendaveis: turmas.map((turma) => ({
          orgUnitId: turma.orgUnitId!,
          nomeDisciplina: turma.titulo ?? null,
          curso: null,
        })),
      };
    }

    const candidatas = await this.candidatas(turmas);

    const agendaveis: DisciplinaAgendavel[] = [];
    const recusas: string[] = [];

    for (const turma of turmas) {
      const escolha = escolherTurma(turma, candidatasDe(turma, candidatas));

      if (escolha.situacao !== 'ENCONTRADA') {
        // Nao e erro do aluno: e planilha desatualizada, grafia diferente ou
        // turma repetida. Quem resolve e a secretaria, entao o motivo precisa
        // aparecer em algum lugar consultavel.
        this.logger.warn(
          `Turma nao liberada (${escolha.situacao}) para codigo="${turma.codigo ?? ''}" ` +
            `nome="${turma.titulo ?? ''}" orgUnitId=${turma.orgUnitId}: ${escolha.motivo}`,
        );

        recusas.push(escolha.motivo);
        continue;
      }

      await this.aprenderOrgUnitId(escolha.turma, turma.orgUnitId!);

      agendaveis.push({
        orgUnitId: turma.orgUnitId!,
        // O nome do CSV manda: e o que a secretaria reconhece no relatorio.
        nomeDisciplina: escolha.turma.nomeDisciplina,
        curso: escolha.turma.curso,
      });
    }

    // O motivo so importa quando NADA passou: com uma disciplina liberada o
    // aluno agenda, e explicar as outras seria ruido na tela dele (o log tem).
    return agendaveis.length > 0
      ? { agendaveis }
      : { agendaveis, motivo: [...new Set(recusas)].join(' ') };
  }

  /**
   * Todas as candidatas das turmas pedidas, numa consulta so.
   *
   * Busca pelos codigos; para as turmas que vieram sem codigo, tenta pelo
   * orgUnitId — que so acha algo depois de a turma ter sido aprendida ou
   * resolvida pela API.
   */
  private async candidatas(turmas: TurmaDoLaunch[]): Promise<TurmaCandidata[]> {
    const codigos = [
      ...new Set(
        turmas.map((t) => normalizarCodigo(t.codigo)).filter((c) => c !== ''),
      ),
    ];

    const semCodigo = [
      ...new Set(
        turmas
          .filter((t) => !normalizarCodigo(t.codigo))
          .map((t) => t.orgUnitId!),
      ),
    ];

    const filtros: Prisma.TurmaImportadaWhereInput[] = [];

    if (codigos.length > 0) filtros.push({ codigoTurma: { in: codigos } });
    if (semCodigo.length > 0) filtros.push({ orgUnitId: { in: semCodigo } });

    return this.prisma.turmaImportada.findMany({
      where: filtros.length === 1 ? filtros[0] : { OR: filtros },
      select: {
        id: true,
        codigoTurma: true,
        nomeDisciplina: true,
        codigoEad: true,
        orgUnitId: true,
        curso: true,
      },
    });
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
