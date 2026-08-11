import {
  candidatasDe,
  codigosParaBuscar,
  escolherTurma,
  ESTRATEGIA,
  extrairCodigoDoTitulo,
  normalizar,
  removerCodigo,
  tokensDoCodigo,
  TurmaCandidata,
} from './turma-match';

/** Uma linha do CSV Tabela_Disciplinas_Turmas. */
const turma = (
  id: number,
  codigoTurma: string,
  nomeDisciplina: string,
  codigoEad: string | null = null,
): TurmaCandidata => ({
  id,
  codigoTurma,
  nomeDisciplina,
  codigoEad,
  orgUnitId: null,
});

/**
 * O caso real que motivou o tier composto: TRES disciplinas sob o MESMO codigo
 * de turma. So o codigo da disciplina as separa.
 */
const HISTORIA = turma(
  1,
  'GSPS0I10227',
  'HISTÓRIA E CULTURA DO CORPO',
  'GSPS02EAD003',
);
const DANCA = turma(2, 'GSPS0I10227', 'DANÇA', 'GSPS02TP001');
const LUTAS = turma(3, 'GSPS0I10227', 'LUTAS', 'GSPS02TP002');

/** O `Code` composto que os enrollments entregam. */
const codeDe = (disciplina: string) =>
  `GSPS02_${disciplina}_GSPS0I10227_2026/1`;

describe('normalizar', () => {
  it('tira acento, caixa e pontuacao', () => {
    expect(normalizar('Gestão de Pessoas — ADM0142 ')).toBe(
      'gestao de pessoas adm0142',
    );
  });

  it('tolera nulo', () => {
    expect(normalizar(null)).toBe('');
    expect(normalizar(undefined)).toBe('');
  });
});

describe('tokensDoCodigo', () => {
  it('quebra o Code composto em tokens', () => {
    expect(tokensDoCodigo('GSPS02_GSPS02EAD003_GSPS0I10227_2026/1')).toEqual([
      'gsps02',
      'gsps02ead003',
      'gsps0i10227',
      '2026',
      '1',
    ]);
  });

  it('codigo simples vira um token so', () => {
    expect(tokensDoCodigo('GSPS0I10227')).toEqual(['gsps0i10227']);
  });

  it('vazio nao vira token vazio', () => {
    expect(tokensDoCodigo('')).toEqual([]);
    expect(tokensDoCodigo(null)).toEqual([]);
  });
});

describe('removerCodigo', () => {
  it('tira o codigo embutido no nome', () => {
    expect(
      removerCodigo('HISTÓRIA E CULTURA DO CORPO - GSPS0I10227', 'GSPS0I10227'),
    ).toBe('historia e cultura do corpo');
  });

  it('remove por TOKEN, nao por substring', () => {
    // "GSPS02" nao pode levar "GSPS02EAD003" junto.
    expect(removerCodigo('SAUDE GSPS02EAD003', 'GSPS02')).toBe(
      'saude gsps02ead003',
    );
  });

  it('aceita o Code composto e tira todos os tokens dele', () => {
    expect(removerCodigo('DANÇA GSPS0I10227', codeDe('GSPS02TP001'))).toBe(
      'danca',
    );
  });
});

describe('extrairCodigoDoTitulo', () => {
  it('extrai o codigo do fim do titulo (formato real do Brightspace)', () => {
    expect(
      extrairCodigoDoTitulo(
        'LABORATÓRIO DE REDES DE COMPUTADORES - GEE11I40254',
      ),
    ).toBe('GEE11I40254');
  });

  it('usa o ULTIMO trecho quando o nome tem hifen no meio', () => {
    expect(
      extrairCodigoDoTitulo('TEORIA E PRATICA - ESTAGIO - GSPS0I10227'),
    ).toBe('GSPS0I10227');
  });

  it('aceita travessao, nao so hifen', () => {
    expect(extrairCodigoDoTitulo('REDES – GEE11I40254')).toBe('GEE11I40254');
  });

  // As recusas importam mais que os acertos: um falso positivo viraria busca por
  // um codigo inexistente, e o aluno perderia a disciplina.
  it('recusa trecho com espaco, so numeros, so letras, ou sem separador', () => {
    expect(extrairCodigoDoTitulo('MATEMATICA - TURMA A')).toBeNull();
    expect(extrairCodigoDoTitulo('QUIMICA GERAL - 2')).toBeNull();
    expect(extrairCodigoDoTitulo('HISTORIA - NOTURNO')).toBeNull();
    expect(extrairCodigoDoTitulo('HISTORIA DO BRASIL')).toBeNull();
  });

  it('recusa hifen sem espacos (faz parte do nome)', () => {
    expect(extrairCodigoDoTitulo('PRÉ-CÁLCULO 2')).toBeNull();
  });

  it('tolera nulo e vazio', () => {
    expect(extrairCodigoDoTitulo(null)).toBeNull();
    expect(extrairCodigoDoTitulo('')).toBeNull();
  });
});

describe('codigosParaBuscar', () => {
  it('expande o Code composto em todos os tokens', () => {
    expect(codigosParaBuscar({ codigo: codeDe('GSPS02EAD003') })).toEqual([
      'GSPS02_GSPS02EAD003_GSPS0I10227_2026/1',
      'GSPS02',
      'GSPS02EAD003',
      'GSPS0I10227',
      '2026',
      '1',
    ]);
  });

  it('mantem o codigo INTEIRO — e o que casa com codigo que tem hifen', () => {
    // "E2E-PORTAL-TURMA-1" tokenizado viraria 4 palavras e nao acharia nada.
    expect(codigosParaBuscar({ codigo: 'ADM-0142' })).toContain('ADM-0142');
  });

  it('sem codigo, tenta o fim do titulo (label vazio deste tenant)', () => {
    expect(
      codigosParaBuscar({ codigo: '', titulo: 'REDES - GEE11I40254' }),
    ).toEqual(['GEE11I40254']);
  });
});

describe('escolherTurma', () => {
  describe('tier 0 — codigo composto', () => {
    it('separa tres disciplinas sob o MESMO codigo de turma', () => {
      const r = escolherTurma(
        {
          codigo: codeDe('GSPS02TP002'),
          titulo: 'LUTAS - GSPS0I10227',
          orgUnitId: '137953',
        },
        [HISTORIA, DANCA, LUTAS],
      );

      expect(r.situacao).toBe('ENCONTRADA');
      expect(r.situacao === 'ENCONTRADA' && r.turma.id).toBe(3);
      expect(r.situacao === 'ENCONTRADA' && r.estrategia).toBe(
        ESTRATEGIA.CODIGO_COMPOSTO,
      );
    });

    it('a disciplina decide mesmo quando o nome nao ajuda', () => {
      const r = escolherTurma(
        { codigo: codeDe('GSPS02TP001'), titulo: 'NOME QUE NAO BATE COM NADA' },
        [HISTORIA, DANCA, LUTAS],
      );

      expect(r.situacao === 'ENCONTRADA' && r.turma.id).toBe(2);
    });

    it('token nao casa por SUBSTRING', () => {
      // "GSPS02" existe dentro de "GSPS02EAD003"; por substring o prefixo do
      // curso passaria por codigo de disciplina.
      const parcial = turma(9, 'GSPS0I10227', 'OUTRA', 'GSPS02EAD');

      const r = escolherTurma(
        {
          codigo: codeDe('GSPS02EAD003'),
          titulo: 'HISTÓRIA E CULTURA DO CORPO',
        },
        [parcial, HISTORIA],
      );

      // Nao casa o composto do `parcial`; resolve o HISTORIA, que casa de fato.
      expect(r.situacao === 'ENCONTRADA' && r.turma.id).toBe(1);
    });
  });

  describe('tier 1/2 — codigo da turma, nome desempata', () => {
    it('libera quando ha uma turma so e o nome bate', () => {
      const r = escolherTurma(
        { codigo: 'GSPS0I10227', titulo: 'HISTÓRIA E CULTURA DO CORPO' },
        [HISTORIA],
      );

      expect(r.situacao).toBe('ENCONTRADA');
    });

    it('NAO libera quando o codigo bate mas o nome diverge', () => {
      // A trava que impede liberar a prova da disciplina errada.
      const r = escolherTurma(
        { codigo: 'GSPS0I10227', titulo: 'SAÚDE COLETIVA' },
        [HISTORIA],
      );

      expect(r.situacao).toBe('DIVERGENTE');
      expect(r.motivo).toMatch(/nome nao confere/);
    });

    it('desempata pelo nome quando o codigo se repete e nao ha disciplina', () => {
      const semEad = [
        turma(1, 'GSPS0I10227', 'HISTÓRIA E CULTURA DO CORPO'),
        turma(2, 'GSPS0I10227', 'DANÇA'),
      ];

      const r = escolherTurma(
        { codigo: 'GSPS0I10227', titulo: 'DANÇA - GSPS0I10227' },
        semEad,
      );

      expect(r.situacao === 'ENCONTRADA' && r.turma.id).toBe(2);
      expect(r.situacao === 'ENCONTRADA' && r.estrategia).toBe(
        ESTRATEGIA.CODIGO_E_NOME,
      );
    });

    it('empate no nome vira AMBIGUA, nao um vencedor arbitrario', () => {
      const iguais = [
        turma(1, 'GSPS0I10227', 'DANÇA'),
        turma(2, 'GSPS0I10227', 'DANÇA'),
      ];

      expect(
        escolherTurma({ codigo: 'GSPS0I10227', titulo: 'DANÇA' }, iguais)
          .situacao,
      ).toBe('AMBIGUA');
    });

    it('launch sem nome passa quando o codigo da uma turma so', () => {
      const r = escolherTurma({ codigo: 'GSPS0I10227', titulo: '' }, [
        HISTORIA,
      ]);

      expect(r.situacao === 'ENCONTRADA' && r.estrategia).toBe(
        ESTRATEGIA.CODIGO_UNICO,
      );
    });

    it('launch sem nome com codigo repetido vira AMBIGUA', () => {
      expect(
        escolherTurma({ codigo: 'GSPS0I10227', titulo: '' }, [HISTORIA, DANCA])
          .situacao,
      ).toBe('AMBIGUA');
    });
  });

  it('sem candidata nenhuma, diz que o codigo nao esta cadastrado', () => {
    const r = escolherTurma({ codigo: 'NAO-EXISTE1', titulo: 'X' }, []);

    expect(r.situacao).toBe('NAO_ENCONTRADA');
    expect(r.motivo).toMatch(/Nenhuma turma cadastrada/);
  });
});

describe('candidatasDe', () => {
  it('acha a linha pelo TOKEN do Code composto', () => {
    // Sem tokenizar, `WHERE codigoTurma = <Code composto>` nao acharia nada — e
    // toda disciplina viria dos enrollments como "sem prova".
    const r = candidatasDe({ codigo: codeDe('GSPS02EAD003') }, [
      HISTORIA,
      DANCA,
    ]);

    expect(r.map((c) => c.id)).toEqual([1, 2]);
  });

  it('acha pelo orgUnitId aprendido quando o codigo nao bate', () => {
    const aprendida = { ...HISTORIA, orgUnitId: '137951' };

    const r = candidatasDe({ codigo: 'GRAFIA-ERRADA1', orgUnitId: '137951' }, [
      aprendida,
      DANCA,
    ]);

    expect(r.map((c) => c.id)).toEqual([1]);
  });

  it('nao repete a linha que bate pelos dois criterios', () => {
    const aprendida = { ...HISTORIA, orgUnitId: '137951' };

    expect(
      candidatasDe({ codigo: 'GSPS0I10227', orgUnitId: '137951' }, [aprendida]),
    ).toHaveLength(1);
  });
});
