import { PrismaService } from '../../database/prisma.service';
import { ModalidadeDaTurmaService } from './modalidade-da-turma.service';

/**
 * A pergunta que este servico responde nao tem coluna no banco: `TurmaImportada`
 * nao guarda modalidade, por decisao de 10/08/2026. Ela e derivada dos
 * agendamentos confirmados, e a regra e "uma, ou nenhuma" — nunca a maioria.
 */
describe('ModalidadeDaTurmaService', () => {
  const montar = (linhas: Record<string, unknown>[]) => {
    const queryRaw = jest.fn().mockResolvedValue(linhas);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    return { servico: new ModalidadeDaTurmaService(prisma), queryRaw };
  };

  const linha = (
    orgUnitId: string,
    modalidadeId: number,
    codigo: string,
    reservas: number | bigint,
  ) => ({ orgUnitId, modalidadeId, codigo, nome: codigo, reservas });

  it('uma modalidade so: resolve', async () => {
    const { servico } = montar([linha('7001', 1, 'EAD', 42)]);
    const mapa = await servico.resolver(['103'], 'N2');

    expect(mapa.de('7001')).toEqual({
      situacao: 'ENCONTRADA',
      modalidadeId: 1,
      codigo: 'EAD',
      nome: 'EAD',
      reservas: 42,
    });
  });

  /**
   * O caso que decide o desenho. O questionario tem UMA janela; escolher a
   * maioria deixaria a minoria sem conseguir abrir a prova, e o erro so
   * apareceria no dia. Mesma regra de ORGUNIT_AMBIGUO.
   */
  it('duas modalidades: NAO escolhe a maioria', async () => {
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
    // O detalhe vai para o CSV do relatorio: quem le precisa das duas
    // modalidades e do peso de cada uma para decidir o que fazer.
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
   * a devolveria como SEM_AGENDAMENTO — turma sem modalidade fica de fora do
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
