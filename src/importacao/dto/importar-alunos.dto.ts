import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';

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
    message: `formato deve ser um de: ${MODALIDADES_UPLOAD.join(', ')}`,
  })
  modalidade!: (typeof MODALIDADES_UPLOAD)[number];
}
