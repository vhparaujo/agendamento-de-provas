import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Perfil } from '../../enums/perfil.enum';
import { AdminJwtPayload } from './jwt.types';

export const ESTRATEGIA_ADMIN = 'jwt-admin';

@Injectable()
export class JwtAdminStrategy extends PassportStrategy(
  Strategy,
  ESTRATEGIA_ADMIN,
) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: AdminJwtPayload): AdminJwtPayload {
    // Um refresh token nunca deve ser aceito como access token.
    if (payload.perfil !== Perfil.ADMIN) {
      throw new UnauthorizedException(
        'Sua sessão não é de administrador. Entre novamente com a sua conta.',
      );
    }

    /**
     * Token emitido ANTES de o nivel existir (21/09/2026).
     *
     * Recusar aqui, e nao tratar como superadmin, e o que impede um access
     * token de 15 minutos de continuar abrindo o sistema inteiro logo depois do
     * deploy que criou os niveis. O custo e zero para o usuario: 401 e o sinal
     * que o front ja usa para renovar, e o refresh le o nivel do banco.
     */
    if (!payload.nivel) {
      throw new UnauthorizedException('Sua sessão expirou. Entre novamente.');
    }

    return payload;
  }
}
