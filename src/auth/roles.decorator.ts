import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Perfil } from '../enums/perfil.enum';
import { JwtAdminGuard } from './jwt/jwt-admin.guard';
import { JwtAlunoGuard } from './jwt/jwt-aluno.guard';
import {
  AdminJwtPayload,
  AlunoJwtPayload,
  UsuarioAutenticado,
} from './jwt/jwt.types';

export const PERFIL_KEY = 'perfil';

/**
 * Ha um unico nivel administrativo: possuir um JWT de admin valido = acesso
 * total. Por isso nao existe matriz de permissoes — so a separacao entre os dois
 * perfis (ADMIN e ALUNO), aplicada por estes decorators.
 */
export const SomenteAdmin = () =>
  applyDecorators(
    SetMetadata(PERFIL_KEY, Perfil.ADMIN),
    UseGuards(JwtAdminGuard),
  );

export const SomenteAluno = () =>
  applyDecorators(
    SetMetadata(PERFIL_KEY, Perfil.ALUNO),
    UseGuards(JwtAlunoGuard),
  );

/** Injeta o payload do token na assinatura do handler. */
export const UsuarioLogado = createParamDecorator(
  (_dado: unknown, ctx: ExecutionContext): UsuarioAutenticado => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as UsuarioAutenticado;
  },
);

export const AdminLogado = createParamDecorator(
  (_dado: unknown, ctx: ExecutionContext): AdminJwtPayload => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as AdminJwtPayload;
  },
);

export const AlunoLogado = createParamDecorator(
  (_dado: unknown, ctx: ExecutionContext): AlunoJwtPayload => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as AlunoJwtPayload;
  },
);
