import {
  D2lGradesService,
  NotaFinalD2L,
} from '../../d2l/service/d2l-grades.service';
import type { FiltroDeNota } from '../../periodo/service/periodo.service';
import type { DisciplinaAgendavel } from '../../turma/service/turma.service';
import {
  ElegibilidadeDeNotaService,
  motivoDeNenhumaElegivel,
} from './elegibilidade-de-nota.service';

/**
 * O que estes testes protegem:
 *
 * 1. Os DOIS criterios, e as fronteiras de cada um. `N1 >= 1,50` e
 *    `final < 7,00`: quem tirou exatamente 1,50 na N1 entra, quem tirou
 *    exatamente 7,00 na final fica de fora. Trocar um dos operadores muda a vida
 *    de quem esta na borda, e o resultado continuaria parecendo correto.
 * 2. Que os dois criterios sao mesmo DOIS. O erro mais provavel nesta regra e
 *    alguem "simplificar" de volta para uma faixa sobre a nota final — por isso
 *    ha caso com N1 boa e final alta, e com N1 ruim e final baixa.
 * 3. Sem filtro, NENHUMA chamada de rede sai. E o caminho da N2, e ele nao pode
 *    passar a custar duas consultas de nota por disciplina.
 * 4. Quem nao tem nota NAO agenda — com motivos distintos para "a turma nao tem
 *    N1" e "este aluno nao tem nota nela": um e defeito de montagem da turma, o
 *    outro e pendencia individual, e as acoes sao diferentes.
 * 5. O cache separa N1 de nota final. Sem isso a segunda leitura devolveria a
 *    primeira, e a N1 do aluno viraria a nota final dele.
 */
describe('ElegibilidadeDeNotaService', () => {
  const REGRA: FiltroDeNota = { minimaN1: 1.5, maximaFinal: 7 };

  /** O `CategoryId` da N1 na turma 6606. Muda de turma para turma, de verdade. */
  const CATEGORIA_N1 = '4231';

  const HISTORIA: DisciplinaAgendavel = {
    orgUnitId: '6606',
    nomeDisciplina: 'HISTORIA E CULTURA DO CORPO',
  };

  const NUTRICAO: DisciplinaAgendavel = {
    orgUnitId: '6610',
    nomeDisciplina: 'NUTRICAO ESPORTIVA',
  };

  const achou = (pontos: number): NotaFinalD2L => ({
    situacao: 'ACHOU',
    pontos,
    denominador: 10,
    origem: 'CALCULADA',
    exibida: `${pontos}`,
  });

  const SEM_NOTA: NotaFinalD2L = { situacao: 'SEM_NOTA' };

  /**
   * O duble da Valence. `finais` e `n1` sao mapas por `orgUnitId`; a turma que
   * nao aparecer em `semCategoria` tem a categoria N1 normalmente.
   */
  const montar = (dados: {
    finais?: Record<string, NotaFinalD2L>;
    n1?: Record<string, NotaFinalD2L>;
    semCategoria?: string[];
  }) => {
    const notaFinal = jest
      .fn()
      .mockImplementation((orgUnitId: string) =>
        Promise.resolve(dados.finais?.[orgUnitId] ?? SEM_NOTA),
      );

    const notaDeGradeObject = jest
      .fn()
      .mockImplementation((orgUnitId: string) =>
        Promise.resolve(dados.n1?.[orgUnitId] ?? SEM_NOTA),
      );

    const categoriaPorNome = jest
      .fn()
      .mockImplementation((orgUnitId: string) =>
        Promise.resolve(
          dados.semCategoria?.includes(orgUnitId) ? null : CATEGORIA_N1,
        ),
      );

    const service = new ElegibilidadeDeNotaService({
      notaFinal,
      notaDeGradeObject,
      categoriaPorNome,
      nomeDaCategoriaN1: () => 'N1',
      notasFinaisDaTurma: jest.fn(),
      notasDeGradeObjectDaTurma: jest.fn(),
      habilitado: () => true,
    } as unknown as D2lGradesService);

    return { service, notaFinal, notaDeGradeObject, categoriaPorNome };
  };

  describe('os dois criterios, e as fronteiras de cada um', () => {
    // Uma tabela em vez de dez testes: o que importa aqui e o CONJUNTO dos
    // casos, e ler as bordas juntas e o que denuncia um `>` virado `>=` — ou,
    // pior, os dois limites voltando a comparar a mesma nota.
    it.each([
      [1.49, 4.0, false, 'N1 abaixo do piso: nao ha substitutiva que salve'],
      [1.5, 4.0, true, 'exatamente o piso da N1 ENTRA'],
      [1.51, 4.0, true, 'acima do piso da N1'],
      [8.0, 6.99, true, 'logo abaixo do teto da final'],
      [8.0, 7.0, false, 'exatamente o teto da final FICA DE FORA: ja passou'],
      [8.0, 9.5, false, 'acima do teto da final: passou com folga'],
      [0, 4.0, false, 'zero na N1 nao e "sem nota", e continua reprovando'],
      // As duas linhas que provam que sao DOIS criterios, e nao um intervalo
      // sobre a nota final: cada uma passa em um e falha no outro.
      [9.0, 8.0, false, 'N1 otima e final ja aprovada: nao faz substitutiva'],
      [1.0, 2.0, false, 'final baixa nao salva quem nao fez a N1'],
      [1.5, 0.0, true, 'final ZERO com a N1 no piso ainda entra'],
    ])('N1 %s + final %s -> elegivel: %s (%s)', async (n1, final, esperado) => {
      const { service } = montar({
        finais: { '6606': achou(final) },
        n1: { '6606': achou(n1) },
      });

      const { elegiveis, recusadas } = await service.filtrar(
        '76629',
        [HISTORIA],
        REGRA,
      );

      expect(elegiveis).toHaveLength(esperado ? 1 : 0);
      expect(recusadas).toHaveLength(esperado ? 0 : 1);
    });
  });

  it('as DUAS notas que decidiram vem juntas, para virar fotografia', async () => {
    const { service } = montar({
      finais: { '6606': achou(4.25) },
      n1: { '6606': achou(2.5) },
    });

    const { elegiveis } = await service.filtrar('76629', [HISTORIA], REGRA);

    expect(elegiveis[0]).toEqual({
      ...HISTORIA,
      notaFinal: 4.25,
      notaN1: 2.5,
    });
  });

  it('filtra disciplina por disciplina: uma passa, a outra nao', async () => {
    const { service } = montar({
      finais: { '6606': achou(4.25), '6610': achou(8.0) },
      n1: { '6606': achou(3.0), '6610': achou(9.0) },
    });

    const { elegiveis, recusadas } = await service.filtrar(
      '76629',
      [HISTORIA, NUTRICAO],
      REGRA,
    );

    expect(elegiveis.map((d) => d.orgUnitId)).toEqual(['6606']);
    expect(recusadas).toEqual([
      {
        orgUnitId: '6610',
        nomeDisciplina: NUTRICAO.nomeDisciplina,
        notaFinal: 8,
        notaN1: null,
        motivo: 'FINAL_ATINGIU_A_MEDIA',
      },
    ]);
  });

  it('N1 abaixo do piso registra AS DUAS notas na recusa', async () => {
    const { service } = montar({
      finais: { '6606': achou(3.0) },
      n1: { '6606': achou(0.5) },
    });

    const { recusadas } = await service.filtrar('76629', [HISTORIA], REGRA);

    expect(recusadas[0]).toEqual({
      orgUnitId: '6606',
      nomeDisciplina: HISTORIA.nomeDisciplina,
      notaFinal: 3,
      notaN1: 0.5,
      motivo: 'N1_ABAIXO_DO_MINIMO',
    });
  });

  /**
   * A ordem existe para o portal nao pagar duas chamadas por disciplina para a
   * maioria dos alunos, que sao os que ja passaram de ano. Inverte-la nao muda
   * resultado nenhum — e por isso ninguem perceberia.
   */
  it('quem ja passou sai na PRIMEIRA leitura: a N1 nem e consultada', async () => {
    const { service, notaDeGradeObject } = montar({
      finais: { '6606': achou(8.0) },
      n1: { '6606': achou(9.0) },
    });

    await service.filtrar('76629', [HISTORIA], REGRA);

    expect(notaDeGradeObject).not.toHaveBeenCalled();
  });

  describe('quando falta nota', () => {
    it('sem nota final NAO agenda, e o motivo e proprio', async () => {
      const { service } = montar({ finais: { '6606': SEM_NOTA } });

      const { elegiveis, recusadas } = await service.filtrar(
        '76629',
        [HISTORIA],
        REGRA,
      );

      expect(elegiveis).toHaveLength(0);
      expect(recusadas[0].motivo).toBe('SEM_NOTA_FINAL');
      expect(recusadas[0].notaFinal).toBeNull();
    });

    it('sem nota na N1 NAO agenda, mesmo com a final na faixa', async () => {
      const { service } = montar({
        finais: { '6606': achou(4.0) },
        n1: { '6606': SEM_NOTA },
      });

      const { elegiveis, recusadas } = await service.filtrar(
        '76629',
        [HISTORIA],
        REGRA,
      );

      expect(elegiveis).toHaveLength(0);
      expect(recusadas[0].motivo).toBe('SEM_NOTA_N1');
      expect(recusadas[0].notaFinal).toBe(4);
    });

    /**
     * Turma sem categoria N1 e defeito de montagem que atinge a turma INTEIRA.
     * Se ele virasse `SEM_NOTA_N1`, a frase mandaria o aluno cobrar uma nota
     * que ninguem tem como lancar — a categoria nem existe.
     */
    it('turma sem categoria N1 recusa com motivo proprio', async () => {
      const { service, notaDeGradeObject } = montar({
        finais: { '6606': achou(4.0) },
        semCategoria: ['6606'],
      });

      const { elegiveis, recusadas } = await service.filtrar(
        '76629',
        [HISTORIA],
        REGRA,
      );

      expect(elegiveis).toHaveLength(0);
      expect(recusadas[0].motivo).toBe('SEM_CATEGORIA_N1');
      expect(notaDeGradeObject).not.toHaveBeenCalled();
    });
  });

  /**
   * O caminho da N2. Se este teste falhar, toda prova regular passou a custar
   * consultas de nota por disciplina — e o portal ficou mais lento e mais
   * fragil sem que nada na tela mudasse.
   */
  it('sem filtro devolve tudo e NAO chama a Valence', async () => {
    const { service, notaFinal, notaDeGradeObject, categoriaPorNome } = montar(
      {},
    );

    const { elegiveis, recusadas } = await service.filtrar(
      '76629',
      [HISTORIA, NUTRICAO],
      null,
    );

    expect(notaFinal).not.toHaveBeenCalled();
    expect(notaDeGradeObject).not.toHaveBeenCalled();
    expect(categoriaPorNome).not.toHaveBeenCalled();
    expect(recusadas).toHaveLength(0);
    expect(elegiveis).toEqual([
      { ...HISTORIA, notaFinal: null, notaN1: null },
      { ...NUTRICAO, notaFinal: null, notaN1: null },
    ]);
  });

  it('o erro da Valence SOBE — nao ha degradacao possivel aqui', async () => {
    const { service } = montar({});

    (service as unknown as { grades: D2lGradesService }).grades.notaFinal = jest
      .fn()
      .mockRejectedValue(new Error('502 no tenant'));

    await expect(service.filtrar('76629', [HISTORIA], REGRA)).rejects.toThrow(
      '502 no tenant',
    );
  });

  describe('cache', () => {
    it('o segundo pedido do mesmo par nao repete as chamadas', async () => {
      const { service, notaFinal, notaDeGradeObject } = montar({
        finais: { '6606': achou(4.25) },
        n1: { '6606': achou(3.0) },
      });

      await service.filtrar('76629', [HISTORIA], REGRA);
      await service.filtrar('76629', [HISTORIA], REGRA);

      expect(notaFinal).toHaveBeenCalledTimes(1);
      expect(notaDeGradeObject).toHaveBeenCalledTimes(1);
    });

    /**
     * A chave inclui o ALVO. Sem isso, a N1 e a nota final do mesmo aluno na
     * mesma turma dividiriam a chave — e a segunda leitura devolveria a
     * primeira, fazendo a nota final passar por N1 (e vice-versa).
     */
    it('nao serve a nota final como se fosse a N1', async () => {
      const { service } = montar({
        finais: { '6606': achou(6.5) }, // abaixo do teto: passa no criterio 1
        n1: { '6606': achou(0.5) }, // abaixo do piso: reprova no criterio 2
      });

      const { elegiveis, recusadas } = await service.filtrar(
        '76629',
        [HISTORIA],
        REGRA,
      );

      expect(elegiveis).toHaveLength(0);
      expect(recusadas[0].motivo).toBe('N1_ABAIXO_DO_MINIMO');
      expect(recusadas[0].notaN1).toBe(0.5);
    });

    /** A chave inclui o aluno: sem isso, um receberia a nota do outro. */
    it('nao serve a nota de um aluno para outro', async () => {
      const notaPorAluno: Record<string, number> = {
        '76629': 4.25,
        '80001': 9.0,
      };

      const service = new ElegibilidadeDeNotaService({
        notaFinal: jest
          .fn()
          .mockImplementation((_orgUnitId: string, userId: string) =>
            Promise.resolve(achou(notaPorAluno[userId])),
          ),
        notaDeGradeObject: jest.fn().mockResolvedValue(achou(3.0)),
        categoriaPorNome: jest.fn().mockResolvedValue(CATEGORIA_N1),
        nomeDaCategoriaN1: () => 'N1',
        habilitado: () => true,
      } as unknown as D2lGradesService);

      const primeiro = await service.filtrar('76629', [HISTORIA], REGRA);
      const segundo = await service.filtrar('80001', [HISTORIA], REGRA);

      expect(primeiro.elegiveis).toHaveLength(1);
      expect(segundo.elegiveis).toHaveLength(0);
    });

    it('`esquecer` obriga a reler — o lote nao herda nota de outra execucao', async () => {
      const { service, notaFinal } = montar({
        finais: { '6606': achou(4.25) },
        n1: { '6606': achou(3.0) },
      });

      await service.filtrar('76629', [HISTORIA], REGRA);
      service.esquecer();
      await service.filtrar('76629', [HISTORIA], REGRA);

      expect(notaFinal).toHaveBeenCalledTimes(2);
    });
  });

  describe('preAquecer', () => {
    const daTurma = (notas: Record<string, NotaFinalD2L>) =>
      jest.fn().mockResolvedValue(new Map(Object.entries(notas)));

    it('serve o filtro de memoria, sem uma chamada por aluno', async () => {
      const notaFinal = jest.fn();
      const notaDeGradeObject = jest.fn();

      const notasFinaisDaTurma = daTurma({
        '76629': achou(4.25),
        '80001': achou(9.0),
      });

      const notasDeGradeObjectDaTurma = daTurma({
        '76629': achou(3.0),
        '80001': achou(8.0),
      });

      const service = new ElegibilidadeDeNotaService({
        notaFinal,
        notaDeGradeObject,
        notasFinaisDaTurma,
        notasDeGradeObjectDaTurma,
        categoriaPorNome: jest.fn().mockResolvedValue(CATEGORIA_N1),
        nomeDaCategoriaN1: () => 'N1',
        habilitado: () => true,
      } as unknown as D2lGradesService);

      const resumo = await service.preAquecer(['6606']);

      const elegivel = await service.filtrar('76629', [HISTORIA], REGRA);
      const passou = await service.filtrar('80001', [HISTORIA], REGRA);

      expect(notasFinaisDaTurma).toHaveBeenCalledTimes(1);
      expect(notasDeGradeObjectDaTurma).toHaveBeenCalledTimes(1);
      expect(notaFinal).not.toHaveBeenCalled();
      expect(notaDeGradeObject).not.toHaveBeenCalled();
      expect(resumo).toEqual({ turmas: 1, falhas: 0, semN1: 0 });
      expect(elegivel.elegiveis).toHaveLength(1);
      expect(passou.elegiveis).toHaveLength(0);
    });

    /**
     * Falha de UMA turma nao pode parar o lote nem, pior, fazer todos os alunos
     * dela virarem "sem nota" — que na substitutiva significa "nao agenda".
     */
    it('turma que falhou volta a ser consultada aluno a aluno', async () => {
      const notaFinal = jest.fn().mockResolvedValue(achou(4.25));
      const notaDeGradeObject = jest.fn().mockResolvedValue(achou(3.0));

      const service = new ElegibilidadeDeNotaService({
        notaFinal,
        notaDeGradeObject,
        notasFinaisDaTurma: jest.fn().mockRejectedValue(new Error('timeout')),
        notasDeGradeObjectDaTurma: jest.fn(),
        categoriaPorNome: jest.fn().mockResolvedValue(CATEGORIA_N1),
        nomeDaCategoriaN1: () => 'N1',
        habilitado: () => true,
      } as unknown as D2lGradesService);

      const resumo = await service.preAquecer(['6606']);
      const { elegiveis } = await service.filtrar('76629', [HISTORIA], REGRA);

      expect(resumo).toEqual({ turmas: 0, falhas: 1, semN1: 0 });
      expect(notaFinal).toHaveBeenCalledTimes(1);
      expect(elegiveis).toHaveLength(1);
    });

    /**
     * Turma sem N1 nao e falha de rede, e conta-la como tal esconderia as
     * falhas de verdade. Ela e contada a parte, e a nota final dela continua
     * pre-carregada — o aluno e recusado por `SEM_CATEGORIA_N1`, e nao por uma
     * chamada que nunca foi feita.
     */
    it('turma sem categoria N1 nao conta como falha', async () => {
      const notasDeGradeObjectDaTurma = jest.fn();

      const service = new ElegibilidadeDeNotaService({
        notaFinal: jest.fn(),
        notaDeGradeObject: jest.fn(),
        notasFinaisDaTurma: daTurma({ '76629': achou(4.25) }),
        notasDeGradeObjectDaTurma,
        categoriaPorNome: jest.fn().mockResolvedValue(null),
        nomeDaCategoriaN1: () => 'N1',
        habilitado: () => true,
      } as unknown as D2lGradesService);

      const resumo = await service.preAquecer(['6606']);
      const { recusadas } = await service.filtrar('76629', [HISTORIA], REGRA);

      expect(resumo).toEqual({ turmas: 1, falhas: 0, semN1: 1 });
      expect(notasDeGradeObjectDaTurma).not.toHaveBeenCalled();
      expect(recusadas[0].motivo).toBe('SEM_CATEGORIA_N1');
    });
  });
});

/**
 * O texto da recusa NAO pode mandar o aluno para o lugar errado: "sem nota
 * lancada" e caso de secretaria (a turma pode nao ter fechado notas), "turma sem
 * N1" e defeito de montagem, e nao ter passado nos criterios e simplesmente a
 * regra. As tres pedem coisas diferentes de quem le.
 */
describe('motivoDeNenhumaElegivel', () => {
  const REGRA: FiltroDeNota = { minimaN1: 1.5, maximaFinal: 7 };

  const recusa = (
    motivo: Parameters<typeof motivoDeNenhumaElegivel>[0][number]['motivo'],
    notas: { notaFinal?: number | null; notaN1?: number | null } = {},
  ) => ({
    orgUnitId: '6606',
    nomeDisciplina: null,
    notaFinal: notas.notaFinal ?? null,
    notaN1: notas.notaN1 ?? null,
    motivo,
  });

  it('so criterio nao atendido: diz os dois numeros, em formato de aluno', () => {
    const texto = motivoDeNenhumaElegivel(
      [recusa('FINAL_ATINGIU_A_MEDIA', { notaFinal: 8 })],
      REGRA,
    );

    expect(texto).toContain('1,50');
    expect(texto).toContain('7,00');
    expect(texto).not.toContain('sem nota lancada');
  });

  it('todas sem nota: manda a secretaria, sem falar em criterio', () => {
    const texto = motivoDeNenhumaElegivel([recusa('SEM_NOTA_FINAL')], REGRA);

    expect(texto).toContain('secretaria');
    expect(texto).not.toContain('1,50');
  });

  /** A N1 que falta e a da TURMA: a frase nao pode culpar o aluno por isso. */
  it('todas sem categoria N1: fala da configuracao, nao da nota do aluno', () => {
    const texto = motivoDeNenhumaElegivel([recusa('SEM_CATEGORIA_N1')], REGRA);

    expect(texto).toContain('secretaria');
    expect(texto).toContain('N1');
    expect(texto).not.toContain('1,50');
  });

  it('misturado: fala da regra E avisa que parte esta sem nota', () => {
    const texto = motivoDeNenhumaElegivel(
      [
        recusa('FINAL_ATINGIU_A_MEDIA', { notaFinal: 8 }),
        recusa('SEM_NOTA_N1', { notaFinal: 4 }),
      ],
      REGRA,
    );

    expect(texto).toContain('1,50');
    expect(texto).toContain('sem nota lancada');
  });
});
