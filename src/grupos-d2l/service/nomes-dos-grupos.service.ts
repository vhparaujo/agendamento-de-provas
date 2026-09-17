import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { hojeUtc } from '../../components/utc.util';
import { PrismaService } from '../../database/prisma.service';
import { FaixaService } from '../../faixa/service/faixa.service';
import {
  StatusAgendamento,
  TipoExecucaoGruposD2L,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import {
  CelulaDeGrupoEntrada,
  GradeGruposService,
} from '../../senha-quiz/service/grade-grupos.service';
import { GradeSenhasService } from '../../senha-quiz/service/grade-senhas.service';
import { normalizarNomeDeGrupo } from '../../senha-quiz/service/grupo';
import { ehDoDiaSeguinte } from '../../senha-quiz/service/janela';
import { isoDeDataUtc } from '../../senha-quiz/service/relogio';
import { minutosDaHora } from '../../senha-quiz/service/turno';
import {
  BLOCOS_DE_GRUPOS,
  BlocoDeGrupos,
  blocoDaModalidade,
  codigoDoGrupo,
  DEFINICAO_DO_BLOCO,
  MODALIDADES_COM_GRUPO,
} from './bloco';
import { IntervaloDeDias, intervaloDeDias } from './intervalo';

/**
 * ============================================================================
 * OS NOMES DOS GRUPOS, POR BLOCO — e os horarios que nao casam
 * ============================================================================
 * A tela de grupos do Brightspace nao tem tabela propria: cada linha que o admin
 * digita ("16/09, 09:00-12:00, 16/09 - 9h as 12h") vira uma celula da GRADE DE
 * GRUPOS (`GrupoDaJanela`), a mesma que o disparo do quiz le para trocar a
 * condicao de liberacao. E o que garante que o nome que CRIA o grupo, o que
 * INSCREVE o aluno e o que o disparo PROCURA sejam um so — com duas fontes, um
 * erro de digitacao faria o disparo nao achar o grupo no dia da prova.
 *
 * Em Semi/Modular uma linha grava a celula nos DOIS formatos: eles dividem a
 * categoria e o calendario, e o disparo de cada uma le a propria janela.
 *
 * A categoria da celula e preenchida com a do bloco. Sem ela, o disparo varreria
 * todas as categorias da turma, e um homonimo em outra categoria viraria
 * `GRUPO_AMBIGUO`.
 */

export interface HorarioDoBloco {
  horaInicio: string;
  horaFim: string;
  /** Codigos dos formatos que tem janela ativa neste horario. */
  modalidades: string[];
}

export interface LinhaDeGrupo {
  data: string;
  horaInicio: string;
  horaFim: string;
  nomeGrupo: string;
  /** Em quais formatos a celula existe. Semi/Modular normalmente as duas. */
  modalidades: string[];
}

export interface BlocoDoPainel {
  bloco: BlocoDeGrupos;
  nome: string;
  categoria: string;
  horarios: HorarioDoBloco[];
  /** Dias com faixa ativa dos formatos do bloco, no intervalo. */
  dias: string[];
  linhas: LinhaDeGrupo[];
}

export interface JanelaCandidata {
  id: number;
  horaInicio: string;
  horaFim: string;
  horaDisparo: string;
  /** Quantas faixas do intervalo ja casam com esta janela. */
  faixasQueCasam: number;
}

export interface PendenciaDeHorario {
  modalidadeId: number;
  modalidadeCodigo: string;
  modalidadeNome: string;
  /** O horario das FAIXAS, que nao existe entre as janelas do formato. */
  horaInicio: string;
  horaFim: string;
  faixas: number;
  dias: string[];
  agendamentos: number;
  janelas: JanelaCandidata[];
  janelaSugeridaId: number | null;
}

export interface PainelDeGrupos {
  de: string;
  ate: string;
  rodada: string | null;
  periodoLetivoIds: string[];
  /** O prazo de agendamento ainda esta aberto — grupos montados agora mudam. */
  agendamentoAberto: boolean;
  blocos: BlocoDoPainel[];
  pendenciasDeHorario: PendenciaDeHorario[];
  ultimaCriacaoId: number | null;
  ultimaInscricaoId: number | null;
}

export interface LinhaDeGrupoEntrada {
  data: string;
  horaInicio: string;
  horaFim: string;
  nomeGrupo: string;
}

export type HorarioQueVale = 'FAIXA' | 'JANELA';

export interface ResolucaoDeHorario {
  modalidadeId: number;
  /** O horario das faixas pendentes. */
  horaInicio: string;
  horaFim: string;
  janelaDeProvaId: number;
  vale: HorarioQueVale;
  de: string;
  ate: string;
}

export interface HorarioResolvido {
  mensagem: string;
  faixasAtualizadas: number;
  recusadas: { faixaId: number; data: string; motivo: string }[];
}

interface JanelaComGrupo {
  id: number;
  modalidadeId: number;
  horaInicio: string;
  horaFim: string;
  horaDisparo: string;
  modalidade: { codigo: string; nome: string };
}

@Injectable()
export class NomesDosGruposService {
  private readonly logger = new Logger(NomesDosGruposService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly periodo: PeriodoService,
    private readonly gradeGrupos: GradeGruposService,
    private readonly gradeSenhas: GradeSenhasService,
    private readonly faixas: FaixaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Tudo que a tela precisa numa ida: nomes por bloco, horarios validos,
   * pendencias de horario e as ultimas execucoes dos dois botoes.
   *
   * Sem intervalo, usa o dos DIAS DE PROVA ja agendados na rodada vigente — e o
   * que o admin quer ver depois do fim do prazo, que e quando os grupos sao
   * montados.
   */
  async painel(de?: string, ate?: string): Promise<PainelDeGrupos> {
    const vigente = await this.periodo.janelaVigente();

    const intervalo =
      de || ate
        ? intervaloDeDias(de, ate)
        : await this.intervaloPadrao(vigente);

    const [janelas, ofertas, situacao, ultimaCriacao, ultimaInscricao] =
      await Promise.all([
        this.janelasComGrupo(),
        this.ofertasDoIntervalo(intervalo),
        this.periodo.situacaoAtual(),
        this.ultimaExecucao(TipoExecucaoGruposD2L.CRIAR_GRUPOS),
        this.ultimaExecucao(TipoExecucaoGruposD2L.INSCREVER_ALUNOS),
      ]);

    const celulas = await this.prisma.grupoDaJanela.findMany({
      where: {
        data: { gte: intervalo.deData, lte: intervalo.ateData },
        janelaDeProvaId: { in: janelas.map((j) => j.id) },
      },
      select: { data: true, janelaDeProvaId: true, nomeGrupo: true },
    });

    const janelaPorId = new Map(janelas.map((j) => [j.id, j]));

    const blocos = BLOCOS_DE_GRUPOS.map((bloco): BlocoDoPainel => {
      const daquiJanelas = janelas.filter(
        (j) => blocoDaModalidade(j.modalidade.codigo) === bloco,
      );

      return {
        bloco,
        nome: DEFINICAO_DO_BLOCO[bloco].nome,
        categoria: DEFINICAO_DO_BLOCO[bloco].categoria,
        horarios: horariosDe(daquiJanelas),
        dias: [
          ...new Set(
            ofertas
              .filter((o) => blocoDaModalidade(o.modalidade.codigo) === bloco)
              .map((o) => isoDeDataUtc(o.faixa.data)),
          ),
        ].sort(),
        linhas: linhasDe(
          celulas.filter(
            (c) =>
              blocoDaModalidade(
                janelaPorId.get(c.janelaDeProvaId)?.modalidade.codigo,
              ) === bloco,
          ),
          janelaPorId,
        ),
      };
    });

    return {
      de: intervalo.de,
      ate: intervalo.ate,
      rodada: vigente?.rodada ?? null,
      periodoLetivoIds: vigente?.periodoLetivoIds ?? [],
      agendamentoAberto: situacao.aberto,
      blocos,
      pendenciasDeHorario: pendenciasDeHorario(ofertas, janelas),
      ultimaCriacaoId: ultimaCriacao,
      ultimaInscricaoId: ultimaInscricao,
    };
  }

  /**
   * Substitui os nomes de UM bloco no intervalo pelas linhas recebidas.
   *
   * ⚠️ **O que nao veio no corpo e APAGADO**, dentro do bloco e do intervalo — e
   * o unico jeito de remover uma linha pela tela. Por isso o painel devolve
   * todas as celulas do bloco no intervalo, inclusive as digitadas na grade da
   * aba "Senhas e datas": o admin ve tudo que esta sendo substituido.
   *
   * A gravacao passa por `GradeGruposService.salvar`, e nao direto no Prisma: e
   * la que vivem a transacao, a `versao` que libera um disparo corrigido no
   * mesmo dia e a auditoria.
   */
  async salvarNomes(
    bloco: BlocoDeGrupos,
    de: string,
    ate: string,
    linhas: LinhaDeGrupoEntrada[],
    adminEmail: string,
  ): Promise<PainelDeGrupos> {
    const intervalo = intervaloDeDias(de, ate);
    const definicao = DEFINICAO_DO_BLOCO[bloco];

    const janelas = (await this.janelasComGrupo()).filter(
      (j) => blocoDaModalidade(j.modalidade.codigo) === bloco,
    );

    if (janelas.length === 0) {
      throw new BadRequestException(
        `Nenhuma janela ativa de ${definicao.nome}. Os horários dos grupos são ` +
          'os das janelas do questionário — cadastre-as na aba "Senhas e datas".',
      );
    }

    const desejadas = new Map<string, CelulaDeGrupoEntrada>();
    const sessoes = new Map<string, number>();
    const nomes = new Map<string, number>();
    const codigos = new Map<string, number>();

    linhas.forEach((linha, indice) => {
      const onde = `Linha ${indice + 1}`;
      const nome = linha.nomeGrupo?.trim();

      if (!nome) {
        throw new BadRequestException(`${onde}: informe o nome do grupo.`);
      }

      if (linha.data < intervalo.de || linha.data > intervalo.ate) {
        throw new BadRequestException(
          `${onde}: o dia ${diaBr(linha.data)} está fora do intervalo ` +
            `${diaBr(intervalo.de)} a ${diaBr(intervalo.ate)}.`,
        );
      }

      const daSessao = janelas.filter(
        (j) => j.horaInicio === linha.horaInicio && j.horaFim === linha.horaFim,
      );

      if (daSessao.length === 0) {
        throw new BadRequestException(
          `${onde}: não há janela ativa de ${definicao.nome} das ` +
            `${linha.horaInicio} às ${linha.horaFim}. O horário do grupo é o de ` +
            'uma janela do questionário.',
        );
      }

      const sessao = `${linha.data} ${linha.horaInicio}-${linha.horaFim}`;
      const sessaoRepetida = sessoes.get(sessao);

      if (sessaoRepetida !== undefined) {
        throw new BadRequestException(
          `${onde}: a linha ${sessaoRepetida + 1} já dá um grupo a ` +
            `${diaBr(linha.data)} das ${linha.horaInicio} às ${linha.horaFim}. ` +
            'Cada sessão tem um grupo só.',
        );
      }
      sessoes.set(sessao, indice);

      // Dois horarios com o mesmo nome cairiam no MESMO grupo do Brightspace: a
      // prova abriria para as duas sessoes, e o aluno de uma veria a da outra.
      const nomeRepetido = nomes.get(normalizarNomeDeGrupo(nome));

      if (nomeRepetido !== undefined) {
        throw new BadRequestException(
          `${onde}: o nome "${nome}" já está na linha ${nomeRepetido + 1}. ` +
            'Com o mesmo nome, as duas sessões cairiam no mesmo grupo.',
        );
      }
      nomes.set(normalizarNomeDeGrupo(nome), indice);

      const codigo = codigoDoGrupo(nome).toLowerCase();
      const codigoRepetido = codigos.get(codigo);

      if (!codigo) {
        throw new BadRequestException(
          `${onde}: o nome "${nome}" não gera um código de grupo válido no AVA.`,
        );
      }

      if (codigoRepetido !== undefined) {
        throw new BadRequestException(
          `${onde}: "${nome}" e o nome da linha ${codigoRepetido + 1} geram o ` +
            'mesmo código de grupo no AVA (os primeiros 50 caracteres, ' +
            'sem pontuação proibida). Diferencie os nomes no início.',
        );
      }
      codigos.set(codigo, indice);

      for (const janela of daSessao) {
        desejadas.set(`${linha.data}#${janela.id}`, {
          data: linha.data,
          janelaDeProvaId: janela.id,
          nomeGrupo: nome,
          categoriaGrupo: definicao.categoria,
        });
      }
    });

    const existentes = await this.prisma.grupoDaJanela.findMany({
      where: {
        data: { gte: intervalo.deData, lte: intervalo.ateData },
        janelaDeProvaId: { in: janelas.map((j) => j.id) },
      },
      select: { data: true, janelaDeProvaId: true },
    });

    const apagar: CelulaDeGrupoEntrada[] = existentes
      .map((c) => ({
        data: isoDeDataUtc(c.data),
        janelaDeProvaId: c.janelaDeProvaId,
      }))
      .filter((c) => !desejadas.has(`${c.data}#${c.janelaDeProvaId}`))
      .map((c) => ({ ...c, nomeGrupo: null }));

    const celulas = [...desejadas.values(), ...apagar];

    // `salvar` recusa lote vazio — e aqui vazio e legitimo: o bloco nao tinha
    // nome nenhum e continua sem.
    if (celulas.length > 0) await this.gradeGrupos.salvar(celulas, adminEmail);

    return this.painel(intervalo.de, intervalo.ate);
  }

  /**
   * Resolve UMA pendencia de horario escolhendo qual dos dois cadastros vale.
   *
   * - `FAIXA`: a janela passa a ter o horario das faixas. Vai pelo
   *   `salvarJanelas`, que valida, sobe a `versao` e audita. O disparo NAO muda:
   *   se a nova abertura inverter o "arma a prova de amanha", a troca e recusada
   *   — a hora do disparo e decisao da aba "Senhas e datas".
   * - `JANELA`: as faixas do intervalo passam a ter o horario da janela, uma a
   *   uma pelo `FaixaService.atualizar`, com as mesmas recusas do PATCH da tela
   *   de faixas (prova que nao cabe, sala em duas provas ao mesmo tempo). Uma
   *   faixa recusada nao desfaz as outras: cada uma e um horario de prova
   *   independente, e a recusa volta na resposta.
   */
  async resolverHorario(
    entrada: ResolucaoDeHorario,
    adminEmail: string,
  ): Promise<HorarioResolvido> {
    const intervalo = intervaloDeDias(entrada.de, entrada.ate);

    for (const [campo, hora] of [
      ['A hora de início', entrada.horaInicio],
      ['A hora de fim', entrada.horaFim],
    ] as const) {
      if (minutosDaHora(hora) == null) {
        throw new BadRequestException(`${campo} deve estar no formato HH:MM.`);
      }
    }

    const janela = await this.prisma.janelaDeProva.findUnique({
      where: { id: entrada.janelaDeProvaId },
      include: { modalidade: { select: { codigo: true } } },
    });

    if (!janela || janela.modalidadeId !== entrada.modalidadeId) {
      throw new BadRequestException(
        'A janela escolhida não é do formato desta pendência. Atualize a página.',
      );
    }

    if (!janela.ativo) {
      throw new BadRequestException(
        'A janela escolhida está desativada: ela não dispara, então casar a ' +
          'faixa com ela não resolveria nada.',
      );
    }

    const horarioDaFaixa = `${entrada.horaInicio}-${entrada.horaFim}`;
    const horarioDaJanela = `${janela.horaInicio}-${janela.horaFim}`;
    const codigo = janela.modalidade.codigo;

    if (entrada.vale === 'FAIXA') {
      const resultado = await this.aplicarNaJanela(janela, entrada, adminEmail);

      this.auditoria.registrar('GRUPOS_D2L_HORARIO_RESOLVIDO', {
        ator: adminEmail,
        detalhe: `${codigo}: janela ${janela.id} ${horarioDaJanela} -> ${horarioDaFaixa} (vale a faixa)`,
      });

      return resultado;
    }

    const faixas = await this.prisma.faixa.findMany({
      where: {
        ativo: true,
        data: { gte: intervalo.deData, lte: intervalo.ateData },
        horaInicio: entrada.horaInicio,
        horaFim: entrada.horaFim,
        salaFaixas: { some: { modalidadeId: entrada.modalidadeId } },
      },
      select: { id: true, data: true },
      orderBy: [{ data: 'asc' }, { id: 'asc' }],
    });

    if (faixas.length === 0) {
      throw new BadRequestException(
        `Nenhuma faixa ativa de ${codigo} das ${entrada.horaInicio} às ` +
          `${entrada.horaFim} no intervalo. A pendência pode já ter sido ` +
          'resolvida — atualize a página.',
      );
    }

    const recusadas: HorarioResolvido['recusadas'] = [];

    for (const faixa of faixas) {
      try {
        await this.faixas.atualizar(faixa.id, {
          horaInicio: janela.horaInicio,
          horaFim: janela.horaFim,
        });
      } catch (erro) {
        recusadas.push({
          faixaId: faixa.id,
          data: isoDeDataUtc(faixa.data),
          motivo: erro instanceof Error ? erro.message : String(erro),
        });
      }
    }

    const atualizadas = faixas.length - recusadas.length;

    this.auditoria.registrar('GRUPOS_D2L_HORARIO_RESOLVIDO', {
      ator: adminEmail,
      detalhe:
        `${codigo}: ${atualizadas} faixa(s) ${horarioDaFaixa} -> ${horarioDaJanela} ` +
        `(vale a janela ${janela.id}), ${recusadas.length} recusada(s), ` +
        `${intervalo.de} a ${intervalo.ate}`,
    });

    this.logger.log(
      `Pendencia de horario ${codigo} ${horarioDaFaixa} resolvida por ${adminEmail}: ` +
        `${atualizadas} faixa(s) movidas para ${horarioDaJanela}.`,
    );

    return {
      mensagem:
        `${atualizadas} faixa(s) de ${codigo} passaram de ${horarioDaFaixa} ` +
        `para ${horarioDaJanela}.` +
        (recusadas.length ? ` ${recusadas.length} foram recusadas.` : ''),
      faixasAtualizadas: atualizadas,
      recusadas,
    };
  }

  // ------------------------------------------------------------------ interno

  private async aplicarNaJanela(
    janela: {
      id: number;
      modalidadeId: number;
      horaDisparo: string;
      diaSeguinte: boolean;
      modalidade: { codigo: string };
    },
    entrada: ResolucaoDeHorario,
    adminEmail: string,
  ): Promise<HorarioResolvido> {
    const diaSeguinte = ehDoDiaSeguinte(janela.horaDisparo, entrada.horaInicio);

    // Exemplo real: disparo 15:20 para abrir as 15:30. Com abertura as 15:00, o
    // disparo das 15:20 viria DEPOIS da abertura e passaria a armar a prova de
    // amanha — a prova de hoje abriria no dia seguinte.
    if (diaSeguinte !== janela.diaSeguinte) {
      throw new BadRequestException(
        `Esta janela dispara às ${janela.horaDisparo}. Com abertura às ` +
          `${entrada.horaInicio}, o disparo passaria a armar a prova de ` +
          `${diaSeguinte ? 'AMANHÃ' : 'HOJE'} em vez da de ` +
          `${diaSeguinte ? 'hoje' : 'amanhã'}. Ajuste a hora do disparo na aba ` +
          '"Senhas e datas", ou escolha que vale o horário da janela.',
      );
    }

    const { janelas } = await this.gradeSenhas.lerJanelas();

    const daModalidade = janelas
      .filter((j) => j.modalidadeId === janela.modalidadeId)
      .map((j) => ({
        ordem: j.ordem,
        horaDisparo: j.horaDisparo,
        horaInicio: j.id === janela.id ? entrada.horaInicio : j.horaInicio,
        horaFim: j.id === janela.id ? entrada.horaFim : j.horaFim,
        turno: j.turno,
        nomeGrupo: j.nomeGrupo,
        categoriaGrupo: j.categoriaGrupo,
        ativo: j.ativo,
      }));

    await this.gradeSenhas.salvarJanelas(
      janela.modalidadeId,
      daModalidade,
      adminEmail,
    );

    return {
      mensagem:
        `A janela de ${janela.modalidade.codigo} passou a abrir às ` +
        `${entrada.horaInicio} e fechar às ${entrada.horaFim}.`,
      faixasAtualizadas: 0,
      recusadas: [],
    };
  }

  private async intervaloPadrao(
    vigente: Awaited<ReturnType<PeriodoService['janelaVigente']>>,
  ): Promise<IntervaloDeDias> {
    if (vigente) {
      const extremos = await this.prisma.faixa.aggregate({
        where: {
          salaFaixas: {
            some: {
              agendamentos: {
                some: {
                  status: StatusAgendamento.CONFIRMADO,
                  periodoLetivoId: { in: vigente.periodoLetivoIds },
                  rodada: vigente.rodada,
                },
              },
            },
          },
        },
        _min: { data: true },
        _max: { data: true },
      });

      if (extremos._min.data && extremos._max.data) {
        return intervaloDeDias(
          isoDeDataUtc(extremos._min.data),
          isoDeDataUtc(extremos._max.data),
        );
      }
    }

    // Ninguem agendou ainda: a semana a partir de hoje, so para a tela abrir.
    const hoje = hojeUtc();
    return intervaloDeDias(
      isoDeDataUtc(hoje),
      isoDeDataUtc(new Date(hoje.getTime() + 6 * 86_400_000)),
    );
  }

  private janelasComGrupo(): Promise<JanelaComGrupo[]> {
    return this.prisma.janelaDeProva.findMany({
      where: {
        ativo: true,
        modalidade: { codigo: { in: [...MODALIDADES_COM_GRUPO] } },
      },
      select: {
        id: true,
        modalidadeId: true,
        horaInicio: true,
        horaFim: true,
        horaDisparo: true,
        modalidade: { select: { codigo: true, nome: true } },
      },
      orderBy: [{ horaInicio: 'asc' }, { modalidadeId: 'asc' }],
    });
  }

  private ofertasDoIntervalo(intervalo: IntervaloDeDias) {
    return this.prisma.salaFaixa.findMany({
      where: {
        faixa: {
          ativo: true,
          data: { gte: intervalo.deData, lte: intervalo.ateData },
        },
        modalidade: { codigo: { in: [...MODALIDADES_COM_GRUPO] } },
      },
      select: {
        modalidadeId: true,
        modalidade: { select: { codigo: true, nome: true } },
        faixa: {
          select: { id: true, data: true, horaInicio: true, horaFim: true },
        },
        _count: {
          select: {
            agendamentos: { where: { status: StatusAgendamento.CONFIRMADO } },
          },
        },
      },
    });
  }

  private async ultimaExecucao(
    tipo: TipoExecucaoGruposD2L,
  ): Promise<number | null> {
    const ultima = await this.prisma.execucaoGruposD2L.findFirst({
      where: { tipo },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    return ultima?.id ?? null;
  }
}

type Oferta = Awaited<
  ReturnType<NomesDosGruposService['ofertasDoIntervalo']>
>[number];

/** Os horarios distintos das janelas, em ordem de relogio. */
function horariosDe(janelas: JanelaComGrupo[]): HorarioDoBloco[] {
  const porHorario = new Map<string, HorarioDoBloco>();

  for (const j of janelas) {
    const chave = `${j.horaInicio}-${j.horaFim}`;
    const atual = porHorario.get(chave) ?? {
      horaInicio: j.horaInicio,
      horaFim: j.horaFim,
      modalidades: [],
    };

    if (!atual.modalidades.includes(j.modalidade.codigo)) {
      atual.modalidades.push(j.modalidade.codigo);
    }
    porHorario.set(chave, atual);
  }

  return [...porHorario.values()]
    .map((h) => ({ ...h, modalidades: h.modalidades.sort() }))
    .sort(
      (a, b) =>
        a.horaInicio.localeCompare(b.horaInicio) ||
        a.horaFim.localeCompare(b.horaFim),
    );
}

/**
 * As celulas do bloco como LINHAS da tela: a mesma sessao em Semi e em Modular,
 * com o mesmo nome, e uma linha so.
 *
 * Se os dois formatos tiverem nomes DIFERENTES na mesma sessao (editados na
 * grade da outra aba), saem duas linhas — e salvar recusa a sessao repetida. E
 * de proposito: escolher um dos dois nomes em silencio apagaria o outro.
 */
function linhasDe(
  celulas: { data: Date; janelaDeProvaId: number; nomeGrupo: string }[],
  janelaPorId: Map<number, JanelaComGrupo>,
): LinhaDeGrupo[] {
  const porLinha = new Map<string, LinhaDeGrupo>();

  for (const celula of celulas) {
    const janela = janelaPorId.get(celula.janelaDeProvaId);
    if (!janela) continue;

    const data = isoDeDataUtc(celula.data);
    const chave = `${data}|${janela.horaInicio}|${janela.horaFim}|${normalizarNomeDeGrupo(celula.nomeGrupo)}`;

    const atual = porLinha.get(chave) ?? {
      data,
      horaInicio: janela.horaInicio,
      horaFim: janela.horaFim,
      nomeGrupo: celula.nomeGrupo,
      modalidades: [],
    };

    if (!atual.modalidades.includes(janela.modalidade.codigo)) {
      atual.modalidades.push(janela.modalidade.codigo);
    }
    porLinha.set(chave, atual);
  }

  return [...porLinha.values()]
    .map((l) => ({ ...l, modalidades: l.modalidades.sort() }))
    .sort(
      (a, b) =>
        a.data.localeCompare(b.data) ||
        a.horaInicio.localeCompare(b.horaInicio) ||
        a.nomeGrupo.localeCompare(b.nomeGrupo, 'pt-BR'),
    );
}

/**
 * Horario de faixa sem janela ATIVA identica no formato.
 *
 * Por formato, e nao por faixa: a faixa e neutra, e uma mesma faixa pode ter
 * sala EaD e sala Semi — cada formato confere o horario contra as proprias
 * janelas. Comparacao EXATA: "15:00 e quase 15:30" colocaria aluno no grupo
 * errado sem aviso.
 */
function pendenciasDeHorario(
  ofertas: Oferta[],
  janelas: JanelaComGrupo[],
): PendenciaDeHorario[] {
  const casa = (modalidadeId: number, horaInicio: string, horaFim: string) =>
    janelas.some(
      (j) =>
        j.modalidadeId === modalidadeId &&
        j.horaInicio === horaInicio &&
        j.horaFim === horaFim,
    );

  const grupos = new Map<
    string,
    {
      oferta: Oferta;
      faixas: Set<number>;
      dias: Set<string>;
      agendamentos: number;
    }
  >();

  /** modalidadeId -> "hi-hf" -> faixas. Para contar quantas casam por janela. */
  const faixasPorHorario = new Map<number, Map<string, Set<number>>>();

  for (const oferta of ofertas) {
    const { faixa } = oferta;
    const horario = `${faixa.horaInicio}-${faixa.horaFim}`;

    const daModalidade =
      faixasPorHorario.get(oferta.modalidadeId) ??
      new Map<string, Set<number>>();
    daModalidade.set(
      horario,
      (daModalidade.get(horario) ?? new Set<number>()).add(faixa.id),
    );
    faixasPorHorario.set(oferta.modalidadeId, daModalidade);

    if (casa(oferta.modalidadeId, faixa.horaInicio, faixa.horaFim)) continue;

    const chave = `${oferta.modalidadeId}|${horario}`;
    const atual = grupos.get(chave) ?? {
      oferta,
      faixas: new Set<number>(),
      dias: new Set<string>(),
      agendamentos: 0,
    };

    atual.faixas.add(faixa.id);
    atual.dias.add(isoDeDataUtc(faixa.data));
    atual.agendamentos += oferta._count.agendamentos;
    grupos.set(chave, atual);
  }

  return [...grupos.values()]
    .map(({ oferta, faixas, dias, agendamentos }): PendenciaDeHorario => {
      const { horaInicio, horaFim } = oferta.faixa;

      const candidatas = janelas
        .filter((j) => j.modalidadeId === oferta.modalidadeId)
        .map((j) => ({
          id: j.id,
          horaInicio: j.horaInicio,
          horaFim: j.horaFim,
          horaDisparo: j.horaDisparo,
          faixasQueCasam:
            faixasPorHorario
              .get(oferta.modalidadeId)
              ?.get(`${j.horaInicio}-${j.horaFim}`)?.size ?? 0,
        }));

      // A sugestao prefere a janela que NINGUEM usa (e quase sempre o outro
      // lado do mesmo erro de digitacao) e, entre elas, a mais proxima.
      const distancia = (j: JanelaCandidata) =>
        Math.abs(minutosDaHora(j.horaInicio)! - minutosDaHora(horaInicio)!) +
        Math.abs(minutosDaHora(j.horaFim)! - minutosDaHora(horaFim)!);

      const sugerida = [...candidatas].sort(
        (a, b) =>
          Number(a.faixasQueCasam > 0) - Number(b.faixasQueCasam > 0) ||
          distancia(a) - distancia(b),
      )[0];

      return {
        modalidadeId: oferta.modalidadeId,
        modalidadeCodigo: oferta.modalidade.codigo,
        modalidadeNome: oferta.modalidade.nome,
        horaInicio,
        horaFim,
        faixas: faixas.size,
        dias: [...dias].sort(),
        agendamentos,
        janelas: candidatas,
        janelaSugeridaId: sugerida?.id ?? null,
      };
    })
    .sort(
      (a, b) =>
        a.modalidadeCodigo.localeCompare(b.modalidadeCodigo) ||
        a.horaInicio.localeCompare(b.horaInicio),
    );
}

function diaBr(iso: string): string {
  const [ano, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${ano}`;
}
