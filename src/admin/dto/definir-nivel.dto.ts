import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { NivelAdmin } from '../../generated/prisma/client';

export class DefinirNivelDto {
  @ApiProperty({
    enum: NivelAdmin,
    example: NivelAdmin.ASSISTENTE_OPERACIONAL,
    description:
      'O novo nivel do administrador. Duas travas: ninguem altera o proprio nivel, e o ' +
      'ultimo superadministrador ativo nao pode ser rebaixado.',
  })
  @IsEnum(NivelAdmin, { message: 'Escolha um nível de acesso válido.' })
  nivel!: NivelAdmin;
}
