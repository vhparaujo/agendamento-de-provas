import { ApiProperty } from '@nestjs/swagger';
import { Perfil } from '../../enums/perfil.enum';
import type { TokensAdmin } from '../service/auth.service';

/**
 * Respostas do fluxo de autenticacao do admin.
 *
 * As classes usam `implements` de proposito: se a interface do service mudar, o
 * compilador quebra aqui e a documentacao nao fica mentindo em silencio.
 */
export class TokensAdminResponseDto implements TokensAdmin {
  @ApiProperty({
    description: 'Envie em Authorization: Bearer <token>. Expira em 15min.',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Use em POST /auth/refresh para obter um par novo. Expira em 7 dias.',
  })
  refreshToken!: string;

  @ApiProperty({
    description:
      'Quando true, so /auth/trocar-senha e /auth/me respondem — todo o resto devolve 403 ate a troca.',
    example: false,
  })
  mustChangePassword!: boolean;
}

export class AdminLogadoResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: '8f1c9d2e-4b7a-4c53-9f61-2a0d5e8b7c14',
  })
  id!: string;

  @ApiProperty({ example: 'admin@ucb.br' })
  email!: string;

  @ApiProperty({ enum: Perfil, example: Perfil.ADMIN })
  perfil!: Perfil;

  @ApiProperty({ example: false })
  mustChangePassword!: boolean;
}

export class MensagemResponseDto {
  @ApiProperty({ example: 'Senha alterada com sucesso' })
  mensagem!: string;
}
