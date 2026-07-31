import { IsJWT } from 'class-validator';

export class RefreshTokenDto {
  @IsJWT({ message: 'refreshToken invalido' })
  refreshToken!: string;
}
