import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { duracaoEmMinutos } from '../../components/horario.util';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import {
  exigirEncontrado,
  exigirSalaLivreNoHorario,
  janelaDaFaixa,
  validarOferta,
} from './sala-faixa.validacao';

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

@Injectable()
export class FaixaService {
  constructor(private readonly prisma: PrismaService) {}

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
      `Polo ${dados.poloId} nao encontrado`,
    );

    // Polo inativo = campus fora da oferta. Esta e a trava que faz "desativar o
    // polo" significar de fato "nao ha mais prova aqui": sem faixa nova, nenhum
    // aluno consegue agendar, e o compulsorio os reporta como SEM_FAIXA_NO_POLO.
    // As faixas JA criadas continuam de pe — quem agendou nao perde a prova.
    if (!polo.ativo) {
      throw new ConflictException(
        `O polo "${polo.nome}" esta inativo e nao recebe faixas novas. ` +
          'Reative-o (PATCH ativo=true) se o campus voltou a ter prova.',
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
        `Ja existe uma faixa em ${polo.nome} no dia ${dados.data} das ` +
          `${dados.horaInicio} as ${dados.horaFim} (id ${duplicada.id}). ` +
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

    if (!faixa) throw new NotFoundException(`Faixa ${id} nao encontrada`);

    return montarDetalhe(faixa);
  }

  /**
   * Alterar o HORARIO de uma faixa que ja tem oferta exige revalidar todas as
   * modalidades: encurtar a janela poderia deixar uma prova de 3h numa faixa de
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

    if (!faixa) throw new NotFoundException(`Faixa ${id} nao encontrada`);

    const horaInicio = dados.horaInicio ?? faixa.horaInicio;
    const horaFim = dados.horaFim ?? faixa.horaFim;
    const janela = janelaDaFaixa(horaInicio, horaFim);

    const naoCabe = faixa.salaFaixas.find(
      (sf) => sf.modalidade.duracaoMinutos > janela,
    );

    if (naoCabe) {
      throw new BadRequestException(
        `A faixa passaria a ter ${janela} min, mas ja oferta a modalidade ` +
          `${naoCabe.modalidade.nome} (${naoCabe.modalidade.duracaoMinutos} min). ` +
          'Remova essa oferta antes de encurtar o horario.',
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

  /** Adiciona uma sala a uma faixa ja existente. */
  async adicionarSala(
    faixaId: number,
    entrada: SalaDaFaixaEntrada,
  ): Promise<FaixaDetalhe> {
    const faixa = await this.prisma.faixa.findUnique({
      where: { id: faixaId },
      include: { salaFaixas: true },
    });

    if (!faixa) throw new NotFoundException(`Faixa ${faixaId} nao encontrada`);

    if (faixa.salaFaixas.some((sf) => sf.salaId === entrada.salaId)) {
      throw new ConflictException(
        'Esta sala ja esta nesta faixa. Uma sala entra uma unica vez por faixa, ' +
          'porque dentro de uma faixa ela fica travada numa modalidade.',
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

    if (!faixa) throw new NotFoundException(`Faixa ${id} nao encontrada`);

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
          : `${cancelados} agendamento(s) CANCELADO(s) — nenhum confirmado`;

      throw new ConflictException(
        `Esta faixa tem ${situacao} e nao pode ser apagada. ` +
          'Cancelar nao apaga o agendamento: ele vira CANCELADO e continua ' +
          'registrado, com o historico de quem marcou e desmarcou. ' +
          'Desative a faixa (PATCH ativo=false) para tira-la da lista dos alunos ' +
          'sem perder esse registro.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.salaFaixa.deleteMany({ where: { faixaId: id } }),
      this.prisma.faixa.delete({ where: { id } }),
    ]);

    return { mensagem: `Faixa ${id} removida` };
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
   * dentro de faixa+modalidade. Quando o admin nao informa, numeramos na ordem
   * em que ele mandou, que e a leitura natural de "primeiro enche esta".
   */
  private async prepararOfertas(
    faixa: { poloId: number; horaInicio: string; horaFim: string },
    entradas: SalaDaFaixaEntrada[],
    jaExistentes: { modalidadeId: number; ordem: number }[] = [],
  ) {
    if (entradas.length === 0) {
      throw new BadRequestException(
        'Informe ao menos uma sala: faixa sem sala nao aparece para aluno nenhum.',
      );
    }

    const idsRepetidos = entradas
      .map((e) => e.salaId)
      .filter((id, i, todos) => todos.indexOf(id) !== i);

    if (idsRepetidos.length > 0) {
      throw new BadRequestException(
        `Sala repetida na mesma faixa: ${[...new Set(idsRepetidos)].join(', ')}. ` +
          'Dentro de uma faixa, a sala fica travada numa unica modalidade.',
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

    // Proxima ordem livre por modalidade, considerando o que a faixa ja tem.
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
        `Sala ${entrada.salaId} nao encontrada`,
      );

      const modalidade = exigirEncontrado(
        modalidades.find((m) => m.id === entrada.modalidadeId) ?? null,
        `Modalidade ${entrada.modalidadeId} nao encontrada`,
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
          `A ordem ${ordem} ja esta usada na modalidade ${modalidade.nome} desta faixa. ` +
            'A ordem define a sequencia de preenchimento e precisa ser unica.',
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

/**
 * "2026-08-20" -> Date em meia-noite UTC. A coluna e @db.Date; construir a data
 * no fuso local faria "2026-08-20" virar dia 19 em fusos a oeste de Greenwich.
 */
function paraData(data: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    throw new BadRequestException(
      `Data invalida: "${data}". Use o formato AAAA-MM-DD.`,
    );
  }

  const quando = new Date(`${data}T00:00:00.000Z`);

  if (Number.isNaN(quando.getTime())) {
    throw new BadRequestException(`Data invalida: "${data}"`);
  }

  return quando;
}
