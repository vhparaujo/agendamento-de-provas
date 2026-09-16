import { TipoMatchQuiz } from '../../generated/prisma/client';
import {
  CAMPOS_DO_CORPO_DO_QUIZ,
  casarPorNome,
  converterBlocoDeTexto,
  jaPreparado,
  montarCorpoDoPreparo,
  montarCorpoDoQuiz,
  paraRichTextInput,
  QuizLido,
} from './quiz-body';

/** Um quiz "cheio", como o GET devolve, para o corpo sair completo. */
function quizLido(sobrepor: Partial<QuizLido> = {}): QuizLido {
  return {
    QuizId: 4242,
    Name: 'Avaliacao: Prova Final',
    Password: 'senha-antiga',
    IsActive: true,
    StartDate: '2026-09-16T11:30:00.000Z',
    EndDate: '2026-09-16T14:30:00.000Z',
    DueDate: null,
    SortOrder: 3,
    AutoExportToGrades: true,
    GradeItemId: 91,
    IsAutoSetGraded: false,
    Instructions: {
      Text: { Text: 'Leia com calma', Html: null },
      IsDisplayed: true,
    },
    Description: {
      Text: { Text: null, Html: '<p>Prova</p>' },
      IsDisplayed: false,
    },
    Header: null,
    Footer: null,
    AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 3 },
    DisplayInCalendar: true,
    LateSubmissionInfo: { LateSubmissionOption: 0, LateLimitMinutes: null },
    SubmissionTimeLimit: {
      IsEnforced: true,
      ShowClock: true,
      TimeLimitValue: 180,
    },
    SubmissionGracePeriod: 5,
    AllowHints: false,
    DisableRightClick: true,
    DisablePagerAndAlerts: false,
    NotificationEmail: null,
    CalcTypeId: 1,
    RestrictIPAddressRange: null,
    CategoryId: null,
    PreventMovingBackwards: true,
    Shuffle: false,
    AllowOnlyUsersWithSpecialAccess: false,
    IsRetakeIncorrectOnly: false,
    PagingTypeId: 2,
    IsSynchronous: false,
    DeductionPercentage: 0,
    HideQuestionPoints: false,
    IsSingleSession: true,
    ...sobrepor,
  };
}

describe('paraRichTextInput', () => {
  it('prefere o Html quando ele existe: e o conteudo COM formatacao', () => {
    expect(paraRichTextInput({ Text: 'cru', Html: '<b>rico</b>' })).toEqual({
      Content: '<b>rico</b>',
      Type: 'Html',
    });
  });

  it('cai no Text quando o Html vem nulo ou vazio', () => {
    expect(paraRichTextInput({ Text: 'cru', Html: null })).toEqual({
      Content: 'cru',
      Type: 'Text',
    });
    expect(paraRichTextInput({ Text: 'cru', Html: '' })).toEqual({
      Content: 'cru',
      Type: 'Text',
    });
  });

  it('aceita string solta e preserva o nulo', () => {
    expect(paraRichTextInput('solto')).toEqual({
      Content: 'solto',
      Type: 'Text',
    });
    expect(paraRichTextInput(null)).toBeNull();
    expect(paraRichTextInput(undefined)).toBeNull();
  });
});

describe('converterBlocoDeTexto', () => {
  it('IsDisplayed ausente vira true — mandar undefined sumiria com o bloco', () => {
    expect(converterBlocoDeTexto({ Text: { Text: 'oi' } })).toEqual({
      Text: { Content: 'oi', Type: 'Text' },
      IsDisplayed: true,
    });
  });

  it('preserva IsDisplayed false', () => {
    expect(
      converterBlocoDeTexto({ Text: { Text: 'oi' }, IsDisplayed: false }),
    ).toEqual({ Text: { Content: 'oi', Type: 'Text' }, IsDisplayed: false });
  });

  it('bloco nulo continua nulo', () => {
    expect(converterBlocoDeTexto(null)).toBeNull();
  });
});

describe('montarCorpoDoQuiz', () => {
  /**
   * ==========================================================================
   * O TESTE MAIS IMPORTANTE DO ARQUIVO
   * ==========================================================================
   * O PUT SUBSTITUI o objeto inteiro: campo que nao volta no corpo e campo
   * APAGADO, sem erro nenhum. Sem esta comparacao contra a lista congelada, uma
   * refatoracao distraida zeraria `SubmissionTimeLimit` ou `EndDate` em TODA
   * prova do CSV, e a descoberta seria no dia.
   */
  it('produz exatamente os campos congelados em CAMPOS_DO_CORPO_DO_QUIZ', () => {
    const corpo = montarCorpoDoQuiz(quizLido(), 'nova');
    expect(Object.keys(corpo).sort()).toEqual(
      [...CAMPOS_DO_CORPO_DO_QUIZ].sort(),
    );
  });

  it('sobrescreve SO a senha e preserva o resto verbatim', () => {
    const lido = quizLido();
    const corpo = montarCorpoDoQuiz(lido, 'manha1609');

    expect(corpo.Password).toBe('manha1609');

    // As datas sao o que este lote NAO pode mover — saem como vieram.
    expect(corpo.StartDate).toBe(lido.StartDate);
    expect(corpo.EndDate).toBe(lido.EndDate);
    expect(corpo.DueDate).toBe(lido.DueDate);

    // Objetos que apenas trafegam continuam sendo o MESMO valor.
    expect(corpo.SubmissionTimeLimit).toBe(lido.SubmissionTimeLimit);
    expect(corpo.LateSubmissionInfo).toBe(lido.LateSubmissionInfo);
    expect(corpo.Name).toBe(lido.Name);
    expect(corpo.IsSingleSession).toBe(true);
  });

  it('nunca deixa a senha antiga vazar para o corpo', () => {
    const corpo = montarCorpoDoQuiz(
      quizLido({ Password: 'segredo-do-turno' }),
      'nova',
    );
    expect(JSON.stringify(corpo)).not.toContain('segredo-do-turno');
  });

  describe('a janela da prova (lote de DATAS)', () => {
    const JANELA = {
      inicio: '2026-08-26T18:00:00.000Z',
      fim: '2026-08-26T21:00:00.000Z',
    };

    it('com janela, produz os MESMOS campos congelados', () => {
      const corpo = montarCorpoDoQuiz(quizLido(), 'nova', JANELA);
      expect(Object.keys(corpo).sort()).toEqual(
        [...CAMPOS_DO_CORPO_DO_QUIZ].sort(),
      );
    });

    it('troca StartDate e EndDate, e preserva DueDate', () => {
      const lido = quizLido({ DueDate: '2026-09-20T02:59:00.000Z' });
      const corpo = montarCorpoDoQuiz(lido, 'nova', JANELA);

      expect(corpo.StartDate).toBe(JANELA.inicio);
      expect(corpo.EndDate).toBe(JANELA.fim);
      // O cliente pediu abertura e fechamento. Mover o prazo de entrega sem
      // pedido mudaria a nota de quem entregou atrasado.
      expect(corpo.DueDate).toBe(lido.DueDate);
    });

    it('passa a janela VERBATIM: nao reformata a ISO recebida', () => {
      // A conversao fuso -> UTC vive em `instanteUtcDe`, com teste. Um
      // `new Date(x).toISOString()` aqui seria uma segunda chance de mover a
      // data em silencio.
      const corpo = montarCorpoDoQuiz(quizLido(), 'nova', JANELA);

      expect(corpo.StartDate).toBe('2026-08-26T18:00:00.000Z');
      expect(corpo.EndDate).toBe('2026-08-26T21:00:00.000Z');
    });

    it('sem janela, o calendario lido sai intacto', () => {
      const lido = quizLido();
      const corpo = montarCorpoDoQuiz(lido, 'nova');

      expect(corpo.StartDate).toBe(lido.StartDate);
      expect(corpo.EndDate).toBe(lido.EndDate);
    });

    it('a janela nao mexe em mais nada do corpo', () => {
      const lido = quizLido();
      const semJanela = montarCorpoDoQuiz(lido, 'nova');
      const comJanela = montarCorpoDoQuiz(lido, 'nova', JANELA);

      for (const campo of CAMPOS_DO_CORPO_DO_QUIZ) {
        if (campo === 'StartDate' || campo === 'EndDate') continue;
        expect(comJanela[campo]).toEqual(semJanela[campo]);
      }
    });
  });

  /**
   * ==========================================================================
   * A TRAVA CONTRA O APAGAMENTO SILENCIOSO DA SENHA
   * ==========================================================================
   * O `QuizReadData` so expoe `Password` se ele for "nao nulo E visivel ao
   * contexto do chamador" — ou seja, o GET pode devolver `Password: null` num
   * questionario QUE TEM SENHA.
   *
   * O caminho obvio para o lote de datas seria preservar a leitura
   * (`Password: quiz.Password`), que e o que o CLI de origem
   * `brightspace-change-dates` faz. Com um GET nulo, isso APAGARIA a senha de
   * toda prova do CSV de uma vez, sem erro nenhum, descoberto no dia.
   *
   * Por isso `novaSenha` e obrigatoria nos DOIS lotes: o de datas le a senha da
   * GRADE (`SenhaDeProva`) e a define, em vez de confiar na leitura. Estes
   * testes existem para que reintroduzir a preservacao quebre o build.
   */
  describe('a senha NUNCA e preservada da leitura', () => {
    it('GET com Password nulo + janela: a senha da grade e gravada mesmo assim', () => {
      const corpo = montarCorpoDoQuiz(quizLido({ Password: null }), 'tarde42', {
        inicio: '2026-08-26T18:00:00.000Z',
        fim: '2026-08-26T21:00:00.000Z',
      });

      expect(corpo.Password).toBe('tarde42');
    });

    it('GET com Password ausente tambem grava a senha da grade', () => {
      const lido = quizLido();
      delete lido.Password;

      expect(montarCorpoDoQuiz(lido, 'tarde42').Password).toBe('tarde42');
    });

    it('o corpo NUNCA sai com Password nulo ou indefinido', () => {
      for (const lido of [
        quizLido(),
        quizLido({ Password: null }),
        quizLido({ Password: '' }),
      ]) {
        const corpo = montarCorpoDoQuiz(lido, 'senha-nova');
        expect(corpo.Password).toBe('senha-nova');
      }
    });
  });

  describe('AttemptsAllowed: aninhado na leitura, achatado na escrita', () => {
    it('achata o valor aninhado', () => {
      const corpo = montarCorpoDoQuiz(
        quizLido({
          AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 7 },
        }),
        'x',
      );
      expect(corpo.NumberOfAttemptsAllowed).toBe(7);
      expect(corpo).not.toHaveProperty('AttemptsAllowed');
    });

    it('cai no campo ja achatado quando o aninhado nao traz o numero', () => {
      const corpo = montarCorpoDoQuiz(
        quizLido({
          AttemptsAllowed: { IsUnlimited: true, NumberOfAttemptsAllowed: null },
          NumberOfAttemptsAllowed: 2,
        }),
        'x',
      );
      expect(corpo.NumberOfAttemptsAllowed).toBe(2);
    });

    it('sem AttemptsAllowed nenhum, usa o campo achatado', () => {
      const corpo = montarCorpoDoQuiz(
        quizLido({ AttemptsAllowed: null, NumberOfAttemptsAllowed: 1 }),
        'x',
      );
      expect(corpo.NumberOfAttemptsAllowed).toBe(1);
    });
  });

  it('converte os quatro blocos de texto para o formato de escrita', () => {
    const corpo = montarCorpoDoQuiz(quizLido(), 'x');

    expect(corpo.Instructions).toEqual({
      Text: { Content: 'Leia com calma', Type: 'Text' },
      IsDisplayed: true,
    });
    expect(corpo.Description).toEqual({
      Text: { Content: '<p>Prova</p>', Type: 'Html' },
      IsDisplayed: false,
    });
    expect(corpo.Header).toBeNull();
    expect(corpo.Footer).toBeNull();
  });
});

describe('casarPorNome', () => {
  const quizzes = [
    { Name: 'Prova N1' },
    { Name: 'Prova N2' },
    { Name: 'Simulado' },
    { Name: '  Avaliacao: Prova Final  ' },
  ];
  const nome = (q: { Name: string }) => q.Name;

  it('EXATO ignora espaco nas pontas dos dois lados', () => {
    expect(
      casarPorNome(
        quizzes,
        nome,
        ' Avaliacao: Prova Final ',
        TipoMatchQuiz.EXATO,
      ),
    ).toEqual([{ Name: '  Avaliacao: Prova Final  ' }]);
  });

  it('EXATO nao casa nome parecido', () => {
    expect(casarPorNome(quizzes, nome, 'Prova', TipoMatchQuiz.EXATO)).toEqual(
      [],
    );
  });

  /**
   * O comportamento aceito e o risco assumido, no mesmo teste: um alvo generico
   * alcanca as duas provas (desejado) e passaria perto do simulado.
   */
  it('CONTEM casa VARIOS quizzes e ignora caixa', () => {
    expect(
      casarPorNome(quizzes, nome, 'prova n', TipoMatchQuiz.CONTEM),
    ).toEqual([{ Name: 'Prova N1' }, { Name: 'Prova N2' }]);
  });

  it('nome ausente nao quebra o casamento', () => {
    const comNulo = [{ Name: null }, { Name: 'Prova N1' }];
    expect(
      casarPorNome(comNulo, (q) => q.Name, 'Prova N1', TipoMatchQuiz.EXATO),
    ).toEqual([{ Name: 'Prova N1' }]);
  });
});

describe('montarCorpoDoPreparo', () => {
  it('produz exatamente os campos congelados — nenhum a mais, nenhum a menos', () => {
    const corpo = montarCorpoDoPreparo(quizLido(), 'nova');
    expect(Object.keys(corpo).sort()).toEqual(
      [...CAMPOS_DO_CORPO_DO_QUIZ].sort(),
    );
  });

  it('apaga as datas, restringe a special access e define a senha', () => {
    const lido = quizLido();
    const corpo = montarCorpoDoPreparo(lido, 'manha1609');

    expect(corpo.StartDate).toBeNull();
    expect(corpo.EndDate).toBeNull();
    expect(corpo.AllowOnlyUsersWithSpecialAccess).toBe(true);
    expect(corpo.Password).toBe('manha1609');

    // O resto sai como veio: o prazo de entrega e o tempo sao outra pergunta.
    expect(corpo.DueDate).toBe(lido.DueDate);
    expect(corpo.SubmissionTimeLimit).toBe(lido.SubmissionTimeLimit);
    expect(corpo.Name).toBe(lido.Name);
  });
});

describe('jaPreparado', () => {
  it('so quando esta restrito E sem as duas datas', () => {
    expect(
      jaPreparado(
        quizLido({
          AllowOnlyUsersWithSpecialAccess: true,
          StartDate: null,
          EndDate: null,
        }),
      ),
    ).toBe(true);

    expect(
      jaPreparado(quizLido({ AllowOnlyUsersWithSpecialAccess: true })),
    ).toBe(false);
    expect(jaPreparado(quizLido({ StartDate: null, EndDate: null }))).toBe(
      false,
    );
  });
});
