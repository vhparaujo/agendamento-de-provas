import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import { CriarAdminDto } from '../dto/criar-admin.dto';
import { DefinirAtivoDto } from '../dto/definir-ativo.dto';
import { AdminService } from '../service/admin.service';

/**
 * Gestao de administradores. Todas as rotas exigem um JWT de admin — nao ha
 * niveis: qualquer admin autenticado pode criar outro ou resetar senha alheia.
 */
@Controller('admins')
@SomenteAdmin()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  listar() {
    return this.adminService.listar();
  }

  @Post()
  criar(@Body() dto: CriarAdminDto) {
    return this.adminService.criar(dto);
  }

  @Post(':id/resetar-senha')
  resetarSenha(
    @Param('id') id: string,
    @AdminLogado() solicitante: AdminJwtPayload,
  ) {
    return this.adminService.resetarSenha(id, solicitante.sub);
  }

  @Patch(':id/ativo')
  definirAtivo(
    @Param('id') id: string,
    @Body() dto: DefinirAtivoDto,
    @AdminLogado() solicitante: AdminJwtPayload,
  ) {
    return this.adminService.definirAtivo(id, dto.ativo, solicitante.sub);
  }
}
