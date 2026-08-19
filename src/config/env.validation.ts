import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Valida o .env no boot. Se faltar algo essencial, a aplicacao nao sobe — e
 * melhor falhar no start do que descobrir um segredo ausente em producao.
 * Variaveis de LTI/Valence sao opcionais aqui porque as credenciais reais so
 * chegam nas etapas 3 e 7.
 */
export class EnvironmentVariables {
  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV?: string;

  @IsOptional()
  @IsNumberString()
  PORT?: string;

  @IsOptional()
  @IsString()
  API_PREFIX?: string;

  // Vazio = ligada fora de producao. Ver src/config/swagger.ts.
  @IsOptional()
  @IsIn(['true', 'false', ''], {
    message: "SWAGGER_ENABLED deve ser 'true', 'false' ou vazio",
  })
  SWAGGER_ENABLED?: string;

  /**
   * Numero de proxies confiaveis na frente da API (`1` = so o nosso Nginx), ou
   * uma das formas do Express ('loopback', lista de IPs/CIDRs). Vazio/ausente =
   * desligado, que e o correto rodando sem proxy. Ver src/main.ts.
   */
  @IsOptional()
  @IsString()
  TRUST_PROXY?: string;

  @IsNotEmpty({ message: 'DATABASE_URL e obrigatoria' })
  @IsString()
  DATABASE_URL!: string;

  @MinLength(16, { message: 'JWT_SECRET deve ter ao menos 16 caracteres' })
  JWT_SECRET!: string;

  @MinLength(16, {
    message: 'JWT_REFRESH_SECRET deve ter ao menos 16 caracteres',
  })
  JWT_REFRESH_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_EXPIRES_IN?: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN?: string;

  @IsOptional()
  @IsString()
  JWT_ALUNO_EXPIRES_IN?: string;

  // Default seguro = 'true': sem turmas importadas, nada e agendavel.
  @IsOptional()
  @IsBooleanString()
  TURMAS_FILTER_ENABLED?: string;

  /**
   * Default = 'true' desde 18/08/2026 (era 'false'). A troca de senha dos
   * questionarios depende da Valence para descobrir o `orgUnitId` das turmas do
   * CSV; um ambiente que apenas esquecesse a variavel rodaria o lote em zero
   * turma e as provas ficariam sem senha no dia, sem erro nenhum. Desligar exige
   * dizer 'false'.
   *
   * Desligado, o cliente D2L nao faz chamada de rede nenhuma e a fila de
   * liberacao acumula em PENDENTE — nada se perde.
   *
   * As demais D2L_* nao sao validadas aqui de proposito: quem cobra o que falta
   * e o proprio D2L_HABILITADO=true, que recusa subir a integracao dizendo
   * exatamente qual variavel esta em branco (src/d2l/config/d2l.config.ts).
   * Exigi-las no boot deixaria a aplicacao inteira sem subir por causa de uma
   * integracao opcional.
   */
  @IsOptional()
  @IsBooleanString()
  D2L_HABILITADO?: string;

  @IsOptional()
  @IsString()
  D2L_BASE_URL?: string;

  /**
   * Uma por PRODUTO da Valence: `lp` (matriculas, orgstructure) e `le` (quizzes)
   * numeram separado, e um numero valido num deles pode nao existir no outro —
   * o erro sai como 404 de corpo vazio. Ver src/d2l/config/d2l.config.ts.
   */
  @IsOptional()
  @IsString()
  D2L_API_VERSION_LP?: string;

  @IsOptional()
  @IsString()
  D2L_API_VERSION_LE?: string;

  // ==========================================================================
  // SENHA DOS QUESTIONARIOS (troca em massa no D2L)
  // ==========================================================================
  // Opcionais como as D2L_*: e integracao, nao infraestrutura. Mas as de HORA
  // sao validadas por FORMATO, e isso nao e preciosismo: um horario mal digitado
  // faz o cron NUNCA disparar, sem erro nenhum — a falha silenciosa que custaria
  // um turno inteiro de alunos travados na hora da prova.

  /** Opt-in. `true` deixa o servidor trocar as senhas sozinho, sem humano. */
  /**
   * Se ESTA INSTANCIA pode disparar o cron. Os HORARIOS nao estao mais aqui
   * (19/08/2026): eles sao escolhidos pelo admin na tela e moram em
   * `configuracao_senha_quiz`. As duas coisas respondem perguntas diferentes —
   * "a que horas a prova comeca" e da secretaria; "esta replica dispara" e de
   * quem sobe o container.
   */
  @IsOptional()
  @IsBooleanString()
  SENHA_QUIZ_CRON_HABILITADO?: string;

  /**
   * Janela de recuperacao, em minutos. Servidor que estava fora as 07:30 e sobe
   * as 07:41 ainda aplica o turno. Sem ela, um deploy na hora errada custa o
   * turno inteiro.
   */
  @IsOptional()
  @IsNumberString()
  SENHA_QUIZ_CRON_TOLERANCIA_MIN?: string;

  /**
   * Teto de tentativas reais por celula dentro da janela de tolerancia. Sem ele,
   * uma falha PERMANENTE (token sem escopo de quizzing) bateria no D2L a cada
   * minuto durante toda a janela.
   */
  @IsOptional()
  @IsNumberString()
  SENHA_QUIZ_CRON_MAX_TENTATIVAS?: string;

  /**
   * O que importa e a RAZAO entre os dois: 4 turmas em paralelo com 400ms de
   * espera antes de cada chamada da ~10 req/s contra um tenant que atende o AVA
   * em uso. Mexer num sem olhar o outro nao diz nada.
   */
  @IsOptional()
  @IsNumberString()
  SENHA_QUIZ_CONCORRENCIA?: string;

  @IsOptional()
  @IsNumberString()
  SENHA_QUIZ_DELAY_MS?: string;

  /** Maior que o timeout do enrollments: objetos de quiz sao grandes. */
  @IsOptional()
  @IsNumberString()
  SENHA_QUIZ_TIMEOUT_MS?: string;

  /** Trava do laco de paginacao de `GET quizzes/` — nao e otimizacao. */
  @IsOptional()
  @IsNumberString()
  SENHA_QUIZ_MAX_PAGINAS?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });

  const erros = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (erros.length > 0) {
    const detalhes = erros
      .map((e) => Object.values(e.constraints ?? {}).join('; '))
      .join('\n  - ');
    throw new Error(`Configuracao de ambiente invalida:\n  - ${detalhes}`);
  }

  return config;
}
