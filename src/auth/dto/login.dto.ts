import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'admin@ucb.br',
    description: 'E-mail do administrador. Espacos e caixa sao normalizados.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'E-mail invalido' })
  email!: string;

  @ApiProperty({
    example: 'senha-do-admin',
    maxLength: 72,
    description: 'Senha em texto puro; trafega apenas sob TLS.',
  })
  @IsString()
  @IsNotEmpty({ message: 'Senha e obrigatoria' })
  // bcrypt so considera os primeiros 72 bytes; limitar evita payload absurdo
  @MaxLength(72, { message: 'Senha deve ter no maximo 72 caracteres' })
  senha!: string;
}
