import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { TrocarSenhaDto } from '../dto/trocar-senha.dto';
import { PermitidoComSenhaProvisoria } from '../jwt/jwt-admin.guard';
import type { AdminJwtPayload } from '../jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../roles.decorator';
import { AuthService } from '../service/auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.loginAdmin(dto.email, dto.senha);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshAdmin(dto.refreshToken);
  }

  @Post('trocar-senha')
  @HttpCode(HttpStatus.OK)
  @SomenteAdmin()
  // unica rota acessivel com senha provisoria pendente — sem ela o admin do seed
  // ficaria travado para sempre
  @PermitidoComSenhaProvisoria()
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
  me(@AdminLogado() admin: AdminJwtPayload) {
    return {
      id: admin.sub,
      email: admin.email,
      perfil: admin.perfil,
      mustChangePassword: admin.mustChangePassword,
    };
  }
}
