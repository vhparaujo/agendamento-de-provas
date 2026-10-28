import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RenomearTurmaDto {
  @ApiProperty({
    example: 'SAUDE COLETIVA',
    maxLength: 191,
    description:
      'O nome novo da disciplina. Unico entre as turmas com o mesmo codigo. ' +
      'Tambem e usado no cruzamento com o Brightspace quando o codigo nao ' +
      'basta — mantenha-o compativel com o titulo da disciplina no AVA.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Informe o nome da disciplina.' })
  @MaxLength(191)
  nomeDisciplina!: string;
}
