import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { Perfil } from '../../enums/perfil.enum';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { extrairIp } from '../../seguranca/requisicao.util';
import { ApiKeyIntegracaoGuard } from '../integracao/api-key-integracao.guard';
import { PERFIL_KEY, PUBLICO_KEY } from '../roles.decorator';
import { JwtAdminGuard } from './jwt-admin.guard';
import { JwtAlunoGuard } from './jwt-aluno.guard';

/**
 * ============================================================================
 * GUARD GLOBAL — NEGA POR PADRAO (OWASP A01)
 * ============================================================================
 * Registrado como APP_GUARD, roda em TODA rota. A decisao e tomada assim:
 *
 *   @Publico()        -> libera
 *   @SomenteAdmin()   -> delega ao JwtAdminGuard
 *   @SomenteAluno()   -> delega ao JwtAlunoGuard
 *   @SomenteIntegracao() -> delega ao ApiKeyIntegracaoGuard (outro sistema)
 *   nenhum decorator  -> 403 (fail-closed)
 *
 * O ultimo caso e o motivo de este guard existir. Antes, proteger era opt-in:
 * um controller novo que esquecesse o @SomenteAdmin() nascia PUBLICO. Agora o
 * esquecimento fecha a rota em vez de abrir — o erro fica obvio no primeiro
 * request, em vez de virar um vazamento silencioso.
 *
 * E tambem o que finalmente da funcao ao PERFIL_KEY: a metadata de perfil era
 * gravada por @SomenteAdmin()/@SomenteAluno() e nunca lida por ninguem. Agora
 * ela E o mecanismo de autorizacao, lido aqui.
 */
@Injectable()
export class AutenticacaoGuard implements CanActivate {
  private readonly logger = new Logger(AutenticacaoGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtAdminGuard: JwtAdminGuard,
    private readonly jwtAlunoGuard: JwtAlunoGuard,
    private readonly apiKeyIntegracaoGuard: ApiKeyIntegracaoGuard,
    private readonly auditoria: AuditoriaService,
  ) {}

  canActivate(
    contexto: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const alvos = [contexto.getHandler(), contexto.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLICO_KEY, alvos)) {
      return true;
    }

    const perfil = this.reflector.getAllAndOverride<Perfil>(PERFIL_KEY, alvos);

    if (perfil === Perfil.ADMIN)
      return this.jwtAdminGuard.canActivate(contexto);
    if (perfil === Perfil.ALUNO)
      return this.jwtAlunoGuard.canActivate(contexto);
    if (perfil === Perfil.INTEGRACAO)
      return this.apiKeyIntegracaoGuard.canActivate(contexto);

    return this.recusarRotaSemControle(contexto);
  }

  /**
   * Rota sem decorator algum. E defeito de programacao, nao ataque — mas a
   * resposta precisa ser negar, e alguem precisa ficar sabendo. Por isso vai
   * para o log de seguranca com nome proprio, e nao morre num 403 silencioso.
   */
  private recusarRotaSemControle(contexto: ExecutionContext): never {
    const req = contexto.switchToHttp().getRequest<Request>();
    const rota = `${req.method} ${req.originalUrl}`;

    this.auditoria.registrar('ROTA_SEM_CONTROLE_DE_ACESSO', {
      rota,
      ip: extrairIp(req),
      detalhe: `${contexto.getClass().name}.${contexto.getHandler().name} sem @Publico/@SomenteAdmin/@SomenteAluno/@SomenteIntegracao`,
    });

    this.logger.error(
      `Rota sem decorator de acesso: ${rota} ` +
        `(${contexto.getClass().name}.${contexto.getHandler().name}). ` +
        'Adicione @SomenteAdmin(), @SomenteAluno(), @SomenteIntegracao() ou @Publico().',
    );

    throw new ForbiddenException('Rota sem controle de acesso configurado');
  }
}
