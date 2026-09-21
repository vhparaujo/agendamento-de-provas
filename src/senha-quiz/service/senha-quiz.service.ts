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
import { D2lCondicoesService } from '../../d2l/service/d2l-condicoes.service';
import {
  D2lQuizzesService,
  QuizDaLista,
} from '../../d2l/service/d2l-quizzes.service';
import {
  OrigemExecucao,
  ResultadoGrupoQuiz,
  ResultadoSenhaQuiz,
  StatusExecucao,
  TipoExecucaoQuiz,
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { carregarRitmo, RitmoDoLote } from '../config/senha-quiz.config';
import {
  CondicoesLidas,
  gruposDasCondicoes,
  removerGruposDasCondicoes,
  trocarGrupoNasCondicoes,
} from './condicoes';
import { GradeGruposService } from './grade-grupos.service';
import { GradeSenhasService } from './grade-senhas.service';
import { rotularGrupo } from './grupo';
import {
  ResolucaoGrupoService,
  SessaoDeResolucao,
} from './resolucao-grupo.service';
import {
  casarPorNome,
  jaPreparado,
  JanelaDoQuiz,
  montarCorpoDoPreparo,
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
 * Uma execucao = UMA celula da grade (dia + SESSAO). Aplica a senha daquela
 * celula nas turmas do CSV **daquele formato**, no periodo letivo vigente.
 *
 * ⚠️ **As duas metades desta frase mudaram em 21/09/2026.** Antes era "dia +
 * turno" em TODAS as turmas do CSV, tres vezes por dia. Duas consequencias do
 * novo desenho, e as duas sao deliberadas:
 *
 *  - **o recorte por formato passou a valer tambem aqui.** Nao ha alternativa:
 *    as 12:01 o EaD troca de senha e o Semi tambem, com senhas diferentes.
 *    Aplicar a do EaD em todas as turmas apagaria a do Semi um minuto antes da
 *    prova dele. O preco e o mesmo do lote de datas — turma sem formato
 *    derivado fica de fora e vira linha de relatorio —, e ele ja estava pago:
 *    essa turma tambem nao recebe a data nova, e sem a data a prova nem abre.
 *  - **o cron nao dispara mais este lote no calendario normal.** Quem troca a
 *    senha e o lote de DATAS, que ja a grava por obrigacao (ver
 *    `montarCorpoDoQuiz`) e roda na mesma sessao, no mesmo minuto. Este lote
 *    continua vivo para o disparo MANUAL e para o modo em que o special access
 *    substitui as janelas — ali a data nao e aplicada e a senha continua
 *    trocando.
 *
 * **Sobrescrever a senha da sessao anterior e a FUNCIONALIDADE, nao um
 * conflito.** A senha vale uma sessao; trocar a cada sessao e o que impede o
 * aluno das 08:30 de repassar a dele para o das 10:30 — e e exatamente isso que
 * a grade por turno NAO conseguia impedir, porque as duas sessoes dividiam a
 * mesma celula. Nao invente deduplicacao aqui.
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

  /**
   * So no lote de DATAS cuja janela tem `nomeGrupo`. NULO = a troca de grupo nem
   * foi tentada nesta linha — nao e um desfecho ruim, e ausencia de tentativa.
   */
  resultadoGrupo?: ResultadoGrupoQuiz | null;
  grupoAnterior?: string | null;
  grupoAplicado?: string | null;
  condicoesAnteriores?: string | null;
}

/**
 * O que o lote precisa saber para trocar o grupo: o nome-alvo, a sessao de
 * resolucao (que cacheia os grupos por turma) e nada mais.
 *
 * `null` em toda a cadeia significa "esta janela nao troca grupo", e o lote se
 * comporta exatamente como antes de 26/08/2026.
 */
interface GrupoDoLote {
  nome: string;
  categoria: string | null;
  sessao: SessaoDeResolucao;
}

/** O alvo ja resolvido DENTRO de uma turma, mais o mapa para nomear o anterior. */
interface AlvoNaTurma {
  groupId: number;
  rotulo: string;
  nomePorId: ReadonlyMap<number, string>;
}

/**
 * O lote de senhas: a celula de UMA sessao, nas turmas de UM formato.
 *
 * Mesma forma de `OpcoesDeData`, e nao por simetria: desde 21/09/2026 os dois
 * partem da mesma janela e tocam o mesmo conjunto de turmas. O que os separa e
 * o que cada um GRAVA — este so o `Password`, aquele tambem as datas e o grupo.
 */
export interface OpcoesDeSenha {
  tipo?: typeof TipoExecucaoQuiz.SENHA;
  /** A sessao cuja senha sera aplicada. Ela ja carrega o formato do recorte. */
  janelaId: number;
  /** O dia da PROVA — ja com o `diaSeguinte` resolvido pelo chamador. */
  data: string;
  simulacao: boolean;
  forcar: boolean;
}

/** O lote de datas: UMA janela, nas turmas de UM formato. */
export interface OpcoesDeData {
  tipo: typeof TipoExecucaoQuiz.DATA;
  /**
   * A janela a aplicar. Ela ja carrega o formato (que recorta as turmas), as
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

/**
 * O PREPARO para o special access (15/09/2026): UMA celula da grade (a senha
 * que vai junto, pelo motivo do lote de datas) em TODAS as turmas do CSV — ou
 * numa so, para o primeiro teste.
 */
export interface OpcoesDePreparo {
  tipo: typeof TipoExecucaoQuiz.PREPARO;
  /**
   * De qual celula sai a senha que vai junto no PUT.
   *
   * ⚠️ O preparo alcanca TODAS as turmas do CSV (nao so as de um formato), e
   * mesmo assim precisa de uma senha — o PUT substitui o questionario inteiro e
   * nao pode preservar a que o GET devolveu. A senha gravada aqui e
   * PROVISORIA: no dia, o disparo da sessao de cada turma poe a senha do
   * formato dela por cima. Escolher a celula e do admin de propósito — e ele
   * quem sabe qual sessao esta preparando.
   */
  janelaId: number;
  data: string;
  simulacao: boolean;
  /** Ignorado: o preparo nao tem trava de "ja aplicado". */
  forcar: boolean;
  /**
   * So estas turmas. **Vazio = todas as turmas do CSV no periodo vigente.**
   *
   * Fatiar o preparo e o que evita mandar a instituicao inteira ao Brightspace
   * de uma vez — e o que permite trancar a prova de uma turma so, conferir, e
   * seguir.
   */
  orgUnitIds: string[];
}

export type OpcoesDoLote = OpcoesDeSenha | OpcoesDeData | OpcoesDePreparo;

/**
 * O evento de auditoria de cada fase, pelo tipo do lote. Quem investiga "por que
 * a prova ficou sem data?" procura o PREPARO, e nao quer as trocas de senha no
 * meio.
 */
function eventoDoLote(
  tipo: TipoExecucaoQuiz,
  fase: 'INICIADA' | 'CONCLUIDA' | 'FALHOU',
) {
  if (tipo === TipoExecucaoQuiz.PREPARO) {
    return (
      {
        INICIADA: 'PREPARO_QUIZ_INICIADO',
        CONCLUIDA: 'PREPARO_QUIZ_CONCLUIDO',
        FALHOU: 'PREPARO_QUIZ_FALHOU',
      } as const
    )[fase];
  }

  return tipo === TipoExecucaoQuiz.DATA
    ? (`DATA_QUIZ_${fase}` as const)
    : (`SENHA_QUIZ_${fase}` as const);
}

export interface ExecucaoIniciada {
  id: number;
  tipo: TipoExecucaoQuiz;
  simulacao: boolean;
  turmasNoCsv: number;
  /** Quantas turmas o lote vai realmente tocar. */
  totalTurmas: number;
  naoResolvidas: number;
  /** So em `DATA`: turmas resolvidas que ficaram de fora por falta de formato. */
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
    private readonly condicoes: D2lCondicoesService,
    private readonly resolucao: ResolucaoOrgUnitService,
    private readonly grupos: ResolucaoGrupoService,
    private readonly modalidades: ModalidadeDaTurmaService,
    private readonly grade: GradeSenhasService,
    private readonly periodo: PeriodoService,
    private readonly auditoria: AuditoriaService,
    private readonly gradeGrupos: GradeGruposService,
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
    const preparo = tipo === TipoExecucaoQuiz.PREPARO;

    if (!this.quizzes.habilitado()) {
      // Sem a Valence nao ha como resolver o orgUnitId das turmas do CSV nem
      // falar com os quizzes — o lote rodaria em zero turma relatando sucesso.
      throw new BadRequestException(
        'A troca de senhas e datas depende da integração com o AVA, ' +
          'que está desligada neste servidor — avise o suporte técnico. Sem ela ' +
          'não há como encontrar as turmas no AVA nem gravar no questionário. ' +
          '(Detalhe técnico: D2L_HABILITADO.)',
      );
    }

    if (tipo === TipoExecucaoQuiz.DATA) {
      await this.recusarSeSpecialAccessSubstitui();
    }

    // A janela inteira: as turmas dos presenciais vivem sob o org unit do
    // semestre e as dos modulares sob o do modulo. O lote de senhas cobre as
    // duas — uma turma que ficasse de fora fica com a prova trancada no dia.
    const {
      periodoLetivoIds,
      principal: periodoLetivoId,
      rodada,
    } = (await this.periodo.janelaVigente()) ?? {};

    if (!periodoLetivoIds || !periodoLetivoId || !rodada) {
      throw new BadRequestException(
        'Nenhum período de agendamento cadastrado. Sem ele não há como separar as ' +
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
        'Nenhum questionário-alvo configurado. Informe o nome da prova em ' +
          'Senhas e datas > Questionário-alvo antes de aplicar.',
      );
    }

    const alvo = {
      nomeQuiz: configurado.nomeQuiz,
      matchQuiz: configurado.matchQuiz,
    };

    // A janela. Lida ANTES do lock para que um id inexistente devolva 404 na
    // hora, em vez de derrubar o lote depois de ele comecar.
    //
    // ⚠️ **Os TRES tipos passam por aqui desde 21/09/2026.** A celula da grade
    // pertence a uma sessao, entao ate o preparo — que nao recorta turma por
    // formato — precisa dizer de qual sessao tira a senha.
    const janela = await this.janelaDoLote(opcoes.janelaId);

    const dataAlvo = dataUtcDeIso(opcoes.data);

    // Do lote de DATAS, e so dele: a janela que o questionario passa a ter e o
    // grupo que a libera. No de senhas ela serve so para achar a celula e o
    // formato — gravar as horas ali moveria a prova num disparo que existe
    // para nao move-la.
    const aplicaJanela = tipo === TipoExecucaoQuiz.DATA;

    // O grupo do DIA, e nao mais so o da janela (14/09/2026): celula da grade de
    // grupos, ou o nome fixo como padrao. Lido ANTES da idempotencia porque a
    // celula entra na chave dela — ver `recusarSeJaAplicadaAJanela`.
    const grupoDoDia = aplicaJanela
      ? await this.gradeGrupos.doDia(janela, dataAlvo)
      : null;

    const celula = await this.prisma.senhaDeProva.findUnique({
      where: {
        data_janelaDeProvaId: { data: dataAlvo, janelaDeProvaId: janela.id },
      },
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
        `Não há senha cadastrada para ${opcoes.data.split('-').reverse().join('/')} ` +
          `na sessão de ${janela.horaInicio}–${janela.horaFim}. ` +
          'Gere as senhas do período na grade antes de aplicar — o questionário ' +
          'precisa receber a senha junto com a janela, senão ela seria apagada.',
      );
    }

    await this.recusarSeJaRodando();

    // O preparo nao tem trava de "ja aplicado": repeti-lo produz o mesmo estado,
    // e numa turma so ele e o teste que se repete ate dar certo.
    if (!preparo && !opcoes.simulacao && !opcoes.forcar) {
      if (aplicaJanela) {
        await this.recusarSeJaAplicadaAJanela(
          janela.id,
          dataAlvo,
          janela.versao,
          grupoDoDia?.celulaId ?? null,
          grupoDoDia?.versao ?? null,
          celula.versao,
        );
      } else {
        await this.recusarSeJaAplicada(celula.id, celula.versao);
      }
    }

    const resolvidas = await this.resolucao.resolver(periodoLetivoIds);

    // O conjunto encolhe para as turmas DO FORMATO da janela — no lote de datas
    // e, desde 21/09/2026, tambem no de SENHAS. As demais nao sao erro: cada uma
    // tem a sua sessao, com a senha dela, no horario dela.
    //
    // O PREPARO e a excecao, e por um motivo proprio: ele nao aplica calendario
    // nenhum, ele TRANCA o questionario para o special access. Toda turma do CSV
    // precisa ser trancada, inclusive as que nunca resolveram formato — deixa-las
    // abertas seria pior que lhes dar a senha de outro formato.
    const recorte = preparo
      ? {
          turmas: resolvidas.resolvidas,
          foraDaModalidade: [] as ItemParaGravar[],
          semModalidade: 0,
          modalidadeAmbigua: 0,
          codigoDaModalidade: null as string | null,
        }
      : await this.recortarPelaModalidade(
          resolvidas,
          janela.modalidadeId,
          periodoLetivoIds,
          rodada,
        );

    // O preparo aceita UMA turma: o primeiro uso real nao pode trancar a prova de
    // toda a instituicao de uma vez. Numa turma so, as nao resolvidas do CSV
    // inteiro ficam fora do relatorio — seriam ruido de outra pergunta.
    const escolhidas = new Set(
      preparo ? (opcoes as OpcoesDePreparo).orgUnitIds : [],
    );
    const turmasDoLote =
      escolhidas.size > 0
        ? recorte.turmas.filter((t) => escolhidas.has(t.orgUnitId))
        : recorte.turmas;
    const naoResolvidasDoLote =
      escolhidas.size > 0 ? [] : resolvidas.naoResolvidas;

    if (escolhidas.size > 0) {
      const encontradas = new Set(turmasDoLote.map((t) => t.orgUnitId));
      const faltando = [...escolhidas].filter((id) => !encontradas.has(id));

      // A lista inteira e recusada quando UMA turma nao casa: preparar quatro de
      // cinco deixaria a quinta com a prova aberta, e isso so apareceria no dia.
      if (faltando.length > 0) {
        throw new BadRequestException(
          `Turma(s) ${faltando.join(', ')} fora das turmas do CSV resolvidas no ` +
            'período vigente. Confira em Senhas e datas > Conferir.',
        );
      }
    }

    const execucao = await this.prisma.execucaoSenhaQuiz.create({
      data: {
        tipo,
        simulacao: opcoes.simulacao,
        origem,
        iniciadoPor,
        // NULO no preparo: o cron e a trava de "senha ja aplicada" procuram
        // execucoes por celula, e um preparo nao pode passar por troca de senha.
        senhaDeProvaId: preparo ? null : celula.id,
        data: dataAlvo,
        // O turno da SESSAO, como rotulo do relatorio e do log. Ele deixou de
        // ser a chave da grade em 21/09/2026, e por isso nao e mais nulo nas
        // execucoes de data: a execucao pertence a uma janela, e a janela
        // acontece num turno.
        turno: janela.turno,
        janelaDeProvaId: janela.id,
        // Só o lote de DATAS move o calendario do questionario. No de senhas as
        // horas ficam nulas de propósito: gravá-las diria que a prova foi
        // movida num disparo que nao a moveu.
        horaInicioAplicada: aplicaJanela ? janela.horaInicio : null,
        horaFimAplicada: aplicaJanela ? janela.horaFim : null,
        periodoLetivoId,
        // A versao do que foi REALMENTE aplicado: da celula no lote de senhas, da
        // janela no de datas. E ela que faz a idempotencia liberar um novo
        // disparo quando o admin corrige o horario.
        versaoAplicada: preparo
          ? null
          : aplicaJanela
            ? janela.versao
            : celula.versao,
        // A versao da CELULA, sempre — e o que a grade compara para dizer se o
        // Brightspace esta com a senha que o admin esta vendo. Em `SENHA` ela
        // repete `versaoAplicada`; em `DATA` e a unica que fala de senha.
        versaoSenhaAplicada: preparo ? null : celula.versao,
        // A celula da grade de grupos e a versao dela, pelo mesmo motivo da
        // linha acima: corrigir o grupo de hoje precisa liberar um novo disparo.
        // Nulas quando o grupo veio do nome fixo da janela, ou nao houve grupo.
        grupoDaJanelaId: grupoDoDia?.celulaId ?? null,
        versaoGrupoAplicada: grupoDoDia?.versao ?? null,
        // Congelado: com um nome por dia, ler da janela na hora de exibir faria
        // o relatorio de ontem mostrar o grupo de hoje.
        nomeGrupoAplicado: grupoDoDia?.nome ?? null,
        nomeQuizAlvo: alvo.nomeQuiz,
        matchQuizAlvo: alvo.matchQuiz,
        turmasNoCsv: resolvidas.totalNoCsv,
        turmasResolvidas: turmasDoLote.length,
        orgUnitsAprendidos: resolvidas.aprendidos,
        semModalidade: recorte.semModalidade,
        modalidadeAmbigua: recorte.modalidadeAmbigua,
      },
      select: { id: true },
    });

    const sessao =
      `${janela.horaInicio}-${janela.horaFim} ` +
      `(${recorte.codigoDaModalidade ?? janela.modalidadeId}, ${rotuloDoTurno(janela.turno)})`;

    const descricao = aplicaJanela
      ? `janela ${sessao} em ${opcoes.data}` +
        // De ONDE veio o grupo entra no log: "por que a prova abriu para o
        // grupo de ontem?" so tem resposta sabendo se foi a grade ou o padrao.
        `; grupo ${grupoDoDia?.nome ? `"${grupoDoDia.nome}" (${grupoDoDia.origem === 'GRADE' ? 'grade do dia' : 'padrao da janela'})` : grupoDoDia?.origem === 'SEM_GRUPO_NO_DIA' ? 'AUSENTE na grade do dia' : 'nao troca'}`
      : preparo
        ? `preparo para special access com a senha de ${opcoes.data}, sessao ${sessao}` +
          (escolhidas.size > 0
            ? `, so ${escolhidas.size} turma(s): ${[...escolhidas].join(', ')}`
            : '')
        : `senha de ${opcoes.data}, sessao ${sessao}`;

    this.auditoria.registrar(eventoDoLote(tipo, 'INICIADA'), {
      ator: iniciadoPor,
      // Sem a senha, por definicao — so o recorte e o tamanho do trabalho.
      detalhe:
        `execucao ${execucao.id}; ${descricao}; ` +
        `${opcoes.simulacao ? 'SIMULACAO' : 'APLICANDO'}; origem ${origem}; ` +
        `${turmasDoLote.length} de ${resolvidas.totalNoCsv} turma(s) do CSV; ` +
        `alvo "${alvo.nomeQuiz}" (${alvo.matchQuiz})`,
    });

    // O dia esquecido na grade. NAO recusa: a data precisa entrar (decisao de
    // 26/08/2026 — falha de grupo nao bloqueia a data). Mas vira evento de falha,
    // e cada questionario vira pendencia no relatorio.
    if (grupoDoDia?.origem === 'SEM_GRUPO_NO_DIA') {
      this.auditoria.registrar('DATA_QUIZ_SEM_GRUPO_NO_DIA', {
        ator: iniciadoPor,
        detalhe:
          `execucao ${execucao.id}; ${descricao}. A janela usa a grade de grupos ` +
          'e o dia esta em branco: a prova segue liberada para o grupo anterior.',
      });
    }

    // Fire-and-forget: o lote leva minutos e nenhum navegador segura a conexao.
    // O `catch` dentro de `executar` e o que garante que uma falha vire FALHOU
    // na tabela, em vez de um unhandled rejection derrubando o processo.
    void this.executar({
      execucaoId: execucao.id,
      tipo,
      turmas: turmasDoLote,
      naoResolvidas: naoResolvidasDoLote,
      foraDaModalidade: recorte.foraDaModalidade,
      senha: celula.senha,
      alvo,
      // `null` aqui significa "nao mexa no calendario do questionario", e nao
      // "nao ha janela": o lote de senhas TEM janela (e dela que saiu a celula e
      // o recorte), e mesmo assim nao move data nenhuma.
      janela: aplicaJanela
        ? {
            inicio: instanteUtcDe(dataAlvo, janela.horaInicio),
            fim: instanteUtcDe(dataAlvo, janela.horaFim),
            codigo: recorte.codigoDaModalidade,
          }
        : null,
      // O grupo e campo SEPARADO da janela, e nao mais um campo dentro dela, de
      // proposito: `JanelaDoQuiz` alimenta `montarCorpoDoQuiz`, que remonta os
      // ~35 campos do questionario. Grupo nao e campo do quiz — e um recurso LP
      // a parte — e deixa-lo entrar naquele objeto convidaria alguem a tentar
      // envia-lo no PUT do quiz, onde ele seria ignorado em silencio.
      //
      // O nome ja chega resolvido e aparado por `escolherGrupoDoDia`: celula do
      // dia, ou o nome fixo da janela. Em branco nos dois conta como ausente.
      grupo: grupoDoDia?.nome
        ? { nome: grupoDoDia.nome, categoria: grupoDoDia.categoria }
        : null,
      semGrupoNoDia: grupoDoDia?.origem === 'SEM_GRUPO_NO_DIA',
      simulacao: opcoes.simulacao,
      iniciadoPor,
    });

    return {
      id: execucao.id,
      tipo,
      simulacao: opcoes.simulacao,
      turmasNoCsv: resolvidas.totalNoCsv,
      totalTurmas: turmasDoLote.length,
      naoResolvidas: naoResolvidasDoLote.length,
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
   * A ultima execucao de DATAS de CADA formato.
   *
   * `ultima()` responde "qual foi a mais recente?", e essa nao e a pergunta que
   * a administração faz. Um unico minuto de disparo produz VARIAS execucoes — as
   * 12:01 sao tres (EaD, Semi e Modular), aplicadas em ticks seguidos porque os
   * dois lotes escrevem no mesmo questionario e o servidor serializa. Mostrar so
   * a mais recente exibe a terceira delas e esconde as outras duas, e quem le
   * conclui que a janela errada foi aplicada.
   *
   * A pergunta util e por formato: **cada um esta com a janela certa?**
   *
   * Uma consulta por formato, e nao um `take: N` com deduplicacao em memoria:
   * sao 4 formatos, o indice `[tipo, origem, id]` cobre cada um, e o
   * resultado e EXATO — um teto arbitrario faria o formato que nao rodou hoje
   * sumir da lista em vez de aparecer como "nunca rodou", que e justamente o
   * estado que precisa ser visto.
   */
  async ultimasDatasPorModalidade(origem?: OrigemExecucao) {
    // So os formatos que tem calendario: os outros nao disparam nunca, e uma
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
          // `null` = nunca rodou. E o estado normal de um formato sem aluno
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
      // O formato da janela. Sem ele a tela mostra "Janela 14:00-15:30" e nao
      // diz de QUEM — e as 12:01 tres formatos disparam, dois deles com a
      // mesma janela. Quem le nao tem como saber qual execucao esta vendo.
      include: {
        janelaDeProva: {
          include: { modalidade: { select: { codigo: true, nome: true } } },
        },
      },
    });

    if (!execucao)
      throw new NotFoundException(`Execução ${id} não encontrada.`);

    const porResultado = await this.prisma.itemSenhaQuiz.groupBy({
      by: ['resultado'],
      where: { execucaoId: id },
      _count: { _all: true },
    });

    const totalItens = porResultado.reduce((s, l) => s + l._count._all, 0);

    // Agrupado a parte do `resultado`, porque os dois desfechos sao
    // independentes: a mesma linha pode aparecer em DEFINIDA e em
    // GRUPO_NAO_ENCONTRADO, e somar tudo numa contagem so esconderia justamente
    // esse caso. O `null` fica de fora — e ausencia de tentativa, nao desfecho.
    const porGrupo = await this.prisma.itemSenhaQuiz.groupBy({
      by: ['resultadoGrupo'],
      where: { execucaoId: id, resultadoGrupo: { not: null } },
      _count: { _all: true },
    });

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
      // `nomeGrupoAplicado` vem da propria execucao, no `...campos`. Ate
      // 14/09/2026 era lido da JANELA aqui, o que so funcionava porque o nome
      // nunca mudava; com a grade de grupos, o relatorio de ontem mostraria o
      // grupo de hoje. A migration congelou o historico com o valor de entao.
      grupos: Object.fromEntries(
        porGrupo.flatMap((linha): [ResultadoGrupoQuiz, number][] =>
          // O `null` fica de fora: ele e ausencia de tentativa (janela sem
          // grupo), nao um desfecho. O `flatMap` faz o filtro e o estreitamento
          // de tipo de uma vez — com `filter`, o `null` continuaria no tipo.
          linha.resultadoGrupo === null
            ? []
            : [[linha.resultadoGrupo, linha._count._all]],
        ),
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
      throw new NotFoundException(`Execução ${id} não encontrada.`);

    const itens = await this.prisma.itemSenhaQuiz.findMany({
      where: { execucaoId: id },
      orderBy: [{ resultado: 'asc' }, { codigoTurma: 'asc' }],
    });

    // As colunas de janela so entram no relatorio de DATAS: no de senhas elas
    // sairiam vazias em toda linha, e coluna vazia num CSV que a administracao abre
    // no Excel e convite a procurar o que nao existe.
    const comDatas = execucao.tipo === TipoExecucaoQuiz.DATA;

    // As colunas de grupo seguem a mesma regra das de janela, um nivel abaixo:
    // so entram se ALGUMA linha tem desfecho de grupo. Numa janela sem
    // `nomeGrupo` elas sairiam vazias em todas as linhas de um relatorio de
    // DATAS, que e o convite a procurar o que nao existe.
    const comGrupos = itens.some((i) => i.resultadoGrupo !== null);

    const cabecalho = [
      'Resultado',
      'Código da turma',
      'Disciplina',
      'Código da turma no AVA',
      'Questionário',
      'Código do questionário',
      'Tinha senha antes',
      ...(comDatas ? ['Formato', 'Abre em', 'Fecha em'] : []),
      ...(comGrupos
        ? ['Resultado do grupo', 'Grupo antes', 'Grupo depois']
        : []),
      'Observação',
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
        i.senhaAnteriorLida ? 'Sim' : 'Não',
        ...(comDatas
          ? [
              i.modalidadeCodigo,
              // No FUSO DA OPERACAO, e nao em UTC. O CSV e lido por pessoas, e
              // "18:00Z" faria a administracao achar que a prova das 15h abre as 18h.
              this.horarioLegivel(i.startDateAplicado),
              this.horarioLegivel(i.endDateAplicado),
            ]
          : []),
        ...(comGrupos
          ? [i.resultadoGrupo, i.grupoAnterior, i.grupoAplicado]
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

      // O formato entra no nome pelo mesmo motivo que entra na tela: as 12:01
      // saem tres arquivos, dois deles com a MESMA janela. Sem ela, dois
      // downloads no mesmo dia sao indistinguiveis na pasta de quem baixou.
      const modalidade = execucao.modalidadeCodigo
        ? `-${execucao.modalidadeCodigo}`
        : '';

      return `datas-${dia}${modalidade}${janela ? `-${janela}` : ''}-execucao-${execucao.id}.csv`;
    }

    if (execucao.tipo === TipoExecucaoQuiz.PREPARO) {
      const turno = execucao.turno
        ? rotuloDoTurno(execucao.turno)
        : 'sem-turno';
      return `preparo-special-access-${dia}-${turno}-execucao-${execucao.id}.csv`;
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
      throw new NotFoundException(`Execução ${id} não encontrada.`);

    return {
      ...execucao,
      modalidadeCodigo: execucao.janelaDeProva?.modalidade.codigo ?? null,
    };
  }

  // ------------------------------------------------------------------ interno

  /**
   * O lote de DATAS nao roda quando o special access substitui as janelas.
   *
   * Nao e cortesia: ele gravaria `StartDate`/`EndDate` num questionario que o
   * preparo deixou sem data, e procuraria uma condicao de grupo que nao existe
   * mais — cada turma viraria pendencia, e a prova ganharia a janela de UM
   * formato.
   */
  private async recusarSeSpecialAccessSubstitui(): Promise<void> {
    const config = await this.prisma.configuracaoSpecialAccess.findUnique({
      where: { id: 1 },
      select: { substituiJanelas: true },
    });

    if (!config?.substituiJanelas) return;

    throw new BadRequestException(
      'O acesso especial está substituindo as janelas (Acesso especial > ' +
        'Configuração). Desligue essa opção para voltar a aplicar datas nos ' +
        'questionários.',
    );
  }

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
          erro: 'Execução interrompida: o processo parou de dar sinal de vida.',
          concluidoEm: new Date(),
        },
      });
      return;
    }

    throw new ConflictException(
      `A execução #${emAndamento.id} ainda está rodando ` +
        `(${emAndamento.processadas} de ${emAndamento.turmasResolvidas} turmas). ` +
        'Espere terminar antes de começar outra.',
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
        // ⚠️ **O `tipo` entrou em 21/09/2026.** O lote de DATAS aponta para a
        // MESMA celula (ele grava a senha por obrigacao), e o `versaoAplicada`
        // dele e a versao da JANELA. Sem este filtro, um disparo de datas cuja
        // janela estivesse por acaso na mesma versao da celula faria este lote
        // recusar dizendo "ja aplicada" — com a senha nunca tendo sido aplicada
        // por ele.
        tipo: TipoExecucaoQuiz.SENHA,
        senhaDeProvaId,
        simulacao: false,
        status: StatusExecucao.CONCLUIDA,
        versaoAplicada: versao,
      },
      orderBy: { concluidoEm: 'desc' },
    });

    if (!ja) return;

    throw new ConflictException(
      `Esta senha já foi aplicada pela execução #${ja.id}. ` +
        'Se quiser aplicar de novo, use a opção de forçar.',
    );
  }

  /**
   * A janela do lote, com o formato e o turno que ela usa.
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
        nomeGrupo: true,
        categoriaGrupo: true,
        ativo: true,
        versao: true,
      },
    });

    if (!janela) {
      throw new NotFoundException(`Janela ${janelaId} não encontrada.`);
    }

    // Desativada NAO bloqueia o disparo MANUAL, so o do cron (que nem a
    // enxerga, porque `janelasParaDisparar` a filtra). E a mesma logica da faixa
    // inativa no agendamento administrativo: quem esta clicando e a administracao,
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
   * Recorta as turmas resolvidas para as de UM formato.
   *
   * ============================================================================
   * DE ONDE SAI O FORMATO DE UMA TURMA
   * ============================================================================
   * De lugar nenhum no cadastro: `TurmaImportada` nao tem a coluna, e isso e
   * deliberado (ver `modalidade-da-turma.service.ts`). Ela e DERIVADA dos
   * agendamentos confirmados da rodada vigente.
   *
   * Tres destinos, e a diferenca entre eles importa:
   *
   *   - formato == a da janela  -> entra no lote;
   *   - formato de OUTRA        -> sai em silencio, e NAO e erro: aquela
   *                                   turma tem a janela dela, no horario dela.
   *                                   Relatar isso encheria o CSV de linhas que
   *                                   ninguem deve tratar, que e justamente o
   *                                   ruido que ensina o time a ignorar o
   *                                   relatorio;
   *   - sem formato / ambigua   -> vira LINHA DE RELATORIO. Sao turmas que
   *                                   ficariam com a data velha, ou seja, alunos
   *                                   que nao abrem a prova.
   */
  private async recortarPelaModalidade(
    resolvidas: ResultadoResolucao,
    modalidadeId: number,
    periodoLetivoIds: string[],
    rodada: string,
  ): Promise<{
    turmas: TurmaResolvida[];
    foraDaModalidade: ItemParaGravar[];
    semModalidade: number;
    modalidadeAmbigua: number;
    codigoDaModalidade: string | null;
  }> {
    const mapa = await this.modalidades.resolver(periodoLetivoIds, rodada);

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
        // Outro formato: silencio proposital, ver o cabecalho.
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
    grupoDaJanelaId: number | null,
    versaoGrupo: number | null,
    versaoSenha: number,
  ): Promise<void> {
    const ja = await this.prisma.execucaoSenhaQuiz.findFirst({
      where: {
        // ⚠️ Desde 21/09/2026 o lote de SENHAS tambem grava `janelaDeProvaId`.
        // Sem o tipo aqui, a troca de senha das 12:01 faria a troca de DATA das
        // 12:01 parecer ja aplicada — e a prova ficaria com o horario anterior.
        tipo: TipoExecucaoQuiz.DATA,
        janelaDeProvaId,
        data,
        // ⚠️ A VERSAO entra na chave. Sem ela, corrigir o horario de uma janela
        // que ja rodou hoje nao a libera — o `upsert` preserva o id da linha, e
        // esta consulta encontraria a execucao antiga. Bug real de 25/08/2026.
        versaoAplicada: versao,
        // A celula da grade de grupos, pelo mesmo motivo (14/09/2026): criar ou
        // corrigir o grupo de hoje depois do disparo nao muda a versao da
        // JANELA. O cron usa a mesma chave em `motivoParaNaoDisparar`.
        grupoDaJanelaId,
        versaoGrupoAplicada: versaoGrupo,
        // E a SENHA, pelo mesmo motivo (21/09/2026): o disparo grava as tres
        // coisas, e gerar a senha de novo as 12:43 deixa o questionario com a
        // anterior. Sem isto na chave, a correcao so valeria no dia seguinte.
        versaoSenhaAplicada: versaoSenha,
        simulacao: false,
        status: StatusExecucao.CONCLUIDA,
      },
      orderBy: { concluidoEm: 'desc' },
    });

    if (!ja) return;

    throw new ConflictException(
      `Esta janela já foi aplicada em ${isoDeDataUtc(data).split('-').reverse().join('/')} pela execução #${ja.id}, ` +
        'com estes mesmos horários. Se quiser aplicar de novo sem mudar nada, ' +
        'use a opção de forçar — corrigir o horário na tela já libera sozinho.',
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
    tipo: TipoExecucaoQuiz;
    turmas: TurmaResolvida[];
    naoResolvidas: TurmaNaoResolvida[];
    /** Turmas descartadas por falta de formato — so no lote de DATAS. */
    foraDaModalidade: ItemParaGravar[];
    senha: string;
    alvo: { nomeQuiz: string; matchQuiz: TipoMatchQuiz };
    /** `null` = lote de senhas: o calendario do questionario nao e tocado. */
    janela: { inicio: Date; fim: Date; codigo: string | null } | null;
    /** `null` = a janela nao tem grupo cadastrado; as condicoes nao sao tocadas. */
    grupo: { nome: string; categoria: string | null } | null;
    /**
     * A janela usa a grade de grupos e o dia ficou em branco. As condicoes nao
     * sao tocadas (nao ha nome), mas cada questionario vira PENDENCIA.
     */
    semGrupoNoDia: boolean;
    simulacao: boolean;
    iniciadoPor: string;
  }): Promise<void> {
    const {
      execucaoId,
      tipo,
      turmas,
      naoResolvidas,
      foraDaModalidade,
      senha,
      alvo,
      janela,
      grupo,
      semGrupoNoDia,
      simulacao,
      iniciadoPor,
    } = entrada;

    const ritmo = carregarRitmo(this.config);
    const preparo = tipo === TipoExecucaoQuiz.PREPARO;

    // A sessao (e o cache de grupos por turma) nasce e morre com ESTE lote — ver
    // o cabecalho de `resolucao-grupo.service.ts`. Um grupo criado no
    // Brightspace as 11h precisa estar visivel no disparo das 12:01.
    const grupoDoLote: GrupoDoLote | null = grupo
      ? {
          nome: grupo.nome,
          categoria: grupo.categoria,
          sessao: this.grupos.paraOLote(grupo.nome, grupo.categoria, ritmo),
        }
      : null;

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
        // Resolveram o orgUnitId mas nao tem formato derivavel. Sao as linhas
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
        gruposTrocados: 0,
        gruposPendentes: 0,
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
              preparo,
              senha,
              alvo,
              janela: janelaDoQuiz,
              grupo: grupoDoLote,
              semGrupoNoDia,
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

          // ⚠️ Contado a PARTE do `resultado`, porque os dois desfechos sao
          // independentes: a mesma linha pode ter a data DEFINIDA e o grupo
          // pendente, que e o caso que este contador existe para nao esconder.
          switch (item.resultadoGrupo) {
            case undefined:
            case null:
              break;
            case ResultadoGrupoQuiz.TROCADO:
            case ResultadoGrupoQuiz.SIMULADO:
            case ResultadoGrupoQuiz.JA_ERA_O_GRUPO:
            case ResultadoGrupoQuiz.REMOVIDO:
            case ResultadoGrupoQuiz.REMOCAO_SIMULADA:
              contagem.gruposTrocados += 1;
              break;
            case ResultadoGrupoQuiz.SEM_CONDICAO_DE_GRUPO:
              // No PREPARO, nao ter condicao de grupo e o estado desejado. Na
              // troca de grupo, e a prova aberta para a sessao anterior.
              if (preparo) contagem.gruposTrocados += 1;
              else contagem.gruposPendentes += 1;
              break;
            default:
              // Todo o resto e pendencia, inclusive os casos "esperados" como
              // SEM_CONDICAO_DE_GRUPO. Nao ha desfecho neutro aqui: se a
              // condicao nao aponta para o grupo desta sessao, a prova abre para
              // a sessao anterior. Ver o comentario de `gruposPendentes` no
              // schema.
              contagem.gruposPendentes += 1;
          }

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

      this.auditoria.registrar(eventoDoLote(tipo, 'CONCLUIDA'), {
        ator: iniciadoPor,
        detalhe:
          `execucao ${execucaoId}: ${contagem.definidas} questionario(s) ` +
          `${simulacao ? 'simulado(s)' : 'atualizado(s)'}, ` +
          `${contagem.naoEncontradas} sem questionario, ${contagem.falhas} falha(s), ` +
          `${naoResolvidas.length} turma(s) nao resolvida(s)` +
          (janela ? `, ${foraDaModalidade.length} sem formato derivavel` : '') +
          // O grupo entra no log so quando havia grupo a trocar: numa janela
          // sem `nomeGrupo` os dois numeros seriam zero em toda execucao, e
          // zero permanente e o ruido que ensina o time a ignorar a linha.
          (grupoDoLote
            ? `; grupo "${grupoDoLote.nome}": ${contagem.gruposTrocados} ` +
              `trocado(s), ${contagem.gruposPendentes} pendente(s)`
            : semGrupoNoDia
              ? `; SEM grupo na grade do dia: ${contagem.gruposPendentes} pendente(s)`
              : ''),
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

      this.auditoria.registrar(eventoDoLote(tipo, 'FALHOU'), {
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
  private async aplicarNaTurma(entrada: {
    turma: TurmaResolvida;
    /** O PREPARO: sem janela, sem grupo, e as condicoes de grupo saem. */
    preparo: boolean;
    senha: string;
    alvo: { nomeQuiz: string; matchQuiz: TipoMatchQuiz };
    janela?: JanelaDoQuiz;
    grupo: GrupoDoLote | null;
    semGrupoNoDia: boolean;
    modalidadeCodigo: string | null;
    simulacao: boolean;
    ritmo: RitmoDoLote;
  }): Promise<ItemParaGravar[]> {
    const {
      turma,
      preparo,
      senha,
      alvo,
      janela,
      grupo,
      semGrupoNoDia,
      modalidadeCodigo,
      simulacao,
      ritmo,
    } = entrada;

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
            `Nenhum questionário casou com "${alvo.nomeQuiz}" (${alvo.matchQuiz}) ` +
            `entre os ${lista.length} da turma.`,
        },
      ];
    }

    // O grupo e por TURMA, nao por quiz: "Prova 2" tem um id so dentro da turma,
    // e as provas dela compartilham esse id. Resolver aqui, uma vez, poupa duas
    // chamadas por quiz casado — e o cache da sessao poupa as desta turma se ela
    // reaparecer.
    let alvoDoGrupo: AlvoNaTurma | null = null;
    let falhaDoGrupo: {
      resultadoGrupo: ResultadoGrupoQuiz;
      detalhe: string | null;
    } | null = null;

    if (grupo) {
      const resolvido = await grupo.sessao.resolver(turma.orgUnitId);

      if (resolvido.alvo) {
        alvoDoGrupo = {
          groupId: resolvido.alvo.GroupId,
          rotulo: `${resolvido.alvo.Name} (#${resolvido.alvo.GroupId})`,
          nomePorId: resolvido.nomePorId,
        };
      } else {
        // ⚠️ A turma NAO e interrompida. A data e a senha seguem normalmente e
        // cada quiz vira uma linha com a pendencia de grupo — decisao do cliente
        // (26/08/2026): sem a data a prova nao abre para NINGUEM; sem a troca de
        // grupo ela abre para o grupo anterior. Trocar o problema menor pelo
        // maior seria o oposto do que se pediu.
        falhaDoGrupo = {
          resultadoGrupo:
            resolvido.falha ?? ResultadoGrupoQuiz.GRUPO_NAO_ENCONTRADO,
          detalhe: resolvido.motivo,
        };
      }
    } else if (semGrupoNoDia) {
      // Nenhuma chamada de grupo: nao ha nome a procurar. Mas a linha NAO fica
      // com `resultadoGrupo` nulo ("nao tentou") — a condicao continua no grupo
      // da sessao anterior, e isso e pendencia com o mesmo peso das outras.
      falhaDoGrupo = {
        resultadoGrupo: ResultadoGrupoQuiz.SEM_GRUPO_NO_DIA,
        detalhe:
          'A grade de grupos não tem este dia para esta janela, e a janela não ' +
          'tem nome padrão. A condição de acesso não foi trocada.',
      };
    }

    const itens: ItemParaGravar[] = [];

    for (const casado of casados) {
      const quizId = String(casado.QuizId ?? '');

      if (preparo) {
        itens.push(
          await this.prepararQuiz({
            base,
            turma,
            quizId,
            nomeQuiz: casado.Name ?? null,
            senha,
            simulacao,
            ritmo,
          }),
        );
        continue;
      }

      itens.push(
        await this.aplicarNoQuiz({
          base,
          turma,
          quizId,
          nomeQuiz: casado.Name ?? null,
          senha,
          janela,
          alvoDoGrupo,
          falhaDoGrupo,
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
    /** `null` = a janela nao troca grupo, ou a resolucao falhou (ver abaixo). */
    alvoDoGrupo: AlvoNaTurma | null;
    /** Preenchido quando a resolucao do grupo falhou NESTA turma. */
    falhaDoGrupo: {
      resultadoGrupo: ResultadoGrupoQuiz;
      detalhe: string | null;
    } | null;
    simulacao: boolean;
    ritmo: RitmoDoLote;
  }): Promise<ItemParaGravar> {
    const {
      base,
      turma,
      quizId,
      nomeQuiz,
      senha,
      janela,
      alvoDoGrupo,
      falhaDoGrupo,
      simulacao,
      ritmo,
    } = entrada;

    // ========================================================================
    // ⚠️ O GRUPO VEM ANTES DO QUIZ, E A ORDEM NAO E INDIFERENTE.
    // ========================================================================
    // O PUT do quiz e o que ABRE a prova no horario novo. Trocando o grupo
    // primeiro, o estado intermediario entre as duas escritas e "janela antiga +
    // grupo novo": a prova esta fechada, e ninguem e prejudicado se a segunda
    // chamada falhar. Na ordem inversa o intermediario seria "janela nova +
    // grupo antigo" — a prova ABERTA para a sessao anterior, que e exatamente o
    // que este recurso existe para impedir.
    //
    // Sao dois recursos independentes da API (LP para condicoes, LE para o
    // quiz): nao ha transacao possivel entre eles, entao o que se escolhe aqui e
    // qual dos dois estados intermediarios se prefere.
    const { detalheGrupo, ...camposDeGrupo } = await this.trocarGrupoDoQuiz({
      turma,
      quizId,
      alvoDoGrupo,
      falhaDoGrupo,
      simulacao,
      ritmo,
    });

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
        ...camposDeGrupo,
        quizId,
        nomeQuiz,
        resultado: ResultadoSenhaQuiz.FALHA_AO_LER,
        detalhe: this.juntarDetalhe(this.motivo(erro), detalheGrupo),
      };
    }

    const senhaAnteriorLida = quiz.Password != null && quiz.Password !== '';

    if (simulacao) {
      return {
        ...base,
        ...camposDeGrupo,
        quizId,
        nomeQuiz: quiz.Name ?? nomeQuiz,
        resultado: ResultadoSenhaQuiz.SIMULADA,
        senhaAnteriorLida,
        detalhe: this.juntarDetalhe(null, detalheGrupo),
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
        ...camposDeGrupo,
        quizId,
        nomeQuiz: quiz.Name ?? nomeQuiz,
        resultado: ResultadoSenhaQuiz.FALHA_AO_GRAVAR,
        senhaAnteriorLida,
        detalhe: this.juntarDetalhe(this.motivo(erro), detalheGrupo),
      };
    }

    return {
      ...base,
      ...camposDeGrupo,
      quizId,
      nomeQuiz: quiz.Name ?? nomeQuiz,
      resultado: ResultadoSenhaQuiz.DEFINIDA,
      senhaAnteriorLida,
      detalhe: this.juntarDetalhe(null, detalheGrupo),
    };
  }

  /**
   * A troca da condicao de liberacao de UM questionario.
   *
   * **NUNCA lanca**, pela mesma razao de `aplicarNaTurma`: o desfecho do grupo e
   * independente do da data, e uma excecao aqui derrubaria a aplicacao da janela
   * — trocando o problema menor (prova aberta para o grupo anterior) pelo maior
   * (prova que nao abre para ninguem).
   *
   * Devolve so os campos de grupo do item; quem os junta ao resto e o `...grupo`
   * dos returns de `aplicarNoQuiz`.
   */
  private async trocarGrupoDoQuiz(entrada: {
    turma: TurmaResolvida;
    quizId: string;
    alvoDoGrupo: AlvoNaTurma | null;
    falhaDoGrupo: {
      resultadoGrupo: ResultadoGrupoQuiz;
      detalhe: string | null;
    } | null;
    simulacao: boolean;
    ritmo: RitmoDoLote;
  }): Promise<{
    resultadoGrupo: ResultadoGrupoQuiz | null;
    grupoAnterior: string | null;
    grupoAplicado: string | null;
    condicoesAnteriores: string | null;
    /** Anexado ao `detalhe` do item quando ha o que explicar. */
    detalheGrupo: string | null;
  }> {
    const { turma, quizId, alvoDoGrupo, falhaDoGrupo, simulacao, ritmo } =
      entrada;

    const vazio = {
      resultadoGrupo: null,
      grupoAnterior: null,
      grupoAplicado: null,
      condicoesAnteriores: null,
      detalheGrupo: null,
    };

    // A resolucao ja falhou nesta turma. Uma linha por quiz, com o motivo — e
    // nenhuma chamada a mais, porque o problema nao esta no questionario.
    if (falhaDoGrupo) {
      return {
        ...vazio,
        resultadoGrupo: falhaDoGrupo.resultadoGrupo,
        detalheGrupo: falhaDoGrupo.detalhe,
      };
    }

    // A janela nao troca grupo. `resultadoGrupo` fica NULO: ausencia de
    // tentativa, nao desfecho ruim.
    if (!alvoDoGrupo) return vazio;

    let condicoes: CondicoesLidas | null;

    try {
      condicoes = await this.condicoes.lerCondicoes<CondicoesLidas>(
        turma.orgUnitId,
        quizId,
        ritmo,
      );
    } catch (erro) {
      return {
        ...vazio,
        resultadoGrupo: ResultadoGrupoQuiz.FALHA_AO_LER_CONDICOES,
        grupoAplicado: alvoDoGrupo.rotulo,
        detalheGrupo: this.motivo(erro),
      };
    }

    // ⚠️ O BACKUP E GRAVADO ANTES DE QUALQUER ESCRITA, e tambem na SIMULACAO.
    // O PUT substitui a lista inteira de condicoes e a API nao guarda historico:
    // sem esta fotografia, uma troca errada nao tem desfazer. O CLI de origem
    // grava o mesmo JSON em `logs/backup/` pelo mesmo motivo, dry-run incluido —
    // e no dry-run que se descobre o que a prova tem hoje.
    const condicoesAnteriores = this.serializarCondicoes(condicoes);

    const anteriores = gruposDasCondicoes(condicoes);
    const grupoAnterior =
      anteriores.length > 0
        ? anteriores
            .map((id) => rotularGrupo(id, alvoDoGrupo.nomePorId))
            .join(' + ')
        : null;

    const troca = trocarGrupoNasCondicoes(condicoes, alvoDoGrupo.groupId);

    if (!troca.corpo) {
      // Nenhuma condicao `EnrolledInGroup` com GroupId. NADA e criado — ver o
      // comentario de SEM_CONDICAO_DE_GRUPO no schema.
      return {
        ...vazio,
        condicoesAnteriores,
        grupoAnterior,
        grupoAplicado: alvoDoGrupo.rotulo,
        resultadoGrupo: troca.porCategoria
          ? ResultadoGrupoQuiz.CONDICAO_POR_CATEGORIA
          : ResultadoGrupoQuiz.SEM_CONDICAO_DE_GRUPO,
        detalheGrupo:
          troca.avisos.join(' ') ||
          'A prova nao tem condicao de liberacao por grupo para trocar. Este ' +
            'lote so TROCA condicao existente, nunca cria — criar mudaria o ' +
            'comportamento de uma prova que talvez seja aberta a todos de ' +
            'proposito.',
      };
    }

    const jaEra =
      troca.antes.length === 1 && troca.antes[0] === alvoDoGrupo.groupId;

    const comum = {
      condicoesAnteriores,
      grupoAnterior,
      grupoAplicado: alvoDoGrupo.rotulo,
      detalheGrupo: troca.avisos.join(' ') || null,
    };

    if (simulacao) {
      // ⚠️ ZERO PUT no dry-run, aqui como no do quiz. E a unica conferencia
      // possivel antes de mexer na condicao de liberacao de toda a instituicao,
      // e ha teste so para provar que nenhuma escrita sai daqui.
      return { ...comum, resultadoGrupo: ResultadoGrupoQuiz.SIMULADO };
    }

    // Ja estava no grupo certo: o PUT seria uma escrita sem efeito num endpoint
    // que substitui tudo. Reprocessar a mesma janela cai aqui, e e o caso comum
    // depois de um `forcar`.
    if (jaEra) {
      return { ...comum, resultadoGrupo: ResultadoGrupoQuiz.JA_ERA_O_GRUPO };
    }

    try {
      await this.condicoes.gravarCondicoes(
        turma.orgUnitId,
        quizId,
        troca.corpo,
        ritmo,
      );
    } catch (erro) {
      return {
        ...comum,
        resultadoGrupo: ResultadoGrupoQuiz.FALHA_AO_GRAVAR_CONDICOES,
        detalheGrupo: [comum.detalheGrupo, this.motivo(erro)]
          .filter(Boolean)
          .join(' '),
      };
    }

    return { ...comum, resultadoGrupo: ResultadoGrupoQuiz.TROCADO };
  }

  /**
   * O PREPARO de UM questionario para o special access (15/09/2026): sem data,
   * restrito a quem tem special access, e sem condicao de liberacao por grupo.
   *
   * ⚠️ O QUIZ VEM ANTES DAS CONDICOES — o inverso da troca de grupo, pelo mesmo
   * raciocinio de escolher o estado intermediario menos perigoso. Gravando o
   * quiz primeiro, o intermediario e "restrito + condicao de grupo ainda la": a
   * prova fica FECHADA para quem nao tem as duas coisas. Na ordem inversa, seria
   * "sem condicao + aberto a turma", a prova liberada para todos nas datas
   * antigas. Por isso, se o PUT do quiz falhar, as condicoes nao sao tocadas.
   *
   * **NUNCA lanca**, como `aplicarNoQuiz`.
   */
  private async prepararQuiz(entrada: {
    base: Omit<ItemParaGravar, 'quizId' | 'nomeQuiz' | 'resultado' | 'detalhe'>;
    turma: TurmaResolvida;
    quizId: string;
    nomeQuiz: string | null;
    senha: string;
    simulacao: boolean;
    ritmo: RitmoDoLote;
  }): Promise<ItemParaGravar> {
    const { base, turma, quizId, nomeQuiz, senha, simulacao, ritmo } = entrada;

    let quiz: QuizLido;

    try {
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

    const comum = {
      ...base,
      quizId,
      nomeQuiz: quiz.Name ?? nomeQuiz,
      senhaAnteriorLida: quiz.Password != null && quiz.Password !== '',
    };

    const situacao = jaPreparado(quiz)
      ? 'Já estava sem data e restrito a quem tem acesso especial.'
      : null;

    if (!simulacao) {
      try {
        await this.quizzes.gravarQuiz(
          turma.orgUnitId,
          quizId,
          montarCorpoDoPreparo(quiz, senha),
          ritmo,
        );
      } catch (erro) {
        return {
          ...comum,
          resultado: ResultadoSenhaQuiz.FALHA_AO_GRAVAR,
          detalhe:
            `${this.motivo(erro)} As condições de liberação NÃO foram tocadas.`.slice(
              0,
              900,
            ),
        };
      }
    }

    const { detalheGrupo, ...camposDeGrupo } = await this.removerGruposDoQuiz({
      turma,
      quizId,
      simulacao,
      ritmo,
    });

    return {
      ...comum,
      ...camposDeGrupo,
      resultado: simulacao
        ? ResultadoSenhaQuiz.SIMULADA
        : ResultadoSenhaQuiz.DEFINIDA,
      detalhe: this.juntarDetalhe(situacao, detalheGrupo),
    };
  }

  /**
   * Tira as condicoes de liberacao por GRUPO de UM questionario — o outro lado
   * do preparo. Com a prova restrita a special access, a condicao de grupo deixa
   * de liberar e passa a TRANCAR: o special access nao passa por cima dela.
   *
   * **NUNCA lanca.** O backup das condicoes e gravado antes de qualquer escrita,
   * tambem na simulacao — ver `trocarGrupoDoQuiz`.
   */
  private async removerGruposDoQuiz(entrada: {
    turma: TurmaResolvida;
    quizId: string;
    simulacao: boolean;
    ritmo: RitmoDoLote;
  }): Promise<{
    resultadoGrupo: ResultadoGrupoQuiz;
    grupoAnterior: string | null;
    grupoAplicado: string | null;
    condicoesAnteriores: string | null;
    detalheGrupo: string | null;
  }> {
    const { turma, quizId, simulacao, ritmo } = entrada;

    const vazio = {
      grupoAnterior: null,
      grupoAplicado: null,
      condicoesAnteriores: null,
      detalheGrupo: null,
    };

    let condicoes: CondicoesLidas | null;

    try {
      condicoes = await this.condicoes.lerCondicoes<CondicoesLidas>(
        turma.orgUnitId,
        quizId,
        ritmo,
      );
    } catch (erro) {
      return {
        ...vazio,
        resultadoGrupo: ResultadoGrupoQuiz.FALHA_AO_LER_CONDICOES,
        detalheGrupo: this.motivo(erro),
      };
    }

    const condicoesAnteriores = this.serializarCondicoes(condicoes);
    const anteriores = gruposDasCondicoes(condicoes);
    const remocao = removerGruposDasCondicoes(condicoes);

    if (!remocao.corpo) {
      return {
        ...vazio,
        condicoesAnteriores,
        resultadoGrupo: ResultadoGrupoQuiz.SEM_CONDICAO_DE_GRUPO,
      };
    }

    const comum = {
      condicoesAnteriores,
      grupoAnterior: anteriores.length
        ? anteriores.map((id) => `#${id}`).join(' + ')
        : 'condicao por categoria',
      grupoAplicado: null,
      detalheGrupo:
        remocao.preservadas > 0
          ? `${remocao.preservadas} condicao(oes) de outro tipo mantida(s).`
          : null,
    };

    if (simulacao) {
      return { ...comum, resultadoGrupo: ResultadoGrupoQuiz.REMOCAO_SIMULADA };
    }

    try {
      await this.condicoes.gravarCondicoes(
        turma.orgUnitId,
        quizId,
        remocao.corpo,
        ritmo,
      );
    } catch (erro) {
      return {
        ...comum,
        resultadoGrupo: ResultadoGrupoQuiz.FALHA_AO_GRAVAR_CONDICOES,
        detalheGrupo: [comum.detalheGrupo, this.motivo(erro)]
          .filter(Boolean)
          .join(' '),
      };
    }

    return { ...comum, resultadoGrupo: ResultadoGrupoQuiz.REMOVIDO };
  }

  /**
   * O JSON do GET das condicoes, para a coluna de backup.
   *
   * O teto existe para proteger o LOTE, nao o banco: `condicoesAnteriores` e
   * `TEXT` (64 KB) e os itens sao gravados com `createMany`, entao uma unica
   * expressao gigante derrubaria a gravacao da FATIA INTEIRA de turmas. Uma
   * condicao real tem poucos KB; se algum dia passar disso, e melhor perder o
   * desfazer de uma linha — dizendo isso em voz alta no lugar do JSON — do que
   * perder o relatorio de quatro turmas.
   */
  private serializarCondicoes(condicoes: CondicoesLidas | null): string | null {
    if (!condicoes) return null;

    const texto = JSON.stringify(condicoes);

    return texto.length > 60_000
      ? `[condicoes com ${texto.length} caracteres — nao guardadas; ` +
          'use o GET de conditionalRelease para recupera-las]'
      : texto;
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
   * Um instante UTC como a administracao le: dia e hora de Brasilia.
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

  /**
   * Junta a explicacao da DATA com a do GRUPO numa coluna so.
   *
   * Os dois desfechos moram em colunas separadas (`resultado` e
   * `resultadoGrupo`), mas o `detalhe` e um campo unico — e ele e o que a
   * administracao le no CSV. Prefixar a parte do grupo evita a leitura mais cara
   * possivel: "a prova falhou ao gravar" quando o que falhou foi o grupo, e a
   * data entrou.
   */
  private juntarDetalhe(
    daData: string | null,
    doGrupo: string | null,
  ): string | null {
    const partes = [daData, doGrupo ? `Grupo: ${doGrupo}` : null].filter(
      (p): p is string => Boolean(p),
    );

    return partes.length ? partes.join(' | ').slice(0, 900) : null;
  }
}
