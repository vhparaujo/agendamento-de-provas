import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'E-mail invalido' })
  email!: string;

  @IsString()
  @IsNotEmpty({ message: 'Senha e obrigatoria' })
  // bcrypt so considera os primeiros 72 bytes; limitar evita payload absurdo
  @MaxLength(72, { message: 'Senha deve ter no maximo 72 caracteres' })
  senha!: string;
}
