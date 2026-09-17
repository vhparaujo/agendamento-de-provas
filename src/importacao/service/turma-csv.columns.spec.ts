import { mapRowToTurma, separarDisciplina } from './turma-csv.columns';

/** Uma linha como o `lerCsv` entrega: cabecalho -> valor, tudo string. */
const linha = (campos: Record<string, string>) => campos;

const BASE = {
  Curso: 'NUTRIÇÃO',
  'Código da Turma': 'GSPS0I10259',
  'Disciplina / Código EAD':
    'PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO (1-GSPS06EAD003)',
};

describe('separarDisciplina', () => {
  it('separa nome e codigo da disciplina, SEM o prefixo do sistema de origem', () => {
    // O "1-" nao aparece no `Code` do Brightspace: mante-lo faria o token nunca
    // casar no tier composto.
    expect(separarDisciplina('SAÚDE COLETIVA (1-GSPS01EAD048)')).toEqual({
      nome: 'SAÚDE COLETIVA',
      codigoEad: 'GSPS01EAD048',
    });
  });

  it('funciona igual sem o prefixo numerico', () => {
    expect(separarDisciplina('SAÚDE COLETIVA (GSPS01EAD048)')).toEqual({
      nome: 'SAÚDE COLETIVA',
      codigoEad: 'GSPS01EAD048',
    });
  });

  describe('recusas — o nome fica INTACTO', () => {
    it('miolo que nao parece codigo', () => {
      for (const celula of [
        'EDUCAÇÃO FÍSICA (TURMA A)', // tem espaco
        'EDUCAÇÃO FÍSICA (2026)', // sem letra
        'EDUCAÇÃO FÍSICA (EAD)', // sem numero
      ]) {
        expect(separarDisciplina(celula)).toEqual({
          nome: celula,
          codigoEad: null,
        });
      }
    });

    it('parentese no MEIO nao e sufixo', () => {
      expect(separarDisciplina('QUÍMICA (GSPS01EAD048) NOTURNO')).toEqual({
        nome: 'QUÍMICA (GSPS01EAD048) NOTURNO',
        codigoEad: null,
      });
    });

    it('so o parentese: o nome ficaria vazio', () => {
      expect(separarDisciplina('(GSPS01EAD048)')).toEqual({
        nome: '(GSPS01EAD048)',
        codigoEad: null,
      });
    });

    it('celula sem parentese nenhum', () => {
      expect(separarDisciplina('SAÚDE COLETIVA')).toEqual({
        nome: 'SAÚDE COLETIVA',
        codigoEad: null,
      });
    });
  });
});

describe('mapRowToTurma', () => {
  it('le a planilha da administracao', () => {
    expect(mapRowToTurma(linha(BASE))).toEqual({
      ok: true,
      turma: {
        codigoTurma: 'GSPS0I10259',
        nomeDisciplina: 'PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO',
        codigoEad: 'GSPS06EAD003',
      },
    });
  });

  it('descarta o codigo da disciplina quando ele e IGUAL ao da turma', () => {
    // "Nome (CODIGO)" e o caso antigo, que o `removerCodigo` do match ja
    // resolve. Guardar os dois iguais faria o tier composto casar consigo mesmo.
    const r = mapRowToTurma(
      linha({
        ...BASE,
        'Disciplina / Código EAD': 'NUTRIÇÃO CLÍNICA (GSPS0I10259)',
      }),
    );

    expect(r.ok === true && r.turma.codigoEad).toBeNull();
    expect(r.ok === true && r.turma.nomeDisciplina).toBe('NUTRIÇÃO CLÍNICA');
  });

  it('sobe o codigo da turma para maiusculas', () => {
    const r = mapRowToTurma(
      linha({ ...BASE, 'Código da Turma': 'gsps0i10259' }),
    );

    expect(r.ok === true && r.turma.codigoTurma).toBe('GSPS0I10259');
  });

  it('ignora a coluna Curso — turma nao pertence a um curso', () => {
    const r = mapRowToTurma(linha(BASE));

    expect(r.ok === true && r.turma).not.toHaveProperty('curso');
  });

  describe('recusas', () => {
    it('rejeita com motivo quando falta o codigo da turma', () => {
      const r = mapRowToTurma(linha({ ...BASE, 'Código da Turma': '' }));

      expect(r.ok).toBe(false);
      expect(r.ok === false && r.motivo).toMatch(/código da turma/);
    });

    it('rejeita com motivo quando falta a disciplina', () => {
      const r = mapRowToTurma(
        linha({ ...BASE, 'Disciplina / Código EAD': '' }),
      );

      expect(r.ok).toBe(false);
    });
  });
});
