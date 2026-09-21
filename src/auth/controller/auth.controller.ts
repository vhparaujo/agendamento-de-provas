import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
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
import { AtualizarPerfilDto } from '../dto/atualizar-perfil.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { TrocarSenhaDto } from '../dto/trocar-senha.dto';
import { PermitidoComSenhaProvisoria } from '../jwt/jwt-admin.guard';
import type { AdminJwtPayload } from '../jwt/jwt.types';
import {
  AdminLogado,
  NiveisPermitidos,
  SomenteAdmin,
} from '../roles.decorator';
import { NivelAdmin } from '../../generated/prisma/client';
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
  // Todo admin troca a PROPRIA senha, em qualquer nivel. Sem esta linha, o guard
  // de nivel trancaria o assistente e o visualizador na tela de senha provisoria
  // — presos num 403 na unica rota que os tiraria de la.
  @NiveisPermitidos(
    NivelAdmin.ASSISTENTE_OPERACIONAL,
    NivelAdmin.VISUALIZADOR_EXECUTIVO,
  )
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

  @Patch('perfil')
  @Throttle(LIMITE_AUTENTICACAO)
  @SomenteAdmin()
  // Todo admin edita a PROPRIA conta, em qualquer nivel: o perfil e da pessoa,
  // nao do nivel dela.
  @NiveisPermitidos(
    NivelAdmin.ASSISTENTE_OPERACIONAL,
    NivelAdmin.VISUALIZADOR_EXECUTIVO,
  )
  // ⚠️ SEM @PermitidoComSenhaProvisoria(), de proposito: com a senha provisoria
  // pendente o admin tem UMA coisa a fazer, que e troca-la. Liberar a edicao do
  // perfil ali daria uma saida lateral ao estado que existe para forcar isso.
  @ApiOperation({
    summary: 'Edita o proprio nome e e-mail',
    description:
      'O perfil da pessoa autenticada, aberto aos **tres niveis**.\n\n' +
      '**Trocar o `email` exige `senhaAtual`** — ele e metade da credencial de ' +
      'login, e uma sessao roubada nao pode troca-lo sozinha. Mudar so o `nome` ' +
      'nao pede senha.\n\n' +
      'O `nome` vazio APAGA o nome (a tela volta a mostrar o e-mail). Campo ' +
      'ausente nao e tocado.\n\n' +
      '⚠️ Nome e e-mail viajam no access token: **renove os tokens em ' +
      '`POST /auth/refresh` logo depois**, senao a tela continua mostrando os ' +
      'valores antigos ate a proxima renovacao.',
  })
  @ApiOkResponse({ type: AdminLogadoResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Senha atual incorreta, ou conta inativa/inexistente',
  })
  @ApiConflictResponse({
    description: 'Ja existe um administrador com o e-mail pedido',
  })
  @ApiBadRequestResponse({
    description:
      'E-mail invalido, nome longo demais, ou `senhaAtual` ausente na troca de e-mail',
  })
  async atualizarPerfil(
    @AdminLogado() admin: AdminJwtPayload,
    @Body() dto: AtualizarPerfilDto,
  ) {
    const atualizado = await this.authService.atualizarPerfil(admin.sub, dto);

    // O nivel e o mustChangePassword vem do token: nenhum dos dois muda aqui, e
    // rele-los do banco so para devolver o mesmo valor seria consulta a toa.
    return {
      ...atualizado,
      perfil: admin.perfil,
      nivel: admin.nivel,
      mustChangePassword: admin.mustChangePassword,
    };
  }

  @Get('me')
  @SomenteAdmin()
  // Quem esta logado precisa saber quem e, em qualquer nivel — e e daqui que a
  // tela descobre o proprio nivel para montar o menu.
  @NiveisPermitidos(
    NivelAdmin.ASSISTENTE_OPERACIONAL,
    NivelAdmin.VISUALIZADOR_EXECUTIVO,
  )
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
      nome: admin.nome ?? null,
      perfil: admin.perfil,
      nivel: admin.nivel,
      mustChangePassword: admin.mustChangePassword,
    };
  }
}
