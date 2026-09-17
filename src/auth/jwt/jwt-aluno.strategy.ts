import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Perfil } from '../../enums/perfil.enum';
import { AlunoJwtPayload } from './jwt.types';

export const ESTRATEGIA_ALUNO = 'jwt-aluno';

@Injectable()
export class JwtAlunoStrategy extends PassportStrategy(
  Strategy,
  ESTRATEGIA_ALUNO,
) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: AlunoJwtPayload): AlunoJwtPayload {
    if (payload.perfil !== Perfil.ALUNO) {
      throw new UnauthorizedException(
        'Sua sessão não é válida no portal do aluno. Volte ao AVA e abra o link da prova de novo.',
      );
    }

    return payload;
  }
}
