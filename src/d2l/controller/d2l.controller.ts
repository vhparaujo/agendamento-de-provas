import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TAGS } from '../../config/swagger';
import { LIMITE_AUTENTICACAO } from '../../config/throttler.config';
import { Publico } from '../../auth/roles.decorator';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { D2lCallbackResponseDto } from '../dto/d2l-callback.response.dto';
import { D2lOauthService } from '../service/d2l-oauth.service';

/**
 * Callback do OAuth 2.0 da Valence (Authorization Code).
 *
 * PUBLICA porque quem chega aqui e o BROWSER do admin, redirecionado pelo
 * Brightspace depois da tela de autorizacao — ele nao carrega o nosso JWT nessa
 * navegacao, e nao ha como exigi-lo sem quebrar o fluxo. O que autoriza a
 * operacao nao e um token nosso: e o `code`, que so o Brightspace emite, vale
 * uma vez e expira em minutos.
 *
 * Registre esta URL como "URI de redirecionamento" ao criar o app em
 * Admin Tools > Manage Extensibility > OAuth 2.0.
 */
@ApiTags(TAGS.D2L)
@Publico()
@Controller('d2l')
export class D2lController {
  private readonly logger = new Logger(D2lController.name);

  constructor(
    private readonly oauth: D2lOauthService,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get('callback')
  // Mesmo limite das rotas de autenticacao: e uma troca de credencial, e o
  // fluxo legitimo passa por aqui uma vez, nao dez por minuto.
  @Throttle(LIMITE_AUTENTICACAO)
  @ApiOperation({
    summary: 'Callback do OAuth 2.0 da Valence (D2L)',
    description:
      'Passo final da autorizacao: recebe o `code` emitido pelo Brightspace, troca por access + ' +
      'refresh token e **grava o refresh token** em `integracao_d2l`.\n\n' +
      'Existe porque o refresh token do Brightspace **rotaciona** — cada uso emite um novo e ' +
      'invalida o anterior —, entao guarda-lo no `.env` funcionaria exatamente uma vez.\n\n' +
      'Nao da para exercitar pelo Swagger UI: o `code` e de uso unico e chega pelo redirect do ' +
      'proprio Brightspace.',
  })
  @ApiQuery({
    name: 'code',
    required: false,
    description:
      'Codigo de autorizacao emitido pelo Brightspace. De uso unico e com expiracao curta.',
  })
  @ApiQuery({
    name: 'state',
    required: false,
    description:
      'Ecoado pelo Brightspace. Registrado no log para correlacionar a tentativa; nao e validado ' +
      'porque quem inicia a autorizacao e o admin, manualmente, e nao ha sessao nossa para proteger.',
  })
  @ApiQuery({
    name: 'error',
    required: false,
    description:
      'Preenchido quando o usuario NEGA a autorizacao na tela do Brightspace (ex: `access_denied`).',
  })
  @ApiQuery({
    name: 'error_description',
    required: false,
    description: 'Texto do Brightspace explicando a recusa.',
  })
  @ApiOkResponse({ type: D2lCallbackResponseDto })
  @ApiBadRequestResponse({
    description:
      '`code` ausente, expirado ou ja usado; ou credenciais/redirect_uri que nao batem com o registro',
  })
  @ApiServiceUnavailableResponse({
    description: 'Faltam variaveis D2L_* no .env — a resposta diz quais',
  })
  @ApiBadGatewayResponse({
    description:
      'O token endpoint do Brightspace nao respondeu ou devolveu algo inesperado',
  })
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') erro?: string,
    @Query('error_description') descricao?: string,
  ): Promise<D2lCallbackResponseDto> {
    // O Brightspace usa o MESMO redirect para dizer "o usuario recusou". Sem
    // tratar isso, a recusa viraria "code ausente" — mensagem que manda o admin
    // procurar defeito na configuracao em vez de reautorizar.
    if (erro) {
      this.auditoria.registrar('D2L_AUTORIZACAO_FALHOU', {
        detalhe:
          `Brightspace recusou no redirect: ${erro} ${descricao ?? ''}`.trim(),
      });

      throw new BadRequestException(
        `Autorizacao recusada pelo Brightspace: ${erro}${descricao ? ` — ${descricao}` : ''}`,
      );
    }

    if (!code) {
      throw new BadRequestException(
        'Parametro `code` ausente. Esta rota nao e para acesso direto: ela e o destino do ' +
          'redirect do Brightspace apos a tela de autorizacao.',
      );
    }

    // Log, e nao evento de auditoria: aqui ainda nao ha desfecho nenhum: o
    // resultado (OK ou FALHOU) e auditado pelo service, depois da troca.
    this.logger.debug(`callback recebido (state=${state ?? 'ausente'})`);

    return this.oauth.trocarCodigoPorTokens(code);
  }
}
