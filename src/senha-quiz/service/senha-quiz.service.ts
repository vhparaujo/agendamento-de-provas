import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { montarCsv } from '../../agendamento/service/csv-relatorio';
import { PrismaService } from '../../database/prisma.service';
import {
  D2lQuizzesService,
  QuizDaLista,
} from '../../d2l/service/d2l-quizzes.service';
import {
  OrigemExecucao,
  ResultadoSenhaQuiz,
  StatusExecucao,
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { carregarRitmo, RitmoDoLote } from '../config/senha-quiz.config';
import { GradeSenhasService } from './grade-senhas.service';
import { casarPorNome, montarCorpoDoQuiz, QuizLido } from './quiz-body';
import { dataUtcDeIso, isoDeDataUtc } from './relogio';
import {
  ResolucaoOrgUnitService,
  ResultadoResolucao,
  TurmaResolvida,
} from './resolucao-orgunit.service';
import { rotuloDoTurno } from './turno';

/**
 * ============================================================================
 * O LOTE QUE TROCA A SENHA DAS PROVAS
 * ============================================================================
 * Uma execucao = UMA celula da grade (dia + turno). Aplica a senha daquela
 * celula em TODAS as turmas do CSV que pertencem ao periodo letivo vigente.
 *
 * **Sobrescrever a senha de um turno anterior e a FUNCIONALIDADE, nao um
 * conflito.** A senha vale um turno; trocar a cada turno e o que impede o aluno
 * da manha de repassar a dele para o da tarde. Nao invente deduplicacao aqui.
 *
 * **Aqui nunca preservamos e nunca removemos senha — sempre DEFINIMOS.** O CLI
 * de origem tinha tres acoes porque o config podia omitir a chave; aqui a celula
 * ou tem senha digitada, ou nao ha o que aplicar. Isso apaga toda a familia
 * `resolvePassword` e muda a natureza do gotcha da "senha invisivel" — ver
 * `comSenhaLida` no schema.
 *
 * A postura de seguranca da senha esta no cabecalho de `grade-senhas.service.ts`
 * e vale integralmente aqui: **nenhuma tabela deste lote guarda o valor**, e ele
 * nao entra em log, auditoria nem CSV.
 */

/** Silencio maior que isto significa lote MORTO — criterio do compulsorio. */
const SILENCIO_ATE_MORRER_MS = 5 * 60_000;

interface ItemParaGravar {
  orgUnitId: string | null;
  codigoTurma: string | null;
  nomeDisciplina: string | null;
  quizId: string | null;
  nomeQuiz: string | null;
  resultado: ResultadoSenhaQuiz;
  senhaAnteriorLida: boolean;
  detalhe: string | null;
}

export interface ExecucaoIniciada {
  id: number;
  simulacao: boolean;
  turmasNoCsv: number;
  totalTurmas: number;
  naoResolvidas: number;
}

@Injectable()
export class SenhaQuizService {
  private readonly logger = new Logger(SenhaQuizService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quizzes: D2lQuizzesService,
    private readonly resolucao: ResolucaoOrgUnitService,
    private readonly grade: GradeSenhasService,
    private readonly periodo: PeriodoService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Dispara o lote e volta na hora com o id — quem acompanha e o `consultar`.
   *
   * A resolucao das turmas acontece AQUI, antes de criar a execucao, e nao
   * dentro do `executar`: ela e barata (uma chamada, cacheada 10 min) e e o
   * unico jeito de a resposta ja dizer QUANTAS turmas serao tocadas. Tambem
   * antecipa a falha de integracao para o clique do admin, em vez de produzir
   * uma execucao FALHOU que ele so descobre no polling.
   */
  async iniciar(
    opcoes: {
      data: string;
      turno: Turno;
      simulacao: boolean;
      forcar: boolean;
    },
    iniciadoPor: string,
    origem: OrigemExecucao = OrigemExecucao.MANUAL,
  ): Promise<ExecucaoIniciada> {
    if (!this.quizzes.habilitado()) {
      // Sem a Valence nao ha como resolver o orgUnitId das turmas do CSV nem
      // falar com os quizzes — o lote rodaria em zero turma relatando sucesso.
      throw new BadRequestException(
        'A troca de senhas depende da integracao com o Brightspace ' +
          '(D2L_HABILITADO). Sem ela nao ha como descobrir o orgUnitId das ' +
          'turmas do CSV nem gravar no questionario.',
      );
    }

    const periodoLetivoId = await this.periodo.periodoLetivoVigente();

    if (!periodoLetivoId) {
      throw new BadRequestException(
        'Nenhum periodo letivo cadastrado. Sem ele nao ha como separar as ' +
          'turmas deste semestre das dos semestres passados.',
      );
    }

    const configurado = await this.grade.lerAlvo();

    // Nao ha mais semente no .env para o alvo (19/08/2026): quem escolhe o
    // questionario e o admin, na tela. Recusar aqui e o ponto: com um default
    // plausivel, o lote rodaria com o nome errado, casaria com o que estivesse
    // por perto e ninguem descobriria ate o dia da prova.
    if (!configurado.nomeQuiz) {
      throw new BadRequestException(
        'Nenhum questionario-alvo configurado. Informe o nome da prova em ' +
          'Senhas de prova > Questionario antes de aplicar.',
      );
    }

    const alvo = {
      nomeQuiz: configurado.nomeQuiz,
      matchQuiz: configurado.matchQuiz,
    };

    const celula = await this.prisma.senhaDeProva.findUnique({
      where: {
        data_turno: { data: dataUtcDeIso(opcoes.data), turno: opcoes.turno },
      },
    });

    if (!celula) {
      throw new BadRequestException(
        `Nao ha senha cadastrada para ${opcoes.data} (${rotuloDoTurno(opcoes.turno)}). ` +
          'Preencha a celula na grade antes de aplicar.',
      );
    }

    await this.recusarSeJaRodando();

    if (!opcoes.simulacao && !opcoes.forcar) {
      await this.recusarSeJaAplicada(celula.id, celula.versao);
    }

    const resolvidas = await this.resolucao.resolver(periodoLetivoId);

    const execucao = await this.prisma.execucaoSenhaQuiz.create({
      data: {
        simulacao: opcoes.simulacao,
        origem,
        iniciadoPor,
        senhaDeProvaId: celula.id,
        data: celula.data,
        turno: celula.turno,
        periodoLetivoId,
        versaoAplicada: celula.versao,
        nomeQuizAlvo: alvo.nomeQuiz,
        matchQuizAlvo: alvo.matchQuiz,
        turmasNoCsv: resolvidas.totalNoCsv,
        turmasResolvidas: resolvidas.resolvidas.length,
        orgUnitsAprendidos: resolvidas.aprendidos,
      },
      select: { id: true },
    });

    this.auditoria.registrar('SENHA_QUIZ_INICIADA', {
      ator: iniciadoPor,
      // Sem a senha, por definicao — so a celula e o tamanho do trabalho.
      detalhe:
        `execucao ${execucao.id}; celula ${opcoes.data} ${rotuloDoTurno(opcoes.turno)}; ` +
        `${opcoes.simulacao ? 'SIMULACAO' : 'APLICANDO'}; origem ${origem}; ` +
        `${resolvidas.resolvidas.length} de ${resolvidas.totalNoCsv} turma(s) do CSV; ` +
        `alvo "${alvo.nomeQuiz}" (${alvo.matchQuiz})`,
    });

    // Fire-and-forget: o lote leva minutos e nenhum navegador segura a conexao.
    // O `catch` dentro de `executar` e o que garante que uma falha vire FALHOU
    // na tabela, em vez de um unhandled rejection derrubando o processo.
    void this.executar(
      execucao.id,
      resolvidas,
      celula.senha,
      alvo,
      opcoes.simulacao,
      iniciadoPor,
    );

    return {
      id: execucao.id,
      simulacao: opcoes.simulacao,
      turmasNoCsv: resolvidas.totalNoCsv,
      totalTurmas: resolvidas.resolvidas.length,
      naoResolvidas: resolvidas.naoResolvidas.length,
    };
  }

  /** O andamento, para a tela perguntar de tempos em tempos. */
  async consultar(id: number) {
    const execucao = await this.prisma.execucaoSenhaQuiz.findUnique({
      where: { id },
    });

    if (!execucao)
      throw new NotFoundException(`Execucao ${id} nao encontrada.`);

    const porResultado = await this.prisma.itemSenhaQuiz.groupBy({
      by: ['resultado'],
      where: { execucaoId: id },
      _count: { _all: true },
    });

    const totalItens = porResultado.reduce((s, l) => s + l._count._all, 0);

    return {
      ...execucao,
      data: isoDeDataUtc(execucao.data),
      interrompida: this.pareceMorta(execucao),
      /**
       * O GET nao devolveu senha em NENHUM quiz. E diagnostico, nao alarme: este
       * lote sempre DEFINE, entao nao ha risco de apagar senha em silencio (que
       * era o perigo real no CLI de origem). Serve para descobrir que a API
       * esconde o campo antes de alguem confiar na coluna "senha antes".
       */
      avisoSenhaInvisivel: totalItens > 0 && execucao.comSenhaLida === 0,
      itens: Object.fromEntries(
        porResultado.map((linha) => [linha.resultado, linha._count._all]),
      ),
    };
  }

  /**
   * O CSV do que aconteceu, no formato do Excel pt-BR (`;` + BOM).
   *
   * **Nenhuma coluna de senha**, nem a antiga nem a nova: o relatorio circula
   * por e-mail e fica no disco de quem baixou. `Tinha senha antes` responde a
   * unica pergunta util sem revelar nada.
   */
  async relatorioCsv(id: number): Promise<string> {
    const execucao = await this.prisma.execucaoSenhaQuiz.findUnique({
      where: { id },
    });

    if (!execucao)
      throw new NotFoundException(`Execucao ${id} nao encontrada.`);

    const itens = await this.prisma.itemSenhaQuiz.findMany({
      where: { execucaoId: id },
      orderBy: [{ resultado: 'asc' }, { codigoTurma: 'asc' }],
    });

    return montarCsv(
      [
        'Resultado',
        'Codigo da turma',
        'Disciplina',
        'OrgUnitId',
        'Questionario',
        'QuizId',
        'Tinha senha antes',
        'Observacao',
      ],
      itens.map((i) => [
        i.resultado,
        i.codigoTurma,
        i.nomeDisciplina,
        i.orgUnitId,
        i.nomeQuiz,
        i.quizId,
        i.senhaAnteriorLida ? 'Sim' : 'Nao',
        i.detalhe,
      ]),
    );
  }

  nomeDoArquivo(execucao: { id: number; data: Date; turno: Turno }): string {
    return `senhas-${isoDeDataUtc(execucao.data)}-${rotuloDoTurno(execucao.turno)}-execucao-${execucao.id}.csv`;
  }

  async dadosDaExecucao(id: number) {
    const execucao = await this.prisma.execucaoSenhaQuiz.findUnique({
      where: { id },
      select: { id: true, data: true, turno: true },
    });

    if (!execucao)
      throw new NotFoundException(`Execucao ${id} nao encontrada.`);
    return execucao;
  }

  // ------------------------------------------------------------------ interno

  /**
   * Uma execucao por vez. Enterra a que morreu com o processo, para um restart
   * nao bloquear todo lote seguinte com "ja existe um em andamento".
   */
  private async recusarSeJaRodando(): Promise<void> {
    const emAndamento = await this.prisma.execucaoSenhaQuiz.findFirst({
      where: { status: StatusExecucao.EM_ANDAMENTO },
      orderBy: { iniciadoEm: 'desc' },
    });

    if (!emAndamento) return;

    if (this.pareceMorta(emAndamento)) {
      await this.prisma.execucaoSenhaQuiz.update({
        where: { id: emAndamento.id },
        data: {
          status: StatusExecucao.FALHOU,
          erro: 'Execucao interrompida: o processo parou de dar sinal de vida.',
          concluidoEm: new Date(),
        },
      });
      return;
    }

    throw new ConflictException(
      `A execucao ${emAndamento.id} ainda esta rodando ` +
        `(${emAndamento.processadas} de ${emAndamento.turmasResolvidas} turmas). ` +
        'Espere terminar antes de comecar outra.',
    );
  }

  /**
   * Impede repetir sem querer uma celula ja aplicada. E guarda contra CARGA e
   * CONFUSAO, nao contra corrupcao: o PUT e idempotente, entao aplicar duas
   * vezes produz o mesmo estado. Por isso `forcar` existe e e barato.
   */
  private async recusarSeJaAplicada(
    senhaDeProvaId: number,
    versao: number,
  ): Promise<void> {
    const ja = await this.prisma.execucaoSenhaQuiz.findFirst({
      where: {
        senhaDeProvaId,
        simulacao: false,
        status: StatusExecucao.CONCLUIDA,
        versaoAplicada: versao,
      },
      orderBy: { concluidoEm: 'desc' },
    });

    if (!ja) return;

    throw new ConflictException(
      `Esta senha ja foi aplicada pela execucao ${ja.id}. ` +
        'Se quiser aplicar de novo, use a opcao de forcar.',
    );
  }

  private pareceMorta(execucao: {
    status: StatusExecucao;
    atualizadoEm: Date;
  }): boolean {
    return (
      execucao.status === StatusExecucao.EM_ANDAMENTO &&
      Date.now() - execucao.atualizadoEm.getTime() > SILENCIO_ATE_MORRER_MS
    );
  }

  /** O trabalho de verdade. NUNCA lanca: toda falha vira estado na tabela. */
  private async executar(
    execucaoId: number,
    resolucao: ResultadoResolucao,
    senha: string,
    alvo: { nomeQuiz: string; matchQuiz: TipoMatchQuiz },
    simulacao: boolean,
    iniciadoPor: string,
  ): Promise<void> {
    const ritmo = carregarRitmo(this.config);

    try {
      // As turmas que nem chegam a ter chamada: entram como item para o
      // relatorio explicar por que ficaram de fora.
      await this.gravarItens(
        execucaoId,
        resolucao.naoResolvidas.map((t) => ({
          orgUnitId: null,
          codigoTurma: t.codigoTurma,
          nomeDisciplina: t.nomeDisciplina,
          quizId: null,
          nomeQuiz: null,
          resultado: t.ambigua
            ? ResultadoSenhaQuiz.ORGUNIT_AMBIGUO
            : ResultadoSenhaQuiz.ORGUNIT_NAO_RESOLVIDO,
          senhaAnteriorLida: false,
          detalhe: t.motivo,
        })),
      );

      const contagem = {
        processadas: 0,
        definidas: 0,
        naoEncontradas: 0,
        falhas: 0,
        comSenhaLida: 0,
      };

      const turmas = resolucao.resolvidas;

      // Fatias de `concorrencia` turmas. Dentro da turma e sequencial: sao ~3
      // chamadas encadeadas (listar -> ler -> gravar) e paraleliza-las nao
      // ganharia nada alem de bater mais forte no mesmo tenant.
      for (let i = 0; i < turmas.length; i += ritmo.concorrencia) {
        const fatia = turmas.slice(i, i + ritmo.concorrencia);

        const resultados = await Promise.all(
          fatia.map((turma) =>
            this.aplicarNaTurma(turma, senha, alvo, simulacao, ritmo),
          ),
        );

        const itens = resultados.flat();
        await this.gravarItens(execucaoId, itens);

        for (const item of itens) {
          if (item.senhaAnteriorLida) contagem.comSenhaLida += 1;

          switch (item.resultado) {
            case ResultadoSenhaQuiz.DEFINIDA:
            case ResultadoSenhaQuiz.SIMULADA:
              contagem.definidas += 1;
              break;
            case ResultadoSenhaQuiz.QUIZ_NAO_ENCONTRADO:
              contagem.naoEncontradas += 1;
              break;
            default:
              contagem.falhas += 1;
          }
        }

        contagem.processadas += fatia.length;

        // Batido a cada fatia: e o sinal de vida que distingue lote lento de
        // lote morto, e o que alimenta a barra de progresso da tela.
        await this.prisma.execucaoSenhaQuiz.update({
          where: { id: execucaoId },
          data: { ...contagem },
        });
      }

      await this.prisma.execucaoSenhaQuiz.update({
        where: { id: execucaoId },
        data: { status: StatusExecucao.CONCLUIDA, concluidoEm: new Date() },
      });

      this.auditoria.registrar('SENHA_QUIZ_CONCLUIDA', {
        ator: iniciadoPor,
        detalhe:
          `execucao ${execucaoId}: ${contagem.definidas} questionario(s) ` +
          `${simulacao ? 'simulado(s)' : 'atualizado(s)'}, ` +
          `${contagem.naoEncontradas} sem questionario, ${contagem.falhas} falha(s), ` +
          `${resolucao.naoResolvidas.length} turma(s) nao resolvida(s)`,
      });
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);

      await this.prisma.execucaoSenhaQuiz
        .update({
          where: { id: execucaoId },
          data: {
            status: StatusExecucao.FALHOU,
            erro: motivo,
            concluidoEm: new Date(),
          },
        })
        .catch(() => undefined);

      this.auditoria.registrar('SENHA_QUIZ_FALHOU', {
        ator: iniciadoPor,
        detalhe: `execucao ${execucaoId}: ${motivo}`,
      });

      this.logger.error(`Execucao ${execucaoId} falhou: ${motivo}`);
    }
  }

  /**
   * Uma turma: lista os quizzes, casa por nome, le e (talvez) grava.
   *
   * **NUNCA lanca.** Falha de uma turma vira linha de item — se subisse, levaria
   * junto as outras da fatia inteira no `Promise.all`. Mesma decisao do
   * `resolverUm` no compulsorio.
   */
  private async aplicarNaTurma(
    turma: TurmaResolvida,
    senha: string,
    alvo: { nomeQuiz: string; matchQuiz: TipoMatchQuiz },
    simulacao: boolean,
    ritmo: RitmoDoLote,
  ): Promise<ItemParaGravar[]> {
    const base = {
      orgUnitId: turma.orgUnitId,
      codigoTurma: turma.codigoTurma,
      nomeDisciplina: turma.nomeDisciplina,
      senhaAnteriorLida: false,
    };

    let lista: QuizDaLista[];

    try {
      lista = await this.quizzes.listarQuizzes(turma.orgUnitId, ritmo);
    } catch (erro) {
      return [
        {
          ...base,
          quizId: null,
          nomeQuiz: null,
          resultado: ResultadoSenhaQuiz.FALHA_AO_LISTAR,
          detalhe: this.motivo(erro),
        },
      ];
    }

    const casados = casarPorNome(
      lista,
      (q) => q.Name,
      alvo.nomeQuiz,
      alvo.matchQuiz,
    );

    if (casados.length === 0) {
      // A saida mais importante do lote: uma turma inteira que nao abriria a
      // prova, e que NAO aparece como falha nenhuma.
      return [
        {
          ...base,
          quizId: null,
          nomeQuiz: null,
          resultado: ResultadoSenhaQuiz.QUIZ_NAO_ENCONTRADO,
          detalhe:
            `Nenhum questionario casou com "${alvo.nomeQuiz}" (${alvo.matchQuiz}) ` +
            `entre os ${lista.length} da turma.`,
        },
      ];
    }

    const itens: ItemParaGravar[] = [];

    for (const casado of casados) {
      const quizId = String(casado.QuizId ?? '');
      itens.push(
        await this.aplicarNoQuiz(
          base,
          turma,
          quizId,
          casado.Name ?? null,
          senha,
          simulacao,
          ritmo,
        ),
      );
    }

    return itens;
  }

  private async aplicarNoQuiz(
    base: {
      orgUnitId: string;
      codigoTurma: string;
      nomeDisciplina: string;
      senhaAnteriorLida: boolean;
    },
    turma: TurmaResolvida,
    quizId: string,
    nomeQuiz: string | null,
    senha: string,
    simulacao: boolean,
    ritmo: RitmoDoLote,
  ): Promise<ItemParaGravar> {
    let quiz: QuizLido;

    try {
      // O GET nao e opcional: o PUT substitui o objeto INTEIRO, e o corpo so
      // pode ser remontado a partir do que a API acabou de devolver.
      quiz = await this.quizzes.lerQuiz<QuizLido>(
        turma.orgUnitId,
        quizId,
        ritmo,
      );
    } catch (erro) {
      return {
        ...base,
        quizId,
        nomeQuiz,
        resultado: ResultadoSenhaQuiz.FALHA_AO_LER,
        detalhe: this.motivo(erro),
      };
    }

    const senhaAnteriorLida = quiz.Password != null && quiz.Password !== '';

    if (simulacao) {
      return {
        ...base,
        quizId,
        nomeQuiz: quiz.Name ?? nomeQuiz,
        resultado: ResultadoSenhaQuiz.SIMULADA,
        senhaAnteriorLida,
        detalhe: null,
      };
    }

    try {
      await this.quizzes.gravarQuiz(
        turma.orgUnitId,
        quizId,
        montarCorpoDoQuiz(quiz, senha),
        ritmo,
      );
    } catch (erro) {
      return {
        ...base,
        quizId,
        nomeQuiz: quiz.Name ?? nomeQuiz,
        resultado: ResultadoSenhaQuiz.FALHA_AO_GRAVAR,
        senhaAnteriorLida,
        detalhe: this.motivo(erro),
      };
    }

    return {
      ...base,
      quizId,
      nomeQuiz: quiz.Name ?? nomeQuiz,
      resultado: ResultadoSenhaQuiz.DEFINIDA,
      senhaAnteriorLida,
      detalhe: null,
    };
  }

  private async gravarItens(
    execucaoId: number,
    itens: ItemParaGravar[],
  ): Promise<void> {
    if (itens.length === 0) return;

    await this.prisma.itemSenhaQuiz.createMany({
      data: itens.map((item) => ({ ...item, execucaoId })),
    });
  }

  /** A mensagem do erro, truncada: `detalhe` e para ler, nao para despejar stack. */
  private motivo(erro: unknown): string {
    return (erro instanceof Error ? erro.message : String(erro)).slice(0, 500);
  }
}
