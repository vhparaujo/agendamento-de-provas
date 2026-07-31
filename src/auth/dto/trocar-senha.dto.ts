import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class TrocarSenhaDto {
  @IsString()
  @IsNotEmpty({ message: 'Senha atual e obrigatoria' })
  @MaxLength(72)
  senhaAtual!: string;

  @IsString()
  @MinLength(8, { message: 'A nova senha deve ter ao menos 8 caracteres' })
  @MaxLength(72, { message: 'A nova senha deve ter no maximo 72 caracteres' })
  novaSenha!: string;
}
