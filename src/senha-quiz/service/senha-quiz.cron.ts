import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service';
import { D2lQuizzesService } from '../../d2l/service/d2l-quizzes.service';
import {
  OrigemExecucao,
  StatusExecucao,
  TipoExecucaoQuiz,
  Turno,
} from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { carregarConfigDoCron } from '../config/senha-quiz.config';
import { GradeGruposService } from './grade-grupos.service';
import { GradeSenhasService } from './grade-senhas.service';
import { janelasParaDisparar } from './janela';
import { agoraNaOperacao, diaSeguinteDe, isoDeDataUtc } from './relogio';
import { SenhaQuizService } from './senha-quiz.service';
import { minutosDaHora, rotuloDoTurno, turnoParaDisparar } from './turno';

/**
 * ============================================================================
 * O SERVIDOR TROCA A SENHA SOZINHO, NO HORARIO
 * ============================================================================
 * Um tick por minuto que pergunta a uma funcao PURA (`turnoParaDisparar`) se e
 * hora de aplicar alguma celula da grade.
 *
 * POR QUE UM TICK, e nao tres `@Cron` com expressao de horario: decorator e
 * avaliado uma vez, na subida, e registrar jobs imperativamente pelo
 * `SchedulerRegistry` trocaria uma decisao testavel por infraestrutura. Com o
 * tick, o miolo e uma funcao pura com teste — e desde que os horarios passaram a
 * ser escolhidos pelo ADMIN na tela (19/08/2026), isso deixou de ser so elegancia:
 * salvar 07:30 pela tela precisa valer no minuto seguinte, sem reiniciar nada.
 *
 * **O cron NUNCA roda em simulacao.** Um dry-run agendado produz um relatorio
 * que ninguem le e da falsa seguranca. A rede de protecao equivalente e outra e
 * e mais forte: **nada acontece se um humano nao tiver digitado a senha daquela
 * celula** — sem linha em `senha_de_prova`, o tick sai avisando.
 *
 * MULTI-INSTANCIA: o `docker-compose.prod.yml` ja fixa UMA replica (por causa
 * dos stores de LTI em memoria). A checagem de idempotencia e transacional, com
 * lock de linha, entao o pior caso com duas replicas seria uma perder a corrida
 * e sair — mas a chave de operacao continua sendo `SENHA_QUIZ_CRON_HABILITADO=false`
 * na replica extra. E por isso que ESSA chave ficou no .env quando os horarios
 * foram para o banco: ela e por instancia, os horarios sao da instituicao.
 *
 * ============================================================================
 * DESDE 25/08/2026 O TICK DECIDE DUAS COISAS
 * ============================================================================
 * A SENHA (uma celula da grade, em todas as turmas) e a DATA (uma janela, nas
 * turmas de uma modalidade). Sao dois calendarios independentes: tres horarios
 * de turno contra ate seis janelas por modalidade.
 *
 * ⚠️ **UM DISPARO POR TICK, e nunca dois.** Os dois lotes fazem GET -> altera ->
 * PUT no MESMO questionario, e o PUT substitui o objeto inteiro;
 * `recusarSeJaRodando()` ja os serializa, entao tentar dois no mesmo minuto so
 * produziria um 409 e uma linha de erro. Em vez disso o tick escolhe UM e deixa
 * o resto para o minuto seguinte — a janela de tolerancia (30 min por padrao)
 * cobre folgadamente os tres disparos que as 12:01 tem a fazer.
 *
 * A DATA VEM PRIMEIRO quando as duas competem. Se o questionario ficar sem a
 * janela nova, ele continua fechado (ou aberto na sessao anterior) e ninguem faz
 * a prova; se ficar com a senha do turno anterior por mais um minuto, o pior
 * caso e um aluno usando a senha velha numa prova que ja esta aberta para ele.
 * A primeira falha impede a prova, a segunda so a adianta.
 */
@Injectable()
export class SenhaQuizCron {
  private readonly logger = new Logger(SenhaQuizCron.name);

  /**
   * Celulas ja avisadas nesta subida do processo.
   *
   * A janela de tolerancia faz o tick reencontrar a mesma situacao a cada minuto
   * por ate 30 minutos; sem esta memoria, "sem senha cadastrada" viraria 30
   * linhas identicas de log e auditoria — o volume que ensina o time a ignorar
   * o aviso justamente quando ele importa.
   */
  private avisadas = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly quizzes: D2lQuizzesService,
    private readonly lote: SenhaQuizService,
    private readonly grade: GradeSenhasService,
    private readonly auditoria: AuditoriaService,
    private readonly gradeGrupos: GradeGruposService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    try {
      await this.decidir();
    } catch (erro) {
      // Um tick nunca pode derrubar o processo: ele volta em 60s, e o turno
      // seguinte depende de o agendador continuar de pe.
      this.logger.error(
        `Falha no tick do cron de senhas: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
  }

  private async decidir(): Promise<void> {
    const cfg = carregarConfigDoCron(this.config);

    // (1) Opt-in DESTA INSTANCIA, no .env. Separado do D2L_HABILITADO de
    // proposito, e separado dos horarios: aqui a pergunta e "esta replica
    // dispara?", nao "a que horas a prova comeca".
    if (!cfg.habilitado) return;

    const { data, hhmm } = agoraNaOperacao();

    // (0) A DATA VEM PRIMEIRO. Ver o cabecalho: sem a janela nova o
    // questionario nao abre, e ai ninguem faz a prova. `true` = disparou algo,
    // e o tick para por aqui — um lote por minuto.
    //
    // (0a) ...a menos que o SPECIAL ACCESS substitua as janelas (15/09/2026). O
    // questionario preparado nao tem data, e aplicar uma janela aqui o abriria
    // no horario de UMA modalidade. A senha continua, logo abaixo.
    const substituidas = await this.janelasSubstituidas(data);
    if (!substituidas && (await this.decidirDatas(data, hhmm, cfg))) return;

    // (2) Os horarios vem do BANCO, escolhidos pelo admin. Ler a cada tick e o
    // que faz uma correcao pela tela as 07:25 valer as 07:30.
    const horarios = await this.grade.horariosDoCron();
    const nenhumHorario = Object.values(horarios).every(
      (hora) => minutosDaHora(hora) == null,
    );

    // (2a) Cron ligado no servidor e nenhum horario cadastrado: ele nunca vai
    // disparar. NAO e erro — pode ser um ambiente recem-configurado —, mas
    // calar aqui e entregar um cron que parece armado e nao esta.
    if (nenhumHorario) {
      this.avisarUmaVez(
        `${isoDeDataUtc(data)}#sem-horario`,
        'SENHA_QUIZ_CRON_SEM_HORARIO',
        data,
        null,
      );
      return;
    }

    // (3) Fora de qualquer janela.
    const turno = turnoParaDisparar(hhmm, horarios, cfg.toleranciaMin);
    if (!turno) return;

    const chave = `${isoDeDataUtc(data)}#${turno}`;

    // (4) Sem celula na grade. NAO e erro: sabado a noite nao tem prova, e a
    // grade do cliente reflete isso. O aviso e o valor — ele diz que o horario
    // chegou e ninguem preencheu.
    const celula = await this.prisma.senhaDeProva.findUnique({
      where: { data_turno: { data, turno } },
    });

    if (!celula) {
      this.avisarUmaVez(chave, 'SENHA_QUIZ_CRON_SEM_GRADE', data, turno);
      return;
    }

    // (5) Integracao desligada. Tambem nao derruba o tick.
    if (!this.quizzes.habilitado()) {
      this.avisarUmaVez(chave, 'SENHA_QUIZ_CRON_IGNORADO', data, turno);
      return;
    }

    // (6) Idempotencia, NO BANCO — e o que sobrevive a um restart.
    if (
      !(await this.podeDisparar(celula.id, celula.versao, cfg.maxTentativas))
    ) {
      return;
    }

    this.logger.log(
      `Cron: aplicando a senha de ${isoDeDataUtc(data)} (${rotuloDoTurno(turno)}).`,
    );

    await this.lote.iniciar(
      {
        data: isoDeDataUtc(data),
        turno,
        // O cron existe para APLICAR. Ver o cabecalho.
        simulacao: false,
        forcar: false,
      },
      'cron',
      OrigemExecucao.CRON,
    );

    this.avisadas.delete(chave);
  }

  /**
   * O special access substitui as janelas? Le do BANCO a cada tick, como os
   * horarios: ligar a opcao na tela as 11:59 precisa valer no disparo das 12:01.
   */
  private async janelasSubstituidas(data: Date): Promise<boolean> {
    const config = await this.prisma.configuracaoSpecialAccess.findUnique({
      where: { id: 1 },
      select: { substituiJanelas: true },
    });

    if (!config?.substituiJanelas) return false;

    this.avisarUmaVez(
      `${isoDeDataUtc(data)}#special-access`,
      'DATA_QUIZ_CRON_SUBSTITUIDO',
      data,
      null,
    );

    return true;
  }

  /**
   * A janela a aplicar neste minuto, se houver.
   *
   * Devolve `true` quando disparou alguma coisa — o tick para ai, e a senha (ou
   * a proxima janela) fica para o minuto seguinte.
   */
  private async decidirDatas(
    data: Date,
    hhmm: string,
    cfg: { toleranciaMin: number; maxTentativas: number },
  ): Promise<boolean> {
    // Os horarios vem do BANCO a cada tick, como os dos turnos: e o que faz uma
    // correcao pela tela as 15:25 valer as 15:31.
    const janelas = await this.prisma.janelaDeProva.findMany({
      where: { ativo: true },
      select: {
        id: true,
        modalidadeId: true,
        horaDisparo: true,
        horaInicio: true,
        horaFim: true,
        turno: true,
        diaSeguinte: true,
        ativo: true,
        versao: true,
        // Para achar o grupo do dia: a celula dele entra na idempotencia.
        nomeGrupo: true,
        categoriaGrupo: true,
        modalidade: { select: { codigo: true } },
      },
      orderBy: [{ modalidadeId: 'asc' }, { ordem: 'asc' }],
    });

    // Nenhuma janela ATIVA cadastrada. Nao e erro — pode ser um semestre sem
    // prova online —, mas calar entregaria um cron que parece armado e nao esta.
    // Mesma escolha de SENHA_QUIZ_CRON_SEM_HORARIO.
    if (janelas.length === 0) {
      this.avisarUmaVez(
        `${isoDeDataUtc(data)}#sem-janela`,
        'DATA_QUIZ_CRON_SEM_JANELA',
        data,
        null,
      );
      return false;
    }

    const candidatas = janelasParaDisparar(hhmm, janelas, cfg.toleranciaMin);
    if (candidatas.length === 0) return false;

    // A partir daqui HOUVE candidata. Toda saida abaixo precisa deixar rastro:
    // um tick que encontra janelas no horario e nao aplica nenhuma, calado, e o
    // pior estado possivel — foi assim que a correcao de horario das 12:43
    // pareceu simplesmente nao funcionar em 25/08/2026.
    const puladas: string[] = [];

    if (!this.quizzes.habilitado()) {
      this.avisarUmaVez(
        `${isoDeDataUtc(data)}#${hhmm}#datas`,
        'DATA_QUIZ_CRON_IGNORADO',
        data,
        null,
      );
      return false;
    }

    for (const janela of candidatas) {
      // O dia que o QUESTIONARIO passa a ter. `diaSeguinte` cobre os disparos da
      // noite (22:01 no EaD, 21:31 no Semi/Modular), que armam a prova da manha
      // seguinte.
      const alvo = janela.diaSeguinte ? diaSeguinteDe(data) : data;
      const chave = `${isoDeDataUtc(alvo)}#janela${janela.id}`;

      // Idempotencia NO BANCO — e o que sobrevive ao restart. Se esta janela ja
      // rodou hoje, passa para a proxima candidata em vez de sair: as 12:01 sao
      // tres modalidades, e parar na primeira ja concluida deixaria as outras
      // duas para o minuto seguinte sem necessidade.
      // A celula da grade de grupos do dia ALVO — a janela das 22:01 le a de
      // amanha, como a senha. Mesma consulta que o lote fara ao comecar.
      const grupoDoDia = await this.gradeGrupos.doDia(janela, alvo);

      const motivoDoPulo = await this.motivoParaNaoDisparar(
        janela.id,
        janela.versao,
        grupoDoDia.celulaId,
        grupoDoDia.versao,
        alvo,
        cfg.maxTentativas,
      );

      if (motivoDoPulo) {
        puladas.push(
          `${janela.modalidade.codigo} ${janela.horaInicio}-${janela.horaFim}: ${motivoDoPulo}`,
        );
        continue;
      }

      // A senha da celula daquele turno. O lote RECUSA sem ela — e nao por
      // disciplina: o PUT substitui o objeto inteiro e nao pode preservar a
      // senha lida (o GET pode devolve-la nula num quiz que tem senha), entao
      // sem a celula a janela apagaria a senha de toda a instituicao.
      const celula = await this.prisma.senhaDeProva.findUnique({
        where: { data_turno: { data: alvo, turno: janela.turno } },
        select: { id: true },
      });

      if (!celula) {
        this.avisarUmaVez(
          chave,
          'DATA_QUIZ_CRON_SEM_GRADE',
          alvo,
          janela.turno,
        );
        continue;
      }

      this.logger.log(
        `Cron: aplicando a janela ${janela.horaInicio}-${janela.horaFim} ` +
          `(${janela.modalidade.codigo}) em ${isoDeDataUtc(alvo)}.`,
      );

      await this.lote.iniciar(
        {
          tipo: TipoExecucaoQuiz.DATA,
          janelaId: janela.id,
          data: isoDeDataUtc(alvo),
          // O cron existe para APLICAR. Ver o cabecalho.
          simulacao: false,
          forcar: false,
        },
        'cron',
        OrigemExecucao.CRON,
      );

      this.avisadas.delete(chave);
      // UM lote por tick: `recusarSeJaRodando` recusaria o proximo de qualquer
      // forma, e a tolerancia cobre as outras candidatas no minuto seguinte.
      return true;
    }

    // Todas as candidatas foram puladas. NAO e erro — na maior parte dos ticks
    // da janela de tolerancia e o estado normal (ja aplicou, nao insiste). Mas
    // precisa aparecer: e a unica resposta possivel para "editei o horario e o
    // cron nao fez nada".
    if (puladas.length > 0) {
      this.avisarUmaVez(
        `${isoDeDataUtc(data)}#${hhmm}#puladas`,
        'DATA_QUIZ_CRON_NADA_A_FAZER',
        data,
        null,
        puladas.join('; '),
      );
    }

    return false;
  }

  /**
   * Esta janela ainda precisa ser aplicada NESTE dia?
   *
   * Espelho de `podeDisparar`, com o recorte `(janela, dia)`: o calendario se
   * repete todo dia, e travar so pela janela faria a sessao das 15:00 de segunda
   * impedir a de terca.
   */
  /**
   * Por que esta janela NAO deve disparar agora, ou `null` se deve.
   *
   * Devolve o motivo em vez de um booleano de proposito: quem chama precisa
   * poder DIZER por que pulou. Um tick que encontra janelas no horario e nao
   * aplica nenhuma, em silencio, e o pior estado possivel — foi exatamente
   * assim que uma correcao de horario pareceu nao funcionar em 25/08/2026.
   *
   * ⚠️ **A VERSAO entra na chave.** `salvarJanelas` faz upsert e PRESERVA o id
   * da linha, entao sem a versao a execucao concluida de manha bloquearia o
   * disparo da tarde depois de o admin corrigir o horario — e so no dia seguinte
   * funcionaria. Mesma solucao de `SenhaDeProva.versao`, do lado das senhas.
   *
   * ⚠️ **A celula da GRADE DE GRUPOS tambem** (14/09/2026). Corrigir o grupo das
   * 15h depois do disparo das 12:01 nao muda a versao da janela; sem a celula e
   * a versao dela na chave, a correcao so valeria no dia seguinte — com a prova
   * aberta para a sessao anterior o dia inteiro.
   */
  private async motivoParaNaoDisparar(
    janelaDeProvaId: number,
    versao: number,
    grupoDaJanelaId: number | null,
    versaoGrupo: number | null,
    data: Date,
    maxTentativas: number,
  ): Promise<string | null> {
    const reais = await this.prisma.execucaoSenhaQuiz.findMany({
      where: {
        janelaDeProvaId,
        data,
        versaoAplicada: versao,
        grupoDaJanelaId,
        versaoGrupoAplicada: versaoGrupo,
        simulacao: false,
      },
      orderBy: { iniciadoEm: 'desc' },
      select: { id: true, status: true, atualizadoEm: true },
    });

    const concluida = reais.find((e) => e.status === StatusExecucao.CONCLUIDA);
    if (concluida) return `ja aplicada hoje pela execucao ${concluida.id}`;

    const viva = reais.find(
      (e) =>
        e.status === StatusExecucao.EM_ANDAMENTO &&
        Date.now() - e.atualizadoEm.getTime() <= 5 * 60_000,
    );

    if (viva) return `execucao ${viva.id} ainda rodando`;

    // Mesmo teto de `podeDisparar`: sem ele, uma falha PERMANENTE (o caso real e
    // o token sem escopo de quizzing, que devolve 403 sempre) bateria no
    // Brightspace a cada minuto durante toda a janela de tolerancia.
    if (reais.length >= maxTentativas) {
      return (
        `${reais.length} tentativa(s) ja falharam nesta versao; nao insiste — ` +
        'verifique a ultima execucao'
      );
    }

    return null;
  }

  /**
   * A celula ainda precisa ser aplicada?
   *
   * Tudo aqui e consulta ao BANCO, e nao memoria do processo: o cenario que esta
   * guarda existe para cobrir e justamente o restart no meio da janela de
   * tolerancia, em que a memoria se perdeu mas a execucao ja aconteceu.
   */
  private async podeDisparar(
    senhaDeProvaId: number,
    versao: number,
    maxTentativas: number,
  ): Promise<boolean> {
    const reais = await this.prisma.execucaoSenhaQuiz.findMany({
      where: { senhaDeProvaId, simulacao: false, versaoAplicada: versao },
      orderBy: { iniciadoEm: 'desc' },
      select: { id: true, status: true, atualizadoEm: true },
    });

    if (reais.some((e) => e.status === StatusExecucao.CONCLUIDA)) return false;

    const viva = reais.find(
      (e) =>
        e.status === StatusExecucao.EM_ANDAMENTO &&
        Date.now() - e.atualizadoEm.getTime() <= 5 * 60_000,
    );

    if (viva) return false;

    // Teto de tentativas: sem ele, uma falha PERMANENTE — o caso real e o token
    // sem escopo de quizzing, que devolve 403 sempre — bateria no Brightspace a
    // cada minuto durante toda a janela de tolerancia.
    if (reais.length >= maxTentativas) {
      this.logger.warn(
        `Cron: celula ${senhaDeProvaId} ja teve ${reais.length} tentativa(s) ` +
          `nesta versao; nao insiste. Verifique a ultima execucao.`,
      );
      return false;
    }

    return true;
  }

  private avisarUmaVez(
    chave: string,
    evento:
      | 'SENHA_QUIZ_CRON_SEM_GRADE'
      | 'SENHA_QUIZ_CRON_SEM_HORARIO'
      | 'SENHA_QUIZ_CRON_IGNORADO'
      | 'DATA_QUIZ_CRON_SEM_GRADE'
      | 'DATA_QUIZ_CRON_SEM_JANELA'
      | 'DATA_QUIZ_CRON_IGNORADO'
      | 'DATA_QUIZ_CRON_NADA_A_FAZER'
      | 'DATA_QUIZ_CRON_SUBSTITUIDO',
    data: Date,
    turno: Turno | null,
    extra?: string,
  ): void {
    if (this.avisadas.has(chave)) return;
    this.avisadas.add(chave);

    const celula = turno
      ? `celula ${isoDeDataUtc(data)} ${rotuloDoTurno(turno)}`
      : `dia ${isoDeDataUtc(data)}`;

    const detalhe = {
      SENHA_QUIZ_CRON_SEM_GRADE: `${celula} sem senha cadastrada na grade`,
      SENHA_QUIZ_CRON_SEM_HORARIO:
        `${celula}: o cron esta ligado no servidor mas nenhum horario de turno ` +
        'foi cadastrado na tela; ele nunca vai disparar',
      SENHA_QUIZ_CRON_IGNORADO: `${celula} ignorada: integracao D2L desligada`,
      // A janela nao foi aplicada, e nao "so" ficou sem senha: o lote de datas
      // depende da celula porque o PUT reenvia `Password` e nao pode preservar
      // o que o GET devolveu. A prova continua com a janela anterior.
      DATA_QUIZ_CRON_SEM_GRADE:
        `${celula} sem senha na grade; a JANELA daquele horario NAO foi ` +
        'aplicada, e a prova continua com a data anterior',
      DATA_QUIZ_CRON_SEM_JANELA:
        `${celula}: o cron esta ligado mas nenhuma janela de prova ativa foi ` +
        'cadastrada na tela; as datas nunca vao mudar sozinhas',
      DATA_QUIZ_CRON_IGNORADO: `${celula} ignorada: integracao D2L desligada`,
      // NAO e falha: na maior parte dos ticks da janela de tolerancia este e o
      // estado normal. Existe para responder "editei o horario e nada
      // aconteceu" sem abrir o banco.
      DATA_QUIZ_CRON_NADA_A_FAZER: `${celula}: havia janela no horario, e nenhuma precisou disparar — ${extra ?? ''}`,
      DATA_QUIZ_CRON_SUBSTITUIDO:
        `${celula}: as janelas nao sao aplicadas — o special access substitui ` +
        'a troca de data e grupo (Special access > Configuracao). A senha segue.',
    }[evento];

    // `NADA_A_FAZER` sai como LOG e nao WARN: warn e para o que precisa de acao,
    // e aqui o comportamento normal e nao fazer nada. Amarelo demais ensina o
    // time a ignorar o amarelo que importa.
    if (
      evento === 'DATA_QUIZ_CRON_NADA_A_FAZER' ||
      evento === 'DATA_QUIZ_CRON_SUBSTITUIDO'
    )
      this.logger.log(`Cron: ${detalhe}.`);
    else this.logger.warn(`Cron: ${detalhe}.`);

    this.auditoria.registrar(evento, { ator: 'cron', detalhe });
  }
}
