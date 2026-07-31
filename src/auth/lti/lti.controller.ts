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
import type { Response } from 'express';
import { LtiKeysService } from './lti-keys.service';
import { LtiService } from './lti.service';
import type { IniciacaoOidc } from './lti.service';

interface CorpoLaunch {
  id_token?: string;
  state?: string;
}

/**
 * Endpoints publicos do LTI 1.3 (nao passam por guard: quem autentica aqui e a
 * assinatura do proprio Brightspace).
 *
 * Registrar no Brightspace:
 *   OpenID Connect Login URL -> {API}/lti/login
 *   Redirect / Target Link   -> {API}/lti/launch
 *   Keyset (JWKS) URL        -> {API}/lti/jwks
 */
@Controller('lti')
export class LtiController {
  constructor(
    private readonly ltiService: LtiService,
    private readonly keysService: LtiKeysService,
  ) {}

  // O Brightspace pode iniciar por GET ou por POST — aceitamos os dois.
  @Get('login')
  loginGet(@Query() query: IniciacaoOidc, @Res() res: Response): void {
    res.redirect(this.ltiService.iniciarLogin(query));
  }

  @Post('login')
  loginPost(@Body() body: IniciacaoOidc, @Res() res: Response): void {
    res.redirect(this.ltiService.iniciarLogin(body));
  }

  @Post('launch')
  @HttpCode(HttpStatus.OK)
  launch(@Body() body: CorpoLaunch) {
    return this.ltiService.processarLaunch(
      body.id_token ?? '',
      body.state ?? '',
    );
  }

  /** Chave publica da ferramenta, consumida pelo Brightspace. */
  @Get('jwks')
  jwks() {
    return this.keysService.jwks();
  }
}
