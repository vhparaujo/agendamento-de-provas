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
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { carregarConfigDoCron } from '../config/senha-quiz.config';
import { dataUtcDeIso, isoDeDataUtc } from './relogio';
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
 *    D2L exige o valor literal no PUT e a secretaria imprime a folha para os
 *    fiscais; hash impossibilitaria as duas. A protecao e EM VOLTA, nao no
 *    armazenamento. Precedente do projeto: `integracao_d2l.refreshToken` ja e
 *    segredo em claro no mesmo banco.
 * 2. A senha NUNCA entra nas tabelas de execucao nem nos itens.
 * 3. NUNCA em auditoria — so a celula, contagens e quem fez.
 * 4. NUNCA no Logger; para isso existe `descreverSenha`.
 * 5. **Ler em claro e uma ROTA SEPARADA e auditada.** `listar()` devolve
 *    `temSenha`, nunca o valor; so `revelar()` entrega o texto, e toda chamada
 *    dela vira `SENHA_QUIZ_REVELADA`. A grade fica aberta num monitor
 *    compartilhado da secretaria: revelar precisa ser um ATO, com rastro.
 * 6. Nenhuma rota de aluno toca nisto.
 * 7. `remover()` existe para retencao; a execucao historica sobrevive
 *    (`onDelete: SetNull` + data/turno desnormalizados).
 */

/**
 * Em que pe esta a celula. DERIVADO, nao gravado: gravar exigiria manter o campo
 * em sincronia com a execucao, e a primeira divergencia mentiria justamente no
 * dia em que a secretaria precisa confiar na tela.
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
        execucoes: {
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
              versaoAplicada: ultima.versaoAplicada,
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

    if (!celula) throw new NotFoundException(`Celula ${id} nao encontrada.`);

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

    if (!celula) throw new NotFoundException(`Celula ${id} nao encontrada.`);

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
        'Informe o nome do questionario que o lote deve procurar.',
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
   * quem o conhece e a secretaria — pedir deploy para mudar 07:30 garantia que
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
    const horaManha = this.horaValidada(dados.horaManha, 'horaManha');
    const horaTarde = this.horaValidada(dados.horaTarde, 'horaTarde');
    const horaNoite = this.horaValidada(dados.horaNoite, 'horaNoite');

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
        `${campo} deve estar em HH:MM (24h, com zero a esquerda), ex.: 07:30. ` +
          'Deixe em branco para nao disparar este turno.',
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
      versaoAplicada: number;
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
