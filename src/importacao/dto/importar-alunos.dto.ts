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
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(MODALIDADES_UPLOAD, {
    message: `modalidade deve ser um de: ${MODALIDADES_UPLOAD.join(', ')}`,
  })
  modalidade!: (typeof MODALIDADES_UPLOAD)[number];
}
