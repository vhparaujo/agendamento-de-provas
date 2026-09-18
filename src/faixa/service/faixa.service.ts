import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { duracaoEmMinutos } from '../../components/horario.util';
import { hojeUtc } from '../../components/utc.util';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import {
  exigirEncontrado,
  exigirSalaLivreNoHorario,
  janelaDaFaixa,
  validarOferta,
} from './sala-faixa.validacao';

const FAIXA_NAO_ENCONTRADA =
  'Faixa não encontrada. Ela pode ter sido apagada; atualize a página.';

export interface OfertaResumo {
  /** Id da SalaFaixa — e ele que o agendamento aponta. */
  id: number;
  salaId: number;
  salaNome: string;
  modalidade: {
    id: number;
    codigo: string;
    nome: string;
    duracaoMinutos: number;
  };
  vagas: number;
  ordem: number;
  ocupadas: number;
  disponiveis: number;
}

export interface FaixaDetalhe {
  id: number;
  poloId: number;
  polo: { id: number; nome: string };
  data: Date;
  horaInicio: string;
  horaFim: string;
  duracaoMinutos: number;
  ativo: boolean;
  ofertas: OfertaResumo[];
}

export interface SalaDaFaixaEntrada {
  salaId: number;
  modalidadeId: number;
  vagas?: number;
  ordem?: number;
}

/** Uma faixa dentro do corte da desativacao em lote. */
export interface FaixaDoLote {
  id: number;
  data: Date;
  horaInicio: string;
  horaFim: string;
  polo: { id: number; nome: string };
  /** Agendamentos CONFIRMADOS nela. Desativar nao mexe em nenhum deles. */
  confirmados: number;
  /** Ja estava inativa: entra no relatorio, mas nao conta como desativada. */
  jaInativa: boolean;
  /** Data ainda por vir — e aqui que desativar muda o que o aluno ve hoje. */
  futura: boolean;
}

export interface ResultadoDesativacaoEmLote {
  simulacao: boolean;
  /** O corte aplicado, ecoado para a tela poder repeti-lo na confirmacao. */
  ate: Date;
  poloId?: number;
  /** Quantas mudaram (ou mudariam) de ativa para inativa. */
  desativadas: number;
  /** Quantas o corte pegou mas ja estavam inativas. */
  jaInativas: number;
  /** Faixas do corte que ainda nao aconteceram. */
  futuras: number;
  /** Agendamentos confirmados nas faixas do corte. Todos PERMANECEM. */
  agendamentosMantidos: number;
  /** O corte inteiro, em ordem de data, para a tela conferir antes de aplicar. */
  faixas: FaixaDoLote[];
  mensagem: string;
}

@Injectable()
export class FaixaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Cria a faixa e a oferta de vagas de uma vez, numa transacao: uma faixa sem
   * nenhuma sala nao serve para nada (nao aparece para aluno nenhum), entao
   * gravar so a faixa e falhar nas salas deixaria lixo no banco.
   */
  async criar(dados: {
    poloId: number;
    data: string;
    horaInicio: string;
    horaFim: string;
    salas: SalaDaFaixaEntrada[];
  }): Promise<FaixaDetalhe> {
    janelaDaFaixa(dados.horaInicio, dados.horaFim);

    const polo = exigirEncontrado(
      await this.prisma.polo.findUnique({ where: { id: dados.poloId } }),
      'Polo não encontrado. Ele pode ter sido apagado; atualize a página.',
    );

    // Polo inativo = campus fora da oferta. Esta e a trava que faz "desativar o
    // polo" significar de fato "nao ha mais prova aqui": sem faixa nova, nenhum
    // aluno consegue agendar, e o compulsorio os reporta como SEM_FAIXA_NO_POLO.
    // As faixas JA criadas continuam de pe — quem agendou nao perde a prova.
    if (!polo.ativo) {
      throw new ConflictException(
        `O polo "${polo.nome}" está inativo e não recebe faixas novas. ` +
          'Se o campus voltou a ter prova, reative o polo na tela de Polos.',
      );
    }

    const data = paraData(dados.data);

    // Duas faixas identicas no mesmo polo quase sempre sao duplo-clique, e
    // dividiriam as vagas em duas listas confusas para o aluno.
    const duplicada = await this.prisma.faixa.findFirst({
      where: {
        poloId: dados.poloId,
        data,
        horaInicio: dados.horaInicio,
        horaFim: dados.horaFim,
      },
    });

    if (duplicada) {
      throw new ConflictException(
        `Já existe uma faixa em ${polo.nome} no dia ` +
          `${dados.data.split('-').reverse().join('/')} das ` +
          `${dados.horaInicio} às ${dados.horaFim} (faixa #${duplicada.id}). ` +
          'Adicione salas a ela em vez de criar outra.',
      );
    }

    const ofertas = await this.prepararOfertas(
      {
        poloId: dados.poloId,
        horaInicio: dados.horaInicio,
        horaFim: dados.horaFim,
      },
      dados.salas,
    );

    await this.exigirSalasLivres(
      data,
      dados,
      ofertas.map((o) => o.salaId),
    );

    const faixa = await this.prisma.$transaction(async (tx) => {
      const criada = await tx.faixa.create({
        data: {
          poloId: dados.poloId,
          data,
          horaInicio: dados.horaInicio,
          horaFim: dados.horaFim,
        },
      });

      await tx.salaFaixa.createMany({
        data: ofertas.map((o) => ({ ...o, faixaId: criada.id })),
      });

      return criada;
    });

    return this.buscar(faixa.id);
  }

  async listar(filtros: {
    poloId?: number;
    modalidadeId?: number;
    de?: string;
    ate?: string;
    apenasAtivas?: boolean;
  }): Promise<FaixaDetalhe[]> {
    const faixas = await this.prisma.faixa.findMany({
      where: {
        poloId: filtros.poloId,
        ativo: filtros.apenasAtivas ? true : undefined,
        data: {
          gte: filtros.de ? paraData(filtros.de) : undefined,
          lte: filtros.ate ? paraData(filtros.ate) : undefined,
        },
        salaFaixas: filtros.modalidadeId
          ? { some: { modalidadeId: filtros.modalidadeId } }
          : undefined,
      },
      orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
      include: INCLUDE_DETALHE,
    });

    return faixas.map((f) => montarDetalhe(f));
  }

  async buscar(id: number): Promise<FaixaDetalhe> {
    const faixa = await this.prisma.faixa.findUnique({
      where: { id },
      include: INCLUDE_DETALHE,
    });

    if (!faixa) throw new NotFoundException(FAIXA_NAO_ENCONTRADA);

    return montarDetalhe(faixa);
  }

  /**
   * Alterar o HORARIO de uma faixa que ja tem oferta exige revalidar todos os
   * formatos: encurtar a janela poderia deixar uma prova de 3h numa faixa de
   * 1h30 que ja tem gente agendada.
   */
  async atualizar(
    id: number,
    dados: {
      data?: string;
      horaInicio?: string;
      horaFim?: string;
      ativo?: boolean;
    },
  ): Promise<FaixaDetalhe> {
    const faixa = await this.prisma.faixa.findUnique({
      where: { id },
      include: { salaFaixas: { include: { modalidade: true } } },
    });

    if (!faixa) throw new NotFoundException(FAIXA_NAO_ENCONTRADA);

    const horaInicio = dados.horaInicio ?? faixa.horaInicio;
    const horaFim = dados.horaFim ?? faixa.horaFim;
    const janela = janelaDaFaixa(horaInicio, horaFim);

    const naoCabe = faixa.salaFaixas.find(
      (sf) => sf.modalidade.duracaoMinutos > janela,
    );

    if (naoCabe) {
      throw new BadRequestException(
        `A faixa passaria a ter ${janela} min, mas já tem sala no formato ` +
          `${naoCabe.modalidade.nome}, cuja prova dura ${naoCabe.modalidade.duracaoMinutos} min. ` +
          'Tire essa sala da faixa antes de encurtar o horário.',
      );
    }

    // Mover a faixa no calendario arrasta TODAS as salas dela junto — e um
    // horario que nao chocava com nada pode passar a chocar. E o caminho menos
    // obvio para criar duas provas na mesma sala, porque o admin acha que so
    // mexeu no relogio.
    //
    // So confere quando data/hora realmente mudam: um PATCH de `ativo` nao cria
    // sobreposicao nenhuma, e recusa-lo por causa de dado antigo deixaria o
    // admin sem conseguir nem desativar a faixa problematica.
    const mudouOQuando =
      (dados.data !== undefined &&
        paraData(dados.data).getTime() !== faixa.data.getTime()) ||
      (dados.horaInicio !== undefined &&
        dados.horaInicio !== faixa.horaInicio) ||
      (dados.horaFim !== undefined && dados.horaFim !== faixa.horaFim);

    if (mudouOQuando) {
      await this.exigirSalasLivres(
        dados.data ? paraData(dados.data) : faixa.data,
        { horaInicio, horaFim },
        faixa.salaFaixas.map((sf) => sf.salaId),
        id,
      );
    }

    await this.prisma.faixa.update({
      where: { id },
      data: {
        data: dados.data ? paraData(dados.data) : undefined,
        horaInicio: dados.horaInicio,
        horaFim: dados.horaFim,
        ativo: dados.ativo,
      },
    });

    return this.buscar(id);
  }

  /**
   * ==========================================================================
   * DESATIVA EM LOTE AS FAIXAS ATE UMA DATA — A VIRADA DE PERIODO
   * ==========================================================================
   * A faixa NAO pertence a periodo nenhum: ela e polo + data + hora, e o que a
   * tira da frente do aluno e a data ter passado (`data >= hoje`, o mesmo corte
   * em `listarFaixas` e no compulsorio). Enquanto as datas de dois periodos nao
   * se cruzam, isso basta e nao ha nada a fazer na virada.
   *
   * Quando se cruzam — a SUB abrindo antes de a ultima data da N2 chegar — o
   * aluno da rodada nova ve as faixas da anterior misturadas com as novas, e
   * nada no modelo sabe distinguir umas das outras. Este lote e o corte
   * explicito que resolve: "o que era do periodo passado sai da lista".
   *
   * POR QUE `ativo = false`, E NAO APAGAR: apagar e recusado quando ha
   * agendamento, inclusive cancelado (ver `remover`) — o registro de quem tinha
   * prova naquele dia nao pode sumir. Desativar tira a faixa do portal e do
   * compulsorio e preserva tudo.
   *
   * NENHUM AGENDAMENTO E TOCADO. Quem ja tem prova numa faixa desativada
   * continua com ela: sai na lista de presenca, no relatorio e no special
   * access, porque nenhum deles filtra por `ativo`. O que a desativacao impede
   * e alguem ENTRAR ali daqui para a frente — que e exatamente o objetivo.
   *
   * `simulacao: true` e o padrao, como no compulsorio e pelo mesmo motivo: um
   * corte de data errado tira o periodo inteiro da frente dos alunos, e desfazer
   * significa reativar faixa por faixa.
   */
  async desativarEmLote(
    dados: { ate: string; poloId?: number; simulacao?: boolean },
    porAdmin?: string,
  ): Promise<ResultadoDesativacaoEmLote> {
    const simulacao = dados.simulacao ?? true;
    const ate = paraData(dados.ate);
    const hoje = hojeUtc();

    if (dados.poloId !== undefined) {
      exigirEncontrado(
        await this.prisma.polo.findUnique({ where: { id: dados.poloId } }),
        'Polo não encontrado. Ele pode ter sido apagado; atualize a página.',
      );
    }

    // `lte`: o corte INCLUI o dia informado. "Desative tudo ate 31/08" tem que
    // pegar as provas do proprio dia 31 — e a leitura natural da frase.
    const encontradas = await this.prisma.faixa.findMany({
      where: { data: { lte: ate }, poloId: dados.poloId },
      orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
      select: {
        id: true,
        data: true,
        horaInicio: true,
        horaFim: true,
        ativo: true,
        polo: { select: { id: true, nome: true } },
        // A contagem vem das SalaFaixa porque e para ELAS que o agendamento
        // aponta; a faixa nao tem agendamento direto.
        salaFaixas: {
          select: {
            _count: {
              select: {
                agendamentos: {
                  where: { status: StatusAgendamento.CONFIRMADO },
                },
              },
            },
          },
        },
      },
    });

    const faixas: FaixaDoLote[] = encontradas.map((f) => ({
      id: f.id,
      data: f.data,
      horaInicio: f.horaInicio,
      horaFim: f.horaFim,
      polo: f.polo,
      confirmados: f.salaFaixas.reduce(
        (total, sf) => total + sf._count.agendamentos,
        0,
      ),
      jaInativa: !f.ativo,
      futura: f.data >= hoje,
    }));

    // Os numeros de baixo olham so as faixas que MUDAM. Uma faixa que ja estava
    // inativa entra no relatorio para o admin entender o corte, mas somar os
    // agendamentos dela em "mantidos" faria a tela anunciar um impacto que esta
    // execucao nao tem.
    const mudam = faixas.filter((f) => !f.jaInativa);

    const resultado: ResultadoDesativacaoEmLote = {
      simulacao,
      ate,
      poloId: dados.poloId,
      desativadas: mudam.length,
      jaInativas: faixas.length - mudam.length,
      futuras: mudam.filter((f) => f.futura).length,
      agendamentosMantidos: mudam.reduce((t, f) => t + f.confirmados, 0),
      faixas,
      mensagem: '',
    };

    if (!simulacao && mudam.length > 0) {
      // Pelos IDS que acabaram de ser contados, e nao repetindo o filtro de
      // data: entre a leitura e a escrita alguem pode ter cadastrado uma faixa
      // dentro do corte, e ela seria desativada sem aparecer no relatorio que o
      // admin confirmou.
      await this.prisma.faixa.updateMany({
        where: { id: { in: mudam.map((f) => f.id) } },
        data: { ativo: false },
      });

      this.auditoria.registrar('FAIXAS_DESATIVADAS_EM_LOTE', {
        ator: porAdmin,
        detalhe:
          `${mudam.length} faixa(s) desativadas ate ${dataBr(ate)}` +
          `${dados.poloId ? ` no polo ${dados.poloId}` : ' (todos os polos)'}; ` +
          `${resultado.futuras} ainda por acontecer, ` +
          `${resultado.agendamentosMantidos} agendamento(s) confirmado(s) preservado(s); ` +
          `ids: ${mudam.map((f) => f.id).join(',')}`,
      });
    }

    resultado.mensagem = mensagemDoLote(resultado, dataBr(ate));

    return resultado;
  }

  /** Adiciona uma sala a uma faixa ja existente. */
  async adicionarSala(
    faixaId: number,
    entrada: SalaDaFaixaEntrada,
  ): Promise<FaixaDetalhe> {
    const faixa = await this.prisma.faixa.findUnique({
      where: { id: faixaId },
      include: { salaFaixas: true },
    });

    if (!faixa) throw new NotFoundException(FAIXA_NAO_ENCONTRADA);

    if (faixa.salaFaixas.some((sf) => sf.salaId === entrada.salaId)) {
      throw new ConflictException(
        'Esta sala já está nesta faixa. Uma sala entra uma única vez por faixa, ' +
          'porque dentro de uma faixa ela fica travada num formato.',
      );
    }

    const [oferta] = await this.prepararOfertas(
      faixa,
      [entrada],
      faixa.salaFaixas,
    );

    await this.exigirSalasLivres(faixa.data, faixa, [oferta.salaId], faixaId);

    await this.prisma.salaFaixa.create({ data: { ...oferta, faixaId } });

    return this.buscar(faixaId);
  }

  async remover(id: number): Promise<{ mensagem: string }> {
    const faixa = await this.prisma.faixa.findUnique({
      where: { id },
      include: { _count: { select: { salaFaixas: true } } },
    });

    if (!faixa) throw new NotFoundException(FAIXA_NAO_ENCONTRADA);

    // O CANCELADO conta tanto quanto o confirmado, e a mensagem precisa dizer
    // isso: quem cancelou os agendamentos acha que "tirou tudo" e nao entende o
    // 409. Cancelado nao some do banco de proposito (quem aparecer no dia sem
    // estar na lista precisa ser explicavel), e ele ainda aponta para a
    // SalaFaixa — a FK e Restrict, entao apagar aqui daria erro de banco cru.
    const [confirmados, cancelados] = await Promise.all([
      this.prisma.agendamento.count({
        where: { salaFaixa: { faixaId: id }, status: 'CONFIRMADO' },
      }),
      this.prisma.agendamento.count({
        where: { salaFaixa: { faixaId: id }, status: 'CANCELADO' },
      }),
    ]);

    if (confirmados > 0 || cancelados > 0) {
      const situacao =
        confirmados > 0
          ? `${confirmados} agendamento(s) confirmado(s)` +
            (cancelados > 0 ? ` e ${cancelados} cancelado(s)` : '')
          : `${cancelados} agendamento(s) cancelado(s), nenhum confirmado`;

      throw new ConflictException(
        `Esta faixa não pode ser apagada porque tem ${situacao}. ` +
          'Mesmo cancelado, o agendamento continua registrado, com o histórico ' +
          'de quem marcou e desmarcou. Em vez de apagar, desative a faixa: ela ' +
          'sai da lista dos alunos e esse registro é preservado.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.salaFaixa.deleteMany({ where: { faixaId: id } }),
      this.prisma.faixa.delete({ where: { id } }),
    ]);

    return { mensagem: 'Faixa removida.' };
  }

  /**
   * Recusa colocar uma sala num horario em que ela ja tem prova no mesmo dia.
   * Regra e criterio de "ocupa de verdade" em exigirSalaLivreNoHorario.
   *
   * O recorte da consulta e `sala + data`, sem filtrar polo: `Sala.poloId` e
   * imutavel e `validarOferta` ja garante que a sala e do polo da faixa, entao
   * toda faixa que disputa esta sala e do mesmo campus por construcao.
   *
   * Como o `duplicada` de `criar`, a checagem e feita FORA da transacao: dois
   * admins montando faixas que se cruzam no mesmo segundo ainda passariam. E o
   * mesmo risco que o projeto ja aceita nas rotas administrativas — sao poucas
   * pessoas, e o custo de serializar o cadastro nao se paga. O caminho critico
   * de concorrencia e a alocacao de vaga, que tem FOR UPDATE.
   */
  private async exigirSalasLivres(
    data: Date,
    janela: { horaInicio: string; horaFim: string },
    salaIds: number[],
    faixaIdIgnorada?: number,
  ): Promise<void> {
    if (salaIds.length === 0) return;

    const concorrentes = await this.prisma.salaFaixa.findMany({
      where: {
        salaId: { in: salaIds },
        faixa: {
          data,
          id: faixaIdIgnorada ? { not: faixaIdIgnorada } : undefined,
        },
      },
      include: {
        sala: { select: { nome: true } },
        faixa: {
          select: { id: true, horaInicio: true, horaFim: true, ativo: true },
        },
        _count: {
          select: {
            agendamentos: { where: { status: StatusAgendamento.CONFIRMADO } },
          },
        },
      },
    });

    exigirSalaLivreNoHorario(
      janela,
      concorrentes.map((c) => ({
        faixaId: c.faixa.id,
        horaInicio: c.faixa.horaInicio,
        horaFim: c.faixa.horaFim,
        faixaAtiva: c.faixa.ativo,
        salaId: c.salaId,
        salaNome: c.sala.nome,
        confirmados: c._count.agendamentos,
      })),
    );
  }

  /**
   * Valida cada sala pedida e resolve a `ordem` — a sequencia de preenchimento
   * dentro de faixa+formato. Quando o admin nao informa, numeramos na ordem
   * em que ele mandou, que e a leitura natural de "primeiro enche esta".
   */
  private async prepararOfertas(
    faixa: { poloId: number; horaInicio: string; horaFim: string },
    entradas: SalaDaFaixaEntrada[],
    jaExistentes: { modalidadeId: number; ordem: number }[] = [],
  ) {
    if (entradas.length === 0) {
      throw new BadRequestException(
        'Informe ao menos uma sala: faixa sem sala não aparece para aluno nenhum.',
      );
    }

    const idsRepetidos = entradas
      .map((e) => e.salaId)
      .filter((id, i, todos) => todos.indexOf(id) !== i);

    if (idsRepetidos.length > 0) {
      throw new BadRequestException(
        'A mesma sala foi escolhida mais de uma vez nesta faixa. ' +
          'Dentro de uma faixa, a sala fica travada num único formato.',
      );
    }

    const [salas, modalidades] = await Promise.all([
      this.prisma.sala.findMany({
        where: { id: { in: entradas.map((e) => e.salaId) } },
      }),
      this.prisma.modalidade.findMany({
        where: { id: { in: entradas.map((e) => e.modalidadeId) } },
      }),
    ]);

    // Proxima ordem livre por formato, considerando o que a faixa ja tem.
    const proximaOrdem = new Map<number, number>();
    for (const existente of jaExistentes) {
      proximaOrdem.set(
        existente.modalidadeId,
        Math.max(
          proximaOrdem.get(existente.modalidadeId) ?? 0,
          existente.ordem,
        ),
      );
    }

    const ordensUsadas = new Set(
      jaExistentes.map((e) => `${e.modalidadeId}:${e.ordem}`),
    );

    return entradas.map((entrada) => {
      const sala = exigirEncontrado(
        salas.find((s) => s.id === entrada.salaId) ?? null,
        'Uma das salas escolhidas não foi encontrada. Ela pode ter sido apagada; atualize a página.',
      );

      const modalidade = exigirEncontrado(
        modalidades.find((m) => m.id === entrada.modalidadeId) ?? null,
        'Formato não encontrado. Atualize a página e tente de novo.',
      );

      const vagas = entrada.vagas ?? sala.capacidade;

      validarOferta(faixa, sala, modalidade, vagas);

      let ordem = entrada.ordem;

      if (ordem === undefined) {
        ordem = (proximaOrdem.get(modalidade.id) ?? 0) + 1;
      }

      const chave = `${modalidade.id}:${ordem}`;
      if (ordensUsadas.has(chave)) {
        throw new ConflictException(
          `A ordem ${ordem} já está sendo usada no formato ${modalidade.nome} desta faixa. ` +
            'A ordem define a sequência de preenchimento e precisa ser única.',
        );
      }

      ordensUsadas.add(chave);
      proximaOrdem.set(
        modalidade.id,
        Math.max(proximaOrdem.get(modalidade.id) ?? 0, ordem),
      );

      return {
        salaId: sala.id,
        modalidadeId: modalidade.id,
        vagas,
        ordem,
      };
    });
  }
}

// `satisfies` em vez de `as const`: mantem os literais para a inferencia do
// Prisma sem congelar o orderBy como readonly, que o tipo FaixaInclude recusa.
const INCLUDE_DETALHE = {
  polo: { select: { id: true, nome: true } },
  salaFaixas: {
    include: {
      sala: { select: { id: true, nome: true } },
      modalidade: true,
      // Cancelado nao ocupa lugar. A contagem precisa ser IDENTICA a que a
      // alocacao usa (src/agendamento/service/agendamento.service.ts): se o
      // admin visse a sala cheia e o alocador a visse com vaga, um dos dois
      // estaria mentindo.
      _count: {
        select: {
          agendamentos: { where: { status: StatusAgendamento.CONFIRMADO } },
        },
      },
    },
    orderBy: [{ modalidadeId: 'asc' }, { ordem: 'asc' }],
  },
} satisfies Prisma.FaixaInclude;

type FaixaComRelacoes = {
  id: number;
  poloId: number;
  data: Date;
  horaInicio: string;
  horaFim: string;
  ativo: boolean;
  polo: { id: number; nome: string };
  salaFaixas: {
    id: number;
    salaId: number;
    vagas: number;
    ordem: number;
    sala: { id: number; nome: string };
    modalidade: {
      id: number;
      codigo: string;
      nome: string;
      duracaoMinutos: number;
    };
    _count: { agendamentos: number };
  }[];
};

function montarDetalhe(faixa: FaixaComRelacoes): FaixaDetalhe {
  return {
    id: faixa.id,
    poloId: faixa.poloId,
    polo: faixa.polo,
    data: faixa.data,
    horaInicio: faixa.horaInicio,
    horaFim: faixa.horaFim,
    duracaoMinutos: duracaoEmMinutos(faixa.horaInicio, faixa.horaFim),
    ativo: faixa.ativo,
    ofertas: faixa.salaFaixas.map((sf) => ({
      id: sf.id,
      salaId: sf.salaId,
      salaNome: sf.sala.nome,
      modalidade: {
        id: sf.modalidade.id,
        codigo: sf.modalidade.codigo,
        nome: sf.modalidade.nome,
        duracaoMinutos: sf.modalidade.duracaoMinutos,
      },
      vagas: sf.vagas,
      ordem: sf.ordem,
      ocupadas: sf._count.agendamentos,
      disponiveis: Math.max(0, sf.vagas - sf._count.agendamentos),
    })),
  };
}

/** A data como o admin a le — a coluna e @db.Date, entao o fuso e UTC. */
function dataBr(quando: Date): string {
  return quando.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

/**
 * O resumo em uma frase. Fica separado porque e o texto que o admin le antes de
 * confirmar um corte que nao tem botao de desfazer: ele precisa dizer o que vai
 * acontecer E o que NAO vai (ninguem perde prova marcada).
 */
function mensagemDoLote(r: ResultadoDesativacaoEmLote, ate: string): string {
  const onde = r.poloId ? 'neste polo' : 'em todos os polos';

  if (r.desativadas === 0) {
    return r.jaInativas > 0
      ? `Nenhuma faixa a desativar até ${ate} ${onde}: as ${r.jaInativas} do corte já estão inativas.`
      : `Nenhuma faixa até ${ate} ${onde}.`;
  }

  const impacto =
    r.agendamentosMantidos > 0
      ? ` ${r.agendamentosMantidos} agendamento(s) confirmado(s) continuam de pé — desativar não desmarca a prova de ninguém.`
      : '';

  const futuras = r.futuras
    ? ` ${r.futuras} ainda não aconteceram: é nelas que o aluno deixa de poder marcar ou trocar.`
    : '';

  return r.simulacao
    ? `Simulação: ${r.desativadas} faixa(s) seriam desativadas até ${ate} ${onde}.${futuras}${impacto} Nada foi gravado.`
    : `${r.desativadas} faixa(s) desativadas até ${ate} ${onde}.${futuras}${impacto}`;
}

/**
 * "2026-08-20" -> Date em meia-noite UTC. A coluna e @db.Date; construir a data
 * no fuso local faria "2026-08-20" virar dia 19 em fusos a oeste de Greenwich.
 */
function paraData(data: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    throw new BadRequestException('Data inválida. Confira a data informada.');
  }

  const quando = new Date(`${data}T00:00:00.000Z`);

  if (Number.isNaN(quando.getTime())) {
    throw new BadRequestException('Data inválida. Confira a data informada.');
  }

  return quando;
}
