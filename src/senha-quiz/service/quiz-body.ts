import { TipoMatchQuiz } from '../../generated/prisma/client';

/**
 * ============================================================================
 * O CORPO DO PUT DE QUIZ — e por que ele remonta o objeto INTEIRO
 * ============================================================================
 *
 * A API de quizzes da Valence NAO faz patch parcial. `PUT .../quizzes/{id}`
 * SUBSTITUI o objeto: **campo que nao volta no corpo e campo APAGADO**. O fluxo
 * e sempre GET -> troca so `Password` -> PUT com tudo de volta.
 *
 * Isso torna este arquivo o de maior impacto do recurso. Um campo esquecido aqui
 * nao da erro nenhum: ele zera `EndDate`, `SubmissionTimeLimit` ou as instrucoes
 * de TODA prova do CSV, e a descoberta acontece no dia. Por isso existe
 * `CAMPOS_DO_CORPO_DO_QUIZ` e o teste que compara as chaves produzidas contra
 * essa lista congelada.
 *
 * SAO DOIS CAMPOS MUTAVEIS, e nao um (25/08/2026). Ate aqui o modulo so trocava
 * `Password` e preservava o calendario verbatim; agora o lote de DATAS tambem
 * troca `StartDate`/`EndDate`.
 *
 * ⚠️ **MAS `novaSenha` CONTINUA OBRIGATORIA, inclusive no lote de datas — e essa
 * e a decisao mais importante deste arquivo.** O caminho obvio seria o lote de
 * datas preservar a senha lida (`Password: quiz.Password`), que e o que o CLI de
 * origem faz. Ele nao pode:
 *
 *   O `QuizReadData` so expoe `Password` se ele for "nao nulo E visivel ao
 *   contexto do chamador". Ou seja, um GET pode devolver `Password: null` num
 *   questionario QUE TEM SENHA. Preservar esse nulo APAGARIA a senha de toda
 *   prova da instituicao — sem erro nenhum, descoberto no dia, com os alunos
 *   entrando sem senha. E o risco que o comentario de `comSenhaLida` (em
 *   `schema.prisma`) ja registrava sobre o CLI de origem.
 *
 * Por isso o lote de datas le a senha da GRADE (`SenhaDeProva`, a fonte
 * autoritativa em texto claro) e a define junto com a janela, em vez de
 * confiar na leitura. `montarCorpoDoQuiz` nunca preserva senha: ou o chamador
 * sabe qual e, ou nao ha PUT.
 *
 * `DueDate` continua PRESERVADO. O cliente pediu abertura e fechamento; o prazo
 * de entrega e outra data, e move-lo sem pedido seria mudar a nota de quem
 * entregou atrasado.
 *
 * Duas conversoes entre leitura e escrita sao OBRIGATORIAS, e nenhuma delas e
 * obvia lendo so a documentacao:
 *
 *  1. `AttemptsAllowed: { IsUnlimited, NumberOfAttemptsAllowed }` na LEITURA vira
 *     `NumberOfAttemptsAllowed` ACHATADO na escrita;
 *  2. `RichText { Text, Html }` na leitura vira `RichTextInput { Content, Type }`
 *     na escrita — dentro dos blocos Description/Instructions/Header/Footer, que
 *     tem a forma `{ Text, IsDisplayed }` nos dois lados.
 *
 * Portado de brightspace-change-passwords/src/updatePasswords.js.
 */

/** RichText como a LEITURA devolve. */
export interface RichTextLeitura {
  Text?: string | null;
  Html?: string | null;
}

/** RichTextInput como a ESCRITA espera. */
export interface RichTextInput {
  Content: string;
  Type: 'Text' | 'Html';
}

/** Bloco de texto do quiz na leitura. */
export interface BlocoDeTextoLeitura {
  Text?: RichTextLeitura | string | null;
  IsDisplayed?: boolean;
}

/** Bloco de texto do quiz na escrita. */
export interface BlocoDeTextoEscrita {
  Text: RichTextInput | null;
  IsDisplayed: boolean;
}

/**
 * O `QuizReadData` nos campos que o PUT precisa reenviar.
 *
 * Deliberadamente FROUXO (`unknown` no que apenas trafega): este modulo nao
 * interpreta nota, tentativa nem calendario — ele os devolve verbatim. Tipar
 * cada um em detalhe convidaria a "corrigir" valores que a API mandou.
 */
export interface QuizLido {
  QuizId?: number | string;
  Name?: string;
  Password?: string | null;
  IsActive?: unknown;
  StartDate?: unknown;
  EndDate?: unknown;
  DueDate?: unknown;
  SortOrder?: unknown;
  AutoExportToGrades?: unknown;
  GradeItemId?: unknown;
  IsAutoSetGraded?: unknown;
  Instructions?: BlocoDeTextoLeitura | null;
  Description?: BlocoDeTextoLeitura | null;
  Header?: BlocoDeTextoLeitura | null;
  Footer?: BlocoDeTextoLeitura | null;
  AttemptsAllowed?: {
    IsUnlimited?: boolean;
    NumberOfAttemptsAllowed?: number | null;
  } | null;
  NumberOfAttemptsAllowed?: number | null;
  DisplayInCalendar?: unknown;
  LateSubmissionInfo?: unknown;
  SubmissionTimeLimit?: unknown;
  SubmissionGracePeriod?: unknown;
  AllowHints?: unknown;
  DisableRightClick?: unknown;
  DisablePagerAndAlerts?: unknown;
  NotificationEmail?: unknown;
  CalcTypeId?: unknown;
  RestrictIPAddressRange?: unknown;
  CategoryId?: unknown;
  PreventMovingBackwards?: unknown;
  Shuffle?: unknown;
  AllowOnlyUsersWithSpecialAccess?: unknown;
  IsRetakeIncorrectOnly?: unknown;
  PagingTypeId?: unknown;
  IsSynchronous?: unknown;
  DeductionPercentage?: unknown;
  HideQuestionPoints?: unknown;
  IsSingleSession?: unknown;
}

/** O `QuizData` que vai no PUT. */
export type QuizParaGravar = Record<string, unknown>;

/**
 * As chaves que `montarCorpoDoQuiz` DEVE produzir, congeladas.
 *
 * Nao e documentacao: e a rede de seguranca. O teste compara as chaves reais
 * contra esta lista, entao remover um campo do corpo quebra o build em vez de
 * apagar aquele campo em centenas de provas silenciosamente. Acrescentar campo
 * aqui e uma decisao consciente; perder um deixou de ser possivel por descuido.
 */
export const CAMPOS_DO_CORPO_DO_QUIZ = [
  'AllowHints',
  'AllowOnlyUsersWithSpecialAccess',
  'AutoExportToGrades',
  'CalcTypeId',
  'CategoryId',
  'DeductionPercentage',
  'Description',
  'DisablePagerAndAlerts',
  'DisableRightClick',
  'DisplayInCalendar',
  'DueDate',
  'EndDate',
  'Footer',
  'GradeItemId',
  'Header',
  'HideQuestionPoints',
  'Instructions',
  'IsActive',
  'IsAutoSetGraded',
  'IsRetakeIncorrectOnly',
  'IsSingleSession',
  'IsSynchronous',
  'LateSubmissionInfo',
  'Name',
  'NotificationEmail',
  'NumberOfAttemptsAllowed',
  'PagingTypeId',
  'Password',
  'PreventMovingBackwards',
  'RestrictIPAddressRange',
  'Shuffle',
  'SortOrder',
  'StartDate',
  'SubmissionGracePeriod',
  'SubmissionTimeLimit',
] as const;

/**
 * RichText de leitura -> RichTextInput de escrita.
 *
 * `Html` vence quando existe e nao e vazio: e o conteudo COM formatacao, e
 * mandar o `Text` no lugar transformaria uma instrucao formatada em texto cru.
 */
export function paraRichTextInput(
  rt: RichTextLeitura | string | null | undefined,
): RichTextInput | null {
  if (rt == null) return null;
  if (typeof rt === 'string') return { Content: rt, Type: 'Text' };
  if (rt.Html != null && rt.Html !== '')
    return { Content: rt.Html, Type: 'Html' };
  return { Content: rt.Text ?? '', Type: 'Text' };
}

/**
 * Bloco `{ Text, IsDisplayed }` de leitura para o de escrita.
 *
 * `IsDisplayed` ausente vira `true` — e o default da API, e mandar `undefined`
 * faria o bloco sumir da prova.
 */
export function converterBlocoDeTexto(
  bloco: BlocoDeTextoLeitura | null | undefined,
): BlocoDeTextoEscrita | null {
  if (bloco == null) return null;
  return {
    Text: paraRichTextInput(bloco.Text),
    IsDisplayed: bloco.IsDisplayed === undefined ? true : bloco.IsDisplayed,
  };
}

/** A janela nova do questionario, ja em ISO 8601 UTC-Z. */
export interface JanelaDoQuiz {
  /** `StartDate` — quando a prova abre. */
  inicio: string;
  /** `EndDate` — quando ela fecha. */
  fim: string;
}

/**
 * Monta o corpo do PUT preservando TUDO e sobrescrevendo so o que foi pedido.
 *
 * `janela` ausente preserva o calendario lido — e o lote de senhas, que nao mexe
 * em datas. `novaSenha` NAO tem equivalente opcional: ver o cabecalho.
 *
 * ⚠️ **A janela chega pronta, em UTC-Z, e este modulo NAO a reformata.** A
 * conversao fuso -> UTC vive em `instanteUtcDe` (`relogio.ts`), com teste; fazer
 * `new Date(x).toISOString()` aqui seria uma segunda chance de mover a data em
 * silencio. Quando `janela` esta ausente, as datas saem verbatim como o GET as
 * devolveu, pelo mesmo motivo.
 *
 * ⚠️ **Nunca `''` numa data**: a Valence responde 500. Ou uma ISO valida, ou
 * `null` (que APAGA a data). Como `janela` e tipada como `string`, o unico
 * caminho para `null` e o proprio GET ter devolvido nulo — que e o estado que
 * queriamos preservar.
 */
export function montarCorpoDoQuiz(
  quiz: QuizLido,
  novaSenha: string,
  janela?: JanelaDoQuiz,
): QuizParaGravar {
  return {
    Name: quiz.Name,
    IsActive: quiz.IsActive,

    // >>> CAMPOS MUTAVEIS (1 de 2): a janela da prova <<<
    // Sem `janela`, saem verbatim: reformatar uma data preservada seria a forma
    // mais silenciosa de move-la.
    StartDate: janela ? janela.inicio : quiz.StartDate,
    EndDate: janela ? janela.fim : quiz.EndDate,
    // PRESERVADO sempre: prazo de entrega e outra pergunta, e o cliente nao pediu.
    DueDate: quiz.DueDate,

    SortOrder: quiz.SortOrder,
    AutoExportToGrades: quiz.AutoExportToGrades,
    GradeItemId: quiz.GradeItemId,
    IsAutoSetGraded: quiz.IsAutoSetGraded,

    Instructions: converterBlocoDeTexto(quiz.Instructions),
    Description: converterBlocoDeTexto(quiz.Description),
    Header: converterBlocoDeTexto(quiz.Header),
    Footer: converterBlocoDeTexto(quiz.Footer),

    // Conversao (1): aninhado na leitura, achatado na escrita.
    NumberOfAttemptsAllowed:
      quiz.AttemptsAllowed?.NumberOfAttemptsAllowed != null
        ? quiz.AttemptsAllowed.NumberOfAttemptsAllowed
        : quiz.NumberOfAttemptsAllowed,

    DisplayInCalendar: quiz.DisplayInCalendar,
    LateSubmissionInfo: quiz.LateSubmissionInfo,
    SubmissionTimeLimit: quiz.SubmissionTimeLimit,
    SubmissionGracePeriod: quiz.SubmissionGracePeriod,

    // >>> CAMPOS MUTAVEIS (2 de 2): a senha <<<
    // SEMPRE DEFINIDA, nunca preservada, nos DOIS lotes. Ver o cabecalho: o GET
    // pode devolver `Password: null` num quiz que tem senha, e preservar esse
    // nulo apagaria a senha de toda prova do CSV em silencio.
    Password: novaSenha,

    AllowHints: quiz.AllowHints,
    DisableRightClick: quiz.DisableRightClick,
    DisablePagerAndAlerts: quiz.DisablePagerAndAlerts,
    NotificationEmail: quiz.NotificationEmail,
    CalcTypeId: quiz.CalcTypeId,
    RestrictIPAddressRange: quiz.RestrictIPAddressRange,
    CategoryId: quiz.CategoryId,
    PreventMovingBackwards: quiz.PreventMovingBackwards,
    Shuffle: quiz.Shuffle,
    AllowOnlyUsersWithSpecialAccess: quiz.AllowOnlyUsersWithSpecialAccess,
    IsRetakeIncorrectOnly: quiz.IsRetakeIncorrectOnly,
    PagingTypeId: quiz.PagingTypeId,
    IsSynchronous: quiz.IsSynchronous,
    DeductionPercentage: quiz.DeductionPercentage,
    HideQuestionPoints: quiz.HideQuestionPoints,
    IsSingleSession: quiz.IsSingleSession,
  };
}

/**
 * Os itens cujo nome casa com o alvo configurado.
 *
 * `CONTEM` pode casar VARIOS quizzes da mesma turma — e isso e aceito: "Prova"
 * casa "Prova N1" e "Prova N2", e as duas sao provas daquele turno. O preco e
 * que um alvo generico alcanca simulado e atividade tambem, e por isso o dry-run
 * lista cada quiz casado por nome antes de qualquer PUT.
 */
export function casarPorNome<T>(
  itens: readonly T[],
  nomeDe: (item: T) => string | null | undefined,
  alvo: string,
  tipo: TipoMatchQuiz,
): T[] {
  const procurado = String(alvo).trim();

  if (tipo === TipoMatchQuiz.CONTEM) {
    const minusculo = procurado.toLowerCase();
    return itens.filter((item) =>
      String(nomeDe(item) ?? '')
        .toLowerCase()
        .includes(minusculo),
    );
  }

  return itens.filter(
    (item) => String(nomeDe(item) ?? '').trim() === procurado,
  );
}
