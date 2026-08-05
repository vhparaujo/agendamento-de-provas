import {
  compararNomes,
  escolherTurma,
  extrairCodigoDoTitulo,
  normalizarCodigo,
  normalizarNome,
  TIPO_MATCH,
  TurmaCandidata,
} from './turma-match';

/** Linhas reais do CSV Tabela_Disciplinas_Turmas. */
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
  curso: null,
});

const HISTORIA = turma(
  1,
  'GSPS0I10227',
  'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
  '1-GSPS02EAD003',
);

describe('normalizarNome', () => {
  it('tira acento e sobe para maiusculas', () => {
    expect(normalizarNome('Nutrição Clínica')).toBe('NUTRICAO CLINICA');
  });

  it('remove o codigo de dentro do nome', () => {
    // O CSV traz "NOME (1-GSPS02EAD003)"; o Brightspace, "NOME - GSPS0I10227".
    // Sem remover, os dois nunca casariam.
    expect(
      normalizarNome(
        'HISTÓRIA E CULTURA DO CORPO (1-GSPS02EAD003)',
        '1-GSPS02EAD003',
      ),
    ).toBe('HISTORIA E CULTURA DO CORPO');

    expect(
      normalizarNome(
        'HISTÓRIA E CULTURA DO CORPO - GSPS0I10227',
        'GSPS0I10227',
      ),
    ).toBe('HISTORIA E CULTURA DO CORPO');
  });

  it('colapsa pontuacao e espacos', () => {
    expect(normalizarNome('PRÁTICAS  PROFISSIONAIS -- E  ÉTICA')).toBe(
      'PRATICAS PROFISSIONAIS E ETICA',
    );
  });
});

describe('normalizarCodigo', () => {
  it('apara espacos e sobe a caixa', () => {
    expect(normalizarCodigo('  gsps0i10227 ')).toBe('GSPS0I10227');
  });

  it('trata ausencia como vazio', () => {
    expect(normalizarCodigo(null)).toBe('');
  });
});

describe('compararNomes', () => {
  it('reconhece nomes iguais a menos de acento e caixa', () => {
    expect(compararNomes('Saúde Coletiva', 'SAUDE COLETIVA')).toBe(
      TIPO_MATCH.EXATO,
    );
  });

  it('reconhece o mesmo nome com e sem o codigo colado', () => {
    expect(
      compararNomes(
        'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO - GSPS0I10227',
        'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO (1-GSPS02EAD003)',
        'GSPS0I10227',
        '1-GSPS02EAD003',
      ),
    ).toBe(TIPO_MATCH.EXATO);
  });

  it('aceita nome truncado como parcial', () => {
    expect(
      compararNomes(
        'PRATICA PROFISSIONAL',
        'PRATICA PROFISSIONAL E ETICA EM NUTRICAO',
      ),
    ).toBe(TIPO_MATCH.PARCIAL);
  });

  it('RECUSA match frouxo por nome curto demais', () => {
    // "ADM" cabe dentro de dezenas de disciplinas; aceitar seria pegar a errada
    expect(compararNomes('ADM', 'ADMINISTRACAO FINANCEIRA')).toBeNull();
  });

  it('recusa nomes diferentes', () => {
    expect(compararNomes('SAUDE COLETIVA', 'NUTRICAO CLINICA')).toBeNull();
  });

  it('recusa quando um dos lados fica vazio apos normalizar', () => {
    expect(
      compararNomes('GSPS0I10227', 'SAUDE COLETIVA', 'GSPS0I10227'),
    ).toBeNull();
  });
});

describe('escolherTurma', () => {
  it('nao encontra quando nao ha candidata', () => {
    const r = escolherTurma({ codigo: 'XPTO', titulo: 'QUALQUER' }, []);

    expect(r.situacao).toBe('NAO_ENCONTRADA');
    expect(r.motivo).toMatch(/XPTO/);
  });

  it('resolve a candidata unica com nome batendo', () => {
    const r = escolherTurma(
      {
        codigo: 'GSPS0I10227',
        titulo: 'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
      },
      [HISTORIA],
    );

    expect(r).toMatchObject({ situacao: 'ENCONTRADA', tipoMatch: 'exato' });
  });

  it('DIVERGENTE quando o codigo bate mas o nome nao — nao libera', () => {
    const r = escolherTurma(
      { codigo: 'GSPS0I10227', titulo: 'SAÚDE COLETIVA' },
      [HISTORIA],
    );

    expect(r.situacao).toBe('DIVERGENTE');
    expect(r.motivo).toMatch(/nome nao confere/);
  });

  it('desempata pelo nome quando o codigo tem varias turmas', () => {
    // O caso que a regra existe para resolver: mesmo codigo em ofertas distintas
    const candidatas = [
      turma(1, 'GSPS0N10225', 'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO'),
      turma(2, 'GSPS0N10225', 'SAÚDE COLETIVA'),
    ];

    const r = escolherTurma(
      { codigo: 'GSPS0N10225', titulo: 'SAÚDE COLETIVA' },
      candidatas,
    );

    expect(r).toMatchObject({ situacao: 'ENCONTRADA' });
    if (r.situacao === 'ENCONTRADA') expect(r.turma.id).toBe(2);
  });

  it('o match EXATO vence o parcial — evidencia melhor, nao desempate', () => {
    const candidatas = [
      turma(1, 'X1', 'NUTRICAO'),
      turma(2, 'X1', 'NUTRICAO CLINICA'),
    ];

    const r = escolherTurma(
      { codigo: 'X1', titulo: 'NUTRICAO CLINICA' },
      candidatas,
    );

    expect(r).toMatchObject({ situacao: 'ENCONTRADA', tipoMatch: 'exato' });
    if (r.situacao === 'ENCONTRADA') expect(r.turma.id).toBe(2);
  });

  it('AMBIGUA quando duas batem no mesmo nivel — nao chuta', () => {
    const candidatas = [
      turma(1, 'X1', 'SAÚDE COLETIVA'),
      turma(2, 'X1', 'SAUDE COLETIVA'),
    ];

    const r = escolherTurma(
      { codigo: 'X1', titulo: 'SAÚDE COLETIVA' },
      candidatas,
    );

    expect(r.situacao).toBe('AMBIGUA');
  });

  it('NAO_ENCONTRADA quando varias tem o codigo e nenhuma o nome', () => {
    const candidatas = [
      turma(1, 'X1', 'SAÚDE COLETIVA'),
      turma(2, 'X1', 'NUTRICAO CLINICA'),
    ];

    const r = escolherTurma({ codigo: 'X1', titulo: 'BIOQUIMICA' }, candidatas);

    expect(r.situacao).toBe('NAO_ENCONTRADA');
    expect(r.motivo).toMatch(/grafia/);
  });

  describe('launch sem nome de disciplina', () => {
    it('aceita quando ha uma unica turma com o codigo', () => {
      const r = escolherTurma({ codigo: 'GSPS0I10227' }, [HISTORIA]);

      expect(r).toMatchObject({ situacao: 'ENCONTRADA', tipoMatch: null });
    });

    it('recusa quando ha mais de uma', () => {
      const r = escolherTurma({ codigo: 'X1' }, [
        turma(1, 'X1', 'A DISCIPLINA'),
        turma(2, 'X1', 'OUTRA DISCIPLINA'),
      ]);

      expect(r.situacao).toBe('AMBIGUA');
    });
  });

  /**
   * O tenant da UCB manda `context.label` VAZIO e o codigo grudado no fim do
   * titulo. Sem extrair dali, todo launch real termina em "o launch nao trouxe
   * codigo de turma para procurar" — foi o que aconteceu em 04/08/2026.
   */
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

    it('sobe para maiusculas', () => {
      expect(extrairCodigoDoTitulo('REDES - gee11i40254')).toBe('GEE11I40254');
    });

    // As recusas importam mais que os acertos: um falso positivo aqui viraria
    // busca por um codigo que nao existe, e o aluno perderia a disciplina.
    it('recusa trecho com espaco ("TURMA A" nao e codigo)', () => {
      expect(extrairCodigoDoTitulo('MATEMATICA - TURMA A')).toBeNull();
    });

    it('recusa trecho so de numeros', () => {
      expect(extrairCodigoDoTitulo('QUIMICA GERAL - 2')).toBeNull();
    });

    it('recusa trecho so de letras', () => {
      expect(extrairCodigoDoTitulo('HISTORIA - NOTURNO')).toBeNull();
    });

    it('recusa titulo sem separador', () => {
      expect(extrairCodigoDoTitulo('HISTORIA DO BRASIL')).toBeNull();
    });

    it('recusa hifen sem espacos (faz parte do nome)', () => {
      expect(extrairCodigoDoTitulo('LUSO-BRASILEIRA 2')).toBeNull();
    });

    it('tolera nulo e vazio', () => {
      expect(extrairCodigoDoTitulo(null)).toBeNull();
      expect(extrairCodigoDoTitulo('')).toBeNull();
    });
  });
});
