import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { AdminJwtPayload } from './jwt.types';
import { ESTRATEGIA_ADMIN } from './jwt-admin.strategy';

export const SENHA_PROVISORIA_OK = 'senha_provisoria_ok';

/**
 * Marca uma rota como acessivel mesmo com senha provisoria pendente. Usado
 * apenas na propria troca de senha (e no logout/refresh), para que o admin
 * consiga sair do estado de senha provisoria.
 */
export const PermitidoComSenhaProvisoria = () =>
  SetMetadata(SENHA_PROVISORIA_OK, true);

@Injectable()
export class JwtAdminGuard extends AuthGuard(ESTRATEGIA_ADMIN) {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  handleRequest<TUser = AdminJwtPayload>(
    err: unknown,
    user: TUser,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    // handleRequest do @nestjs/passport e tipado como `any`; a estrategia ja
    // garantiu que o payload e de admin, entao estreitamos aqui.
    const autenticado = super.handleRequest<AdminJwtPayload>(
      err,
      user,
      info,
      context,
    );

    // Senha provisoria trava tudo, menos as rotas explicitamente liberadas.
    if (autenticado.mustChangePassword) {
      const liberada = this.reflector.getAllAndOverride<boolean>(
        SENHA_PROVISORIA_OK,
        [context.getHandler(), context.getClass()],
      );

      if (!liberada) {
        throw new ForbiddenException(
          'Troque a senha provisória antes de usar o sistema.',
        );
      }
    }

    const request = context.switchToHttp().getRequest<Request>();
    request.user = autenticado;

    return autenticado as TUser;
  }
}
