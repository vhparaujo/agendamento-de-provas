import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LIMITE_AUTENTICACAO } from '../../config/throttler.config';
import { TAGS } from '../../config/swagger';
import { Publico } from '../roles.decorator';
import {
  AdminLogadoResponseDto,
  MensagemResponseDto,
  TokensAdminResponseDto,
} from '../dto/auth.response.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { TrocarSenhaDto } from '../dto/trocar-senha.dto';
import { PermitidoComSenhaProvisoria } from '../jwt/jwt-admin.guard';
import type { AdminJwtPayload } from '../jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../roles.decorator';
import { AuthService } from '../service/auth.service';

@ApiTags(TAGS.AUTH_ADMIN)
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Publico()
  @Throttle(LIMITE_AUTENTICACAO)
  @ApiOperation({
    summary: 'Login do administrador',
    description:
      'E-mail + senha em troca de access token e refresh token. ' +
      'Se a resposta trouxer `mustChangePassword: true`, apenas /auth/trocar-senha e /auth/me ' +
      'respondem ate a troca ser feita.',
  })
  @ApiOkResponse({ type: TokensAdminResponseDto })
  @ApiUnauthorizedResponse({
    description:
      'Credenciais invalidas. A mesma mensagem cobre e-mail inexistente, senha errada e conta ' +
      'inativa — qualquer diferenca viraria um oraculo para descobrir e-mails validos.',
  })
  login(@Body() dto: LoginDto) {
    return this.authService.loginAdmin(dto.email, dto.senha);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Publico()
  @Throttle(LIMITE_AUTENTICACAO)
  @ApiOperation({
    summary: 'Renova o par de tokens',
    description:
      'Aceita apenas tokens marcados como refresh: um access token nao pode ser trocado por tokens novos.',
  })
  @ApiOkResponse({ type: TokensAdminResponseDto })
  @ApiUnauthorizedResponse({
    description:
      'Refresh token invalido, expirado, do tipo errado, ou admin inativo/inexistente',
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshAdmin(dto.refreshToken);
  }

  @Post('trocar-senha')
  @HttpCode(HttpStatus.OK)
  @Throttle(LIMITE_AUTENTICACAO)
  @SomenteAdmin()
  // unica rota acessivel com senha provisoria pendente — sem ela o admin do seed
  // ficaria travado para sempre
  @PermitidoComSenhaProvisoria()
  @ApiOperation({
    summary: 'Troca a propria senha',
    description:
      'Acessivel mesmo com senha provisoria pendente — e a rota que tira o admin desse estado. ' +
      'Limpa `mustChangePassword` e os campos de reset.',
  })
  @ApiOkResponse({ type: MensagemResponseDto })
  @ApiUnauthorizedResponse({ description: 'Senha atual incorreta' })
  @ApiBadRequestResponse({
    description: 'A nova senha e igual a atual, ou tem menos de 8 caracteres',
  })
  trocarSenha(
    @AdminLogado() admin: AdminJwtPayload,
    @Body() dto: TrocarSenhaDto,
  ) {
    return this.authService.trocarSenha(
      admin.sub,
      dto.senhaAtual,
      dto.novaSenha,
    );
  }

  @Get('me')
  @SomenteAdmin()
  @PermitidoComSenhaProvisoria()
  @ApiOperation({
    summary: 'Dados do admin autenticado',
    description:
      'Le direto do payload do token — nao consulta o banco. Tambem acessivel com senha provisoria pendente.',
  })
  @ApiOkResponse({ type: AdminLogadoResponseDto })
  me(@AdminLogado() admin: AdminJwtPayload) {
    return {
      id: admin.sub,
      email: admin.email,
      perfil: admin.perfil,
      mustChangePassword: admin.mustChangePassword,
    };
  }
}
