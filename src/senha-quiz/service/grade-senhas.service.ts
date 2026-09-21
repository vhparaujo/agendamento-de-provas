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
import { ehDoDiaSeguinte } from './janela';
import { minutosDaHora, rotuloDoTurno } from './turno';
import { validarSenha } from './senha';
import { sortearSenhasDoDia } from './senha-aleatoria';

/**
 * ============================================================================
 * A GRADE DIA x JANELA — as senhas de cada sessao e a situacao de cada celula
 * ============================================================================
 *
 * ⚠️ **A chave era dia x TURNO ate 21/09/2026**, e o cron de senhas tinha um
 * calendario proprio de tres horarios. Agora a celula pertence a uma JANELA — a
 * mesma chave da grade de grupos —, e a senha troca no disparo daquela sessao,
 * junto com a data e o grupo. Sao ~20 celulas por dia contra as 3 de antes, e e
 * por isso que ninguem mais as digita: `gerar()` sorteia (`senha-aleatoria.ts`).
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
 *    `temSenha`, nunca o valor; so `revelar()` e `revelarIntervalo()` entregam o
 *    texto, e toda chamada vira `SENHA_QUIZ_REVELADA`. A grade fica aberta num
 *    monitor compartilhado da administracao: revelar precisa ser um ATO, com
 *    rastro.
 *
 *    ⚠️ `revelarIntervalo` nasceu em 21/09/2026 junto com a grade por sessao, e
 *    afrouxa a regra 5 de propósito e com limite. Com ~20 celulas por dia,
 *    montar a folha dos fiscais a um clique por celula seriam 120 cliques por
 *    semana — e o que acontece quando um controle custa isso e alguem anotar as
 *    senhas fora do sistema, onde nao ha rastro nenhum. A tela abre OCULTA, e o
 *    clique de mostrar registra uma linha dizendo quantas celulas e de que
 *    intervalo. O ato continua tendo rastro; o que mudou foi o tamanho do ato.
 * 6. Nenhuma rota de aluno toca nisto.
 * 7. `remover()` existe para retencao; a execucao historica sobrevive
 *    (`onDelete: SetNull` + data/turno desnormalizados).
 * 8. A senha SORTEADA nao passa pela tela nem pelo log no caminho de volta:
 *    `gerar()` devolve a grade com `temSenha`, como qualquer listagem. Quem
 *    quiser o valor pede a rota de revelar, e ela audita.
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
  /** "AAAA-MM-DD" — o dia da PROVA. */
  data: string;
  /** A SESSAO. A janela carrega o formato, as horas e o horario do disparo. */
  janelaDeProvaId: number;
  /** **Nunca o valor.** Ver a regra 5 no cabecalho. */
  temSenha: boolean;
  versao: number;
  atualizadoEm: Date;
  atualizadoPor: string | null;
  situacao: SituacaoDaCelula;
  ultimaExecucao: ResumoDaExecucao | null;
}

/** Uma celula como a tela a manda ao gravar a mao. */
export interface CelulaDeSenhaEntrada {
  data: string;
  janelaDeProvaId: number;
  senha: string;
}

/** O resultado de uma geracao em lote, como a tela a resume. */
export interface SenhasGeradas {
  /** Celulas que nasceram agora. */
  criadas: number;
  /** Celulas que ja existiam e receberam uma senha nova. */
  substituidas: number;
  /** Celulas que ja tinham senha e foram preservadas (sem `substituir`). */
  preservadas: number;
  /** A grade do intervalo, ja com o que foi gerado. */
  celulas: CelulaDaGrade[];
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
  /**
   * O turno da sessao. Hoje e ROTULO: a tela agrupa as sessoes por ele. Ate
   * 21/09/2026 ele decidia de qual celula da grade saia a senha — agora cada
   * sessao tem a sua celula.
   */
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

/**
 * Teto de dias por geracao.
 *
 * Nao e limite tecnico: sao ~20 senhas por dia, e o intervalo util e a semana de
 * provas. O teto existe para que "gerar o semestre" nao seja um clique — seriam
 * milhares de segredos em claro nascendo de uma vez, quase todos para dias que
 * ainda vao mudar de calendario.
 */
const MAXIMO_DE_DIAS_POR_GERACAO = 31;

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

  /**
   * As celulas cadastradas no intervalo. A tela desenha as colunas vazias.
   *
   * **So as chaveadas por JANELA.** As linhas anteriores a 21/09/2026 eram
   * chaveadas por turno e continuam na tabela como historico das execucoes
   * daqueles dias; devolve-las aqui poria numa grade de sessoes celulas que nao
   * pertencem a sessao nenhuma.
   */
  async listar(de: string, ate: string): Promise<CelulaDaGrade[]> {
    const celulas = await this.prisma.senhaDeProva.findMany({
      where: {
        data: { gte: dataUtcDeIso(de), lte: dataUtcDeIso(ate) },
        janelaDeProvaId: { not: null },
      },
      orderBy: [{ data: 'asc' }, { janelaDeProvaId: 'asc' }],
      include: {
        // A ultima execucao de cada celula. Sao poucas dezenas de celulas, e o
        // `take: 1` por celula sai de graca no MySQL com o indice de execucao.
        //
        // ⚠️ **Sem filtro por `tipo`, e isso mudou em 21/09/2026.** Antes a
        // consulta pedia `tipo: SENHA`, porque o lote de DATAS apontava para a
        // mesma celula sem ser "a troca daquele turno" — contar a execucao de
        // datas deixaria a celula "aplicada" antes de o turno dela rodar. Agora
        // os dois disparam na MESMA sessao, no mesmo minuto, e no calendario
        // normal e justamente o lote de DATAS que grava a senha: filtrar por
        // `tipo` faria toda celula aplicada parecer nunca aplicada.
        //
        // O `PREPARO` continua de fora sem filtro nenhum — ele grava
        // `senhaDeProvaId: null` de proposito, e por isso nao aparece aqui.
        execucoes: { orderBy: { iniciadoEm: 'desc' }, take: 1 },
      },
    });

    return celulas.map((celula) => {
      const ultima = celula.execucoes[0] ?? null;

      return {
        id: celula.id,
        data: isoDeDataUtc(celula.data),
        // Nunca nulo aqui: o `where` acima ja exclui as linhas historicas.
        janelaDeProvaId: celula.janelaDeProvaId!,
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
              // A versao da SENHA, e nao `versaoAplicada`: numa execucao `DATA`
              // aquela guarda a versao da JANELA, e compara-la com a da celula
              // seria comparar dois contadores sem relacao. Ver a coluna no
              // schema.
              versaoAplicada: ultima.versaoSenhaAplicada ?? 0,
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
   * ==========================================================================
   * SORTEIA AS SENHAS DE UM INTERVALO
   * ==========================================================================
   * O caminho NORMAL desde 21/09/2026. Uma celula por (dia, sessao ativa) do
   * intervalo, com senha de 6 digitos sorteada em `senha-aleatoria.ts`.
   *
   * ⚠️ **`substituir: false` e o padrao, e a diferenca importa.** Regerar uma
   * celula que ja foi aplicada troca a senha do questionario no proximo
   * disparo — e se aquele disparo ja passou, a folha impressa que esta na mao
   * do fiscal deixa de valer sem nada avisar. Gerar de novo tem de ser um
   * pedido explicito, nao o efeito de clicar duas vezes no mesmo botao.
   *
   * ⚠️ **As senhas sao unicas DENTRO DE CADA DIA.** Duas sessoes vizinhas com a
   * mesma senha seriam a mesma prova aberta duas vezes. Entre dias diferentes
   * repetir nao ajuda ninguem: o que barra o aluno de ontem e a janela, que
   * fechou. `sortearSenhasDoDia` recebe o que o dia ja tem, inclusive as
   * celulas que estao sendo preservadas.
   *
   * ⚠️ **Só sessões ATIVAS.** Uma janela desligada nao dispara, e dar senha a
   * ela encheria a grade de celulas que ninguem vai usar — e que contariam como
   * "ja usadas" no sorteio do dia.
   */
  async gerar(
    intervalo: { de: string; ate: string; substituir?: boolean },
    adminEmail: string,
  ): Promise<SenhasGeradas> {
    const de = dataUtcDeIso(intervalo.de);
    const ate = dataUtcDeIso(intervalo.ate);
    const substituir = intervalo.substituir ?? false;

    if (ate < de) {
      throw new BadRequestException(
        'A data final precisa ser igual ou posterior à inicial.',
      );
    }

    const dias = this.diasEntre(de, ate);

    // Um teto para o pedido, e nao para a tela: gerar "o semestre" de uma vez
    // seriam milhares de senhas em claro criadas por um clique, e o intervalo
    // util e a semana de provas.
    if (dias.length > MAXIMO_DE_DIAS_POR_GERACAO) {
      throw new BadRequestException(
        `O intervalo tem ${dias.length} dias; o máximo por geração é ` +
          `${MAXIMO_DE_DIAS_POR_GERACAO}. Gere uma semana de cada vez — são as ` +
          'senhas de uma instituição inteira nascendo de um clique.',
      );
    }

    const janelas = await this.prisma.janelaDeProva.findMany({
      where: { ativo: true },
      select: {
        id: true,
        horaInicio: true,
        horaFim: true,
        modalidade: { select: { codigo: true } },
      },
      orderBy: [{ modalidadeId: 'asc' }, { ordem: 'asc' }],
    });

    if (janelas.length === 0) {
      throw new BadRequestException(
        'Nenhuma sessão ativa cadastrada. As senhas pertencem às janelas do ' +
          'questionário — cadastre o calendário antes de gerar.',
      );
    }

    const existentes = await this.prisma.senhaDeProva.findMany({
      where: { data: { gte: de, lte: ate }, janelaDeProvaId: { not: null } },
      select: { id: true, data: true, janelaDeProvaId: true, senha: true },
    });

    let criadas = 0;
    let substituidas = 0;
    let preservadas = 0;

    // Uma transacao por DIA, e nao uma para o intervalo inteiro: o sorteio de um
    // dia so depende daquele dia, e uma transacao de seis dias x 20 sessoes
    // seguraria as linhas da tabela por tempo demais enquanto o cron tenta ler a
    // celula do disparo corrente.
    for (const dia of dias) {
      const doDia = existentes.filter(
        (c) => c.data.getTime() === dia.getTime(),
      );
      const porJanela = new Map(doDia.map((c) => [c.janelaDeProvaId!, c]));

      const aPreencher = janelas.filter(
        (j) => substituir || !porJanela.has(j.id),
      );
      preservadas += janelas.length - aPreencher.length;
      if (aPreencher.length === 0) continue;

      // As que ficam no dia entram no conjunto a evitar: sem isso, gerar so as
      // celulas que faltam poderia repetir a senha de uma sessao vizinha que ja
      // estava preenchida — e o dia inteiro e o que precisa ser distinto.
      const preservadasNoDia = substituir
        ? []
        : doDia
            .filter((c) => !aPreencher.some((j) => j.id === c.janelaDeProvaId))
            .map((c) => c.senha);

      const sorteadas = sortearSenhasDoDia(aPreencher.length, preservadasNoDia);

      await this.prisma.$transaction(async (tx) => {
        for (const [i, janela] of aPreencher.entries()) {
          const senha = sorteadas[i];
          const chave = {
            data_janelaDeProvaId: { data: dia, janelaDeProvaId: janela.id },
          };

          if (porJanela.has(janela.id)) {
            await tx.senhaDeProva.update({
              where: chave,
              data: {
                senha,
                atualizadoPor: adminEmail,
                // O valor MUDOU: a versao sobe, e e ela que libera um novo
                // disparo hoje para a sessao que ja tinha rodado.
                versao: { increment: 1 },
              },
            });
            substituidas += 1;
          } else {
            await tx.senhaDeProva.create({
              data: {
                data: dia,
                janelaDeProvaId: janela.id,
                senha,
                criadoPor: adminEmail,
              },
            });
            criadas += 1;
          }
        }
      });
    }

    // Sem o valor, por definicao (regra 3 do cabecalho) — so o tamanho do que
    // mudou e onde. "Substituindo" aparece em voz alta: e a variante que invalida
    // folha impressa, e quem investigar depois precisa distinguir as duas.
    this.auditoria.registrar('SENHA_QUIZ_GRADE_GERADA', {
      ator: adminEmail,
      detalhe:
        `${intervalo.de} a ${intervalo.ate}; ` +
        `${substituir ? 'SUBSTITUINDO as existentes' : 'preservando as existentes'}; ` +
        `${criadas} criada(s), ${substituidas} substituida(s), ` +
        `${preservadas} preservada(s); ${janelas.length} sessao(oes) ativa(s)`,
    });

    this.logger.log(
      `Senhas sorteadas de ${intervalo.de} a ${intervalo.ate}: ` +
        `${criadas} criada(s), ${substituidas} substituida(s), por ${adminEmail}.`,
    );

    return {
      criadas,
      substituidas,
      preservadas,
      celulas: await this.listar(intervalo.de, intervalo.ate),
    };
  }

  /**
   * Cadastra ou atualiza a senha de uma celula A MAO.
   *
   * ⚠️ **Deixou de ser o caminho normal em 21/09/2026** — quem preenche a grade
   * e `gerar()`. Continua existindo como saida de emergencia: repor a senha que
   * um fiscal ja anunciou na sala, ou casar com uma folha impressa que nao da
   * para reimprimir. Por isso ela aceita qualquer texto que o D2L aceite, e nao
   * so seis digitos: a regra do sorteio e sobre o que o sistema PRODUZ, e
   * impo-la aqui impediria exatamente o conserto que esta rota existe para
   * permitir.
   *
   * A `versao` sobe SO quando o valor muda. E o que faz `DESATUALIZADA`
   * significar alguma coisa: salvar de novo a mesma senha nao pode fazer a tela
   * alegar que o Brightspace ficou para tras.
   */
  async definir(
    dados: CelulaDeSenhaEntrada,
    adminEmail: string,
  ): Promise<CelulaDaGrade> {
    const senha = validarSenha(dados.senha);
    const data = dataUtcDeIso(dados.data);

    const janela = await this.prisma.janelaDeProva.findUnique({
      where: { id: dados.janelaDeProvaId },
      select: {
        id: true,
        horaInicio: true,
        horaFim: true,
        modalidade: { select: { codigo: true } },
      },
    });

    if (!janela) {
      throw new BadRequestException(
        'Sessão não encontrada. Atualize a página: o calendário pode ter sido ' +
          'alterado.',
      );
    }

    const chave = {
      data_janelaDeProvaId: { data, janelaDeProvaId: janela.id },
    };

    const existente = await this.prisma.senhaDeProva.findUnique({
      where: chave,
    });

    const mudou = !existente || existente.senha !== senha;

    const celula = await this.prisma.senhaDeProva.upsert({
      where: chave,
      create: {
        data,
        janelaDeProvaId: janela.id,
        senha,
        criadoPor: adminEmail,
      },
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
        `celula ${dados.data} ${this.ondeFica(janela)}; ` +
        `${existente ? 'atualizada' : 'criada'}; ` +
        `valor ${mudou ? 'mudou' : 'inalterado'}; versao ${celula.versao}; ` +
        'digitada a mao',
    });

    const doDia = await this.listar(dados.data, dados.data);

    return (
      doDia.find((c) => c.id === celula.id) ?? {
        id: celula.id,
        data: dados.data,
        janelaDeProvaId: janela.id,
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
   * O valor em claro de UMA celula. **Toda chamada e auditada** — e essa a
   * diferenca entre esta rota e a listagem, e a razao de ela existir separada.
   */
  async revelar(id: number, adminEmail: string): Promise<{ senha: string }> {
    const celula = await this.prisma.senhaDeProva.findUnique({
      where: { id },
      include: {
        janelaDeProva: {
          select: {
            id: true,
            horaInicio: true,
            horaFim: true,
            modalidade: { select: { codigo: true } },
          },
        },
      },
    });

    if (!celula) throw new NotFoundException(`Célula ${id} não encontrada.`);

    this.auditoria.registrar('SENHA_QUIZ_REVELADA', {
      ator: adminEmail,
      detalhe: `celula ${isoDeDataUtc(celula.data)} ${this.ondeFica(
        celula.janelaDeProva,
        celula.turno,
      )}`,
    });

    return { senha: celula.senha };
  }

  /**
   * ==========================================================================
   * AS SENHAS DE UM INTERVALO INTEIRO, EM CLARO (21/09/2026)
   * ==========================================================================
   * O que a tela chama de "Mostrar senhas", e o que vira a folha dos fiscais.
   *
   * **Uma linha de auditoria para o intervalo, e nao uma por celula.** Com ~20
   * sessoes por dia, auditar celula a celula produziria 120 linhas identicas por
   * semana e afogaria o log de seguranca — o volume que ensina a ignorar
   * justamente o evento que importa. A linha diz quantas celulas e de que
   * intervalo, que e o que se quer saber depois.
   *
   * Continua sendo um ATO: a grade abre oculta, e nada nesta resposta chega a
   * tela sem alguem ter clicado.
   */
  async revelarIntervalo(
    de: string,
    ate: string,
    adminEmail: string,
  ): Promise<Record<number, string>> {
    const inicio = dataUtcDeIso(de);
    const fim = dataUtcDeIso(ate);

    if (fim < inicio) {
      throw new BadRequestException(
        'A data final precisa ser igual ou posterior à inicial.',
      );
    }

    const celulas = await this.prisma.senhaDeProva.findMany({
      where: {
        data: { gte: inicio, lte: fim },
        janelaDeProvaId: { not: null },
      },
      select: { id: true, senha: true },
    });

    this.auditoria.registrar('SENHA_QUIZ_REVELADA', {
      ator: adminEmail,
      detalhe:
        `${celulas.length} celula(s) de ${de} a ${ate} ` +
        '(grade inteira, botao "Mostrar senhas")',
    });

    return Object.fromEntries(celulas.map((c) => [c.id, c.senha]));
  }

  /**
   * Apaga a celula. A execucao historica SOBREVIVE (`onDelete: SetNull`):
   * apagar o segredo nao pode apagar a prova de que o lote rodou.
   */
  async remover(id: number, adminEmail: string): Promise<void> {
    const celula = await this.prisma.senhaDeProva.findUnique({
      where: { id },
      include: {
        janelaDeProva: {
          select: {
            id: true,
            horaInicio: true,
            horaFim: true,
            modalidade: { select: { codigo: true } },
          },
        },
      },
    });

    if (!celula) throw new NotFoundException(`Célula ${id} não encontrada.`);

    await this.prisma.senhaDeProva.delete({ where: { id } });

    this.auditoria.registrar('SENHA_QUIZ_GRADE_REMOVIDA', {
      ator: adminEmail,
      detalhe: `celula ${isoDeDataUtc(celula.data)} ${this.ondeFica(
        celula.janelaDeProva,
        celula.turno,
      )}`,
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
              // O turno vai junto como ROTULO. Ate 21/09/2026 ele decidia de
              // qual celula da grade saia a senha; agora cada sessao tem a sua,
              // e o que fica no log e a identificacao da linha — "por que a
              // janela das 15h nao rodou?" comeca por achar a janela das 15h.
              `${j.horaDisparo} -> ${j.horaInicio}-${j.horaFim} ` +
              `[${rotuloDoTurno(j.turno)}]` +
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
   * Os dias do intervalo, inclusive nas duas pontas.
   *
   * Anda em UTC porque a coluna e `DATE` e `dataUtcDeIso` ja poe todo dia na
   * meia-noite UTC: somar 24h aqui nunca cai num horario de verao, que e
   * justamente o bug que uma aritmetica no fuso local produziria uma vez por ano.
   */
  private diasEntre(de: Date, ate: Date): Date[] {
    const dias: Date[] = [];

    for (
      let dia = new Date(de);
      dia <= ate;
      dia = new Date(dia.getTime() + 24 * 60 * 60_000)
    ) {
      dias.push(dia);
    }

    return dias;
  }

  /**
   * Como uma celula e nomeada em log e auditoria: "EAD 09:00-12:00".
   *
   * Cai no turno quando nao ha janela — sao as linhas anteriores a 21/09/2026,
   * que continuam podendo ser reveladas e apagadas.
   */
  private ondeFica(
    janela: {
      horaInicio: string;
      horaFim: string;
      modalidade: { codigo: string };
    } | null,
    turno?: Turno | null,
  ): string {
    if (janela) {
      return `${janela.modalidade.codigo} ${janela.horaInicio}-${janela.horaFim}`;
    }

    return turno
      ? `turno da ${rotuloDoTurno(turno)} (grade antiga)`
      : 'sessão removida';
  }

  /**
   * A situacao a partir da ULTIMA execucao da celula.
   *
   * `DESATUALIZADA` e a que justifica o par `versao`/`versaoSenhaAplicada`:
   * responde "gerei as senhas de novo as 07:20, o cron ja tinha rodado as
   * 07:30?" sem guardar a senha anterior em lugar nenhum.
   */
  private situacaoDa(
    versaoAtual: number,
    ultima: {
      status: StatusExecucao;
      simulacao: boolean;
      /**
       * A versao da CELULA que aquela execucao gravou — em `SENHA` e em `DATA`,
       * que desde 25/08/2026 tambem grava a senha.
       *
       * NULO nas execucoes anteriores a 21/09/2026 (e em `PREPARO`, que o
       * chamador ja nao ve). Aceitar o nulo aqui e o que impede um `!` no
       * `where`: uma execucao sem versao cai em DESATUALIZADA — a leitura
       * pessimista —, nunca em APLICADA.
       */
      versaoSenhaAplicada: number | null;
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

    return ultima.versaoSenhaAplicada === versaoAtual
      ? 'APLICADA'
      : 'DESATUALIZADA';
  }
}
