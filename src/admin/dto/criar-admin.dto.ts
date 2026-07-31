import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CriarAdminDto {
  @ApiProperty({
    example: 'coordenacao@ucb.br',
    description: 'Precisa ser unico. Espacos e caixa sao normalizados.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'E-mail invalido' })
  email!: string;

  @ApiPropertyOptional({ example: 'Maria da Silva', maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  nome?: string;

  @ApiPropertyOptional({
    minLength: 8,
    maxLength: 72,
    description:
      'Se omitida, o sistema gera uma senha provisoria e a devolve UMA unica vez na resposta. ' +
      'Em qualquer dos casos a troca no primeiro acesso e obrigatoria.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'A senha deve ter ao menos 8 caracteres' })
  @MaxLength(72)
  senha?: string;
}
