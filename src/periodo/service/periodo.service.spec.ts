import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { PeriodoService } from './periodo.service';

interface Periodo {
  id: number;
  periodoLetivoId: string;
  /** A metade da identidade que separa a regular da substitutiva. */
  rodada: string;
  /** Os criterios de nota da janela. Ausentes nos fixtures = sem filtro. */
  notaMinimaN1?: number | null;
  notaMaximaFinal?: number | null;
  descricao: string | null;
  createdAt: Date;
  /**
   * O mapa `modalidade -> periodo letivo`. Ausente no fixture = o que a
   * migration produz para as janelas antigas: todos os formatos no
   * principal.
   */
  letivosPorModalidade?: { modalidadeId: number; periodoLetivoId: string }[];
}

/**
 * Os formatos cadastrados, como o seed as cria. O mapa e validado contra
 * ELAS — faltar uma e 400 —, entao o duble precisa das quatro.
 */
const MODALIDADES = [
  { id: 1, codigo: 'EAD', nome: 'EaD' },
  { id: 2, codigo: 'SEMI', nome: 'Semipresencial' },
  { id: 3, codigo: 'MODULAR', nome: 'Modular' },
  { id: 4, codigo: 'PRESENCIAL', nome: 'Presencial' },
];

/**
 * O mapa de uma janela, como o `include` do service o traz.
 *
 * Sem `letivosPorModalidade` no fixture, sintetiza o produto cartesiano com o
 * principal — exatamente o que o backfill da migration gravou.
 */
function mapaDe(periodo: Periodo) {
  const linhas =
    periodo.letivosPorModalidade ??
    MODALIDADES.map((m) => ({
      modalidadeId: m.id,
      periodoLetivoId: periodo.periodoLetivoId,
    }));

  return linhas.map((l) => ({
    ...l,
    modalidade: MODALIDADES.find((m) => m.id === l.modalidadeId)!,
  }));
}

interface Reserva {
  periodoLetivoId: string;
  rodada: string;
  status: 'CONFIRMADO' | 'CANCELADO';
}

/**
 * Prisma duble em memoria. A transacao executa direto: cada caso monta o seu
 * estado, entao nao ha o que revirar.
 */
function montar(periodos: Periodo[], reservas: Reserva[] = []) {
  const eventos: { evento: string; detalhe?: string }[] = [];
  /** A linha unica de `configuracao_senha_quiz`; `null` = nunca gravada. */
  const config: {
    atual: {
      periodoDosDisparosId: number | null;
      periodoDosDisparosPor: string | null;
      periodoDosDisparosEm: Date | null;
    } | null;
  } = { atual: null };

  const servico = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(servico),
    periodoAgendamento: {
      findUnique: ({ where }: { where: { id: number } }) => {
        const achado = periodos.find((p) => p.id === where.id);

        return Promise.resolve(
          achado
            ? {
                ...achado,
                ...COLUNAS_DE_JANELA,
                letivosPorModalidade: mapaDe(achado),
              }
            : null,
        );
      },
      // O vigente e o mais recente — mesma ordenacao do service. O `select` e
      // reproduzido de proposito: sem ele o teste passaria com um objeto que o
      // Prisma real nunca devolveria.
      findFirst: ({ select }: { select?: Record<string, boolean> } = {}) => {
        const vigente = [...periodos].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        )[0];

        if (!vigente) return Promise.resolve(null);

        const linha = {
          id: vigente.id,
          periodoLetivoId: vigente.periodoLetivoId,
          rodada: vigente.rodada,
          // Ausente no fixture = coluna nula, como no banco.
          notaMinimaN1: vigente.notaMinimaN1 ?? null,
          notaMaximaFinal: vigente.notaMaximaFinal ?? null,
          descricao: vigente.descricao,
          ...COLUNAS_DE_JANELA,
          // O `include` do mapa e sempre pedido junto (`MAPA_DA_JANELA`), e sem
          // ele `idsDaJanela` devolveria so o principal — o duble ficaria
          // silenciosamente ignorando a grade presencial.
          letivosPorModalidade: mapaDe(vigente),
        };

        // O `select` e HONRADO: cada chamador pede um conjunto diferente de
        // colunas, e um duble que devolvesse tudo faria passar um teste sobre
        // um objeto que o Prisma real nunca montaria.
        if (!select) return Promise.resolve(linha);

        return Promise.resolve(
          Object.fromEntries(
            Object.keys(select).map((coluna) => [
              coluna,
              (linha as Record<string, unknown>)[coluna],
            ]),
          ),
        );
      },
      delete: ({ where }: { where: { id: number } }) => {
        const i = periodos.findIndex((p) => p.id === where.id);
        if (i >= 0) periodos.splice(i, 1);
        return Promise.resolve({});
      },
      // `listar` le a linha inteira; os fixtures so carregam o que distingue um
      // periodo do outro, entao as colunas de janela vem daqui com valor fixo.
      findMany: () =>
        Promise.resolve(
          [...periodos]
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((p) => ({
              ...p,
              ...COLUNAS_DE_JANELA,
              letivosPorModalidade: mapaDe(p),
            })),
        ),
      update: ({ where, data }: { where: { id: number }; data: Periodo }) => {
        const alvo = periodos.find((p) => p.id === where.id)!;

        // `undefined` no Prisma significa "nao mexe nesta coluna" — reproduzir
        // isso importa: um duble que sobrescrevesse com undefined faria o teste
        // da rodada inalterada passar por acidente.
        for (const [chave, valor] of Object.entries(data)) {
          if (valor !== undefined)
            (alvo as never as Record<string, unknown>)[chave] = valor;
        }

        return Promise.resolve(alvo);
      },
      create: ({
        data,
      }: {
        data: Periodo & {
          letivosPorModalidade?: {
            create: { modalidadeId: number; periodoLetivoId: string }[];
          };
        };
      }) => {
        const { letivosPorModalidade: aninhado, ...colunas } = data;

        const criado: Periodo = {
          ...colunas,
          id: Math.max(0, ...periodos.map((p) => p.id)) + 1,
          createdAt: new Date(),
          // O `create` aninhado do Prisma vira o mapa da linha — sem isto o
          // duble perderia justamente o que `criar` passou a gravar.
          letivosPorModalidade: aninhado?.create,
        };

        periodos.push(criado);
        return Promise.resolve(criado);
      },
    },
    agendamento: {
      // Reproduz o `where` inteiro de proposito: um duble que ignorasse a
      // `rodada` passaria dizendo que a janela da substitutiva esta travada
      // pelas provas da regular — justamente o que o service deixou de fazer.
      count: ({
        where,
      }: {
        where: { periodoLetivoId: { in: string[] }; rodada: string };
      }) =>
        Promise.resolve(
          reservas.filter(
            (r) =>
              where.periodoLetivoId.in.includes(r.periodoLetivoId) &&
              r.rodada === where.rodada,
          ).length,
        ),
      // Agrupado pelo PAR, como o service pede — agrupar so pelo semestre faria
      // o teste da contagem por janela passar com a soma das duas rodadas.
      groupBy: () => {
        const porPar = new Map<string, { par: Reserva; total: number }>();

        for (const r of reservas.filter((x) => x.status === 'CONFIRMADO')) {
          const chave = `${r.periodoLetivoId}|${r.rodada}`;
          const atual = porPar.get(chave);
          if (atual) atual.total += 1;
          else porPar.set(chave, { par: r, total: 1 });
        }

        return Promise.resolve(
          [...porPar.values()].map(({ par, total }) => ({
            periodoLetivoId: par.periodoLetivoId,
            rodada: par.rodada,
            _count: { _all: total },
          })),
        );
      },
    },
    modalidade: {
      findMany: () => Promise.resolve(MODALIDADES),
    },
    configuracaoSenhaQuiz: {
      findUnique: () => Promise.resolve(config.atual),
      count: ({ where }: { where: { periodoDosDisparosId: number } }) =>
        Promise.resolve(
          config.atual?.periodoDosDisparosId === where.periodoDosDisparosId
            ? 1
            : 0,
        ),
      upsert: ({
        update,
      }: {
        update: NonNullable<(typeof config)['atual']>;
      }) => {
        config.atual = { ...update };
        return Promise.resolve(config.atual);
      },
    },
    periodoLetivoModalidade: {
      deleteMany: ({ where }: { where: { periodoAgendamentoId: number } }) => {
        const alvo = periodos.find((p) => p.id === where.periodoAgendamentoId);
        if (alvo) alvo.letivosPorModalidade = [];
        return Promise.resolve({ count: 0 });
      },
      createMany: ({
        data,
      }: {
        data: {
          periodoAgendamentoId: number;
          modalidadeId: number;
          periodoLetivoId: string;
        }[];
      }) => {
        for (const linha of data) {
          const alvo = periodos.find(
            (p) => p.id === linha.periodoAgendamentoId,
          );
          if (!alvo) continue;
          alvo.letivosPorModalidade = [
            ...(alvo.letivosPorModalidade ?? []),
            {
              modalidadeId: linha.modalidadeId,
              periodoLetivoId: linha.periodoLetivoId,
            },
          ];
        }
        return Promise.resolve({ count: data.length });
      },
    },
  } as unknown as PrismaService & Record<string, never>;

  const auditoria = {
    registrar: (evento: string, ctx: { detalhe?: string }) =>
      eventos.push({ evento, detalhe: ctx.detalhe }),
  } as unknown as AuditoriaService;

  return {
    service: new PeriodoService(servico, auditoria),
    periodos,
    eventos,
    config,
  };
}

/** As colunas de janela que os fixtures nao carregam — iguais para todos. */
const COLUNAS_DE_JANELA = {
  aberto: true,
  dataAbertura: new Date('2026-08-01T03:00:00Z'),
  dataFechamento: new Date('2026-12-31T02:59:00Z'),
};

const DOIS_MIL_E_VINTE_SEIS_UM: Periodo = {
  id: 80,
  periodoLetivoId: '132035',
  rodada: 'N2',
  descricao: '2026/1',
  createdAt: new Date('2026-08-14T11:45:00Z'),
};

const DOIS_MIL_E_VINTE_SEIS_DOIS: Periodo = {
  id: 79,
  periodoLetivoId: '142286',
  rodada: 'N2',
  descricao: '2026/2',
  createdAt: new Date('2026-08-14T11:00:00Z'),
};

/** A substitutiva do MESMO semestre de `DOIS_MIL_E_VINTE_SEIS_UM`. */
const SUBSTITUTIVA_DE_2026_1: Periodo = {
  id: 81,
  periodoLetivoId: '132035',
  rodada: 'SUB',
  descricao: '2026/1 — substitutiva',
  createdAt: new Date('2026-08-20T09:00:00Z'),
};

describe('PeriodoService.remover', () => {
  it('apaga o periodo sem agendamento e devolve quem virou vigente', async () => {
    const { service, periodos } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM },
      { ...DOIS_MIL_E_VINTE_SEIS_DOIS },
    ]);

    const resultado = await service.remover(80, 'admin@ucb.br');

    expect(periodos.map((p) => p.id)).toEqual([79]);
    expect(resultado.vigenteAgora).toEqual({
      id: 79,
      periodoLetivoId: '142286',
      rodada: 'N2',
      descricao: '2026/2',
    });
  });

  it('devolve vigenteAgora nulo quando nao sobra periodo nenhum', async () => {
    const { service } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    const resultado = await service.remover(80, 'admin@ucb.br');

    expect(resultado.vigenteAgora).toBeNull();
  });

  it('recusa apagar periodo letivo com agendamento confirmado', async () => {
    const { service, periodos } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }],
      [{ periodoLetivoId: '132035', rodada: 'N2', status: 'CONFIRMADO' }],
    );

    await expect(service.remover(80, 'admin@ucb.br')).rejects.toThrow(
      ConflictException,
    );
    expect(periodos).toHaveLength(1);
  });

  /**
   * Cancelado tambem trava, ao contrario do `totalAgendamentos` da tela: a
   * pergunta aqui nao e "quantas vagas estao tomadas" e sim "alguem ja usou
   * este semestre" — e o cancelamento e justamente o registro que precisa
   * continuar explicavel no dia da prova.
   */
  it('recusa mesmo quando o unico agendamento foi cancelado', async () => {
    const { service } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }],
      [{ periodoLetivoId: '132035', rodada: 'N2', status: 'CANCELADO' }],
    );

    await expect(service.remover(80, 'admin@ucb.br')).rejects.toThrow(
      ConflictException,
    );
  });

  it('404 em periodo inexistente', async () => {
    const { service } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    await expect(service.remover(999, 'admin@ucb.br')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('audita a remocao com o admin e o vigente que assumiu', async () => {
    const { service, eventos } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM },
      { ...DOIS_MIL_E_VINTE_SEIS_DOIS },
    ]);

    await service.remover(80, 'admin@ucb.br');

    expect(eventos).toHaveLength(1);
    expect(eventos[0].evento).toBe('PERIODO_REMOVIDO');
    expect(eventos[0].detalhe).toContain('vigente agora: 79');
  });

  /**
   * A trava e do PAR `periodoLetivoId + rodada`, nao do semestre.
   *
   * Cadastrar a substitutiva e o caso em que o admin mais erra a data — e
   * desfazer o cadastro precisa continuar possivel. As provas ja marcadas na
   * regular sao de OUTRA janela e nao dizem nada sobre a que esta sendo apagada;
   * contá-las travaria a SUB para sempre em todo semestre que ja teve prova, que
   * e todo semestre.
   */
  it('apaga a janela da SUB mesmo com prova marcada na N2 do mesmo semestre', async () => {
    const { service, periodos } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }, { ...SUBSTITUTIVA_DE_2026_1 }],
      [{ periodoLetivoId: '132035', rodada: 'N2', status: 'CONFIRMADO' }],
    );

    await service.remover(81, 'admin@ucb.br');

    expect(periodos.map((p) => p.id)).toEqual([80]);
  });

  /** E a propria SUB com prova marcada continua travada, como a N2. */
  it('recusa apagar a SUB quando ela mesma ja tem prova', async () => {
    const { service } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }, { ...SUBSTITUTIVA_DE_2026_1 }],
      [{ periodoLetivoId: '132035', rodada: 'SUB', status: 'CONFIRMADO' }],
    );

    await expect(service.remover(81, 'admin@ucb.br')).rejects.toThrow(
      ConflictException,
    );
  });
});

// ============================================================================
// `criar` — DUAS PROVAS NO MESMO SEMESTRE SAO DUAS JANELAS
// ============================================================================
// A duplicata que a rota recusa e a do PAR `periodoLetivoId + rodada`. Comparar
// so o `periodoLetivoId` — como era antes da rodada — recusava justamente o
// cadastro da substitutiva, e sem ele o aluno que fez a N2 nao consegue agendar
// a segunda prova.

// ============================================================================
// `atualizar` — CORRIGIR A RODADA, SO ENQUANTO A JANELA ESTA VAZIA
// ============================================================================
// `Agendamento.rodada` e fotografia: trocar a da janela nao renomeia prova
// nenhuma. Com provas dentro, a janela passaria a dizer "SUB" e as reservas
// continuariam dizendo "N2" — e toda consulta pelo par pararia de casar, com o
// aluno vendo "voce nao tem prova marcada".

describe('PeriodoService.atualizar — a rodada', () => {
  it('troca a rodada de uma janela sem agendamento nenhum', async () => {
    const { service, periodos } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    await service.atualizar(80, { rodada: 'SUB' }, 'admin@ucb.br');

    expect(periodos[0].rodada).toBe('SUB');
  });

  it('recusa trocar a rodada de uma janela que ja tem prova', async () => {
    const { service, periodos } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }],
      [{ periodoLetivoId: '132035', rodada: 'N2', status: 'CONFIRMADO' }],
    );

    const promessa = service.atualizar(80, { rodada: 'SUB' }, 'admin@ucb.br');

    await expect(promessa).rejects.toThrow(ConflictException);
    await expect(promessa).rejects.toThrow(/fotografia/);
    expect(periodos[0].rodada).toBe('N2');
  });

  /** Cancelado tambem trava — a mesma pergunta do `remover`: "ja foi usada?". */
  it('recusa mesmo quando a unica prova da janela foi cancelada', async () => {
    const { service } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }],
      [{ periodoLetivoId: '132035', rodada: 'N2', status: 'CANCELADO' }],
    );

    await expect(
      service.atualizar(80, { rodada: 'SUB' }, 'admin@ucb.br'),
    ).rejects.toThrow(ConflictException);
  });

  /**
   * Reenviar a MESMA rodada nao e troca. Sem isto, a tela que manda o formulario
   * inteiro no PATCH (o caso normal) nao conseguiria mais editar a descricao de
   * uma janela que ja tem prova — que e justamente a janela em curso.
   */
  it('deixa editar a descricao de uma janela com prova, reenviando a mesma rodada', async () => {
    const { service, periodos } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }],
      [{ periodoLetivoId: '132035', rodada: 'N2', status: 'CONFIRMADO' }],
    );

    await service.atualizar(
      80,
      { rodada: 'N2', descricao: '2026/1 — final' },
      'admin@ucb.br',
    );

    expect(periodos[0].descricao).toBe('2026/1 — final');
  });
});

describe('PeriodoService.criar — a duplicata e do par periodo + rodada', () => {
  const JANELA_NOVA = {
    dataAbertura: '2026-09-01T08:00:00-03:00',
    dataFechamento: '2026-09-10T23:59:00-03:00',
  };

  it('recusa repetir o MESMO periodo letivo na MESMA rodada', async () => {
    const { service } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    const promessa = service.criar({
      periodoLetivoId: '132035',
      rodada: 'N2',
      ...JANELA_NOVA,
    });

    await expect(promessa).rejects.toThrow(ConflictException);
    await expect(promessa).rejects.toThrow(/rodada N2/);
  });

  /** Sem `rodada` no corpo, o default e "N2" — e a duplicata continua valendo. */
  it('recusa repetir o periodo letivo quando nenhuma rodada e informada', async () => {
    const { service } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    await expect(
      service.criar({ periodoLetivoId: '132035', ...JANELA_NOVA }),
    ).rejects.toThrow(ConflictException);
  });

  it('aceita a SUB do mesmo periodo letivo que ja tem a N2', async () => {
    const { service, periodos } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    const criado = await service.criar({
      periodoLetivoId: '132035',
      rodada: 'SUB',
      descricao: '2026/1 — substitutiva',
      ...JANELA_NOVA,
    });

    expect(criado).toMatchObject({ periodoLetivoId: '132035', rodada: 'SUB' });
    expect(periodos).toHaveLength(2);
  });

  /**
   * O `totalAgendamentos` da listagem conta por JANELA. Sem isso a linha da
   * substitutiva exibiria as provas da regular como se fossem dela, e o admin
   * leria "1 agendamento" numa janela em que ninguem entrou ainda.
   */
  it('conta os agendamentos por janela, e nao por semestre', async () => {
    const { service } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM }, { ...SUBSTITUTIVA_DE_2026_1 }],
      [{ periodoLetivoId: '132035', rodada: 'N2', status: 'CONFIRMADO' }],
    );

    const listados = await service.listar();

    expect(listados.map((p) => [p.rodada, p.totalAgendamentos])).toEqual([
      ['SUB', 0],
      ['N2', 1],
    ]);
  });
});

// ============================================================================
// `encerrado` — O PRAZO ACABOU, QUE NAO E O MESMO QUE `!aberto`
// ============================================================================
// Ele existe para a DECLARACAO DE AGENDAMENTO, que so pode sair depois do
// fechamento: com o prazo aberto o aluno ainda troca de horario e cancela
// (regra 7), e o papel afirmaria uma data que ele mesmo pode mudar depois.
//
// Os testes abaixo cobrem os QUATRO estados que `aberto: false` esconde, porque
// so dois deles sao encerramento. Ler `!aberto` no lugar de `encerrado` — que e
// o atalho obvio — emitiria declaracao num semestre que ninguem configurou.

/** Uma linha completa de `periodo_agendamento`, como o Prisma a devolve. */
interface LinhaDePeriodo {
  id: number;
  periodoLetivoId: string;
  rodada: string;
  descricao: string | null;
  aberto: boolean;
  dataAbertura: Date | null;
  dataFechamento: Date;
  createdAt: Date;
  /** O mapa que o `include` traz junto. Ausente = so o principal. */
  letivosPorModalidade?: {
    modalidadeId: number;
    periodoLetivoId: string;
    modalidade: { id: number; codigo: string; nome: string };
  }[];
}

/**
 * Double proprio, separado do `montar` de cima: aquele reproduz o `select` de
 * `remover`, que devolve tres colunas. `situacaoAtual` le a linha inteira, e um
 * duble com o objeto recortado passaria dizendo que o periodo nunca fecha.
 */
function comPeriodo(linha: LinhaDePeriodo | null) {
  const prisma = {
    periodoAgendamento: {
      // O service sempre pede o mapa junto (`MAPA_DA_JANELA`); um duble sem ele
      // faria `idsDaJanela` explodir — que e melhor que devolver so o principal
      // em silencio.
      findFirst: () =>
        Promise.resolve(linha && { letivosPorModalidade: [], ...linha }),
    },
  } as unknown as PrismaService;

  return new PeriodoService(prisma, {} as AuditoriaService);
}

const JANELA: LinhaDePeriodo = {
  id: 80,
  periodoLetivoId: '132035',
  rodada: 'SUB',
  descricao: '2026/2',
  aberto: true,
  dataAbertura: new Date('2026-08-01T03:00:00Z'),
  dataFechamento: new Date('2026-08-18T02:59:00Z'),
  createdAt: new Date('2026-07-20T12:00:00Z'),
};

const DENTRO_DO_PRAZO = new Date('2026-08-10T12:00:00Z');
const ANTES_DE_ABRIR = new Date('2026-07-25T12:00:00Z');
const DEPOIS_DO_PRAZO = new Date('2026-08-20T12:00:00Z');

describe('PeriodoService.situacaoAtual — encerrado', () => {
  it('prazo correndo: aberto, nao encerrado', async () => {
    const situacao = await comPeriodo(JANELA).situacaoAtual(DENTRO_DO_PRAZO);

    expect(situacao).toMatchObject({ aberto: true, encerrado: false });
  });

  it('prazo vencido: encerrado', async () => {
    const situacao = await comPeriodo(JANELA).situacaoAtual(DEPOIS_DO_PRAZO);

    expect(situacao).toMatchObject({ aberto: false, encerrado: true });
  });

  /**
   * Fechar a mao antes da data prevista e encerramento antecipado: a partir
   * dali ninguem mais escolhe horario, que e a condicao de que a declaracao
   * depende.
   */
  it('fechado pelo admin antes da data: encerrado', async () => {
    const situacao = await comPeriodo({
      ...JANELA,
      aberto: false,
    }).situacaoAtual(DENTRO_DO_PRAZO);

    expect(situacao).toMatchObject({ aberto: false, encerrado: true });
  });

  /** O unico `!aberto` que NAO e encerrado: o prazo ainda vai comecar. */
  it('ainda nao abriu: nem aberto nem encerrado', async () => {
    const situacao = await comPeriodo(JANELA).situacaoAtual(ANTES_DE_ABRIR);

    expect(situacao).toMatchObject({ aberto: false, encerrado: false });
  });

  /** Banco recem-migrado. Quem nunca abriu tambem nunca fechou. */
  it('sem periodo cadastrado: nem aberto nem encerrado', async () => {
    const situacao = await comPeriodo(null).situacaoAtual(DENTRO_DO_PRAZO);

    expect(situacao).toMatchObject({ aberto: false, encerrado: false });
  });
});

describe('PeriodoService.exigirEncerrado', () => {
  it('devolve o periodo letivo vigente depois do fechamento', async () => {
    await expect(
      comPeriodo(JANELA).exigirEncerrado(DEPOIS_DO_PRAZO),
    ).resolves.toMatchObject({ periodoLetivoId: '132035', rodada: 'SUB' });
  });

  it('recusa com o prazo aberto, dizendo quando ele encerra', async () => {
    const promessa = comPeriodo(JANELA).exigirEncerrado(DENTRO_DO_PRAZO);

    await expect(promessa).rejects.toThrow(ForbiddenException);
    await expect(promessa).rejects.toThrow(/quando o prazo de agendamento/);
  });

  it('recusa quando o prazo ainda nao comecou', async () => {
    await expect(
      comPeriodo(JANELA).exigirEncerrado(ANTES_DE_ABRIR),
    ).rejects.toThrow(ForbiddenException);
  });

  it('recusa quando nao ha periodo cadastrado', async () => {
    await expect(
      comPeriodo(null).exigirEncerrado(DENTRO_DO_PRAZO),
    ).rejects.toThrow(ForbiddenException);
  });
});

/**
 * ==========================================================================
 * OS CRITERIOS DE NOTA DA JANELA — a regra da substitutiva
 * ==========================================================================
 * O par `notaMinimaN1 + notaMaximaFinal` e o que liga o filtro. Ele NAO e
 * comparado com a `rodada`, que e texto livre: e por isso que estes testes nunca
 * mencionam a string "SUB".
 *
 * ⚠️ Os dois NAO formam intervalo — um olha a N1, o outro a nota final. Ver
 * `aceita piso da N1 maior que o teto da final`, que guarda a ausencia da
 * validacao de ordem que existiu ate 08/09/2026.
 */
describe('PeriodoService — os criterios de nota', () => {
  const JANELA = {
    dataFechamento: '2026-12-31T23:59:00-03:00',
    periodoLetivoId: '132035',
  };

  it('cadastra os criterios e os devolve como objeto no vigente', async () => {
    const { service } = montar([]);

    await service.criar({
      ...JANELA,
      rodada: 'SUB',
      notaMinimaN1: 1.5,
      notaMaximaFinal: 7,
    });

    await expect(service.periodoLetivoDaModalidade('EAD')).resolves.toEqual({
      periodoLetivoId: '132035',
      rodada: 'SUB',
      filtroDeNota: { minimaN1: 1.5, maximaFinal: 7 },
    });
  });

  it('sem criterios, o vigente diz `null` — e nenhuma nota sera consultada', async () => {
    const { service } = montar([]);

    await service.criar(JANELA);

    const vigente = await service.periodoLetivoDaModalidade('EAD');

    expect(vigente?.filtroDeNota).toBeNull();
  });

  /**
   * Meio intervalo nao delimita nada: o banco leria a linha como "sem filtro", a
   * substitutiva abriria para o curso inteiro e nada apareceria no log.
   */
  it('recusa uma das duas sem a outra', async () => {
    const { service } = montar([]);

    await expect(
      service.criar({ ...JANELA, notaMinimaN1: 1.5 }),
    ).rejects.toThrow(/andam juntas/);

    await expect(
      service.criar({ ...JANELA, notaMaximaFinal: 7 }),
    ).rejects.toThrow(/andam juntas/);
  });

  /**
   * ⚠️ A recusa de "minima >= maxima" SAIU em 08/09/2026, e este teste guarda a
   * ausencia dela. Os dois numeros passaram a comparar notas DIFERENTES — N1 e
   * nota final —, e ordem entre eles nao significa nada: `N1 >= 7 com final < 3`
   * e uma janela severa, nao um intervalo vazio. Recusa-la seria a validacao
   * afirmando uma relacao que a regra nao tem.
   */
  it('aceita piso da N1 maior que o teto da final', async () => {
    const { service, periodos } = montar([]);

    await service.criar({ ...JANELA, notaMinimaN1: 7, notaMaximaFinal: 3 });

    expect(periodos[0].notaMinimaN1).toBe(7);
    expect(periodos[0].notaMaximaFinal).toBe(3);
  });

  /** "67,5" digitado no lugar de "6,75" liberaria todo mundo. */
  it('recusa nota fora de 0..10', async () => {
    const { service } = montar([]);

    await expect(
      service.criar({ ...JANELA, notaMinimaN1: 1.5, notaMaximaFinal: 67.5 }),
    ).rejects.toThrow(/entre 0 e 10/);
  });

  /**
   * ⚠️ Ao contrario da `rodada`, a faixa muda com a janela CHEIA. A rodada e
   * fotografia gravada em cada reserva, e troca-la desalinha toda consulta; a
   * faixa nao e gravada em lugar nenhum. Bloquear seria pior que o problema: a
   * correcao mais provavel e ter cadastrado a faixa errada e perceber depois de
   * abrir.
   */
  it('deixa corrigir os criterios mesmo com prova ja marcada, e audita', async () => {
    const { service, periodos, eventos } = montar(
      [{ ...DOIS_MIL_E_VINTE_SEIS_UM, notaMinimaN1: 1.5, notaMaximaFinal: 6 }],
      [{ periodoLetivoId: '132035', rodada: 'N2', status: 'CONFIRMADO' }],
    );

    await service.atualizar(80, { notaMaximaFinal: 7 }, 'admin@ucb.br');

    expect(periodos[0].notaMaximaFinal).toBe(7);
    expect(periodos[0].notaMinimaN1).toBe(1.5);
    expect(eventos.map((e) => e.evento)).toContain(
      'PERIODO_FILTRO_DE_NOTA_ALTERADO',
    );
  });

  /**
   * Mandar so um campo no PATCH nao pode deixar meio filtro no banco — o
   * service revalida o par inteiro, mesclando com o que ja estava la.
   */
  it('recusa desligar so metade dos criterios', async () => {
    const { service } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM, notaMinimaN1: 1.5, notaMaximaFinal: 7 },
    ]);

    await expect(
      service.atualizar(80, { notaMaximaFinal: null }, 'admin@ucb.br'),
    ).rejects.toThrow(/andam juntas/);
  });

  it('desliga o filtro quando os dois vem nulos', async () => {
    const { service, periodos } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM, notaMinimaN1: 1.5, notaMaximaFinal: 7 },
    ]);

    await service.atualizar(
      80,
      { notaMinimaN1: null, notaMaximaFinal: null },
      'admin@ucb.br',
    );

    expect(periodos[0].notaMinimaN1).toBeNull();
    expect(periodos[0].notaMaximaFinal).toBeNull();
  });

  /**
   * Editar so a descricao NAO pode apagar os criterios. E o caso normal da tela,
   * que manda o formulario inteiro — sem os campos de nota quando nao mudaram.
   */
  it('editar so a descricao preserva os criterios', async () => {
    const { service, periodos } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM, notaMinimaN1: 1.5, notaMaximaFinal: 7 },
    ]);

    await service.atualizar(80, { descricao: 'outra' }, 'admin@ucb.br');

    expect(periodos[0].notaMinimaN1).toBe(1.5);
    expect(periodos[0].notaMaximaFinal).toBe(7);
  });
});

/**
 * ============================================================================
 * O MAPA `MODALIDADE -> PERIODO LETIVO`
 * ============================================================================
 * A UCB corre duas grades ao mesmo tempo: EaD/Semi/Modular por MODULO (quatro
 * por ano) e Presencial por SEMESTRE (dois). Sao dois org units diferentes e
 * vivos ao mesmo tempo no Brightspace, e a janela precisa cobrir os dois.
 *
 * O que estes testes protegem e o modo de falhar: um `periodoLetivoId` que nao
 * bate NAO da erro nenhum — a busca de ofertas responde 200 com lista vazia, e
 * o formato inteiro recebe "nenhuma disciplina sua aparece no periodo letivo
 * vigente". Toda conferencia que nao acontecer no cadastro vira suporte no dia
 * da abertura.
 */
describe('PeriodoService — o mapa por formato', () => {
  const JANELA_DUAS_GRADES: Periodo = {
    id: 90,
    periodoLetivoId: 'MODULO-2026-4',
    rodada: 'N2',
    descricao: '2026/4 + 2026/2',
    createdAt: new Date('2026-09-01T12:00:00Z'),
    letivosPorModalidade: [
      { modalidadeId: 1, periodoLetivoId: 'MODULO-2026-4' }, // EAD
      { modalidadeId: 2, periodoLetivoId: 'MODULO-2026-4' }, // SEMI
      { modalidadeId: 3, periodoLetivoId: 'MODULO-2026-4' }, // MODULAR
      { modalidadeId: 4, periodoLetivoId: 'SEMESTRE-2026-2' }, // PRESENCIAL
    ],
  };

  it('resolve o periodo letivo pelo formato do vinculo', async () => {
    const { service } = montar([JANELA_DUAS_GRADES]);

    await expect(
      service.periodoLetivoDaModalidade('EAD'),
    ).resolves.toMatchObject({ periodoLetivoId: 'MODULO-2026-4' });

    await expect(
      service.periodoLetivoDaModalidade('PRESENCIAL'),
    ).resolves.toMatchObject({ periodoLetivoId: 'SEMESTRE-2026-2' });
  });

  /** O codigo vem do banco e do token; comparar sem normalizar quebraria calado. */
  it('o formato casa sem diferenciar maiuscula de minuscula', async () => {
    const { service } = montar([JANELA_DUAS_GRADES]);

    await expect(
      service.periodoLetivoDaModalidade('presencial'),
    ).resolves.toMatchObject({ periodoLetivoId: 'SEMESTRE-2026-2' });
  });

  it('janelaVigente devolve os DOIS org units, sem repetir', async () => {
    const { service } = montar([JANELA_DUAS_GRADES]);

    const janela = await service.janelaVigente();

    expect(janela?.principal).toBe('MODULO-2026-4');
    // Tres formatos apontam para o modulo: ele entra UMA vez.
    expect(janela?.periodoLetivoIds.sort()).toEqual([
      'MODULO-2026-4',
      'SEMESTRE-2026-2',
    ]);
  });

  /**
   * O principal entra em `periodoLetivoIds` mesmo quando ja esta no mapa, e
   * mesmo quando nenhum formato aponta para ele: ele e o destino do
   * fallback, entao pode haver reserva gravada com ele. Deixa-lo de fora faria
   * essa prova sumir de toda consulta pela janela.
   */
  it('o principal entra na lista mesmo sem formato apontando para ele', async () => {
    const { service } = montar([
      {
        ...JANELA_DUAS_GRADES,
        letivosPorModalidade: [
          { modalidadeId: 1, periodoLetivoId: 'OUTRO-A' },
          { modalidadeId: 2, periodoLetivoId: 'OUTRO-A' },
          { modalidadeId: 3, periodoLetivoId: 'OUTRO-A' },
          { modalidadeId: 4, periodoLetivoId: 'OUTRO-B' },
        ],
      },
    ]);

    const janela = await service.janelaVigente();

    expect(janela?.periodoLetivoIds).toContain('MODULO-2026-4');
    expect(janela?.periodoLetivoIds).toHaveLength(3);
  });

  /**
   * O recorte das telas que olham para tras (as estatisticas do Inicio por
   * periodo): a janela pedida, e nao a mais recente. Sem isto, escolher a
   * rodada anterior no filtro devolveria os numeros da vigente — plausiveis e
   * errados, que e o pior resultado possivel.
   */
  it('janelaDoPeriodo devolve a janela PEDIDA, nao a vigente', async () => {
    const { service } = montar([
      JANELA_DUAS_GRADES,
      {
        id: 7,
        periodoLetivoId: 'MODULO-2026-3',
        rodada: 'SUB',
        descricao: 'Substitutiva anterior',
        createdAt: new Date('2026-06-01T12:00:00Z'),
      },
    ]);

    const janela = await service.janelaDoPeriodo(7);

    expect(janela.principal).toBe('MODULO-2026-3');
    expect(janela.rodada).toBe('SUB');
    // A vigente e a outra: a escolha do chamador e que decide, nao a data.
    await expect(service.janelaVigente()).resolves.toMatchObject({
      principal: 'MODULO-2026-4',
    });
  });

  /**
   * 404, e nao uma janela vazia: a tela precisa saber que o filtro dela ficou
   * velho. Contagem zerada pareceria um semestre em que ninguem agendou.
   */
  it('janelaDoPeriodo recusa periodo inexistente', async () => {
    const { service } = montar([JANELA_DUAS_GRADES]);

    await expect(service.janelaDoPeriodo(999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * Formato sem linha no mapa cai no principal — e o que segura o sistema de
   * pe quando um formato novo e semeada depois da janela. Nao e erro: e a
   * alternativa a derrubar o agendamento das outras quatro.
   */
  it('formato fora do mapa cai no principal', async () => {
    const { service } = montar([
      {
        ...JANELA_DUAS_GRADES,
        letivosPorModalidade: [
          { modalidadeId: 4, periodoLetivoId: 'SEMESTRE-2026-2' },
        ],
      },
    ]);

    await expect(
      service.periodoLetivoDaModalidade('EAD'),
    ).resolves.toMatchObject({ periodoLetivoId: 'MODULO-2026-4' });
  });

  it('sem mapa informado, todos os formatos ficam no principal', async () => {
    const { service, periodos } = montar([]);

    await service.criar({
      periodoLetivoId: '555',
      dataFechamento: '2026-12-31T23:59:00-03:00',
    });

    expect(periodos[0].letivosPorModalidade).toEqual([
      { modalidadeId: 1, periodoLetivoId: '555' },
      { modalidadeId: 2, periodoLetivoId: '555' },
      { modalidadeId: 3, periodoLetivoId: '555' },
      { modalidadeId: 4, periodoLetivoId: '555' },
    ]);
  });

  /**
   * Cobrir o mapa parcialmente e pior que nao cobrir: o formato esquecido
   * cairia no principal em silencio, que e exatamente o erro que o mapa existe
   * para impedir. A frase precisa dizer QUAIS faltam.
   */
  it('recusa o mapa incompleto, nomeando os formatos que faltam', async () => {
    const { service } = montar([]);

    await expect(
      service.criar({
        periodoLetivoId: '555',
        dataFechamento: '2026-12-31T23:59:00-03:00',
        letivosPorModalidade: [
          { modalidadeCodigo: 'EAD', periodoLetivoId: '555' },
        ],
      }),
    ).rejects.toThrow(/SEMI.*MODULAR.*PRESENCIAL|PRESENCIAL/s);
  });

  it('recusa codigo de formato que nao existe', async () => {
    const { service } = montar([]);

    await expect(
      service.criar({
        periodoLetivoId: '555',
        dataFechamento: '2026-12-31T23:59:00-03:00',
        letivosPorModalidade: [
          { modalidadeCodigo: 'INEXISTENTE', periodoLetivoId: '555' },
        ],
      }),
    ).rejects.toThrow(/INEXISTENTE/);
  });

  it('grava o mapa que o admin cadastrou', async () => {
    const { service, periodos } = montar([]);

    await service.criar({
      periodoLetivoId: 'MODULO',
      dataFechamento: '2026-12-31T23:59:00-03:00',
      letivosPorModalidade: [
        { modalidadeCodigo: 'EAD', periodoLetivoId: 'MODULO' },
        { modalidadeCodigo: 'SEMI', periodoLetivoId: 'MODULO' },
        { modalidadeCodigo: 'MODULAR', periodoLetivoId: 'MODULO' },
        { modalidadeCodigo: 'PRESENCIAL', periodoLetivoId: 'SEMESTRE' },
      ],
    });

    expect(periodos[0].letivosPorModalidade).toContainEqual({
      modalidadeId: 4,
      periodoLetivoId: 'SEMESTRE',
    });
  });

  /**
   * O mapa e travado como a `rodada`, e pelo mesmo motivo: o `periodoLetivoId`
   * da reserva e fotografia. Trocar o da janela com provas dentro faria a janela
   * apontar para um org unit e as provas dela para outro — e dali em diante toda
   * consulta pelo par para de casar.
   */
  it('recusa mexer no mapa quando a janela ja tem reserva', async () => {
    const { service } = montar(
      [JANELA_DUAS_GRADES],
      [
        {
          periodoLetivoId: 'SEMESTRE-2026-2',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
      ],
    );

    await expect(
      service.atualizar(
        90,
        {
          letivosPorModalidade: [
            { modalidadeCodigo: 'EAD', periodoLetivoId: 'MODULO-2026-4' },
            { modalidadeCodigo: 'SEMI', periodoLetivoId: 'MODULO-2026-4' },
            { modalidadeCodigo: 'MODULAR', periodoLetivoId: 'MODULO-2026-4' },
            { modalidadeCodigo: 'PRESENCIAL', periodoLetivoId: 'TROCADO' },
          ],
        },
        'admin@ucb.br',
      ),
    ).rejects.toThrow(/janela estiver vazia/i);
  });

  /**
   * A reserva que trava esta sob o org unit do PRESENCIAL, nao sob o principal.
   * Contar so o principal (como antes do mapa) deixaria a trava passar — e o
   * teste acima e o que prova que ela nao passa.
   *
   * Este prova o outro lado: reenviar o mapa IGUAL nao dispara a trava, senao
   * editar a data de fechamento de uma janela cheia ficaria impossivel (a tela
   * manda o formulario inteiro).
   */
  it('reenviar o mapa igual nao dispara a trava', async () => {
    const { service, periodos } = montar(
      [JANELA_DUAS_GRADES],
      [
        {
          periodoLetivoId: 'SEMESTRE-2026-2',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
      ],
    );

    await service.atualizar(
      90,
      {
        descricao: 'so mexi na descricao',
        letivosPorModalidade: [
          { modalidadeCodigo: 'EAD', periodoLetivoId: 'MODULO-2026-4' },
          { modalidadeCodigo: 'SEMI', periodoLetivoId: 'MODULO-2026-4' },
          { modalidadeCodigo: 'MODULAR', periodoLetivoId: 'MODULO-2026-4' },
          {
            modalidadeCodigo: 'PRESENCIAL',
            periodoLetivoId: 'SEMESTRE-2026-2',
          },
        ],
      },
      'admin@ucb.br',
    );

    expect(periodos[0].descricao).toBe('so mexi na descricao');
  });

  /**
   * A contagem da tela soma os DOIS org units. Contar so o principal faria o
   * admin ler "1 agendamento" numa janela com 2 — os presenciais ficariam
   * invisiveis.
   */
  it('o total da janela soma as reservas das duas grades', async () => {
    const { service } = montar(
      [JANELA_DUAS_GRADES],
      [
        {
          periodoLetivoId: 'MODULO-2026-4',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
        {
          periodoLetivoId: 'SEMESTRE-2026-2',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
      ],
    );

    const [janela] = await service.listar();

    expect(janela.totalAgendamentos).toBe(2);
  });

  /** Apagar uma janela cheia continua recusado quando a reserva e da outra grade. */
  it('recusa apagar a janela por causa de uma reserva do presencial', async () => {
    const { service } = montar(
      [JANELA_DUAS_GRADES],
      [
        {
          periodoLetivoId: 'SEMESTRE-2026-2',
          rodada: 'N2',
          status: 'CONFIRMADO',
        },
      ],
    );

    await expect(service.remover(90, 'admin@ucb.br')).rejects.toThrow(
      /não pode ser apagado/,
    );
  });

  /** A tela precisa ver TODOS os formatos, inclusive as que herdam. */
  it('a listagem mostra o formato que herdou o principal', async () => {
    const { service } = montar([
      {
        ...JANELA_DUAS_GRADES,
        letivosPorModalidade: [
          { modalidadeId: 4, periodoLetivoId: 'SEMESTRE-2026-2' },
        ],
      },
    ]);

    const [janela] = await service.listar();

    expect(janela.letivosPorModalidade).toHaveLength(4);

    const ead = janela.letivosPorModalidade.find(
      (l) => l.modalidadeCodigo === 'EAD',
    );

    expect(ead).toMatchObject({
      periodoLetivoId: 'MODULO-2026-4',
      herdadoDoPrincipal: true,
    });

    const presencial = janela.letivosPorModalidade.find(
      (l) => l.modalidadeCodigo === 'PRESENCIAL',
    );

    expect(presencial).toMatchObject({
      periodoLetivoId: 'SEMESTRE-2026-2',
      herdadoDoPrincipal: false,
    });
  });
});

/**
 * O filtro de periodo dos disparos (23/09/2026). O que ele precisa garantir e
 * uma coisa so: cadastrar um periodo novo NAO muda as turmas de um disparo que
 * ja tem periodo escolhido — e sem escolha, tudo continua como antes.
 */
describe('PeriodoService — o periodo dos disparos', () => {
  it('sem escolha, os disparos seguem o vigente (o comportamento de antes)', async () => {
    const { service } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM },
      { ...SUBSTITUTIVA_DE_2026_1 },
    ]);

    await expect(service.janelaDosDisparos()).resolves.toMatchObject({
      principal: '132035',
      rodada: 'SUB',
    });

    const lido = await service.lerPeriodoDosDisparos();
    expect(lido.periodoId).toBeNull();
    expect(lido.emUso).toMatchObject({ id: 81, vigente: true });
  });

  it('com escolha, um periodo cadastrado DEPOIS nao rouba os disparos', async () => {
    const { service, periodos } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    await service.definirPeriodoDosDisparos(80, 'admin@ucb.br');

    // O cadastro antecipado da substitutiva: vira o vigente...
    periodos.push({ ...SUBSTITUTIVA_DE_2026_1 });
    await expect(service.janelaVigente()).resolves.toMatchObject({
      rodada: 'SUB',
    });

    // ...e os disparos continuam na N2 escolhida.
    await expect(service.janelaDosDisparos()).resolves.toMatchObject({
      principal: '132035',
      rodada: 'N2',
    });

    const lido = await service.lerPeriodoDosDisparos();
    expect(lido).toMatchObject({
      periodoId: 80,
      atualizadoPor: 'admin@ucb.br',
    });
    expect(lido.emUso).toMatchObject({ id: 80, vigente: false });
  });

  it('null volta ao vigente, e a troca e auditada nos dois sentidos', async () => {
    const { service, eventos } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM },
      { ...SUBSTITUTIVA_DE_2026_1 },
    ]);

    await service.definirPeriodoDosDisparos(80, 'admin@ucb.br');
    await service.definirPeriodoDosDisparos(null, 'admin@ucb.br');

    await expect(service.janelaDosDisparos()).resolves.toMatchObject({
      rodada: 'SUB',
    });
    expect(
      eventos.filter((e) => e.evento === 'PERIODO_DOS_DISPAROS_ALTERADO'),
    ).toHaveLength(2);
  });

  it('recusa periodo inexistente sem gravar nada', async () => {
    const { service, config } = montar([{ ...DOIS_MIL_E_VINTE_SEIS_UM }]);

    await expect(
      service.definirPeriodoDosDisparos(999, 'admin@ucb.br'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(config.atual).toBeNull();
  });

  /**
   * Apagar o escolhido voltaria os disparos ao vigente em silencio — o sintoma
   * que o filtro existe para evitar. A FK e RESTRICT; esta e a frase que diz
   * como destravar, antes de a FK responder com um erro que ninguem entende.
   */
  it('recusa apagar o periodo escolhido para os disparos', async () => {
    const { service, periodos } = montar([
      { ...DOIS_MIL_E_VINTE_SEIS_UM },
      { ...DOIS_MIL_E_VINTE_SEIS_DOIS },
    ]);

    await service.definirPeriodoDosDisparos(80, 'admin@ucb.br');

    await expect(service.remover(80, 'admin@ucb.br')).rejects.toThrow(
      /escolhido como o período das senhas/,
    );
    expect(periodos.map((p) => p.id)).toContain(80);

    // O outro continua apagavel.
    await expect(service.remover(79, 'admin@ucb.br')).resolves.toBeDefined();
  });
});
