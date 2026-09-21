import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiSecurity,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AUTH_ADMIN, AUTH_ALUNO, AUTH_INTEGRACAO } from '../config/swagger';
import { Perfil } from '../enums/perfil.enum';
import { NivelAdmin } from '../generated/prisma/client';
import { ROTULO_DO_NIVEL } from './jwt/niveis';
import {
  AdminJwtPayload,
  AlunoJwtPayload,
  IntegracaoPayload,
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
export const NIVEIS_KEY = 'niveis_de_admin';

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
 * Exige um JWT de admin valido. **Sozinho, isto significa SO SUPERADMIN**: o
 * nivel e declarado a parte, com `@NiveisPermitidos()` — ver src/auth/jwt/niveis.ts.
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

/**
 * Abre a rota TAMBEM para estes niveis, alem do superadmin (que passa sempre).
 *
 * So faz sentido junto de `@SomenteAdmin()` — e o nivel de um admin que ele
 * declara. Quem aplica e o `JwtAdminGuard`, depois de autenticar.
 *
 * ⚠️ **Rota de admin SEM este decorator e rota de superadmin.** O padrao e
 * fechado de proposito, pelo mesmo motivo do AutenticacaoGuard: o controller
 * novo que esquecer a linha nega o assistente (alguem reclama no mesmo dia) em
 * vez de entregar a ele, calado, uma rota que nao era dele.
 */
export const NiveisPermitidos = (...niveis: NivelAdmin[]) =>
  applyDecorators(
    SetMetadata(NIVEIS_KEY, niveis),
    ApiForbiddenResponse({
      description:
        'Nivel de administrador sem acesso a esta rota. Abertas para: ' +
        [
          ROTULO_DO_NIVEL.SUPERADMIN,
          ...niveis.map((n) => ROTULO_DO_NIVEL[n]),
        ].join(', '),
    }),
  );

/**
 * Rota para OUTRO SISTEMA, e nao para pessoa: autentica pela API key do header
 * `X-API-Key` (`ApiKeyIntegracaoGuard`), nunca por JWT. A chave so abre as rotas
 * marcadas com este decorator — nao vale como admin nem como aluno, e nenhum
 * JWT vale aqui.
 */
export const SomenteIntegracao = () =>
  applyDecorators(
    SetMetadata(PERFIL_KEY, Perfil.INTEGRACAO),
    ApiSecurity(AUTH_INTEGRACAO),
    ApiUnauthorizedResponse({
      description: 'Header X-API-Key ausente ou com chave invalida',
    }),
    ApiForbiddenResponse({
      description: 'Chamada de um IP fora de INTEGRACAO_IPS_PERMITIDOS',
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

/** O sistema dono da API key que autenticou a chamada. */
export const IntegracaoLogada = createParamDecorator(
  (_dado: unknown, ctx: ExecutionContext): IntegracaoPayload => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as IntegracaoPayload;
  },
);
