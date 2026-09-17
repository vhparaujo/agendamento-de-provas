import { janelaDoAgendamento } from './janela-do-agendamento';

function janela(
  id: number,
  periodoLetivoId: string,
  rodada: string,
  doMapa: string[] = [],
) {
  return {
    id,
    periodoLetivoId,
    rodada,
    letivosPorModalidade: doMapa.map((p) => ({ periodoLetivoId: p })),
  };
}

describe('janelaDoAgendamento', () => {
  it('casa pelo periodo letivo PRINCIPAL e pela rodada', () => {
    const janelas = [janela(2, '103', 'SUB'), janela(1, '103', 'N2')];

    expect(
      janelaDoAgendamento({ periodoLetivoId: '103', rodada: 'N2' }, janelas)
        ?.id,
    ).toBe(1);
  });

  /**
   * DUAS GRADES. A prova presencial fica gravada sob o org unit do SEMESTRE,
   * que so aparece no mapa da janela — comparar so com o principal a deixaria
   * sem periodo nenhum.
   */
  it('casa por um periodo letivo do mapa por formato', () => {
    const janelas = [janela(1, '2026-4-modulo', 'N2', ['2026-2-semestre'])];

    expect(
      janelaDoAgendamento(
        { periodoLetivoId: '2026-2-semestre', rodada: 'N2' },
        janelas,
      )?.id,
    ).toBe(1);
  });

  it('a N2 e a SUB do mesmo semestre sao janelas diferentes', () => {
    const janelas = [janela(1, '103', 'N2')];

    expect(
      janelaDoAgendamento({ periodoLetivoId: '103', rodada: 'SUB' }, janelas),
    ).toBeUndefined();
  });

  it('com duas linhas do mesmo par, vence a primeira (a mais recente)', () => {
    const janelas = [janela(9, '103', 'N2'), janela(3, '103', 'N2')];

    expect(
      janelaDoAgendamento({ periodoLetivoId: '103', rodada: 'N2' }, janelas)
        ?.id,
    ).toBe(9);
  });
});
