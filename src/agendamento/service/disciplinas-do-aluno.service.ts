import { Injectable, Logger } from '@nestjs/common';
import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import { D2lEnrollmentsService } from '../../d2l/service/d2l-enrollments.service';
import type { FiltroDeNota } from '../../periodo/service/periodo.service';
import { PeriodoService } from '../../periodo/service/periodo.service';
import {
  ResultadoDoCruzamento,
  TurmaService,
} from '../../turma/service/turma.service';
import type { TurmaDoLaunch } from '../../turma/service/turma-match';
import {
  DisciplinaComNota,
  ElegibilidadeDeNotaService,
  motivoDeNenhumaElegivel,
  NOTAS_INDISPONIVEIS,
  notasIndisponiveis,
} from './elegibilidade-de-nota.service';

/** De onde saiu a lista de turmas. So muda a mensagem quando nao ha nenhuma. */
type Origem = 'LAUNCH' | 'ENROLLMENTS';

/**
 * O que sai daqui: as disciplinas que o aluno consegue agendar NESTA janela.
 *
 * E o `ResultadoDoCruzamento` do `TurmaService` com a nota junto — a mesma
 * lista, depois do filtro de elegibilidade. A nota vem `null` quando a janela
 * nao filtra por nota (a N2), porque nesse caso nenhuma foi consultada.
 */
export interface DisciplinasParaAgendar {
  agendaveis: DisciplinaComNota[];
  /** Por que nao passou, em texto de tela. Ausente quando encontrou. */
  motivo?: string;
  /**
   * A CAUSA em codigo, para quem precisa decidir e nao exibir.
   *
   * O `motivo` e uma frase para o aluno ler, e comparar frase e a receita para
   * a regra silenciosamente parar de valer quando alguem melhorar o texto. Quem
   * usa isto e o compulsorio: `FILTRO_DE_NOTA` vira uma linha de relatorio que
   * NAO manda a secretaria conferir o CSV de turmas, porque nao ha nada la para
   * conferir — o aluno passou de ano.
   */
  causa?: 'FILTRO_DE_NOTA';
}

const SEM_PERIODO_LETIVO =
  'O periodo letivo ainda nao foi configurado. Procure a secretaria academica.';

/**
 * A Valence caiu E o launch nao trouxe turma nenhuma — nao ha de onde tirar a
 * lista. Mensagem PROPRIA de proposito: devolver "nenhuma disciplina sua aparece
 * no periodo letivo vigente" mandaria o aluno a secretaria por um problema que e
 * nosso, e a secretaria procuraria defeito no CSV de turmas.
 */
const VALENCE_FORA_SEM_LAUNCH =
  'Nao foi possivel consultar suas disciplinas no Brightspace agora. ' +
  'Tente de novo em alguns minutos; se continuar, procure a secretaria academica.';

/** Intervalo minimo entre dois avisos de Valence fora. Ver `avisarIndisponivel`. */
const INTERVALO_AVISO_MS = 60_000;

/**
 * ============================================================================
 * QUAIS DISCIPLINAS A PROVA AGENDADA COBRE
 * ============================================================================
 * Regra (especificacao 3.3): disciplinas do aluno ∩ turmas reais com prova
 * (CSV) ∩ periodo letivo vigente.
 *
 * Sao DUAS fontes possiveis para o primeiro conjunto, e a escolha e a unica
 * coisa que este arquivo decide:
 *
 * - `D2L_HABILITADO=true`  -> os enrollments da Valence, filtrados pelo periodo
 *   letivo que o ADMIN cadastrou em `PeriodoAgendamento`. Traz TODAS as
 *   disciplinas do aluno no semestre, nao so a que ele clicou.
 * - `D2L_HABILITADO=false` -> a turma de onde ele clicou (claim `context` do
 *   LTI). E o comportamento anterior, e continua sendo o de quem ainda nao tem
 *   credencial da Valence.
 *
 * O cruzamento com o CSV e o mesmo nos dois casos (`TurmaService`): a costura
 * existe aqui, e nao no `AgendamentoService`, para que a troca de fonte seja de
 * um arquivo so.
 *
 * O aluno NAO agenda disciplina por disciplina: um agendamento cobre TODAS as
 * disciplinas com prova dele, de uma vez. Ele clica o link LTI de dentro de
 * qualquer uma delas e ve a lista inteira.
 *
 * ⚠️ **A lista nao e separada por vinculo** (decisao de 10/08/2026). Uma turma
 * tem alunos de varios cursos, entao o CSV de turmas nao pode dizer de qual
 * curso cada oferta e — e sem isso nao ha como atribuir a disciplina a um
 * vinculo. Quem tem dois vinculos NA MESMA MATRICULA recebe as disciplinas dos
 * dois cursos juntas pelos enrollments, com duracoes de prova diferentes. Sao 2
 * alunos em 7519 na base real; resolver isso exige a informacao do par
 * (aluno, turma), que nenhum dos dois CSVs tem hoje.
 */
@Injectable()
export class DisciplinasDoAlunoService {
  private readonly logger = new Logger(DisciplinasDoAlunoService.name);

  /** Ver `avisarSeFiltroDesligado`: o aviso sai uma vez por processo. */
  private avisouFiltroDesligado = false;

  /** Ver `avisarIndisponivel`: um aviso por minuto, nao um por request. */
  private avisouIndisponivelEmMs = 0;

  /** Ver `avisarNotasIndisponiveis`. Contador PROPRIO: sao dois incidentes
   * diferentes (as disciplinas e as notas), e um so relogio deixaria o segundo
   * calado enquanto o primeiro estivesse dentro do intervalo. */
  private avisouSemNotasEmMs = 0;

  constructor(
    private readonly turmaService: TurmaService,
    private readonly enrollments: D2lEnrollmentsService,
    private readonly periodo: PeriodoService,
    private readonly elegibilidade: ElegibilidadeDeNotaService,
  ) {}

  /** As disciplinas que o aluno consegue agendar. Pode vir vazia. */
  async agendaveis(
    aluno: AlunoJwtPayload,
    modalidadeCodigo: string,
  ): Promise<DisciplinaComNota[]> {
    const { agendaveis } = await this.cruzar(aluno, modalidadeCodigo);
    return agendaveis;
  }

  /**
   * Igual ao anterior, mas devolve tambem o MOTIVO de nao ter achado — o portal
   * usa para dizer ao aluno algo melhor que "nao ha o que agendar".
   */
  async cruzar(
    aluno: AlunoJwtPayload,
    modalidadeCodigo: string,
  ): Promise<DisciplinasParaAgendar> {
    // O periodo letivo e a rodada saem da MESMA leitura, e nao de duas: o filtro
    // de nota e do periodo vigente, e ler o periodo de novo mais adiante abriria
    // a janela para ele mudar no meio do cruzamento.
    //
    // O formato e do VINCULO, e e ele que escolhe a arvore do Brightspace:
    // o aluno EaD busca disciplina no modulo 2026/4 e o presencial no semestre
    // 2026/2, na mesma janela e no mesmo dia.
    const vigente =
      await this.periodo.periodoLetivoDaModalidade(modalidadeCodigo);

    if (!vigente) return { agendaveis: [], motivo: SEM_PERIODO_LETIVO };

    const origem = await this.turmasDoAluno(
      aluno,
      modalidadeCodigo,
      vigente.filtroDeNota,
    );

    if (origem.motivo) return { agendaveis: [], motivo: origem.motivo };

    this.avisarSeFiltroDesligado(origem.origem);

    const cruzamento = await this.turmaService.filtrarAgendaveis(origem.turmas);

    // O portal responde 200 com `motivo` mesmo quando nada passou — e o que
    // desabilita o botao ANTES de o aluno escolher horario. Por isso a Valence
    // fora vira TEXTO aqui, e excecao no `cruzarPorUserId`.
    return this.filtrarPorNota(
      aluno.userIdD2L,
      cruzamento,
      vigente.filtroDeNota,
      {
        erroVira: 'MOTIVO',
      },
    );
  }

  /**
   * `TURMAS_FILTER_ENABLED=false` ficou MUITO mais perigoso com os enrollments.
   *
   * Com a turma clicada, desligar o filtro liberava uma disciplina — a que o
   * aluno escolheu. Com os enrollments, libera o semestre inteiro dele: o CSV de
   * turmas e justamente quem diz QUAIS turmas tem prova, e sem ele toda
   * disciplina vira prova. O aviso sai uma vez por processo, para nao virar
   * ruido em cada request.
   */
  private avisarSeFiltroDesligado(origem: Origem): void {
    if (origem !== 'ENROLLMENTS' || this.turmaService.filtroAtivo()) return;
    if (this.avisouFiltroDesligado) return;

    this.avisouFiltroDesligado = true;

    this.logger.warn(
      'TURMAS_FILTER_ENABLED=false com os enrollments ligados: TODA disciplina do ' +
        'semestre esta sendo tratada como disciplina com prova. Ligue o filtro e ' +
        'importe o CSV de turmas.',
    );
  }

  /**
   * ==========================================================================
   * O CRUZAMENTO SEM LAUNCH — a porta do agendamento COMPULSORIO
   * ==========================================================================
   * Igual ao `cruzar`, mas partindo do UserId do Brightspace em vez do JWT.
   *
   * Existe porque o compulsorio agenda por quem NUNCA entrou: nao ha token, nao
   * ha claim `context`, nao ha nada alem da matricula da planilha — e o UserId
   * vem de `identidadePorMatricula`.
   *
   * **Exige `D2L_HABILITADO`, e por isso recusa em vez de devolver vazio.** Com
   * a integracao desligada a unica fonte de turmas e o clique do aluno, e quem
   * nao agendou nunca clicou: o resultado seria "nenhuma disciplina" para TODO
   * mundo, e o lote alocaria zero pessoas relatando um problema que nao e o
   * verdadeiro.
   *
   * **E por isso que aqui NAO ha o fallback de `cairParaOLaunch`.** Sem turma
   * clicada ele degradaria para lista vazia, e o lote registraria
   * `SEM_DISCIPLINA_AGENDAVEL` — motivo que manda a secretaria conferir o CSV de
   * turmas — quando a causa foi a rede. O erro sobe, `resolverUm` o classifica
   * como `FALHA_NA_INTEGRACAO`, e rodar de novo reprocessa so aquele aluno.
   */
  async cruzarPorUserId(
    userIdD2L: string,
    modalidadeCodigo: string,
  ): Promise<DisciplinasParaAgendar> {
    if (!this.enrollments.habilitado()) {
      return {
        agendaveis: [],
        motivo:
          'O compulsorio depende da integracao com o Brightspace (D2L_HABILITADO), ' +
          'que e quem sabe as disciplinas de quem nunca fez login.',
      };
    }

    const { turmas, motivo, filtroDeNota } = await this.turmasPorUserId(
      userIdD2L,
      modalidadeCodigo,
    );

    if (motivo) return { agendaveis: [], motivo };

    this.avisarSeFiltroDesligado('ENROLLMENTS');

    const cruzamento = await this.turmaService.filtrarAgendaveis(turmas);

    // Aqui o erro SOBE, ao contrario do `cruzar`: transformado em texto, ele
    // viraria `NAO_ELEGIVEL_PELA_NOTA` no relatorio — uma linha que diz "este
    // aluno passou de ano" quando a causa foi a rede, e que ninguem
    // reprocessaria. Deixando subir, `resolverUm` o classifica como
    // `FALHA_NA_INTEGRACAO` e rodar de novo refaz so aquele aluno.
    return this.filtrarPorNota(userIdD2L, cruzamento, filtroDeNota, {
      erroVira: 'EXCECAO',
    });
  }

  /**
   * ==========================================================================
   * OS CRITERIOS DE NOTA DA JANELA — a diferenca entre a N2 e a SUBSTITUTIVA
   * ==========================================================================
   * Sem filtro (`null`), devolve o cruzamento como estava, com `notaFinal: null`
   * — e a verdade: nenhuma nota foi consultada, e nenhuma chamada de rede saiu.
   * E o caminho da N2, e ele continua custando zero.
   *
   * Com filtro, cada disciplina passa pela nota do aluno naquela turma. O
   * resultado costuma ser uma lista MENOR que a do CSV, e e isso que a
   * substitutiva e: a prova das materias que faltaram, nao a do semestre.
   *
   * `erroVira` existe porque as duas portas precisam de coisas opostas da mesma
   * falha — ver os comentarios em `cruzar` e `cruzarPorUserId`.
   */
  private async filtrarPorNota(
    userIdD2L: string,
    cruzamento: ResultadoDoCruzamento,
    filtro: FiltroDeNota | null,
    como: { erroVira: 'MOTIVO' | 'EXCECAO' },
  ): Promise<DisciplinasParaAgendar> {
    if (!filtro) {
      return {
        agendaveis: cruzamento.agendaveis.map((d) => ({
          ...d,
          notaFinal: null,
          notaN1: null,
        })),
        motivo: cruzamento.motivo,
      };
    }

    // Nada passou pelo CSV: o motivo do cruzamento e melhor que qualquer coisa
    // que a nota diria, e consultar nota de lista vazia so gastaria tempo.
    if (cruzamento.agendaveis.length === 0) {
      return { agendaveis: [], motivo: cruzamento.motivo };
    }

    try {
      const { elegiveis, recusadas } = await this.elegibilidade.filtrar(
        userIdD2L,
        cruzamento.agendaveis,
        filtro,
      );

      if (elegiveis.length > 0) return { agendaveis: elegiveis };

      return {
        agendaveis: [],
        motivo: motivoDeNenhumaElegivel(recusadas),
        causa: 'FILTRO_DE_NOTA',
      };
    } catch (erro) {
      this.avisarNotasIndisponiveis(erro);

      if (como.erroVira === 'EXCECAO') throw notasIndisponiveis(erro);

      return { agendaveis: [], motivo: NOTAS_INDISPONIVEIS };
    }
  }

  /** As turmas do aluno, antes de qualquer filtro de prova. */
  private async turmasDoAluno(
    aluno: AlunoJwtPayload,
    modalidadeCodigo: string,
    filtroDeNota: FiltroDeNota | null,
  ): Promise<{
    turmas: TurmaDoLaunch[];
    origem: Origem;
    motivo?: string;
  }> {
    if (!this.enrollments.habilitado()) {
      // A janela pede nota e a integracao esta desligada: nao ha de onde tirar
      // a nota, e a turma do launch entregaria a substitutiva SEM conferir
      // nenhuma. E erro de configuracao, nao do aluno — mas quem esta na tela e
      // ele, entao a frase manda para a secretaria e o log diz o que fazer.
      if (filtroDeNota) {
        this.logger.error(
          'A janela vigente filtra por nota e D2L_HABILITADO esta desligado. ' +
            'Ninguem consegue agendar a substitutiva: ligue a integracao ou ' +
            'remova os criterios de nota do periodo.',
        );

        return { turmas: [], origem: 'LAUNCH', motivo: NOTAS_INDISPONIVEIS };
      }

      return {
        turmas: aluno.contexto ? [aluno.contexto] : [],
        origem: 'LAUNCH',
      };
    }

    try {
      const { turmas, motivo } = await this.turmasPorUserId(
        aluno.userIdD2L,
        modalidadeCodigo,
      );

      return { turmas, origem: 'ENROLLMENTS', motivo };
    } catch (erro) {
      return this.cairParaOLaunch(aluno, erro, filtroDeNota);
    }
  }

  /**
   * ==========================================================================
   * A VALENCE CAIU NO MEIO DO LAUNCH — degrada, nao derruba
   * ==========================================================================
   * `habilitado()` so olha o .env: ele NAO sabe se ha refresh token gravado, se
   * ele ainda vale, nem se o Brightspace esta de pe. Sem este catch, qualquer um
   * dos tres vira 503 na cara do aluno e o portal inteiro para — foi assim que o
   * ambiente ficou com `D2L_HABILITADO=true` e `integracao_d2l` vazia, e nada
   * avisou ate alguem tentar agendar.
   *
   * A turma clicada e um fallback POBRE, e de proposito: ela cobre so a
   * disciplina de onde o aluno entrou, e quem tem tres provas agenda uma. Mas
   * agendar uma prova e melhor que agendar nenhuma, e o remanejo administrativo
   * conserta o resto — enquanto o 503 nao deixa nem comecar.
   *
   * **O compulsorio NAO passa por aqui, e nao pode passar**: quem nunca fez
   * launch nao tem turma clicada, entao o fallback seria a lista vazia. Ver
   * `cruzarPorUserId`, que deixa o erro subir para virar `FALHA_NA_INTEGRACAO`
   * naquele aluno — linha de relatorio reprocessavel, em vez de aluno alocado
   * para as disciplinas erradas.
   */
  private cairParaOLaunch(
    aluno: AlunoJwtPayload,
    erro: unknown,
    filtroDeNota: FiltroDeNota | null,
  ): { turmas: TurmaDoLaunch[]; origem: Origem; motivo?: string } {
    this.avisarIndisponivel(erro);

    // ⚠️ **O fallback NAO vale quando a janela filtra por nota.** Degradar para
    // a turma clicada aqui liberaria a substitutiva sem conferir nota nenhuma —
    // exatamente o que a regra existe para impedir. Na N2 "agendar uma prova e
    // melhor que agendar nenhuma"; na SUB, agendar a prova errada e pior que
    // nao agendar, porque o aluno so descobre no dia.
    if (filtroDeNota) {
      return { turmas: [], origem: 'LAUNCH', motivo: NOTAS_INDISPONIVEIS };
    }

    if (!aluno.contexto) {
      return { turmas: [], origem: 'LAUNCH', motivo: VALENCE_FORA_SEM_LAUNCH };
    }

    return { turmas: [aluno.contexto], origem: 'LAUNCH' };
  }

  /**
   * O aviso sai no maximo uma vez por minuto.
   *
   * Uma queda da Valence atinge TODO request de TODO aluno: sem o intervalo, o
   * incidente que precisa ser visto vira milhares de linhas iguais e enterra o
   * resto do log — inclusive a auditoria, que e JSON na mesma saida.
   */
  private avisarNotasIndisponiveis(erro: unknown): void {
    const agora = Date.now();

    if (agora - this.avisouSemNotasEmMs < INTERVALO_AVISO_MS) return;

    this.avisouSemNotasEmMs = agora;

    this.logger.warn(
      'Nao foi possivel ler as notas no Brightspace, e a janela vigente filtra ' +
        'por nota: NINGUEM consegue agendar ate isto normalizar. Ao contrario ' +
        'das disciplinas, aqui nao ha fallback possivel — liberar sem a nota e ' +
        `o que a regra existe para impedir. Causa: ${
          erro instanceof Error ? erro.message : String(erro)
        }`,
    );
  }

  private avisarIndisponivel(erro: unknown): void {
    const agora = Date.now();

    if (agora - this.avisouIndisponivelEmMs < INTERVALO_AVISO_MS) return;

    this.avisouIndisponivelEmMs = agora;

    this.logger.warn(
      'Valence indisponivel: usando a turma do launch como fallback. ' +
        'O aluno so ve a disciplina de onde clicou ate isto normalizar. ' +
        `Causa: ${erro instanceof Error ? erro.message : String(erro)}`,
    );
  }

  /**
   * As ofertas do aluno no periodo letivo CADASTRADO pelo admin PARA O
   * FORMATO DELE.
   *
   * Compartilhado pelas duas portas (launch e compulsorio) de proposito: se
   * fossem duas implementacoes, uma delas acabaria sem o filtro do periodo
   * letivo — e traria os semestres passados junto. Vale igual para o
   * formato: uma implementacao que o esquecesse mandaria os presenciais
   * procurarem disciplina na grade dos modulos, e eles nao achariam nenhuma.
   */
  private async turmasPorUserId(
    userIdD2L: string,
    modalidadeCodigo: string,
  ): Promise<{
    turmas: TurmaDoLaunch[];
    filtroDeNota: FiltroDeNota | null;
    motivo?: string;
  }> {
    // O semestre e o que o admin cadastrou, nao o "atual" segundo o relogio: e
    // ele quem diz quais ofertas do Brightspace contam nesta janela.
    // A `rodada` continua sem entrar aqui: quem diz quais ofertas contam e o
    // SEMESTRE, e as duas rodadas dele cobrem as mesmas disciplinas — a
    // substitutiva e outra prova das mesmas materias. O que a janela da SUB
    // muda e QUANTAS delas o aluno agenda, e isso e o `filtroDeNota`, aplicado
    // depois do cruzamento com o CSV.
    const vigente =
      await this.periodo.periodoLetivoDaModalidade(modalidadeCodigo);

    if (!vigente) {
      return { turmas: [], filtroDeNota: null, motivo: SEM_PERIODO_LETIVO };
    }

    const ofertas = await this.enrollments.ofertasDoPeriodo(
      userIdD2L,
      vigente.periodoLetivoId,
    );

    return {
      turmas: ofertas,
      // A rodada nao muda QUAIS ofertas contam (as duas cobrem as mesmas
      // materias), mas os criterios de nota decidem quais delas ele agenda — e
      // ela sai da mesma leitura, para as duas nao poderem divergir.
      filtroDeNota: vigente.filtroDeNota,
      // A frase NOMEIA o periodo letivo e o formato que o escolheu.
      //
      // E a unica defesa contra o erro mais caro deste cadastro: um
      // `periodoLetivoId` que nao bate NAO da erro — a busca responde 200 com
      // lista vazia, a intersecao da vazia, e o formato inteiro recebe uma
      // frase generica sem nada ligando o sintoma a causa. Com o id na
      // mensagem, o primeiro aluno que abrir um chamado ja entrega o
      // diagnostico: "2026/4" numa tela de presencial e o mapa cadastrado
      // errado, e nao a matricula dele.
      motivo:
        ofertas.length === 0
          ? `Nenhuma disciplina sua aparece no periodo letivo vigente ` +
            `(${vigente.periodoLetivoId}, formato ${modalidadeCodigo}). ` +
            'Procure a secretaria academica.'
          : undefined,
    };
  }
}
