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

  @IsOptional()
  @IsString()
  PERIODO_LETIVO_ID?: string;

  // Default seguro = 'true': sem turmas importadas, nada e agendavel.
  @IsOptional()
  @IsBooleanString()
  TURMAS_FILTER_ENABLED?: string;

  /**
   * Default seguro = 'false'. Desligado, o cliente D2L nao faz chamada de rede
   * nenhuma e a fila de liberacao acumula em PENDENTE — nada se perde, e nada e
   * gravado no Brightspace por engano enquanto a configuracao nao esta pronta.
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

  @IsOptional()
  @IsString()
  D2L_API_VERSION?: string;
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
