import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

/**
 * Codigos aceitos no dropdown de formato do upload. A aba do arquivo define o
 * valor: EaD -> EAD, Semi -> SEMI, Modular -> MODULAR.
 */
export const MODALIDADES_UPLOAD = [
  'EAD',
  'SEMI',
  'MODULAR',
  'PRESENCIAL',
] as const;

export class ImportarAlunosDto {
  @ApiProperty({
    enum: MODALIDADES_UPLOAD,
    example: 'EAD',
    description:
      'O formato NAO e coluna do CSV: vem do dropdown do upload e corresponde a aba de origem ' +
      'da planilha (EaD -> EAD, Semi -> SEMI, Modular -> MODULAR). Define a duracao da prova.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(MODALIDADES_UPLOAD, {
    message: `Escolha o formato do arquivo: ${MODALIDADES_UPLOAD.join(', ')}.`,
  })
  modalidade!: (typeof MODALIDADES_UPLOAD)[number];

  @ApiPropertyOptional({
    example: false,
    description:
      'O arquivo e a lista COMPLETA do formato. So assim a importacao compara ' +
      'com o banco e aponta quem saiu da planilha. Padrao false: um CSV de um ' +
      'aluno so, para corrigir o status dele, nao pode tirar os outros.',
  })
  @Transform(({ obj, key }) =>
    paraBooleano((obj as Record<string, unknown>)[key]),
  )
  @IsOptional()
  @IsBoolean()
  listaCompleta?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'Marca de fato quem saiu (exige `listaCompleta`). Padrao false: o envio ' +
      'so mostra a lista, e a tela reenvia o mesmo arquivo para confirmar.',
  })
  @Transform(({ obj, key }) =>
    paraBooleano((obj as Record<string, unknown>)[key]),
  )
  @IsOptional()
  @IsBoolean()
  aplicarSaidas?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'Segunda confirmacao, exigida quando a saida passa do limite (10% do formato).',
  })
  @Transform(({ obj, key }) =>
    paraBooleano((obj as Record<string, unknown>)[key]),
  )
  @IsOptional()
  @IsBoolean()
  confirmarAcimaDoLimite?: boolean;
}

/**
 * Multipart so carrega texto: "true"/"false" chegam como string. Outro valor
 * passa adiante cru e o `IsBoolean` recusa — melhor que um "sim" virar false.
 *
 * ⚠️ Le de `obj[key]`, nao de `value`: com `enableImplicitConversion` (main.ts)
 * o `value` ja chega convertido por `Boolean()`, e `Boolean("false")` e true.
 */
function paraBooleano(valor: unknown): unknown {
  if (valor === 'true') return true;
  if (valor === 'false') return false;

  return valor;
}
