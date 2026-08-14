import {
  candidatasARenomeacao,
  chaveDoVinculo,
  compararCurso,
  SEMELHANCA,
} from './curso-renomeado';

describe('compararCurso', () => {
  it('reconhece mudanca so de caixa, acento e pontuacao', () => {
    expect(compararCurso('PSICOLOGIA', 'Psicologia')).toBe(
      SEMELHANCA.IDENTICO_NORMALIZADO,
    );
    expect(compararCurso('FARMACIA', 'Farmácia')).toBe(
      SEMELHANCA.IDENTICO_NORMALIZADO,
    );
    expect(compararCurso('  Ciencias  Contabeis ', 'CIENCIAS CONTABEIS')).toBe(
      SEMELHANCA.IDENTICO_NORMALIZADO,
    );
  });

  it('reconhece o mesmo curso com palavras a mais', () => {
    // O caso que motivou o modulo.
    expect(compararCurso('Psicologia — Bacharelado', 'PSICOLOGIA')).toBe(
      SEMELHANCA.TOKENS_CONTIDOS,
    );
  });

  it('nao depende da ordem das palavras', () => {
    expect(compararCurso('Bacharelado em Psicologia', 'Psicologia')).toBe(
      SEMELHANCA.TOKENS_CONTIDOS,
    );
  });

  it('NAO casa dois cursos distintos que compartilham uma palavra', () => {
    expect(
      compararCurso('ENGENHARIA CIVIL', 'ENGENHARIA DE PRODUCAO'),
    ).toBeUndefined();
    expect(
      compararCurso('CIENCIA DA COMPUTACAO', 'CIENCIAS CONTABEIS'),
    ).toBeUndefined();
  });

  it('NAO casa cursos parecidos letra a letra', () => {
    // Sem distancia de edicao de proposito: sao 2 letras de diferenca e sao
    // cursos diferentes.
    expect(
      compararCurso('ENGENHARIA CIVIL', 'ENGENHARIA QUIMICA'),
    ).toBeUndefined();
  });

  it('compara por TOKEN, nunca por substring', () => {
    // "adm" esta dentro de "administracao"; por substring isto casaria.
    expect(compararCurso('ADM', 'ADMINISTRACAO')).toBeUndefined();
  });

  it('exige tamanho minimo no menor dos nomes', () => {
    expect(compararCurso('TI', 'TI APLICADA A GESTAO')).toBeUndefined();
  });

  it('trata vazio como nao comparavel', () => {
    expect(compararCurso('', 'PSICOLOGIA')).toBeUndefined();
    expect(compararCurso('PSICOLOGIA', '   ')).toBeUndefined();
  });
});

describe('candidatasARenomeacao', () => {
  const PSICOLOGIA = { id: 1, curso: 'PSICOLOGIA' };
  const PEDAGOGIA = { id: 2, curso: 'PEDAGOGIA' };

  const nenhumNoArquivo = () => false;

  it('aponta o vinculo orfao com grafia parecida', () => {
    const candidatas = candidatasARenomeacao(
      'Psicologia — Bacharelado',
      [PSICOLOGIA, PEDAGOGIA],
      nenhumNoArquivo,
    );

    expect(candidatas).toEqual([
      { vinculo: PSICOLOGIA, semelhanca: SEMELHANCA.TOKENS_CONTIDOS },
    ]);
  });

  it('IGNORA o vinculo que continua no arquivo — ai sao dois cursos de verdade', () => {
    // "PSICOLOGIA" e "Psicologia — Bacharelado" nas duas linhas do mesmo
    // arquivo: a planilha esta dizendo que sao dois vinculos, nao um renomeado.
    const candidatas = candidatasARenomeacao(
      'Psicologia — Bacharelado',
      [PSICOLOGIA, PEDAGOGIA],
      (v) => v.id === PSICOLOGIA.id,
    );

    expect(candidatas).toEqual([]);
  });

  it('devolve TODAS as candidatas em vez de escolher uma', () => {
    const outraGrafia = { id: 3, curso: 'Psicologia' };

    const candidatas = candidatasARenomeacao(
      'PSICOLOGIA',
      [PSICOLOGIA, outraGrafia],
      nenhumNoArquivo,
    );

    expect(candidatas).toHaveLength(2);
  });

  it('nao reporta nada quando o RA nao tem vinculo parecido', () => {
    expect(
      candidatasARenomeacao('ENFERMAGEM', [PEDAGOGIA], nenhumNoArquivo),
    ).toEqual([]);
  });
});

describe('chaveDoVinculo', () => {
  it('normaliza so a matricula, como o import faz', () => {
    expect(chaveDoVinculo('uc25426847', 'PSICOLOGIA')).toBe(
      'UC25426847\u0000PSICOLOGIA',
    );
  });

  it('distingue grafias diferentes do mesmo curso', () => {
    expect(chaveDoVinculo('UC1', 'PSICOLOGIA')).not.toBe(
      chaveDoVinculo('UC1', 'Psicologia'),
    );
  });
});
