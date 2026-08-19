import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service';
import { D2lQuizzesService } from '../../d2l/service/d2l-quizzes.service';
import {
  OrigemExecucao,
  StatusExecucao,
  Turno,
} from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { carregarConfigDoCron } from '../config/senha-quiz.config';
import { GradeSenhasService } from './grade-senhas.service';
import { agoraNaOperacao, isoDeDataUtc } from './relogio';
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
      | 'SENHA_QUIZ_CRON_IGNORADO',
    data: Date,
    turno: Turno | null,
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
    }[evento];

    this.logger.warn(`Cron: ${detalhe}.`);
    this.auditoria.registrar(evento, { ator: 'cron', detalhe });
  }
}
