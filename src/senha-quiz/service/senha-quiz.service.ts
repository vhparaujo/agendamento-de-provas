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
  TipoExecucaoQuiz,
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { carregarRitmo, RitmoDoLote } from '../config/senha-quiz.config';
import { GradeSenhasService } from './grade-senhas.service';
import {
  casarPorNome,
  JanelaDoQuiz,
  montarCorpoDoQuiz,
  QuizLido,
} from './quiz-body';
import {
  dataUtcDeIso,
  FUSO_DA_OPERACAO,
  instanteUtcDe,
  isoDeDataUtc,
} from './relogio';
import { ModalidadeDaTurmaService } from './modalidade-da-turma.service';
import {
  ResolucaoOrgUnitService,
  ResultadoResolucao,
  TurmaNaoResolvida,
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
  /** So no lote de DATAS — fotografia do que aquela turma recebeu. */
  modalidadeCodigo?: string | null;
  startDateAplicado?: Date | null;
  endDateAplicado?: Date | null;
}

/** O lote de senhas: uma celula da grade, em TODAS as turmas do CSV. */
export interface OpcoesDeSenha {
  tipo?: typeof TipoExecucaoQuiz.SENHA;
  data: string;
  turno: Turno;
  simulacao: boolean;
  forcar: boolean;
}

/** O lote de datas: UMA janela, nas turmas de UMA modalidade. */
export interface OpcoesDeData {
  tipo: typeof TipoExecucaoQuiz.DATA;
  /**
   * A janela a aplicar. Ela ja carrega a modalidade (que recorta as turmas), as
   * horas e o turno de onde sai a senha.
   */
  janelaId: number;
  /**
   * O dia que o QUESTIONARIO passa a ter — ja com o `diaSeguinte` resolvido pelo
   * chamador.
   *
   * E o alvo, nao a referencia: o cron dispara as 22:01 de segunda com
   * `data = terca`, e a tela mostra ao admin a data que a prova vai ficar. Fazer
   * o servico somar o dia aqui esconderia do admin o que ele esta mandando
   * gravar — e "amanha" e ambiguo perto da meia-noite.
   */
  data: string;
  simulacao: boolean;
  forcar: boolean;
}

export type OpcoesDoLote = OpcoesDeSenha | OpcoesDeData;

export interface ExecucaoIniciada {
  id: number;
  tipo: TipoExecucaoQuiz;
  simulacao: boolean;
  turmasNoCsv: number;
  /** Quantas turmas o lote vai realmente tocar. */
  totalTurmas: number;
  naoResolvidas: number;
  /** So em `DATA`: turmas resolvidas que ficaram de fora por falta de modalidade. */
  semModalidade: number;
  modalidadeAmbigua: number;
}

@Injectable()
export class SenhaQuizService {
  private readonly logger = new Logger(SenhaQuizService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quizzes: D2lQuizzesService,
    private readonly resolucao: ResolucaoOrgUnitService,
    private readonly modalidades: ModalidadeDaTurmaService,
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
    opcoes: OpcoesDoLote,
    iniciadoPor: string,
    origem: OrigemExecucao = OrigemExecucao.MANUAL,
  ): Promise<ExecucaoIniciada> {
    const tipo = opcoes.tipo ?? TipoExecucaoQuiz.SENHA;

    if (!this.quizzes.habilitado()) {
      // Sem a Valence nao ha como resolver o orgUnitId das turmas do CSV nem
      // falar com os quizzes — o lote rodaria em zero turma relatando sucesso.
      throw new BadRequestException(
        'A troca de senhas e datas depende da integracao com o Brightspace ' +
          '(D2L_HABILITADO). Sem ela nao ha como descobrir o orgUnitId das ' +
          'turmas do CSV nem gravar no questionario.',
      );
    }

    const { periodoLetivoId, rodada } =
      (await this.periodo.periodoLetivoVigente()) ?? {};

    if (!periodoLetivoId || !rodada) {
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
          'Senhas e datas > Questionario antes de aplicar.',
      );
    }

    const alvo = {
      nomeQuiz: configurado.nomeQuiz,
      matchQuiz: configurado.matchQuiz,
    };

    // A janela, quando houver. Lida ANTES do lock para que um id inexistente
    // devolva 404 na hora, em vez de derrubar o lote depois de ele comecar.
    const janela =
      tipo === TipoExecucaoQuiz.DATA
        ? await this.janelaDoLote((opcoes as OpcoesDeData).janelaId)
        : null;

    const dataAlvo = dataUtcDeIso(opcoes.data);

    // O turno de onde sai a senha: da propria opcao, no lote de senhas; da
    // janela, no de datas.
    const turnoDaSenha = janela
      ? janela.turno
      : (opcoes as OpcoesDeSenha).turno;

    const celula = await this.prisma.senhaDeProva.findUnique({
      where: { data_turno: { data: dataAlvo, turno: turnoDaSenha } },
    });

    // ⚠️ A celula e obrigatoria NOS DOIS LOTES, e no de datas por um motivo mais
    // duro que "o humano no circuito": o PUT substitui o objeto inteiro, entao o
    // lote de datas TEM de reenviar `Password`. Ele nao pode preservar o que o
    // GET devolveu, porque o `QuizReadData` so expoe a senha se ela for "nao
    // nula E visivel ao contexto do chamador" — um GET nulo num quiz que tem
    // senha apagaria a senha de toda prova do CSV, em silencio. A grade e a
    // unica fonte autoritativa em texto claro. Ver `quiz-body.ts`.
    if (!celula) {
      throw new BadRequestException(
        `Nao ha senha cadastrada para ${opcoes.data} (${rotuloDoTurno(turnoDaSenha)}). ` +
          'Preencha a celula na grade antes de aplicar — o questionario precisa ' +
          'receber a senha junto com a janela, senao ela seria apagada.',
      );
    }

    await this.recusarSeJaRodando();

    if (!opcoes.simulacao && !opcoes.forcar) {
      if (janela) {
        await this.recusarSeJaAplicadaAJanela(
          janela.id,
          dataAlvo,
          janela.versao,
        );
      } else {
        await this.recusarSeJaAplicada(celula.id, celula.versao);
      }
    }

    const resolvidas = await this.resolucao.resolver(periodoLetivoId);

    // No lote de datas o conjunto encolhe: so as turmas DA MODALIDADE da janela.
    // As demais nao sao erro — cada uma tem a sua janela, no horario dela.
    const recorte = janela
      ? await this.recortarPelaModalidade(
          resolvidas,
          janela.modalidadeId,
          periodoLetivoId,
          rodada,
        )
      : {
          turmas: resolvidas.resolvidas,
          foraDaModalidade: [] as ItemParaGravar[],
          semModalidade: 0,
          modalidadeAmbigua: 0,
          codigoDaModalidade: null as string | null,
        };

    const execucao = await this.prisma.execucaoSenhaQuiz.create({
      data: {
        tipo,
        simulacao: opcoes.simulacao,
        origem,
        iniciadoPor,
        senhaDeProvaId: celula.id,
        data: dataAlvo,
        // Nulo no lote de datas: turno e a chave da GRADE, e uma execucao de
        // datas nao "pertence" a um turno — ela pertence a uma janela.
        turno: janela ? null : celula.turno,
        janelaDeProvaId: janela?.id ?? null,
        horaInicioAplicada: janela?.horaInicio ?? null,
        horaFimAplicada: janela?.horaFim ?? null,
        periodoLetivoId,
        // A versao do que foi REALMENTE aplicado: da celula no lote de senhas, da
        // janela no de datas. E ela que faz a idempotencia liberar um novo
        // disparo quando o admin corrige o horario ou a senha.
        versaoAplicada: janela ? janela.versao : celula.versao,
        nomeQuizAlvo: alvo.nomeQuiz,
        matchQuizAlvo: alvo.matchQuiz,
        turmasNoCsv: resolvidas.totalNoCsv,
        turmasResolvidas: recorte.turmas.length,
        orgUnitsAprendidos: resolvidas.aprendidos,
        semModalidade: recorte.semModalidade,
        modalidadeAmbigua: recorte.modalidadeAmbigua,
      },
      select: { id: true },
    });

    const descricao = janela
      ? `janela ${janela.horaInicio}-${janela.horaFim} de ${recorte.codigoDaModalidade ?? janela.modalidadeId} em ${opcoes.data}`
      : `celula ${opcoes.data} ${rotuloDoTurno(celula.turno)}`;

    this.auditoria.registrar(
      tipo === TipoExecucaoQuiz.DATA
        ? 'DATA_QUIZ_INICIADA'
        : 'SENHA_QUIZ_INICIADA',
      {
        ator: iniciadoPor,
        // Sem a senha, por definicao — so o recorte e o tamanho do trabalho.
        detalhe:
          `execucao ${execucao.id}; ${descricao}; ` +
          `${opcoes.simulacao ? 'SIMULACAO' : 'APLICANDO'}; origem ${origem}; ` +
          `${recorte.turmas.length} de ${resolvidas.totalNoCsv} turma(s) do CSV; ` +
          `alvo "${alvo.nomeQuiz}" (${alvo.matchQuiz})`,
      },
    );

    // Fire-and-forget: o lote leva minutos e nenhum navegador segura a conexao.
    // O `catch` dentro de `executar` e o que garante que uma falha vire FALHOU
    // na tabela, em vez de um unhandled rejection derrubando o processo.
    void this.executar({
      execucaoId: execucao.id,
      turmas: recorte.turmas,
      naoResolvidas: resolvidas.naoResolvidas,
      foraDaModalidade: recorte.foraDaModalidade,
      senha: celula.senha,
      alvo,
      janela: janela
        ? {
            inicio: instanteUtcDe(dataAlvo, janela.horaInicio),
            fim: instanteUtcDe(dataAlvo, janela.horaFim),
            codigo: recorte.codigoDaModalidade,
          }
        : null,
      simulacao: opcoes.simulacao,
      iniciadoPor,
    });

    return {
      id: execucao.id,
      tipo,
      simulacao: opcoes.simulacao,
      turmasNoCsv: resolvidas.totalNoCsv,
      totalTurmas: recorte.turmas.length,
      naoResolvidas: resolvidas.naoResolvidas.length,
      semModalidade: recorte.semModalidade,
      modalidadeAmbigua: recorte.modalidadeAmbigua,
    };
  }

  /**
   * A execucao mais recente, opcionalmente so as de uma origem.
   *
   * Existe por causa do CRON. O disparo manual acompanha o proprio lote pelo id
   * que o POST devolveu; o do cron nao tem quem o acompanhe — ele acontece as
   * 07:30, sozinho, e ate 19/08/2026 a tela nao dizia nada nem enquanto rodava
   * nem depois de acabar. Quem estava na tela via a grade parada, e quem chegava
   * depois nao tinha como saber se a troca das 07:30 aconteceu.
   *
   * Devolve `null` quando nunca houve execucao: e o estado normal de um ambiente
   * recem-configurado, nao um 404. A tela precisa distinguir "nunca rodou" de
   * "nao consegui perguntar" — um 404 aqui faria as duas coisas parecerem erro.
   *
   * Ordenada por `id`, e nao por `iniciadoEm`: a chave primaria ja e crescente e
   * indexada, e esta rota e consultada em laco por toda tela aberta.
   */
  async ultima(origem?: OrigemExecucao, tipo?: TipoExecucaoQuiz) {
    const recente = await this.prisma.execucaoSenhaQuiz.findFirst({
      where: { ...(origem ? { origem } : {}), ...(tipo ? { tipo } : {}) },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    return recente ? await this.consultar(recente.id) : null;
  }

  /**
   * A ultima execucao de DATAS de CADA modalidade.
   *
   * `ultima()` responde "qual foi a mais recente?", e essa nao e a pergunta que
   * a secretaria faz. Um unico minuto de disparo produz VARIAS execucoes — as
   * 12:01 sao tres (EaD, Semi e Modular), aplicadas em ticks seguidos porque os
   * dois lotes escrevem no mesmo questionario e o servidor serializa. Mostrar so
   * a mais recente exibe a terceira delas e esconde as outras duas, e quem le
   * conclui que a janela errada foi aplicada.
   *
   * A pergunta util e por modalidade: **cada uma esta com a janela certa?**
   *
   * Uma consulta por modalidade, e nao um `take: N` com deduplicacao em memoria:
   * sao 4 modalidades, o indice `[tipo, origem, id]` cobre cada uma, e o
   * resultado e EXATO — um teto arbitrario faria a modalidade que nao rodou hoje
   * sumir da lista em vez de aparecer como "nunca rodou", que e justamente o
   * estado que precisa ser visto.
   */
  async ultimasDatasPorModalidade(origem?: OrigemExecucao) {
    // So as modalidades que tem calendario: as outras nao disparam nunca, e uma
    // linha "nunca rodou" para elas seria ruido permanente.
    const comJanela = await this.prisma.modalidade.findMany({
      where: { janelas: { some: {} } },
      select: { id: true, codigo: true, nome: true },
      orderBy: { id: 'asc' },
    });

    return Promise.all(
      comJanela.map(async (modalidade) => {
        const recente = await this.prisma.execucaoSenhaQuiz.findFirst({
          where: {
            tipo: TipoExecucaoQuiz.DATA,
            ...(origem ? { origem } : {}),
            janelaDeProva: { modalidadeId: modalidade.id },
          },
          orderBy: { id: 'desc' },
          select: { id: true },
        });

        return {
          modalidadeId: modalidade.id,
          modalidadeCodigo: modalidade.codigo,
          modalidadeNome: modalidade.nome,
          // `null` = nunca rodou. E o estado normal de uma modalidade sem aluno
          // importado (o Presencial, hoje), e a tela precisa distingui-lo de
          // "rodou e falhou".
          execucao: recente ? await this.consultar(recente.id) : null,
        };
      }),
    );
  }

  /** O andamento, para a tela perguntar de tempos em tempos. */
  async consultar(id: number) {
    const execucao = await this.prisma.execucaoSenhaQuiz.findUnique({
      where: { id },
      // A modalidade da janela. Sem ela a tela mostra "Janela 14:00-15:30" e nao
      // diz de QUEM — e as 12:01 tres modalidades disparam, duas delas com a
      // mesma janela. Quem le nao tem como saber qual execucao esta vendo.
      include: {
        janelaDeProva: {
          include: { modalidade: { select: { codigo: true, nome: true } } },
        },
      },
    });

    if (!execucao)
      throw new NotFoundException(`Execucao ${id} nao encontrada.`);

    const porResultado = await this.prisma.itemSenhaQuiz.groupBy({
      by: ['resultado'],
      where: { execucaoId: id },
      _count: { _all: true },
    });

    const totalItens = porResultado.reduce((s, l) => s + l._count._all, 0);

    const { janelaDeProva, ...campos } = execucao;

    return {
      ...campos,
      data: isoDeDataUtc(execucao.data),
      modalidadeCodigo: janelaDeProva?.modalidade.codigo ?? null,
      modalidadeNome: janelaDeProva?.modalidade.nome ?? null,
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

    // As colunas de janela so entram no relatorio de DATAS: no de senhas elas
    // sairiam vazias em toda linha, e coluna vazia num CSV que a secretaria abre
    // no Excel e convite a procurar o que nao existe.
    const comDatas = execucao.tipo === TipoExecucaoQuiz.DATA;

    const cabecalho = [
      'Resultado',
      'Codigo da turma',
      'Disciplina',
      'OrgUnitId',
      'Questionario',
      'QuizId',
      'Tinha senha antes',
      ...(comDatas ? ['Modalidade', 'Abre em', 'Fecha em'] : []),
      'Observacao',
    ];

    return montarCsv(
      cabecalho,
      itens.map((i) => [
        i.resultado,
        i.codigoTurma,
        i.nomeDisciplina,
        i.orgUnitId,
        i.nomeQuiz,
        i.quizId,
        i.senhaAnteriorLida ? 'Sim' : 'Nao',
        ...(comDatas
          ? [
              i.modalidadeCodigo,
              // No FUSO DA OPERACAO, e nao em UTC. O CSV e lido por pessoas, e
              // "18:00Z" faria a secretaria achar que a prova das 15h abre as 18h.
              this.horarioLegivel(i.startDateAplicado),
              this.horarioLegivel(i.endDateAplicado),
            ]
          : []),
        i.detalhe,
      ]),
    );
  }

  /**
   * O nome do arquivo diz de que LOTE ele e — os dois recortes sao diferentes e
   * o admin baixa os dois no mesmo dia.
   *
   * `:` e invalido em nome de arquivo, dai o `h`, a mesma convencao de
   * `relatorio/service/nome-de-arquivo.ts`.
   */
  nomeDoArquivo(execucao: {
    id: number;
    tipo: TipoExecucaoQuiz;
    data: Date;
    turno: Turno | null;
    horaInicioAplicada: string | null;
    horaFimAplicada: string | null;
    modalidadeCodigo: string | null;
  }): string {
    const dia = isoDeDataUtc(execucao.data);

    if (execucao.tipo === TipoExecucaoQuiz.DATA) {
      const janela = [execucao.horaInicioAplicada, execucao.horaFimAplicada]
        .filter((h): h is string => h !== null)
        .map((h) => h.replace(':', 'h'))
        .join('-');

      // A modalidade entra no nome pelo mesmo motivo que entra na tela: as 12:01
      // saem tres arquivos, dois deles com a MESMA janela. Sem ela, dois
      // downloads no mesmo dia sao indistinguiveis na pasta de quem baixou.
      const modalidade = execucao.modalidadeCodigo
        ? `-${execucao.modalidadeCodigo}`
        : '';

      return `datas-${dia}${modalidade}${janela ? `-${janela}` : ''}-execucao-${execucao.id}.csv`;
    }

    // `turno` so e nulo em execucoes DATA, tratadas acima. O fallback existe
    // para nao produzir "undefined" no nome se essa invariante mudar.
    const turno = execucao.turno ? rotuloDoTurno(execucao.turno) : 'sem-turno';
    return `senhas-${dia}-${turno}-execucao-${execucao.id}.csv`;
  }

  async dadosDaExecucao(id: number) {
    const execucao = await this.prisma.execucaoSenhaQuiz.findUnique({
      where: { id },
      select: {
        id: true,
        tipo: true,
        data: true,
        turno: true,
        horaInicioAplicada: true,
        horaFimAplicada: true,
        janelaDeProva: { select: { modalidade: { select: { codigo: true } } } },
      },
    });

    if (!execucao)
      throw new NotFoundException(`Execucao ${id} nao encontrada.`);

    return {
      ...execucao,
      modalidadeCodigo: execucao.janelaDeProva?.modalidade.codigo ?? null,
    };
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

  /**
   * A janela do lote, com a modalidade e o turno que ela usa.
   *
   * Lida antes do lock de propósito: um `janelaId` que nao existe precisa virar
   * 404 no clique do admin, e nao uma execucao FALHOU que ele so descobre no
   * polling.
   */
  private async janelaDoLote(janelaId: number) {
    const janela = await this.prisma.janelaDeProva.findUnique({
      where: { id: janelaId },
      select: {
        id: true,
        modalidadeId: true,
        horaInicio: true,
        horaFim: true,
        turno: true,
        ativo: true,
        versao: true,
      },
    });

    if (!janela) {
      throw new NotFoundException(`Janela ${janelaId} nao encontrada.`);
    }

    // Desativada NAO bloqueia o disparo MANUAL, so o do cron (que nem a
    // enxerga, porque `janelasParaDisparar` a filtra). E a mesma logica da faixa
    // inativa no agendamento administrativo: quem esta clicando e a secretaria,
    // e usar uma janela fora do calendario e caso de uso real — consertar o dia
    // em que o cron falhou. Recusar seria decidir no lugar dela.
    if (!janela.ativo) {
      this.logger.warn(
        `Janela ${janelaId} esta desativada e foi aplicada manualmente.`,
      );
    }

    return janela;
  }

  /**
   * Recorta as turmas resolvidas para as de UMA modalidade.
   *
   * ============================================================================
   * DE ONDE SAI A MODALIDADE DE UMA TURMA
   * ============================================================================
   * De lugar nenhum no cadastro: `TurmaImportada` nao tem a coluna, e isso e
   * deliberado (ver `modalidade-da-turma.service.ts`). Ela e DERIVADA dos
   * agendamentos confirmados da rodada vigente.
   *
   * Tres destinos, e a diferenca entre eles importa:
   *
   *   - modalidade == a da janela  -> entra no lote;
   *   - modalidade de OUTRA        -> sai em silencio, e NAO e erro: aquela
   *                                   turma tem a janela dela, no horario dela.
   *                                   Relatar isso encheria o CSV de linhas que
   *                                   ninguem deve tratar, que e justamente o
   *                                   ruido que ensina o time a ignorar o
   *                                   relatorio;
   *   - sem modalidade / ambigua   -> vira LINHA DE RELATORIO. Sao turmas que
   *                                   ficariam com a data velha, ou seja, alunos
   *                                   que nao abrem a prova.
   */
  private async recortarPelaModalidade(
    resolvidas: ResultadoResolucao,
    modalidadeId: number,
    periodoLetivoId: string,
    rodada: string,
  ): Promise<{
    turmas: TurmaResolvida[];
    foraDaModalidade: ItemParaGravar[];
    semModalidade: number;
    modalidadeAmbigua: number;
    codigoDaModalidade: string | null;
  }> {
    const mapa = await this.modalidades.resolver(periodoLetivoId, rodada);

    const turmas: TurmaResolvida[] = [];
    const foraDaModalidade: ItemParaGravar[] = [];
    let semModalidade = 0;
    let modalidadeAmbigua = 0;
    let codigoDaModalidade: string | null = null;

    for (const turma of resolvidas.resolvidas) {
      const decisao = mapa.de(turma.orgUnitId);

      if (decisao.situacao === 'ENCONTRADA') {
        if (decisao.modalidadeId === modalidadeId) {
          turmas.push(turma);
          codigoDaModalidade ??= decisao.codigo;
        }
        // Outra modalidade: silencio proposital, ver o cabecalho.
        continue;
      }

      const ambigua = decisao.motivo === 'AMBIGUA';
      if (ambigua) modalidadeAmbigua += 1;
      else semModalidade += 1;

      foraDaModalidade.push({
        orgUnitId: turma.orgUnitId,
        codigoTurma: turma.codigoTurma,
        nomeDisciplina: turma.nomeDisciplina,
        quizId: null,
        nomeQuiz: null,
        resultado: ambigua
          ? ResultadoSenhaQuiz.MODALIDADE_AMBIGUA
          : ResultadoSenhaQuiz.SEM_AGENDAMENTO,
        senhaAnteriorLida: false,
        detalhe: decisao.detalhe,
        modalidadeCodigo: null,
        startDateAplicado: null,
        endDateAplicado: null,
      });
    }

    return {
      turmas,
      foraDaModalidade,
      semModalidade,
      modalidadeAmbigua,
      codigoDaModalidade,
    };
  }

  /**
   * A janela ja foi aplicada NESTE dia?
   *
   * O recorte e `(janela, dia)` e nao so a janela: o calendario se repete todo
   * dia, e travar pela janela sozinha faria a sessao das 15:00 de segunda
   * impedir a de terca.
   *
   * Como em `recusarSeJaAplicada`, isto e guarda contra CARGA e CONFUSAO, nao
   * contra corrupcao — o PUT e idempotente. Por isso `forcar` continua barato.
   */
  private async recusarSeJaAplicadaAJanela(
    janelaDeProvaId: number,
    data: Date,
    versao: number,
  ): Promise<void> {
    const ja = await this.prisma.execucaoSenhaQuiz.findFirst({
      where: {
        janelaDeProvaId,
        data,
        // ⚠️ A VERSAO entra na chave. Sem ela, corrigir o horario de uma janela
        // que ja rodou hoje nao a libera — o `upsert` preserva o id da linha, e
        // esta consulta encontraria a execucao antiga. Bug real de 25/08/2026.
        versaoAplicada: versao,
        simulacao: false,
        status: StatusExecucao.CONCLUIDA,
      },
      orderBy: { concluidoEm: 'desc' },
    });

    if (!ja) return;

    throw new ConflictException(
      `Esta janela ja foi aplicada em ${isoDeDataUtc(data)} pela execucao ${ja.id}, ` +
        'com estes mesmos horarios. Se quiser aplicar de novo sem mudar nada, ' +
        'use a opcao de forcar — corrigir o horario na tela ja libera sozinho.',
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
  private async executar(entrada: {
    execucaoId: number;
    turmas: TurmaResolvida[];
    naoResolvidas: TurmaNaoResolvida[];
    /** Turmas descartadas por falta de modalidade — so no lote de DATAS. */
    foraDaModalidade: ItemParaGravar[];
    senha: string;
    alvo: { nomeQuiz: string; matchQuiz: TipoMatchQuiz };
    /** `null` = lote de senhas: o calendario do questionario nao e tocado. */
    janela: { inicio: Date; fim: Date; codigo: string | null } | null;
    simulacao: boolean;
    iniciadoPor: string;
  }): Promise<void> {
    const {
      execucaoId,
      turmas,
      naoResolvidas,
      foraDaModalidade,
      senha,
      alvo,
      janela,
      simulacao,
      iniciadoPor,
    } = entrada;

    const ritmo = carregarRitmo(this.config);

    // Ja em UTC-Z, como a Valence exige. A conversao aconteceu uma vez, em
    // `instanteUtcDe`; daqui para a frente a string trafega verbatim.
    const janelaDoQuiz = janela
      ? { inicio: janela.inicio.toISOString(), fim: janela.fim.toISOString() }
      : undefined;

    try {
      // As turmas que nem chegam a ter chamada: entram como item para o
      // relatorio explicar por que ficaram de fora.
      await this.gravarItens(execucaoId, [
        ...naoResolvidas.map((t) => ({
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
        // Resolveram o orgUnitId mas nao tem modalidade derivavel. Sao as linhas
        // que mais importam no lote de datas: cada uma e uma turma inteira que
        // fica com a data velha.
        ...foraDaModalidade,
      ]);

      const contagem = {
        processadas: 0,
        definidas: 0,
        naoEncontradas: 0,
        falhas: 0,
        comSenhaLida: 0,
      };

      // Fatias de `concorrencia` turmas. Dentro da turma e sequencial: sao ~3
      // chamadas encadeadas (listar -> ler -> gravar) e paraleliza-las nao
      // ganharia nada alem de bater mais forte no mesmo tenant.
      for (let i = 0; i < turmas.length; i += ritmo.concorrencia) {
        const fatia = turmas.slice(i, i + ritmo.concorrencia);

        const resultados = await Promise.all(
          fatia.map((turma) =>
            this.aplicarNaTurma({
              turma,
              senha,
              alvo,
              janela: janelaDoQuiz,
              modalidadeCodigo: janela?.codigo ?? null,
              simulacao,
              ritmo,
            }),
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

      this.auditoria.registrar(
        janela ? 'DATA_QUIZ_CONCLUIDA' : 'SENHA_QUIZ_CONCLUIDA',
        {
          ator: iniciadoPor,
          detalhe:
            `execucao ${execucaoId}: ${contagem.definidas} questionario(s) ` +
            `${simulacao ? 'simulado(s)' : 'atualizado(s)'}, ` +
            `${contagem.naoEncontradas} sem questionario, ${contagem.falhas} falha(s), ` +
            `${naoResolvidas.length} turma(s) nao resolvida(s)` +
            (janela
              ? `, ${foraDaModalidade.length} sem modalidade derivavel`
              : ''),
        },
      );
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

      this.auditoria.registrar(
        janela ? 'DATA_QUIZ_FALHOU' : 'SENHA_QUIZ_FALHOU',
        { ator: iniciadoPor, detalhe: `execucao ${execucaoId}: ${motivo}` },
      );

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
  private async aplicarNaTurma(entrada: {
    turma: TurmaResolvida;
    senha: string;
    alvo: { nomeQuiz: string; matchQuiz: TipoMatchQuiz };
    janela?: JanelaDoQuiz;
    modalidadeCodigo: string | null;
    simulacao: boolean;
    ritmo: RitmoDoLote;
  }): Promise<ItemParaGravar[]> {
    const { turma, senha, alvo, janela, modalidadeCodigo, simulacao, ritmo } =
      entrada;

    const base = {
      orgUnitId: turma.orgUnitId,
      codigoTurma: turma.codigoTurma,
      nomeDisciplina: turma.nomeDisciplina,
      senhaAnteriorLida: false,
      modalidadeCodigo,
      startDateAplicado: janela ? new Date(janela.inicio) : null,
      endDateAplicado: janela ? new Date(janela.fim) : null,
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
        await this.aplicarNoQuiz({
          base,
          turma,
          quizId,
          nomeQuiz: casado.Name ?? null,
          senha,
          janela,
          simulacao,
          ritmo,
        }),
      );
    }

    return itens;
  }

  private async aplicarNoQuiz(entrada: {
    base: {
      orgUnitId: string;
      codigoTurma: string;
      nomeDisciplina: string;
      senhaAnteriorLida: boolean;
      modalidadeCodigo: string | null;
      startDateAplicado: Date | null;
      endDateAplicado: Date | null;
    };
    turma: TurmaResolvida;
    quizId: string;
    nomeQuiz: string | null;
    senha: string;
    janela?: JanelaDoQuiz;
    simulacao: boolean;
    ritmo: RitmoDoLote;
  }): Promise<ItemParaGravar> {
    const { base, turma, quizId, nomeQuiz, senha, janela, simulacao, ritmo } =
      entrada;

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
        // `senha` SEMPRE vai, nos dois lotes. Preservar a lida apagaria a senha
        // quando o GET a esconde — ver o cabecalho de `quiz-body.ts`.
        montarCorpoDoQuiz(quiz, senha, janela),
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

  /**
   * Um instante UTC como a secretaria le: dia e hora de Brasilia.
   *
   * O relatorio e um documento para PESSOAS. Despejar o ISO em UTC faria a
   * janela das 15:00 aparecer como 18:00 e alguem "corrigir" o que estava certo.
   */
  private horarioLegivel(instante: Date | null): string | null {
    if (!instante) return null;

    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: FUSO_DA_OPERACAO,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(instante);
  }

  /** A mensagem do erro, truncada: `detalhe` e para ler, nao para despejar stack. */
  private motivo(erro: unknown): string {
    return (erro instanceof Error ? erro.message : String(erro)).slice(0, 500);
  }
}
