import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NivelAdmin } from '../../generated/prisma/client';

export class CriarAdminDto {
  @ApiProperty({
    example: 'coordenacao@ucb.br',
    description: 'Precisa ser unico. Espacos e caixa sao normalizados.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'E-mail inválido.' })
  email!: string;

  @ApiPropertyOptional({ example: 'Maria da Silva', maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  nome?: string;

  @ApiProperty({
    enum: NivelAdmin,
    example: NivelAdmin.ASSISTENTE_OPERACIONAL,
    description:
      'O que a conta podera fazer. **Obrigatorio**: o default da coluna existe para a ' +
      'migracao das contas antigas, nao para o cadastro — quem cria um administrador ' +
      'escolhe o nivel dele na hora, e nunca por omissao.',
  })
  @IsEnum(NivelAdmin, { message: 'Escolha um nível de acesso válido.' })
  nivel!: NivelAdmin;

  @ApiPropertyOptional({
    minLength: 8,
    maxLength: 72,
    description:
      'Se omitida, o sistema gera uma senha provisoria e a devolve UMA unica vez na resposta. ' +
      'Em qualquer dos casos a troca no primeiro acesso e obrigatoria.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'A senha deve ter ao menos 8 caracteres.' })
  @MaxLength(72)
  senha?: string;
}
