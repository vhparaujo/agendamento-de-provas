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

    return payload;
  }
}
