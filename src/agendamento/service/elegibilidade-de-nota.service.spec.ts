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
 * 1. As FRONTEIRAS da faixa. `>= minima` e `< maxima` e a regra, nao um detalhe:
 *    quem tirou exatamente 1,50 entra e quem tirou exatamente 6,75 fica de fora.
 *    Trocar um dos operadores muda a vida de quem esta na borda, e o resultado
 *    continuaria parecendo correto.
 * 2. Sem filtro, NENHUMA chamada de rede sai. E o caminho da N2, e ele nao pode
 *    passar a custar uma consulta de nota por disciplina.
 * 3. Aluno sem nota NAO agenda — e por um motivo proprio, distinto de "fora da
 *    faixa": um manda procurar a secretaria, o outro nao.
 * 4. O cache serve o segundo pedido do mesmo par sem repetir a chamada — o
 *    portal pergunta as disciplinas e confirma o agendamento em seguida.
 */
describe('ElegibilidadeDeNotaService', () => {
  const FAIXA: FiltroDeNota = { minima: 1.5, maxima: 6.75 };

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

  const montar = (notas: Record<string, NotaFinalD2L>) => {
    const notaFinal = jest
      .fn()
      .mockImplementation((orgUnitId: string) =>
        Promise.resolve(notas[orgUnitId] ?? SEM_NOTA),
      );

    const service = new ElegibilidadeDeNotaService({
      notaFinal,
      notasFinaisDaTurma: jest.fn(),
      habilitado: () => true,
    } as unknown as D2lGradesService);

    return { service, notaFinal };
  };

  describe('as fronteiras da faixa', () => {
    // Uma tabela em vez de quatro testes: o que importa aqui e o CONJUNTO das
    // quatro bordas, e ler as quatro juntas e o que denuncia um `>` virado `>=`.
    it.each([
      [1.49, false, 'abaixo do piso: ja reprovou por nota'],
      [1.5, true, 'exatamente o piso ENTRA (a faixa e fechada aqui)'],
      [6.74, true, 'logo abaixo do teto'],
      [6.75, false, 'exatamente o teto FICA DE FORA (a faixa e aberta aqui)'],
      [9.9, false, 'acima do teto: ja passou'],
      [0, false, 'zero nao e "sem nota", e continua fora da faixa'],
    ])('nota %s -> elegivel: %s (%s)', async (nota, esperado) => {
      const { service } = montar({ '6606': achou(nota) });

      const { elegiveis, recusadas } = await service.filtrar(
        '76629',
        [HISTORIA],
        FAIXA,
      );

      expect(elegiveis).toHaveLength(esperado ? 1 : 0);
      expect(recusadas).toHaveLength(esperado ? 0 : 1);
    });
  });

  it('a nota que decidiu vem junto, para virar fotografia na reserva', async () => {
    const { service } = montar({ '6606': achou(4.25) });

    const { elegiveis } = await service.filtrar('76629', [HISTORIA], FAIXA);

    expect(elegiveis[0]).toEqual({ ...HISTORIA, notaFinal: 4.25 });
  });

  it('filtra disciplina por disciplina: uma passa, a outra nao', async () => {
    const { service } = montar({
      '6606': achou(4.25), // na faixa
      '6610': achou(8.0), // ja passou
    });

    const { elegiveis, recusadas } = await service.filtrar(
      '76629',
      [HISTORIA, NUTRICAO],
      FAIXA,
    );

    expect(elegiveis.map((d) => d.orgUnitId)).toEqual(['6606']);
    expect(recusadas).toEqual([
      {
        orgUnitId: '6610',
        nomeDisciplina: NUTRICAO.nomeDisciplina,
        nota: 8,
        motivo: 'FORA_DA_FAIXA',
      },
    ]);
  });

  it('sem nota lancada NAO agenda, e o motivo e proprio', async () => {
    const { service } = montar({ '6606': SEM_NOTA });

    const { elegiveis, recusadas } = await service.filtrar(
      '76629',
      [HISTORIA],
      FAIXA,
    );

    expect(elegiveis).toHaveLength(0);
    expect(recusadas[0].motivo).toBe('SEM_NOTA');
    expect(recusadas[0].nota).toBeNull();
  });

  /**
   * O caminho da N2. Se este teste falhar, toda prova regular passou a custar
   * uma consulta de nota por disciplina — e o portal ficou mais lento e mais
   * fragil sem que nada na tela mudasse.
   */
  it('sem filtro devolve tudo e NAO chama a Valence', async () => {
    const { service, notaFinal } = montar({});

    const { elegiveis, recusadas } = await service.filtrar(
      '76629',
      [HISTORIA, NUTRICAO],
      null,
    );

    expect(notaFinal).not.toHaveBeenCalled();
    expect(recusadas).toHaveLength(0);
    expect(elegiveis).toEqual([
      { ...HISTORIA, notaFinal: null },
      { ...NUTRICAO, notaFinal: null },
    ]);
  });

  it('o erro da Valence SOBE — nao ha degradacao possivel aqui', async () => {
    const notaFinal = jest.fn().mockRejectedValue(new Error('502 no tenant'));

    const service = new ElegibilidadeDeNotaService({
      notaFinal,
      notasFinaisDaTurma: jest.fn(),
      habilitado: () => true,
    } as unknown as D2lGradesService);

    await expect(service.filtrar('76629', [HISTORIA], FAIXA)).rejects.toThrow(
      '502 no tenant',
    );
  });

  describe('cache', () => {
    it('o segundo pedido do mesmo par nao repete a chamada', async () => {
      const { service, notaFinal } = montar({ '6606': achou(4.25) });

      await service.filtrar('76629', [HISTORIA], FAIXA);
      await service.filtrar('76629', [HISTORIA], FAIXA);

      expect(notaFinal).toHaveBeenCalledTimes(1);
    });

    /** A chave inclui o aluno: sem isso, um receberia a nota do outro. */
    it('nao serve a nota de um aluno para outro', async () => {
      const notaPorAluno: Record<string, number> = {
        '76629': 4.25,
        '80001': 9.0,
      };

      const notaFinal = jest
        .fn()
        .mockImplementation((_orgUnitId: string, userId: string) =>
          Promise.resolve(achou(notaPorAluno[userId])),
        );

      const service = new ElegibilidadeDeNotaService({
        notaFinal,
        notasFinaisDaTurma: jest.fn(),
        habilitado: () => true,
      } as unknown as D2lGradesService);

      const primeiro = await service.filtrar('76629', [HISTORIA], FAIXA);
      const segundo = await service.filtrar('80001', [HISTORIA], FAIXA);

      expect(primeiro.elegiveis).toHaveLength(1);
      expect(segundo.elegiveis).toHaveLength(0);
      expect(notaFinal).toHaveBeenCalledTimes(2);
    });

    it('`esquecer` obriga a reler — o lote nao herda nota de outra execucao', async () => {
      const { service, notaFinal } = montar({ '6606': achou(4.25) });

      await service.filtrar('76629', [HISTORIA], FAIXA);
      service.esquecer();
      await service.filtrar('76629', [HISTORIA], FAIXA);

      expect(notaFinal).toHaveBeenCalledTimes(2);
    });
  });

  describe('preAquecer', () => {
    it('serve o filtro de memoria, sem uma chamada por aluno', async () => {
      const notaFinal = jest.fn();

      const notasFinaisDaTurma = jest.fn().mockResolvedValue(
        new Map<string, NotaFinalD2L>([
          ['76629', achou(4.25)],
          ['80001', achou(9.0)],
        ]),
      );

      const service = new ElegibilidadeDeNotaService({
        notaFinal,
        notasFinaisDaTurma,
        habilitado: () => true,
      } as unknown as D2lGradesService);

      await service.preAquecer(['6606']);

      const naFaixa = await service.filtrar('76629', [HISTORIA], FAIXA);
      const passou = await service.filtrar('80001', [HISTORIA], FAIXA);

      expect(notasFinaisDaTurma).toHaveBeenCalledTimes(1);
      expect(notaFinal).not.toHaveBeenCalled();
      expect(naFaixa.elegiveis).toHaveLength(1);
      expect(passou.elegiveis).toHaveLength(0);
    });

    /**
     * Falha de UMA turma nao pode parar o lote nem, pior, fazer todos os alunos
     * dela virarem "sem nota" — que na substitutiva significa "nao agenda".
     */
    it('turma que falhou volta a ser consultada aluno a aluno', async () => {
      const notaFinal = jest.fn().mockResolvedValue(achou(4.25));

      const notasFinaisDaTurma = jest
        .fn()
        .mockRejectedValue(new Error('timeout'));

      const service = new ElegibilidadeDeNotaService({
        notaFinal,
        notasFinaisDaTurma,
        habilitado: () => true,
      } as unknown as D2lGradesService);

      const resumo = await service.preAquecer(['6606']);
      const { elegiveis } = await service.filtrar('76629', [HISTORIA], FAIXA);

      expect(resumo).toEqual({ turmas: 0, falhas: 1 });
      expect(notaFinal).toHaveBeenCalledTimes(1);
      expect(elegiveis).toHaveLength(1);
    });
  });
});

/**
 * O texto da recusa NAO pode mandar o aluno para o lugar errado: "sem nota
 * lancada" e caso de secretaria (a turma pode nao ter fechado notas), enquanto
 * "fora da faixa" e simplesmente a regra.
 */
describe('motivoDeNenhumaElegivel', () => {
  const FAIXA: FiltroDeNota = { minima: 1.5, maxima: 6.75 };

  it('so notas fora da faixa: diz a faixa, em formato de aluno', () => {
    const texto = motivoDeNenhumaElegivel(
      [
        {
          orgUnitId: '6606',
          nomeDisciplina: null,
          nota: 8,
          motivo: 'FORA_DA_FAIXA',
        },
      ],
      FAIXA,
    );

    expect(texto).toContain('1,50');
    expect(texto).toContain('6,75');
    expect(texto).not.toContain('nao tem nota final lancada');
  });

  it('todas sem nota: manda a secretaria, sem falar em faixa', () => {
    const texto = motivoDeNenhumaElegivel(
      [
        {
          orgUnitId: '6606',
          nomeDisciplina: null,
          nota: null,
          motivo: 'SEM_NOTA',
        },
      ],
      FAIXA,
    );

    expect(texto).toContain('secretaria');
    expect(texto).not.toContain('1,50');
  });

  it('misturado: fala da faixa E avisa que parte esta sem nota', () => {
    const texto = motivoDeNenhumaElegivel(
      [
        {
          orgUnitId: '6606',
          nomeDisciplina: null,
          nota: 8,
          motivo: 'FORA_DA_FAIXA',
        },
        {
          orgUnitId: '6610',
          nomeDisciplina: null,
          nota: null,
          motivo: 'SEM_NOTA',
        },
      ],
      FAIXA,
    );

    expect(texto).toContain('1,50');
    expect(texto).toContain('sem nota final');
  });
});
