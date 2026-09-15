import { GrupoLido, planejarGrupos, planejarInscricoes } from './plano';

const grupo = (
  GroupId: number,
  Name: string,
  Enrollments: number[] = [],
): GrupoLido => ({
  GroupId,
  Name,
  Enrollments,
});

describe('planejarGrupos', () => {
  it('categoria em dia: nada a criar', () => {
    const plano = planejarGrupos(
      ['16/09 - 9h', '16/09 - 15h'],
      [grupo(1, '16/09 - 9h'), grupo(2, '16/09 - 15h')],
    );

    expect(plano).toEqual({ criar: [], renomear: [], sobrando: [] });
  });

  it('compara o nome como o disparo do quiz: sem acento, caixa ou espaco duplo', () => {
    const plano = planejarGrupos(
      ['Manhã  - 16/09'],
      [grupo(1, 'MANHA - 16/09')],
    );

    expect(plano.criar).toEqual([]);
  });

  /**
   * A categoria recem-criada vem com grupos genericos. Eles viram os grupos da
   * prova por renomeacao, na ordem em que a D2L os criou.
   */
  it('renomeia os grupos genericos vazios antes de criar outros', () => {
    const plano = planejarGrupos(
      ['A', 'B', 'C'],
      [grupo(11, 'Grupo 2'), grupo(10, 'Grupo 1')],
    );

    expect(plano.renomear).toEqual([
      { GroupId: 10, de: 'Grupo 1', para: 'A' },
      { GroupId: 11, de: 'Grupo 2', para: 'B' },
    ]);
    expect(plano.criar).toEqual(['C']);
  });

  it('grupo com aluno fora da lista NUNCA e renomeado — so relatado', () => {
    const plano = planejarGrupos(['Novo'], [grupo(1, 'Prova de ontem', [500])]);

    expect(plano.renomear).toEqual([]);
    expect(plano.criar).toEqual(['Novo']);
    expect(plano.sobrando.map((g) => g.GroupId)).toEqual([1]);
  });

  it('nome repetido na lista gera um grupo so', () => {
    expect(planejarGrupos(['A', 'a '], []).criar).toEqual(['A']);
  });
});

describe('planejarInscricoes', () => {
  const G9 = grupo(1, '16/09 - 9h');
  const G15 = grupo(2, '16/09 - 15h');

  it('inscreve quem falta e conta quem ja esta', () => {
    const plano = planejarInscricoes({
      grupos: [grupo(1, '16/09 - 9h', [100])],
      desejado: new Map([
        [100, new Set(['16/09 - 9h'])],
        [200, new Set(['16/09 - 9h'])],
      ]),
      removiveis: new Set([100, 200]),
    });

    expect(plano.adicionar).toEqual([
      { GroupId: 1, nomeGrupo: '16/09 - 9h', userId: 200 },
    ]);
    expect(plano.jaInscritos).toBe(1);
    expect(plano.remover).toEqual([]);
  });

  it('remanejo: entra no grupo novo e sai do antigo', () => {
    const plano = planejarInscricoes({
      grupos: [{ ...G9, Enrollments: [100] }, G15],
      desejado: new Map([[100, new Set(['16/09 - 15h'])]]),
      removiveis: new Set([100]),
    });

    expect(plano.adicionar).toEqual([
      { GroupId: 2, nomeGrupo: '16/09 - 15h', userId: 100 },
    ]);
    expect(plano.remover).toEqual([
      { GroupId: 1, nomeGrupo: '16/09 - 9h', userId: 100 },
    ]);
  });

  it('nunca tira do grupo quem o portal nao conhece (tutor, inclusao manual)', () => {
    const plano = planejarInscricoes({
      grupos: [{ ...G9, Enrollments: [999] }],
      desejado: new Map(),
      removiveis: new Set(),
    });

    expect(plano.remover).toEqual([]);
  });

  it('cancelado conhecido sai do grupo', () => {
    const plano = planejarInscricoes({
      grupos: [{ ...G9, Enrollments: [300] }],
      desejado: new Map(),
      removiveis: new Set([300]),
    });

    expect(plano.remover).toEqual([
      { GroupId: 1, nomeGrupo: '16/09 - 9h', userId: 300 },
    ]);
  });

  /**
   * Sem o grupo novo, tirar o aluno do antigo o deixaria sem grupo nenhum. A
   * pendencia pede acao; ate la, o antigo e melhor que nada.
   */
  it('quem tem grupo desejado inexistente nao sai de onde esta', () => {
    const plano = planejarInscricoes({
      grupos: [{ ...G9, Enrollments: [100] }],
      desejado: new Map([[100, new Set(['17/09 - 9h'])]]),
      removiveis: new Set([100]),
    });

    expect(plano.semGrupo).toEqual([
      { userId: 100, nomeGrupo: '17/09 - 9h', duplicado: false },
    ]);
    expect(plano.remover).toEqual([]);
  });

  it('grupo duplicado na categoria e tratado como ausente', () => {
    const plano = planejarInscricoes({
      grupos: [G9, grupo(3, '16/09 - 9h')],
      desejado: new Map([[100, new Set(['16/09 - 9h'])]]),
      removiveis: new Set([100]),
    });

    expect(plano.adicionar).toEqual([]);
    expect(plano.semGrupo[0].duplicado).toBe(true);
  });

  it('aluno com duas reservas em sessoes diferentes fica nos dois grupos', () => {
    const plano = planejarInscricoes({
      grupos: [
        { ...G9, Enrollments: [100] },
        { ...G15, Enrollments: [100] },
      ],
      desejado: new Map([[100, new Set(['16/09 - 9h', '16/09 - 15h'])]]),
      removiveis: new Set([100]),
    });

    expect(plano.remover).toEqual([]);
    expect(plano.jaInscritos).toBe(2);
  });
});
