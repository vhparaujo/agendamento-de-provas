import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { LIMITE_AUTENTICACAO } from '../../config/throttler.config';
import { TAGS } from '../../config/swagger';
import { Publico } from '../roles.decorator';
import {
  JwksResponseDto,
  LaunchResponseDto,
} from '../dto/lti-launch.response.dto';
import { LtiKeysService } from './lti-keys.service';
import { LtiService } from './lti.service';
import type { IniciacaoOidc } from './lti.service';

interface CorpoLaunch {
  id_token?: string;
  state?: string;
}

/**
 * Corpo do launch, declarado como schema em vez de DTO de propósito: quem valida
 * estas rotas e a assinatura do Brightspace, nao o ValidationPipe. Um DTO com
 * `forbidNonWhitelisted` rejeitaria qualquer campo extra que o Brightspace
 * resolvesse enviar, quebrando o launch por um detalhe de documentacao.
 */
const SCHEMA_LAUNCH = {
  type: 'object',
  required: ['id_token', 'state'],
  properties: {
    id_token: {
      type: 'string',
      description:
        'JWT assinado pelo Brightspace, verificado contra o JWKS remoto (issuer, audience, nonce, 30s de tolerancia de relogio).',
    },
    state: {
      type: 'string',
      description:
        'O mesmo `state` emitido na iniciacao OIDC. De uso unico e com expiracao.',
    },
  },
};

/**
 * Endpoints publicos do LTI 1.3 (nao passam por guard: quem autentica aqui e a
 * assinatura do proprio Brightspace).
 *
 * Registrar no Brightspace:
 *   OpenID Connect Login URL -> {API}/lti/login
 *   Redirect / Target Link   -> {API}/lti/launch
 *   Keyset (JWKS) URL        -> {API}/lti/jwks
 */
@ApiTags(TAGS.AUTH_ALUNO)
// Todo o fluxo LTI e publico por natureza: quem autentica aqui e a assinatura
// do Brightspace no id_token, nao um token emitido por nos.
@Publico()
@Controller('lti')
export class LtiController {
  constructor(
    private readonly ltiService: LtiService,
    private readonly keysService: LtiKeysService,
  ) {}

  // O Brightspace pode iniciar por GET ou por POST — aceitamos os dois.
  @Get('login')
  @ApiOperation({
    summary: 'Iniciacao OIDC (GET)',
    description:
      'Passo 1 do LTI 1.3. Gera `state` + `nonce` e redireciona para a tela de autorizacao do ' +
      'Brightspace. Chamada pelo proprio LMS, nunca pelo front.',
  })
  @ApiQuery({
    name: 'iss',
    required: false,
    description: 'Issuer; rejeitado se diferente de LTI_ISSUER',
  })
  @ApiQuery({ name: 'login_hint', required: true, description: 'Obrigatorio' })
  @ApiQuery({ name: 'target_link_uri', required: false })
  @ApiQuery({ name: 'lti_message_hint', required: false })
  @ApiQuery({
    name: 'client_id',
    required: false,
    description: 'Sobrepoe LTI_CLIENT_ID quando presente',
  })
  @ApiQuery({ name: 'lti_deployment_id', required: false })
  @ApiResponse({
    status: 302,
    description: 'Redirect para a autorizacao do Brightspace',
  })
  @ApiBadRequestResponse({ description: 'login_hint ausente' })
  @ApiUnauthorizedResponse({ description: 'Issuer inesperado' })
  @ApiServiceUnavailableResponse({
    description:
      'Integracao LTI nao configurada — faltam variaveis LTI_* no .env',
  })
  loginGet(@Query() query: IniciacaoOidc, @Res() res: Response): void {
    res.redirect(this.ltiService.iniciarLogin(query));
  }

  @Post('login')
  @ApiOperation({
    summary: 'Iniciacao OIDC (POST)',
    description:
      'Mesma logica do GET — o Brightspace pode usar qualquer um dos dois verbos.',
  })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['login_hint'],
      properties: {
        iss: { type: 'string' },
        login_hint: { type: 'string' },
        target_link_uri: { type: 'string' },
        lti_message_hint: { type: 'string' },
        client_id: { type: 'string' },
        lti_deployment_id: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect para a autorizacao do Brightspace',
  })
  loginPost(@Body() body: IniciacaoOidc, @Res() res: Response): void {
    res.redirect(this.ltiService.iniciarLogin(body));
  }

  @Post('launch')
  @HttpCode(HttpStatus.OK)
  @Throttle(LIMITE_AUTENTICACAO)
  @ApiOperation({
    summary: 'Launch LTI — entrada do aluno',
    description:
      'Passo 2. Valida assinatura, issuer, audience, state, nonce, versao 1.3.0, message type e ' +
      'deployment_id ANTES de olhar qualquer dado. So entao cruza a matricula com o CSV de alunos ' +
      'e devolve os vinculos + o JWT interno do aluno.\n\n' +
      'Nao ha como exercitar esta rota pelo Swagger UI: o `id_token` precisa ser assinado pelo ' +
      'Brightspace. O contrato abaixo serve para orientar o front.',
  })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiBody({ schema: SCHEMA_LAUNCH })
  @ApiOkResponse({ type: LaunchResponseDto })
  @ApiBadRequestResponse({ description: 'id_token ou state ausentes' })
  @ApiUnauthorizedResponse({
    description:
      'id_token invalido, state expirado/reutilizado, nonce divergente, versao ou message type ' +
      'inesperados, ou matricula/UserId nao localizados nos claims',
  })
  @ApiForbiddenResponse({
    description:
      'Matricula valida no LMS mas ausente da base importada: sem a linha do CSV nao ha modalidade ' +
      'nem polo, entao nao ha o que agendar',
  })
  launch(@Body() body: CorpoLaunch) {
    return this.ltiService.processarLaunch(
      body.id_token ?? '',
      body.state ?? '',
    );
  }

  /** Chave publica da ferramenta, consumida pelo Brightspace. */
  @Get('jwks')
  @ApiOperation({
    summary: 'JWKS da ferramenta',
    description:
      'Chave publica que o Brightspace usa para verificar o que assinamos. Registre esta URL como ' +
      '**Keyset URL**. Responde `{ "keys": [] }` enquanto LTI_TOOL_PRIVATE_KEY nao estiver configurada.',
  })
  @ApiOkResponse({ type: JwksResponseDto })
  jwks() {
    return this.keysService.jwks();
  }
}
