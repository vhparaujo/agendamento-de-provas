import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Perfil } from '../../enums/perfil.enum';
import { extrairIp } from '../../seguranca/requisicao.util';
import type { IntegracaoPayload } from '../jwt/jwt.types';
import {
  CABECALHO_DA_CHAVE,
  type ChaveDeIntegracao,
  identificarSistema,
  ipPermitido,
  lerChaves,
  lerIps,
} from './chaves-de-integracao';

/**
 * Protege as rotas de `@SomenteIntegracao()`. Chamado pelo `AutenticacaoGuard`
 * (global), como os guards de JWT — nao use `UseGuards` com ele.
 *
 * As chaves sao lidas UMA vez, na subida: trocar `INTEGRACAO_API_KEYS` exige
 * reiniciar a aplicacao, como qualquer outro segredo do `.env`.
 */
@Injectable()
export class ApiKeyIntegracaoGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyIntegracaoGuard.name);
  private readonly chaves: ChaveDeIntegracao[];
  private readonly ipsPermitidos: string[];

  constructor(config: ConfigService) {
    this.chaves = lerChaves(config.get<string>('INTEGRACAO_API_KEYS'));
    this.ipsPermitidos = lerIps(
      config.get<string>('INTEGRACAO_IPS_PERMITIDOS'),
    );

    // FAIL-CLOSED. Sem chave nenhuma, a rota continua de pe e recusa tudo —
    // o contrario (aceitar enquanto nao houver chave) abriria dados pessoais de
    // todo aluno num ambiente que so esqueceu a variavel.
    if (this.chaves.length === 0) {
      this.logger.warn(
        'INTEGRACAO_API_KEYS vazia: as rotas de integracao recusam toda chamada (401).',
      );
    }
  }

  canActivate(contexto: ExecutionContext): boolean {
    const req = contexto
      .switchToHttp()
      .getRequest<Request & { user?: IntegracaoPayload }>();

    // A ORIGEM ANTES DA CHAVE: de um IP fora da lista, a resposta e a mesma com
    // chave certa ou errada — quem esta fora nao consegue nem testar chaves.
    if (!ipPermitido(extrairIp(req), this.ipsPermitidos)) {
      throw new ForbiddenException('Origem nao autorizada a usar a integracao');
    }

    const sistema = identificarSistema(
      req.header(CABECALHO_DA_CHAVE),
      this.chaves,
    );

    // Mensagem unica para "ausente" e "invalida": distinguir as duas nao ajuda
    // o sistema legitimo (que manda a chave sempre) e ajuda quem testa chaves.
    if (!sistema) {
      throw new UnauthorizedException(
        'Chave de integracao ausente ou invalida (header X-API-Key)',
      );
    }

    // E daqui que a auditoria le o ator (`integracao:<sistema>`) — um fato
    // verificado pela chave, nunca um header que o cliente declara.
    req.user = { perfil: Perfil.INTEGRACAO, sistema };

    return true;
  }
}
