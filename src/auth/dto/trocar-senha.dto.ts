import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class TrocarSenhaDto {
  @ApiProperty({
    description: 'Senha em uso — a provisoria, no primeiro acesso.',
    maxLength: 72,
  })
  @IsString()
  @IsNotEmpty({ message: 'Informe a senha atual.' })
  @MaxLength(72)
  senhaAtual!: string;

  @ApiProperty({
    description: 'Precisa ser diferente da atual.',
    minLength: 8,
    maxLength: 72,
  })
  @IsString()
  @MinLength(8, { message: 'A nova senha deve ter ao menos 8 caracteres.' })
  @MaxLength(72, { message: 'A nova senha deve ter no máximo 72 caracteres.' })
  novaSenha!: string;
}
