import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';

/**
 * Codigos aceitos no dropdown de modalidade do upload. A aba do arquivo define o
 * valor: EaD -> EAD, Semi -> SEMI, Hibrido -> MODULAR (sao a mesma coisa).
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
      'A modalidade NAO e coluna do CSV: vem do dropdown do upload e corresponde a aba de origem ' +
      'da planilha (EaD -> EAD, Semi -> SEMI, Hibrido -> MODULAR). Define a duracao da prova.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(MODALIDADES_UPLOAD, {
    message: `modalidade deve ser um de: ${MODALIDADES_UPLOAD.join(', ')}`,
  })
  modalidade!: (typeof MODALIDADES_UPLOAD)[number];
}
