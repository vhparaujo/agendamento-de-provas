import { PrismaService } from '../../database/prisma.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { ModalidadeDaTurmaService } from './modalidade-da-turma.service';

/**
 * A pergunta que este servico responde nao tem coluna no banco: `TurmaImportada`
 * nao guarda formato, por decisao de 10/08/2026. Ele e derivado dos
 * agendamentos confirmados, e a regra e "uma, ou nenhuma" — nunca a maioria.
 *
 * A partir de 10/09/2026 ha uma segunda fonte, e ela NAO afrouxa a regra: o
 * admin pode desempatar uma turma AMBIGUA, e so ela. Os testes de
 * `desempate manual` cobrem as duas formas de a decisao caducar sozinha.
 */
describe('ModalidadeDaTurmaService', () => {
  const montar = (
    linhas: Record<string, unknown>[],
    escolhas: Record<string, unknown>[] = [],
  ) => {
    const queryRaw = jest.fn().mockResolvedValue(linhas);
    const findMany = jest.fn().mockResolvedValue(escolhas);
    const prisma = {
      $queryRaw: queryRaw,
      modalidadeEscolhidaDaTurma: { findMany },
    } as unknown as PrismaService;
    const auditoria = { registrar: jest.fn() } as unknown as AuditoriaService;

    return {
      servico: new ModalidadeDaTurmaService(prisma, auditoria),
      queryRaw,
      findMany,
      auditoria,
    };
  };

  /** Uma linha de `modalidade_escolhida_turma`, como o Prisma a devolve. */
  const escolha = (
    orgUnitId: string,
    modalidadeId: number,
    codigo: string,
    escolhidaPor = 'secretaria@ucb.br',
  ) => ({
    orgUnitId,
    modalidadeId,
    escolhidaPor,
    updatedAt: new Date('2026-09-10T13:45:00.000Z'),
    modalidade: { id: modalidadeId, codigo, nome: codigo },
  });

  const linha = (
    orgUnitId: string,
    modalidadeId: number,
    codigo: string,
    reservas: number | bigint,
  ) => ({ orgUnitId, modalidadeId, codigo, nome: codigo, reservas });

  it('um formato so: resolve', async () => {
    const { servico } = montar([linha('7001', 1, 'EAD', 42)]);
    const mapa = await servico.resolver(['103'], 'N2');

    expect(mapa.de('7001')).toEqual({
      situacao: 'ENCONTRADA',
      modalidadeId: 1,
      codigo: 'EAD',
      nome: 'EAD',
      reservas: 42,
      // Derivacao unanime: nao houve empate, entao nao ha decisao a exibir nem
      // candidatas a oferecer na tela.
      escolha: null,
      candidatas: [],
    });
  });

  /**
   * O caso que decide o desenho. O questionario tem UMA janela; escolher a
   * maioria deixaria a minoria sem conseguir abrir a prova, e o erro so
   * apareceria no dia. Mesma regra de ORGUNIT_AMBIGUO.
   */
  it('dois formatos: NAO escolhe a maioria', async () => {
    const { servico } = montar([
      linha('7003', 1, 'EAD', 9),
      linha('7003', 2, 'SEMI', 7),
    ]);
    const decisao = await servico
      .resolver(['103'], 'N2')
      .then((m) => m.de('7003'));

    expect(decisao.situacao).toBe('SEM_MODALIDADE');
    if (decisao.situacao !== 'SEM_MODALIDADE') return;

    expect(decisao.motivo).toBe('AMBIGUA');
    expect(decisao.candidatas.map((c) => c.codigo)).toEqual(['EAD', 'SEMI']);
    // O detalhe vai para o CSV do relatorio: quem le precisa dos dois
    // formatos e do peso de cada um para decidir o que fazer.
    expect(decisao.detalhe).toContain('EAD (9)');
    expect(decisao.detalhe).toContain('SEMI (7)');
  });

  it('turma sem agendamento nenhum: SEM_AGENDAMENTO', async () => {
    const { servico } = montar([]);
    const decisao = await servico
      .resolver(['103'], 'N2')
      .then((m) => m.de('7999'));

    expect(decisao.situacao).toBe('SEM_MODALIDADE');
    if (decisao.situacao !== 'SEM_MODALIDADE') return;
    expect(decisao.motivo).toBe('SEM_AGENDAMENTO');
    expect(decisao.candidatas).toEqual([]);
  });

  it('as candidatas saem ordenadas por reservas, com o codigo desempatando', async () => {
    // Ordem estavel: duas execucoes com os mesmos dados precisam produzir o
    // mesmo relatorio.
    const { servico } = montar([
      linha('7003', 3, 'MODULAR', 5),
      linha('7003', 1, 'EAD', 12),
      linha('7003', 2, 'SEMI', 5),
    ]);
    const decisao = await servico
      .resolver(['103'], 'N2')
      .then((m) => m.de('7003'));

    if (decisao.situacao !== 'SEM_MODALIDADE')
      throw new Error('esperava ambigua');
    expect(decisao.candidatas.map((c) => c.codigo)).toEqual([
      'EAD',
      'MODULAR',
      'SEMI',
    ]);
  });

  /**
   * `COUNT(*)` volta BigInt no driver do MySQL, e `JSON.stringify` de BigInt
   * LANCA — o relatorio morreria na serializacao, depois de o lote ter rodado.
   */
  it('converte o BigInt do COUNT para number', async () => {
    const { servico } = montar([linha('7001', 1, 'EAD', BigInt(42))]);
    const decisao = await servico
      .resolver(['103'], 'N2')
      .then((m) => m.de('7001'));

    if (decisao.situacao !== 'ENCONTRADA')
      throw new Error('esperava encontrada');
    expect(decisao.reservas).toBe(42);
    expect(typeof decisao.reservas).toBe('number');
    expect(() => JSON.stringify(decisao)).not.toThrow();
  });

  it('conta as turmas alcancadas, para o log', async () => {
    const { servico } = montar([
      linha('7001', 1, 'EAD', 3),
      linha('7002', 1, 'EAD', 4),
      linha('7003', 2, 'SEMI', 1),
    ]);

    expect((await servico.resolver(['103'], 'N2')).totalComAgendamento).toBe(3);
  });

  /**
   * Sem o semestre, a prova do semestre passado decidiria a janela de hoje; sem
   * a rodada, quem fez a N2 entraria na conta da substitutiva — e as duas
   * rodadas tem o MESMO periodoLetivoId no Brightspace.
   */
  it('o recorte leva periodo E rodada para a consulta', async () => {
    const { servico, queryRaw } = montar([]);
    await servico.resolver(['103'], 'SUB');

    const parametros = queryRaw.mock.calls[0].slice(1) as unknown[];
    expect(valoresDe(parametros)).toContain('103');
    expect(parametros).toContain('SUB');
    expect(parametros).toContain('CONFIRMADO');
  });

  /**
   * Os DOIS periodos letivos da janela vao para o `IN`.
   *
   * A janela cobre as duas grades ao mesmo tempo (modulo e semestre), e uma
   * turma presencial so tem reserva sob o org unit do semestre. Consultar so um
   * a devolveria como SEM_AGENDAMENTO — turma sem formato fica de fora do
   * lote de datas, e a prova nao abre no dia.
   */
  it('leva TODOS os periodos letivos da janela para o IN', async () => {
    const { servico, queryRaw } = montar([]);
    await servico.resolver(['8811', '8790'], 'N2');

    const valores = valoresDe(queryRaw.mock.calls[0].slice(1) as unknown[]);

    expect(valores).toContain('8811');
    expect(valores).toContain('8790');
  });

  /** Lista vazia e sempre falso num `IN`: responde mapa vazio sem ir ao banco. */
  it('sem periodo letivo nenhum, nao consulta o banco', async () => {
    const { servico, queryRaw } = montar([]);

    const mapa = await servico.resolver([], 'N2');

    expect(queryRaw).not.toHaveBeenCalled();
    expect(mapa.totalComAgendamento).toBe(0);
    expect(mapa.de('qualquer').situacao).toBe('SEM_MODALIDADE');
  });

  /**
   * O caso real de 10/09/2026: EAD (583) e MODULAR (1). Sem desempate a turma
   * inteira fica com a data antiga — os 583 tanto quanto o 1.
   */
  describe('desempate manual', () => {
    const ambigua = (escolhas: Record<string, unknown>[] = []) =>
      montar(
        [linha('7003', 1, 'EAD', 583), linha('7003', 3, 'MODULAR', 1)],
        escolhas,
      );

    it('a escolha do admin resolve a turma ambigua', async () => {
      const { servico } = ambigua([escolha('7003', 1, 'EAD')]);
      const decisao = await servico
        .resolver(['103'], 'N2')
        .then((m) => m.de('7003'));

      expect(decisao.situacao).toBe('ENCONTRADA');
      if (decisao.situacao !== 'ENCONTRADA') return;

      expect(decisao.codigo).toBe('EAD');
      // As reservas sao as REAIS do formato eleito, nao o total da turma: e
      // o numero que o relatorio mostra ao lado da decisao.
      expect(decisao.reservas).toBe(583);
      expect(decisao.escolha?.escolhidaPor).toBe('secretaria@ucb.br');
      // As candidatas continuam ali para a tela poder TROCAR a escolha sem
      // exigir um "desfazer" antes.
      expect(decisao.candidatas.map((c) => c.codigo)).toEqual([
        'EAD',
        'MODULAR',
      ]);
    });

    /**
     * A minoria tambem pode ser a resposta certa — se a prova daquela turma e
     * aplicada no calendario MODULAR, um voto de maioria teria acertado o
     * numero e errado a decisao. E o argumento de a escolha ser de uma pessoa.
     */
    it('escolher a MINORIA vale, e nao ha voto de maioria por baixo', async () => {
      const { servico } = ambigua([escolha('7003', 3, 'MODULAR')]);
      const decisao = await servico
        .resolver(['103'], 'N2')
        .then((m) => m.de('7003'));

      if (decisao.situacao !== 'ENCONTRADA')
        throw new Error('esperava encontrada');
      expect(decisao.codigo).toBe('MODULAR');
      expect(decisao.reservas).toBe(1);
    });

    /**
     * O aluno MODULAR cancelou: a turma deixou de ser ambigua. A derivacao
     * vence, senao uma turma 100% EaD receberia a janela MODULAR porque alguem
     * desempatou na terca.
     */
    it('a derivacao unanime VENCE a escolha gravada', async () => {
      const { servico } = montar(
        [linha('7003', 1, 'EAD', 583)],
        [escolha('7003', 3, 'MODULAR')],
      );
      const decisao = await servico
        .resolver(['103'], 'N2')
        .then((m) => m.de('7003'));

      if (decisao.situacao !== 'ENCONTRADA')
        throw new Error('esperava encontrada');
      expect(decisao.codigo).toBe('EAD');
      expect(decisao.escolha).toBeNull();
    });

    /**
     * Escolheram MODULAR e depois o unico MODULAR trocou por SEMI. Aplicar a
     * janela MODULAR agora fecharia a prova para a turma INTEIRA, e nao so para
     * a minoria — pior que nao aplicar nada.
     */
    it('escolha sem reserva nenhuma caduca, e a turma volta a ser ambigua', async () => {
      const { servico } = montar(
        [linha('7003', 1, 'EAD', 583), linha('7003', 2, 'SEMI', 1)],
        [escolha('7003', 3, 'MODULAR')],
      );
      const decisao = await servico
        .resolver(['103'], 'N2')
        .then((m) => m.de('7003'));

      expect(decisao.situacao).toBe('SEM_MODALIDADE');
      if (decisao.situacao !== 'SEM_MODALIDADE') return;

      expect(decisao.motivo).toBe('AMBIGUA');
      // A turma apareceu resolvida na conferencia de ontem: sumir do painel sem
      // explicacao seria a pior versao deste aviso.
      expect(decisao.detalhe).toContain('MODULAR');
      expect(decisao.detalhe).toContain('nao vale mais');
    });

    /** Escolha de OUTRA turma nao pode vazar para esta. */
    it('a escolha e por turma', async () => {
      const { servico } = ambigua([escolha('9999', 1, 'EAD')]);
      const decisao = await servico
        .resolver(['103'], 'N2')
        .then((m) => m.de('7003'));

      expect(decisao.situacao).toBe('SEM_MODALIDADE');
    });

    /**
     * A N2 e a SUB do mesmo semestre COMPARTILHAM o org unit. Sem a rodada no
     * recorte, o desempate da N2 decidiria a substitutiva, que tem outro
     * publico — e podia ter outra composicao de formatos.
     */
    it('o recorte da escolha leva a rodada, e so as turmas com agendamento', async () => {
      const { servico, findMany } = ambigua();
      await servico.resolver(['103'], 'SUB');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rodada: 'SUB', orgUnitId: { in: ['7003'] } },
        }),
      );
    });

    /** Nenhuma turma com agendamento: nao ha onde uma escolha valer. */
    it('sem turma alcancada, nem consulta as escolhas', async () => {
      const { servico, findMany } = montar([]);
      await servico.resolver(['103'], 'N2');

      expect(findMany).not.toHaveBeenCalled();
    });
  });

  /**
   * As travas da gravacao. Sao elas que impedem isto de virar "definir o
   * formato de qualquer turma" — a coluna de cadastro recusada em
   * 10/08/2026, com outro nome.
   */
  describe('escolher / esquecer', () => {
    const montarEscrita = (
      linhas: Record<string, unknown>[],
      turma: Record<string, unknown> | null = {
        orgUnitId: '7003',
        codigoTurma: 'GEG02EAD008',
        nomeDisciplina: 'PROBABILIDADE E ESTATISTICA',
      },
    ) => {
      const upsert = jest.fn().mockResolvedValue({});
      const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue(linhas),
        modalidadeEscolhidaDaTurma: {
          findMany: jest.fn().mockResolvedValue([]),
          upsert,
          deleteMany,
        },
        turmaImportada: { findUnique: jest.fn().mockResolvedValue(turma) },
      } as unknown as PrismaService;
      const registrar = jest.fn();
      const auditoria = { registrar } as unknown as AuditoriaService;

      return {
        servico: new ModalidadeDaTurmaService(prisma, auditoria),
        upsert,
        deleteMany,
        registrar,
      };
    };

    const disputada = [
      linha('7003', 1, 'EAD', 583),
      linha('7003', 3, 'MODULAR', 1),
    ];

    it('grava a decisao e a audita', async () => {
      const { servico, upsert, registrar } = montarEscrita(disputada);

      const resultado = await servico.escolher(
        41,
        1,
        ['103'],
        'N2',
        'secretaria@ucb.br',
      );

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgUnitId_rodada: { orgUnitId: '7003', rodada: 'N2' } },
        }),
      );
      expect(registrar).toHaveBeenCalledWith(
        'DATA_QUIZ_MODALIDADE_ESCOLHIDA',
        expect.objectContaining({ ator: 'secretaria@ucb.br' }),
      );
      expect(resultado.decisao.situacao).toBe('ENCONTRADA');
      // A linha volta pronta para a tela redesenhar sem refazer a conferencia
      // inteira, que custa uma volta na Valence por turma do CSV.
      expect(resultado.codigoTurma).toBe('GEG02EAD008');
    });

    /**
     * A trava principal. Sem ela, isto seria uma coluna de formato no
     * cadastro da turma — exatamente o que a decisao de 10/08/2026 recusou.
     */
    it('RECUSA turma que nao esta ambigua', async () => {
      const { servico, upsert } = montarEscrita([linha('7003', 1, 'EAD', 583)]);

      await expect(
        servico.escolher(41, 1, ['103'], 'N2', 'a@b.c'),
      ).rejects.toThrow(/nao esta ambigua/i);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('RECUSA turma sem agendamento nenhum', async () => {
      const { servico, upsert } = montarEscrita([]);

      await expect(
        servico.escolher(41, 1, ['103'], 'N2', 'a@b.c'),
      ).rejects.toThrow(/ausencia/i);
      expect(upsert).not.toHaveBeenCalled();
    });

    /**
     * Um formato sem reserva na turma aplicaria uma janela que ninguem ali
     * usa: a prova deixaria de abrir para TODOS, e nao so para a minoria.
     */
    it('RECUSA formato que nao tem aluno com prova na turma', async () => {
      const { servico, upsert } = montarEscrita(disputada);

      await expect(
        servico.escolher(41, 2, ['103'], 'N2', 'a@b.c'),
      ).rejects.toThrow(/Nenhum aluno/i);
      expect(upsert).not.toHaveBeenCalled();
    });

    /** Turma que nem chega ao lote: a decisao nunca seria lida. */
    it('RECUSA turma sem orgUnitId resolvido', async () => {
      const { servico, upsert } = montarEscrita(disputada, {
        orgUnitId: null,
        codigoTurma: 'ANTIGA0001',
        nomeDisciplina: 'DISCIPLINA DE 2025',
      });

      await expect(
        servico.escolher(41, 1, ['103'], 'N2', 'a@b.c'),
      ).rejects.toThrow(/nao casou com nenhuma oferta/i);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('turma inexistente e 404', async () => {
      const { servico } = montarEscrita(disputada, null);

      await expect(
        servico.escolher(41, 1, ['103'], 'N2', 'a@b.c'),
      ).rejects.toThrow(/Turma nao encontrada/i);
    });

    /**
     * Apagar nunca aplica nada em prova nenhuma, entao exigir ambiguidade aqui
     * prenderia a linha no banco justamente quando ela ja nao vale.
     */
    it('esquecer NAO exige que a turma continue ambigua', async () => {
      const { servico, deleteMany, registrar } = montarEscrita([
        linha('7003', 1, 'EAD', 583),
      ]);

      const resultado = await servico.esquecer(41, ['103'], 'N2', 'a@b.c');

      expect(deleteMany).toHaveBeenCalledWith({
        where: { orgUnitId: '7003', rodada: 'N2' },
      });
      expect(registrar).toHaveBeenCalledWith(
        'DATA_QUIZ_MODALIDADE_ESCOLHA_REMOVIDA',
        expect.anything(),
      );
      // Relido depois de apagar: a tela redesenha o estado de AGORA.
      expect(resultado.decisao.situacao).toBe('ENCONTRADA');
    });
  });
});

/**
 * Achata os parametros da consulta crua.
 *
 * `Prisma.join()` entrega um fragmento (`{ strings, values }`) em vez de um
 * valor solto, entao os ids do `IN` ficam um nivel abaixo dos demais
 * parametros.
 */
function valoresDe(parametros: unknown[]): unknown[] {
  return parametros.flatMap((p) =>
    p && typeof p === 'object' && 'values' in p
      ? ((p as { values: unknown[] }).values ?? [])
      : [p],
  );
}
