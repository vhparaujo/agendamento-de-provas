import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { NivelAdmin } from '../../generated/prisma/client';
import { NIVEIS_KEY } from '../roles.decorator';
import { AdminJwtPayload } from './jwt.types';
import { ESTRATEGIA_ADMIN } from './jwt-admin.strategy';
import { nivelPermitido, ROTULO_DO_NIVEL } from './niveis';

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

    this.exigirNivel(autenticado, context);

    const request = context.switchToHttp().getRequest<Request>();
    request.user = autenticado;

    return autenticado as TUser;
  }

  /**
   * A segunda pergunta do guard: autenticado, sim — mas ESTE admin abre ESTA
   * rota? Ver src/auth/jwt/niveis.ts para a matriz e para o motivo de rota sem
   * `@NiveisPermitidos` ser rota de superadmin.
   *
   * A recusa e 403 e vira `ACESSO_NEGADO` no log de seguranca de graca: o
   * `ExcecoesFilter` audita todo 401/403. A mensagem nao nomeia a rota nem o
   * nivel que faltou — quem le e a administracao, e quem sonda nao ganha um
   * mapa de quais telas existem.
   */
  private exigirNivel(admin: AdminJwtPayload, context: ExecutionContext): void {
    const permitidos = this.reflector.getAllAndOverride<NivelAdmin[]>(
      NIVEIS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (nivelPermitido(admin.nivel, permitidos)) return;

    throw new ForbiddenException(
      `Esta função não faz parte do seu perfil de acesso` +
        `${admin.nivel ? ` (${ROTULO_DO_NIVEL[admin.nivel]})` : ''}. ` +
        'Fale com um superadministrador.',
    );
  }
}
