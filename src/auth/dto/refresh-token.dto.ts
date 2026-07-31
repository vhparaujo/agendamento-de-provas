import { ApiProperty } from '@nestjs/swagger';
import { IsJWT } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description:
      'Refresh token devolvido no login. Um access token NAO e aceito aqui.',
    example:
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1dWlkIiwidGlwbyI6InJlZnJlc2gifQ.sig',
  })
  @IsJWT({ message: 'refreshToken invalido' })
  refreshToken!: string;
}
