import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import {
  StatusExecucao,
  TipoExecucaoQuiz,
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { carregarConfigDoCron } from '../config/senha-quiz.config';
import { dataUtcDeIso, isoDeDataUtc } from './relogio';
import { ehDoDiaSeguinte } from './janela';
import { HorariosDoCron, minutosDaHora, rotuloDoTurno } from './turno';
import { validarSenha } from './senha';

/**
 * ============================================================================
 * A GRADE DIA x TURNO — cadastro das senhas e a situacao de cada celula
 * ============================================================================
 *
 * ⚠️ **POSTURA DE SEGURANCA DA SENHA** (vale para este arquivo e para o lote):
 *
 * 1. Texto claro e inevitavel e fica em UM lugar so — `senha_de_prova.senha`. O
 *    D2L exige o valor literal no PUT e a administracao imprime a folha para os
 *    fiscais; hash impossibilitaria as duas. A protecao e EM VOLTA, nao no
 *    armazenamento. Precedente do projeto: `integracao_d2l.refreshToken` ja e
 *    segredo em claro no mesmo banco.
 * 2. A senha NUNCA entra nas tabelas de execucao nem nos itens.
 * 3. NUNCA em auditoria — so a celula, contagens e quem fez.
 * 4. NUNCA no Logger; para isso existe `descreverSenha`.
 * 5. **Ler em claro e uma ROTA SEPARADA e auditada.** `listar()` devolve
 *    `temSenha`, nunca o valor; so `revelar()` entrega o texto, e toda chamada
 *    dela vira `SENHA_QUIZ_REVELADA`. A grade fica aberta num monitor
 *    compartilhado da administracao: revelar precisa ser um ATO, com rastro.
 * 6. Nenhuma rota de aluno toca nisto.
 * 7. `remover()` existe para retencao; a execucao historica sobrevive
 *    (`onDelete: SetNull` + data/turno desnormalizados).
 */

/**
 * Em que pe esta a celula. DERIVADO, nao gravado: gravar exigiria manter o campo
 * em sincronia com a execucao, e a primeira divergencia mentiria justamente no
 * dia em que a administracao precisa confiar na tela.
 */
export type SituacaoDaCelula =
  /** Ha senha cadastrada e nenhum lote real rodou nela. */
  | 'SALVA'
  /** So dry-run ate agora. */
  | 'SIMULADA'
  /** Aplicada, e a senha nao mudou desde entao. */
  | 'APLICADA'
  /** Aplicada, mas a senha foi EDITADA depois: o D2L esta com a anterior. */
  | 'DESATUALIZADA'
  | 'EM_ANDAMENTO'
  | 'FALHOU';

export interface ResumoDaExecucao {
  id: number;
  status: StatusExecucao;
  simulacao: boolean;
  origem: string;
  versaoAplicada: number;
  concluidoEm: Date | null;
  turmasResolvidas: number;
  definidas: number;
  naoEncontradas: number;
  falhas: number;
}

export interface CelulaDaGrade {
  id: number;
  /** "AAAA-MM-DD". */
  data: string;
  turno: Turno;
  /** **Nunca o valor.** Ver a regra 5 no cabecalho. */
  temSenha: boolean;
  versao: number;
  atualizadoEm: Date;
  atualizadoPor: string | null;
  situacao: SituacaoDaCelula;
  ultimaExecucao: ResumoDaExecucao | null;
}

export interface AlvoDoQuiz {
  /**
   * NULO enquanto ninguem escolheu. Nao ha mais semente no .env (19/08/2026):
   * um alvo que "ja vem preenchido" e um lote que roda com o nome errado
   * calado, trocando a senha do questionario errado em toda turma de uma vez.
   */
  nomeQuiz: string | null;
  matchQuiz: TipoMatchQuiz;
  atualizadoPor: string | null;
  atualizadoEm: Date | null;
  /** `false` = ninguem escolheu ainda, e o lote recusa comecar. */
  configurado: boolean;
}

export interface HorariosDoCronConfig {
  /** "HH:MM" em America/Sao_Paulo. Nulo = o cron nao dispara este turno. */
  horaManha: string | null;
  horaTarde: string | null;
  horaNoite: string | null;
  atualizadoPor: string | null;
  atualizadoEm: Date | null;
  /**
   * Do .env, SO LEITURA. Vai junto porque sem ele a tela deixaria o admin
   * cadastrar 07:30 e esperar por um cron que esta desligado no servidor —
   * exatamente a falha silenciosa que esta tela existe para evitar.
   */
  cronHabilitado: boolean;
  /** Do .env, so leitura: a janela em que um restart ainda aplica o turno. */
  toleranciaMin: number;
}

/** Uma janela do questionario, como a tela a le e a escreve. */
export interface JanelaDeProvaConfig {
  /** Ausente ao criar; presente ao editar. */
  id?: number;
  modalidadeId: number;
  modalidadeCodigo?: string;
  modalidadeNome?: string;
  ordem: number;
  /** "HH:MM" — quando o cron aplica esta janela. */
  horaDisparo: string;
  /** "HH:MM" — vira o StartDate do questionario. */
  horaInicio: string;
  /** "HH:MM" — vira o EndDate. */
  horaFim: string;
  /** De qual celula da grade sai a senha desta janela. */
  turno: Turno;
  /**
   * O NOME do grupo, no Brightspace, que passa a liberar a prova quando esta
   * janela dispara. `null` = esta janela nao troca grupo.
   */
  nomeGrupo: string | null;
  /** A categoria onde procurar o grupo, para desempatar homonimos. */
  categoriaGrupo: string | null;
  /**
   * O disparo arma a prova de AMANHA — a janela da noite, que abre o ciclo do
   * dia seguinte.
   *
   * **DERIVADO, so leitura.** Vale `horaDisparo > horaInicio`; ver
   * `ehDoDiaSeguinte`. Vai na resposta para a tela poder exibi-lo, e e ignorado
   * se vier no corpo de um PUT.
   */
  diaSeguinte: boolean;
  ativo: boolean;
  /**
   * Sobe a cada mudanca de HORARIO. E o que libera um novo disparo no mesmo dia
   * depois de uma correcao — ver a coluna no schema, e `SenhaDeProva.versao`,
   * de onde a ideia veio.
   */
  versao?: number;
}

/**
 * A janela como a TELA a manda: sem id (a chave e `modalidadeId + ordem`), sem
 * `diaSeguinte` (DERIVADO das duas horas — ver `ehDoDiaSeguinte`) e com `ativo`
 * opcional, que tem default no servico.
 */
export type JanelaDeProvaEntrada = Omit<
  JanelaDeProvaConfig,
  | 'id'
  | 'modalidadeId'
  | 'modalidadeCodigo'
  | 'modalidadeNome'
  | 'diaSeguinte'
  | 'ativo'
  | 'nomeGrupo'
  | 'categoriaGrupo'
> & {
  ativo?: boolean;
  /**
   * Opcionais na ENTRADA e nulaveis na SAIDA: a tela pode simplesmente nao
   * mandar o campo, e o servico normaliza vazio -> `null`. Deixa-los
   * obrigatorios aqui quebraria todo cliente que salva o calendario sem mexer em
   * grupo, e forcaria a tela a reenviar um valor que ela nao editou.
   */
  nomeGrupo?: string | null;
  categoriaGrupo?: string | null;
};

export interface JanelasDeProva {
  janelas: JanelaDeProvaConfig[];
  atualizadoPor: string | null;
  atualizadoEm: Date | null;
  /** Do .env, so leitura — o mesmo aviso que os horarios do cron carregam. */
  cronHabilitado: boolean;
  toleranciaMin: number;
}

/** Silencio maior que isto significa lote MORTO — mesmo criterio do compulsorio. */
const SILENCIO_ATE_MORRER_MS = 5 * 60_000;

@Injectable()
export class GradeSenhasService {
  private readonly logger = new Logger(GradeSenhasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** As celulas cadastradas no intervalo. A tela desenha as colunas vazias. */
  async listar(de: string, ate: string): Promise<CelulaDaGrade[]> {
    const celulas = await this.prisma.senhaDeProva.findMany({
      where: { data: { gte: dataUtcDeIso(de), lte: dataUtcDeIso(ate) } },
      orderBy: [{ data: 'asc' }, { turno: 'asc' }],
      include: {
        // A ultima execucao de cada celula. Sao poucas dezenas de celulas, e o
        // `take: 1` por celula sai de graca no MySQL com o indice de execucao.
        //
        // `tipo: SENHA` porque desde 25/08/2026 o lote de DATAS tambem grava a
        // senha da celula (ele PRECISA reenviar `Password` no PUT, e nao pode
        // confiar na leitura — ver `quiz-body.ts`). Ele aponta para a mesma
        // `senhaDeProvaId`, e sem este filtro a coluna "situacao" da grade
        // passaria a contar a troca de DATAS como se fosse a troca de SENHA:
        // a celula ficaria "aplicada" antes de o turno dela ter rodado.
        execucoes: {
          where: { tipo: TipoExecucaoQuiz.SENHA },
          orderBy: { iniciadoEm: 'desc' },
          take: 1,
        },
      },
    });

    return celulas.map((celula) => {
      const ultima = celula.execucoes[0] ?? null;

      return {
        id: celula.id,
        data: isoDeDataUtc(celula.data),
        turno: celula.turno,
        temSenha: celula.senha !== '',
        versao: celula.versao,
        atualizadoEm: celula.updatedAt,
        atualizadoPor: celula.atualizadoPor,
        situacao: this.situacaoDa(celula.versao, ultima),
        ultimaExecucao: ultima
          ? {
              id: ultima.id,
              status: ultima.status,
              simulacao: ultima.simulacao,
              origem: ultima.origem,
              // Nunca nulo aqui: o `where` acima ja restringe a execucoes SENHA,
              // e so as de DATA tem `versaoAplicada` nula.
              versaoAplicada: ultima.versaoAplicada ?? 0,
              concluidoEm: ultima.concluidoEm,
              turmasResolvidas: ultima.turmasResolvidas,
              definidas: ultima.definidas,
              naoEncontradas: ultima.naoEncontradas,
              falhas: ultima.falhas,
            }
          : null,
      };
    });
  }

  /**
   * Cadastra ou atualiza a senha de uma celula.
   *
   * A `versao` sobe SO quando o valor muda. E o que faz `DESATUALIZADA`
   * significar alguma coisa: salvar de novo a mesma senha nao pode fazer a tela
   * alegar que o Brightspace ficou para tras.
   */
  async definir(
    dados: { data: string; turno: Turno; senha: string },
    adminEmail: string,
  ): Promise<CelulaDaGrade> {
    const senha = validarSenha(dados.senha);
    const data = dataUtcDeIso(dados.data);

    const existente = await this.prisma.senhaDeProva.findUnique({
      where: { data_turno: { data, turno: dados.turno } },
    });

    const mudou = !existente || existente.senha !== senha;

    const celula = await this.prisma.senhaDeProva.upsert({
      where: { data_turno: { data, turno: dados.turno } },
      create: { data, turno: dados.turno, senha, criadoPor: adminEmail },
      update: {
        senha,
        atualizadoPor: adminEmail,
        ...(mudou ? { versao: { increment: 1 } } : {}),
      },
    });

    this.auditoria.registrar('SENHA_QUIZ_GRADE_ALTERADA', {
      ator: adminEmail,
      // Sem o valor, por definicao. So o que permite investigar depois.
      detalhe:
        `celula ${dados.data} ${rotuloDoTurno(dados.turno)}; ` +
        `${existente ? 'atualizada' : 'criada'}; ` +
        `valor ${mudou ? 'mudou' : 'inalterado'}; versao ${celula.versao}`,
    });

    const [comSituacao] = await this.listar(dados.data, dados.data);

    return (
      comSituacao ?? {
        id: celula.id,
        data: dados.data,
        turno: dados.turno,
        temSenha: true,
        versao: celula.versao,
        atualizadoEm: celula.updatedAt,
        atualizadoPor: celula.atualizadoPor,
        situacao: 'SALVA',
        ultimaExecucao: null,
      }
    );
  }

  /**
   * O valor em claro. **Toda chamada e auditada** — e essa a diferenca entre
   * esta rota e a listagem, e a razao de ela existir separada.
   */
  async revelar(id: number, adminEmail: string): Promise<{ senha: string }> {
    const celula = await this.prisma.senhaDeProva.findUnique({ where: { id } });

    if (!celula) throw new NotFoundException(`Célula ${id} não encontrada.`);

    this.auditoria.registrar('SENHA_QUIZ_REVELADA', {
      ator: adminEmail,
      detalhe: `celula ${isoDeDataUtc(celula.data)} ${rotuloDoTurno(celula.turno)}`,
    });

    return { senha: celula.senha };
  }

  /**
   * Apaga a celula. A execucao historica SOBREVIVE (`onDelete: SetNull`):
   * apagar o segredo nao pode apagar a prova de que o lote rodou.
   */
  async remover(id: number, adminEmail: string): Promise<void> {
    const celula = await this.prisma.senhaDeProva.findUnique({ where: { id } });

    if (!celula) throw new NotFoundException(`Célula ${id} não encontrada.`);

    await this.prisma.senhaDeProva.delete({ where: { id } });

    this.auditoria.registrar('SENHA_QUIZ_GRADE_REMOVIDA', {
      ator: adminEmail,
      detalhe: `celula ${isoDeDataUtc(celula.data)} ${rotuloDoTurno(celula.turno)}`,
    });
  }

  /**
   * Qual questionario o lote procura.
   *
   * Sem semente no .env: enquanto ninguem escolher, `nomeQuiz` e nulo e o lote
   * RECUSA comecar. Um default plausivel ("Prova") seria pior que a ausencia —
   * ele rodaria, casaria com o que estivesse por perto e ninguem saberia ate o
   * dia da prova.
   */
  async lerAlvo(): Promise<AlvoDoQuiz> {
    const gravado = await this.prisma.configuracaoSenhaQuiz.findUnique({
      where: { id: 1 },
    });

    return {
      nomeQuiz: gravado?.nomeQuiz ?? null,
      matchQuiz: gravado?.matchQuiz ?? TipoMatchQuiz.CONTEM,
      atualizadoPor: gravado?.atualizadoPor ?? null,
      atualizadoEm: gravado?.atualizadoEm ?? null,
      configurado: Boolean(gravado?.nomeQuiz),
    };
  }

  async salvarAlvo(
    dados: { nomeQuiz: string; matchQuiz: TipoMatchQuiz },
    adminEmail: string,
  ): Promise<AlvoDoQuiz> {
    const nomeQuiz = dados.nomeQuiz.trim();

    if (!nomeQuiz) {
      throw new BadRequestException(
        'Informe o nome do questionário que o lote deve procurar.',
      );
    }

    await this.prisma.configuracaoSenhaQuiz.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        nomeQuiz,
        matchQuiz: dados.matchQuiz,
        atualizadoPor: adminEmail,
      },
      update: {
        nomeQuiz,
        matchQuiz: dados.matchQuiz,
        atualizadoPor: adminEmail,
      },
    });

    this.logger.log(
      `Alvo do lote de senhas: "${nomeQuiz}" (${dados.matchQuiz}), por ${adminEmail}.`,
    );

    // Auditavel porque decide QUAIS questionarios sao reescritos: trocar
    // "Prova N2" por "Prova" alcanca simulados e atividades em toda turma do
    // CSV de uma vez, e nada no resultado do lote denuncia a troca.
    this.auditoria.registrar('SENHA_QUIZ_ALVO_ALTERADO', {
      ator: adminEmail,
      detalhe: `alvo "${nomeQuiz}" (${dados.matchQuiz})`,
    });

    return this.lerAlvo();
  }

  /**
   * A que horas o cron aplica cada turno.
   *
   * Saiu do .env em 19/08/2026: o calendario dos turnos muda por semestre, e
   * quem o conhece e a administração — pedir deploy para mudar 07:30 garantia que
   * o horario ficasse errado no primeiro dia em que a prova mudasse de hora.
   *
   * O `cronHabilitado` do .env vem junto de proposito (ver a interface).
   */
  async lerHorarios(): Promise<HorariosDoCronConfig> {
    const gravado = await this.prisma.configuracaoSenhaQuiz.findUnique({
      where: { id: 1 },
    });

    const cfg = carregarConfigDoCron(this.config);

    return {
      horaManha: gravado?.horaManha ?? null,
      horaTarde: gravado?.horaTarde ?? null,
      horaNoite: gravado?.horaNoite ?? null,
      atualizadoPor: gravado?.atualizadoPor ?? null,
      atualizadoEm: gravado?.atualizadoEm ?? null,
      cronHabilitado: cfg.habilitado,
      toleranciaMin: cfg.toleranciaMin,
    };
  }

  async salvarHorarios(
    dados: {
      horaManha?: string | null;
      horaTarde?: string | null;
      horaNoite?: string | null;
    },
    adminEmail: string,
  ): Promise<HorariosDoCronConfig> {
    const horaManha = this.horaValidada(dados.horaManha, 'A hora da manhã');
    const horaTarde = this.horaValidada(dados.horaTarde, 'A hora da tarde');
    const horaNoite = this.horaValidada(dados.horaNoite, 'A hora da noite');

    await this.prisma.configuracaoSenhaQuiz.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        horaManha,
        horaTarde,
        horaNoite,
        atualizadoPor: adminEmail,
      },
      update: { horaManha, horaTarde, horaNoite, atualizadoPor: adminEmail },
    });

    const descricao = [
      `manha ${horaManha ?? '(desligado)'}`,
      `tarde ${horaTarde ?? '(desligado)'}`,
      `noite ${horaNoite ?? '(desligado)'}`,
    ].join('; ');

    this.logger.log(
      `Horarios do cron de senhas: ${descricao}; por ${adminEmail}.`,
    );

    // Auditavel pela mesma razao do alvo: muda QUANDO a instituicao inteira
    // troca de senha, e o efeito de um horario errado so aparece no dia.
    this.auditoria.registrar('SENHA_QUIZ_HORARIOS_ALTERADOS', {
      ator: adminEmail,
      detalhe: descricao,
    });

    return this.lerHorarios();
  }

  /** Os horarios no formato que `turnoParaDisparar` consome. Usado pelo cron. */
  async horariosDoCron(): Promise<HorariosDoCron> {
    const { horaManha, horaTarde, horaNoite } = await this.lerHorarios();

    return {
      [Turno.MANHA]: horaManha,
      [Turno.TARDE]: horaTarde,
      [Turno.NOITE]: horaNoite,
    };
  }

  /**
   * As janelas do questionario, agrupadas por formato.
   *
   * Devolve TODAS, inclusive as inativas: a tela precisa mostrar o horario
   * guardado de uma sessao desligada, senao reativa-la significaria digitar tudo
   * de novo.
   */
  async lerJanelas(): Promise<JanelasDeProva> {
    const janelas = await this.prisma.janelaDeProva.findMany({
      orderBy: [{ modalidadeId: 'asc' }, { ordem: 'asc' }],
      include: { modalidade: { select: { codigo: true, nome: true } } },
    });

    const cfg = carregarConfigDoCron(this.config);

    // O mais recente entre todas: a tela mostra uma linha so de "alterado por".
    const ultimaEdicao = janelas
      .map((j) => j.atualizadoEm)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      janelas: janelas.map((j) => ({
        id: j.id,
        modalidadeId: j.modalidadeId,
        modalidadeCodigo: j.modalidade.codigo,
        modalidadeNome: j.modalidade.nome,
        ordem: j.ordem,
        horaDisparo: j.horaDisparo,
        horaInicio: j.horaInicio,
        horaFim: j.horaFim,
        turno: j.turno,
        nomeGrupo: j.nomeGrupo,
        categoriaGrupo: j.categoriaGrupo,
        diaSeguinte: j.diaSeguinte,
        ativo: j.ativo,
        versao: j.versao,
      })),
      atualizadoPor:
        janelas.find((j) => j.atualizadoEm === ultimaEdicao)?.atualizadoPor ??
        null,
      atualizadoEm: ultimaEdicao ?? null,
      cronHabilitado: cfg.habilitado,
      toleranciaMin: cfg.toleranciaMin,
    };
  }

  /**
   * Substitui as janelas de UM formato pelas recebidas.
   *
   * ⚠️ **O recorte e o FORMATO, nunca a tabela inteira.** A tela edita um
   * calendario por vez, e um PUT que apagasse o que nao veio no corpo deixaria
   * EaD sem janela nenhuma no momento em que alguem salvasse Semi. Como a
   * `ordem` e a chave dentro do formato, o que nao veio naquele formato
   * SAI — e o unico jeito de remover uma sessao pela tela.
   *
   * Tudo numa transacao: um calendario meio salvo faria o cron disparar uma
   * sessao e nao a seguinte, e o sintoma apareceria so no dia.
   */
  async salvarJanelas(
    modalidadeId: number,
    janelas: JanelaDeProvaEntrada[],
    adminEmail: string,
  ): Promise<JanelasDeProva> {
    const modalidade = await this.prisma.modalidade.findUnique({
      where: { id: modalidadeId },
      select: { id: true, codigo: true },
    });

    if (!modalidade) {
      throw new BadRequestException(`Formato ${modalidadeId} não encontrado.`);
    }

    const validadas = janelas.map((janela, indice) =>
      this.janelaValidada(janela, indice),
    );

    this.exigirOrdensUnicas(validadas);
    this.exigirDisparosSeparados(validadas, modalidade.codigo);

    await this.prisma.$transaction(async (tx) => {
      await tx.janelaDeProva.deleteMany({
        where: {
          modalidadeId,
          ordem: { notIn: validadas.map((j) => j.ordem) },
        },
      });

      for (const janela of validadas) {
        const existente = await tx.janelaDeProva.findUnique({
          where: { modalidadeId_ordem: { modalidadeId, ordem: janela.ordem } },
          select: {
            horaDisparo: true,
            horaInicio: true,
            horaFim: true,
            turno: true,
            nomeGrupo: true,
            categoriaGrupo: true,
          },
        });

        // ⚠️ A VERSAO SOBE SO QUANDO O HORARIO MUDA — e e ela que libera um novo
        // disparo HOJE. Sem isto, corrigir a janela que ja rodou de manha nao
        // adianta nada ate o dia seguinte: o `upsert` preserva o id da linha, e
        // a idempotencia do cron encontra a execucao concluida daquele id e pula
        // em silencio. Bug real de 25/08/2026; e o mesmo remedio que
        // `SenhaDeProva.versao` ja aplicava do lado das senhas.
        //
        // `ativo` NAO conta: religar uma sessao desligada nao muda o que ela
        // grava, e subir a versao ali faria um simples "salvar" reprocessar a
        // instituicao inteira.
        //
        // ⚠️ **`nomeGrupo` e `categoriaGrupo` CONTAM** (26/08/2026). Sao campos
        // que o disparo APLICA, exatamente como as horas, e um nome de grupo
        // digitado errado tem a mesma cara do bug original: o admin corrige as
        // 12:43 depois do disparo das 12:01, o upsert preserva o id, a
        // idempotencia encontra a execucao concluida e pula em silencio. Sem
        // isto, a correcao de um grupo so valeria no dia seguinte — e o sintoma
        // seria a prova abrindo para a sessao anterior o dia inteiro.
        const mudouOQueEAplicado =
          existente !== null &&
          (existente.horaDisparo !== janela.horaDisparo ||
            existente.horaInicio !== janela.horaInicio ||
            existente.horaFim !== janela.horaFim ||
            existente.turno !== janela.turno ||
            existente.nomeGrupo !== janela.nomeGrupo ||
            existente.categoriaGrupo !== janela.categoriaGrupo);

        await tx.janelaDeProva.upsert({
          where: { modalidadeId_ordem: { modalidadeId, ordem: janela.ordem } },
          update: {
            ...janela,
            atualizadoPor: adminEmail,
            ...(mudouOQueEAplicado ? { versao: { increment: 1 } } : {}),
          },
          create: { ...janela, modalidadeId, atualizadoPor: adminEmail },
        });
      }
    });

    this.auditoria.registrar('DATA_QUIZ_JANELAS_ALTERADAS', {
      ator: adminEmail,
      detalhe:
        `formato ${modalidade.codigo}: ${validadas.length} janela(s) — ` +
        validadas
          .map(
            (j) =>
              // O turno vai junto: e ele que decide de qual celula da grade sai
              // a senha, e uma janela apontando para um turno sem senha
              // cadastrada NAO dispara. Sem isto na auditoria, "por que a janela
              // das 15h nao rodou?" nao tem resposta no log.
              `${j.horaDisparo} -> ${j.horaInicio}-${j.horaFim} ` +
              `[senha da ${rotuloDoTurno(j.turno)}]` +
              // O grupo entra na auditoria pelo mesmo motivo que o turno: e o
              // que a janela APLICA, e "por que a prova abriu para o grupo
              // errado?" nao tem resposta no log sem ele. "sem grupo" e dito em
              // voz alta de proposito — e um estado valido, e confundi-lo com
              // "esqueci de olhar" e o que faz o recurso parecer quebrado.
              ` [${j.nomeGrupo ? `grupo "${j.nomeGrupo}"` : 'sem grupo'}]` +
              `${j.diaSeguinte ? ' (D+1)' : ''}${j.ativo ? '' : ' [inativa]'}`,
          )
          .join('; '),
    });

    this.logger.log(
      `Janelas de ${modalidade.codigo} atualizadas por ${adminEmail}: ${validadas.length} sessao(oes).`,
    );

    return this.lerJanelas();
  }

  /** As tres horas em HH:MM, e a janela do questionario com fim depois do inicio. */
  private janelaValidada(janela: JanelaDeProvaEntrada, indice: number) {
    const onde = `Janela ${indice + 1}`;

    const horaDisparo = this.horaObrigatoria(
      janela.horaDisparo,
      `${onde}: hora do disparo`,
    );
    const horaInicio = this.horaObrigatoria(
      janela.horaInicio,
      `${onde}: hora de abertura`,
    );
    const horaFim = this.horaObrigatoria(
      janela.horaFim,
      `${onde}: hora de fechamento`,
    );

    // Uma janela invertida produz um questionario que fecha antes de abrir — a
    // API aceita, e ninguem faz a prova. O caso legitimo de atravessar a
    // meia-noite nao existe aqui: a janela mais tarde do calendario real fecha
    // as 22:00.
    if (minutosDaHora(horaFim)! <= minutosDaHora(horaInicio)!) {
      throw new BadRequestException(
        `${onde}: o fechamento (${horaFim}) precisa ser depois da abertura ` +
          `(${horaInicio}). Uma prova que fecha antes de abrir não é aplicável.`,
      );
    }

    if (!Number.isInteger(janela.ordem) || janela.ordem < 1) {
      throw new BadRequestException(`${onde}: a ordem deve ser 1 ou maior.`);
    }

    return {
      ordem: janela.ordem,
      horaDisparo,
      horaInicio,
      horaFim,
      turno: janela.turno,
      // ⚠️ Vazio vira NULO, e nao string vazia. Nulo significa "esta janela nao
      // troca grupo"; um `""` gravado passaria pela checagem de "tem grupo?" e
      // faria a resolucao procurar um grupo sem nome em cada turma, produzindo
      // uma pendencia por turma sem que nada estivesse configurado. O `trim` e
      // pelo mesmo motivo: espaco digitado por engano nao e cadastro.
      nomeGrupo: janela.nomeGrupo?.trim() || null,
      // So faz sentido com o nome. Guardar a categoria de uma janela que nao
      // troca grupo deixaria um cadastro orfao que ninguem sabe reativar.
      categoriaGrupo: janela.nomeGrupo?.trim()
        ? janela.categoriaGrupo?.trim() || null
        : null,
      // Calculado, nunca recebido. O admin nao tinha como responder isto melhor
      // que a aritmetica, e tinha como responder errado.
      diaSeguinte: ehDoDiaSeguinte(horaDisparo, horaInicio),
      ativo: janela.ativo ?? true,
    };
  }

  private horaObrigatoria(valor: string | null | undefined, campo: string) {
    const texto = (valor ?? '').trim();

    // Diferente de `horaValidada`: aqui vazio NAO e "desligado". Para desligar
    // uma sessao existe `ativo: false`, que preserva o horario cadastrado.
    if (!texto || minutosDaHora(texto) == null) {
      throw new BadRequestException(
        `${campo} deve estar no formato HH:MM, de 00:00 a 23:59 (ex.: 15:00).`,
      );
    }

    return texto;
  }

  private exigirOrdensUnicas(janelas: { ordem: number }[]): void {
    const vistas = new Set<number>();

    for (const { ordem } of janelas) {
      if (vistas.has(ordem)) {
        // O banco recusaria pelo unique, mas com uma mensagem de driver. A
        // ordem e a chave da sessao dentro do formato — duas iguais fariam
        // uma sobrescrever a outra no upsert, em silencio.
        throw new BadRequestException(
          `Há duas janelas com a ordem ${ordem}. A ordem identifica a sessão ` +
            'dentro do formato e não pode repetir.',
        );
      }
      vistas.add(ordem);
    }
  }

  /**
   * Dois disparos ATIVOS no mesmo minuto, no mesmo formato.
   *
   * `janelasParaDisparar` desempata escolhendo o que comecou mais tarde, entao
   * isto nao quebra nada — mas significa que uma das duas sessoes NUNCA seria
   * aplicada, e o admin nao teria como saber. Recusar na escrita e o momento em
   * que ele ainda esta olhando para a tela.
   */
  private exigirDisparosSeparados(
    janelas: { horaDisparo: string; ativo: boolean }[],
    codigoDaModalidade: string,
  ): void {
    const vistos = new Set<string>();

    for (const { horaDisparo, ativo } of janelas) {
      if (!ativo) continue;

      if (vistos.has(horaDisparo)) {
        throw new BadRequestException(
          `${codigoDaModalidade} tem duas janelas ativas disparando às ` +
            `${horaDisparo}. Apenas uma delas seria aplicada, e a outra ficaria ` +
            'sem efeito sem aviso nenhum.',
        );
      }
      vistos.add(horaDisparo);
    }
  }

  /**
   * Vazio/ausente = turno DESLIGADO, e isso e um estado legitimo (sabado a
   * noite nao tem prova). O que nao pode passar e "07:3" ou "7:30": o cron
   * ignoraria em silencio e o turno nunca dispararia — a classe de falha que
   * este projeto combate em toda parte.
   */
  private horaValidada(valor: string | null | undefined, campo: string) {
    const texto = (valor ?? '').trim();
    if (!texto) return null;

    if (minutosDaHora(texto) == null) {
      throw new BadRequestException(
        `${campo} deve estar no formato HH:MM, de 00:00 a 23:59 (ex.: 07:30). ` +
          'Deixe em branco para não disparar este turno.',
      );
    }

    return texto;
  }

  /**
   * A situacao a partir da ULTIMA execucao da celula.
   *
   * `DESATUALIZADA` e a que justifica o par `versao`/`versaoAplicada`: responde
   * "editei a senha as 07:20, o cron ja tinha rodado as 07:30?" sem guardar a
   * senha anterior em lugar nenhum.
   */
  private situacaoDa(
    versaoAtual: number,
    ultima: {
      status: StatusExecucao;
      simulacao: boolean;
      /**
       * NULO so em execucoes de DATA, que o chamador ja filtra fora. Aceitar o
       * nulo aqui e o que impede um `!` no `where`: se algum dia uma execucao
       * sem versao chegar, ela cai em DESATUALIZADA (a leitura pessimista),
       * nunca em APLICADA.
       */
      versaoAplicada: number | null;
      atualizadoEm: Date;
    } | null,
  ): SituacaoDaCelula {
    if (!ultima) return 'SALVA';

    if (ultima.status === StatusExecucao.EM_ANDAMENTO) {
      // Lote cujo processo morreu continua EM_ANDAMENTO na tabela; mostrar isso
      // como "quase la" esconderia que ninguem esta trabalhando naquilo.
      const morta =
        Date.now() - ultima.atualizadoEm.getTime() > SILENCIO_ATE_MORRER_MS;
      return morta ? 'FALHOU' : 'EM_ANDAMENTO';
    }

    if (ultima.status === StatusExecucao.FALHOU) return 'FALHOU';
    if (ultima.simulacao) return 'SIMULADA';

    return ultima.versaoAplicada === versaoAtual ? 'APLICADA' : 'DESATUALIZADA';
  }
}
