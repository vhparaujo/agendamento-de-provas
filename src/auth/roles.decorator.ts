import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AUTH_ADMIN, AUTH_ALUNO } from '../config/swagger';
import { Perfil } from '../enums/perfil.enum';
import {
  AdminJwtPayload,
  AlunoJwtPayload,
  UsuarioAutenticado,
} from './jwt/jwt.types';

/**
 * Chaves de metadata lidas pelo AutenticacaoGuard (guard global). Este arquivo
 * DECLARA a intencao de acesso; quem a aplica e o guard.
 *
 * Nao ha `UseGuards` aqui de proposito: com o guard global, um UseGuards local
 * faria o mesmo token ser verificado duas vezes por request.
 */
export const PERFIL_KEY = 'perfil';
export const PUBLICO_KEY = 'publico';

/**
 * Marca a rota como aberta. **Toda rota sem decorator de acesso e NEGADA** pelo
 * AutenticacaoGuard, entao rota publica precisa dizer isso explicitamente.
 *
 * Use com parcimonia e sempre com o motivo escrito: hoje sao apenas o health
 * check e o fluxo LTI (que e autenticado pela assinatura do Brightspace, nao
 * por token nosso).
 */
export const Publico = () => SetMetadata(PUBLICO_KEY, true);

/**
 * Ha um unico nivel administrativo: possuir um JWT de admin valido = acesso
 * total. Por isso nao existe matriz de permissoes — so a separacao entre os dois
 * perfis (ADMIN e ALUNO), declarada por estes decorators.
 *
 * Os decorators tambem declaram a seguranca no OpenAPI: qualquer rota nova que
 * use @SomenteAdmin()/@SomenteAluno() ja nasce documentada com o cadeado certo e
 * com as respostas 401/403, sem precisar repetir @ApiBearerAuth em cada handler.
 */
export const SomenteAdmin = () =>
  applyDecorators(
    SetMetadata(PERFIL_KEY, Perfil.ADMIN),
    ApiBearerAuth(AUTH_ADMIN),
    ApiUnauthorizedResponse({
      description: 'Token de admin ausente, invalido ou expirado',
    }),
    ApiForbiddenResponse({
      description:
        'Senha provisoria pendente — troque em POST /auth/trocar-senha antes de usar o sistema',
    }),
  );

export const SomenteAluno = () =>
  applyDecorators(
    SetMetadata(PERFIL_KEY, Perfil.ALUNO),
    ApiBearerAuth(AUTH_ALUNO),
    ApiUnauthorizedResponse({
      description: 'Token de aluno ausente, invalido ou expirado',
    }),
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
