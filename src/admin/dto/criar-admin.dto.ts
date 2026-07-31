import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CriarAdminDto {
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'E-mail invalido' })
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  nome?: string;

  /**
   * Opcional: se nao vier, o sistema gera uma senha provisoria e a devolve UMA
   * unica vez na resposta, para o admin repassar ao novo usuario.
   */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'A senha deve ter ao menos 8 caracteres' })
  @MaxLength(72)
  senha?: string;
}
