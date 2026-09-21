import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import {
  AdminCriadoResponseDto,
  AdminResumoDto,
  SenhaResetadaResponseDto,
} from '../dto/admin.response.dto';
import { CriarAdminDto } from '../dto/criar-admin.dto';
import { DefinirAtivoDto } from '../dto/definir-ativo.dto';
import { DefinirNivelDto } from '../dto/definir-nivel.dto';
import { AdminService } from '../service/admin.service';

/**
 * Gestao de administradores. **So SUPERADMIN**, e por isso nenhuma rota daqui
 * leva `@NiveisPermitidos` — na ausencia do decorator o guard fecha para os
 * demais niveis (ver src/auth/jwt/niveis.ts).
 *
 * E a unica tela que concede acesso: quem a abre pode criar contas, resetar
 * senha alheia e promover alguem a superadministrador.
 */
@ApiTags(TAGS.ADMINS)
@Controller('admins')
@SomenteAdmin()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os administradores',
    description: 'Ordenada por data de criacao. Nunca expoe hash de senha.',
  })
  @ApiOkResponse({ type: [AdminResumoDto] })
  listar() {
    return this.adminService.listar();
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um administrador',
    description:
      'O `nivel` e obrigatorio: quem cria a conta escolhe o que ela podera fazer, nunca ' +
      'por omissao.\n\n' +
      'Sem `senha` no corpo, o sistema gera uma provisoria e a devolve UMA unica vez. ' +
      'Em ambos os casos a conta nasce com `mustChangePassword: true`, para que so o dono ' +
      'conheca a senha final.',
  })
  @ApiCreatedResponse({ type: AdminCriadoResponseDto })
  @ApiConflictResponse({
    description: 'Ja existe um administrador com este e-mail',
  })
  criar(@Body() dto: CriarAdminDto) {
    return this.adminService.criar(dto);
  }

  @Post(':id/resetar-senha')
  @ApiOperation({
    summary: 'Reset administrativo de senha',
    description:
      'Um admin gera senha provisoria para outro — nao ha reset por e-mail no MVP. ' +
      'A senha e devolvida UMA unica vez, para repasse por canal interno.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Id do admin alvo' })
  @ApiCreatedResponse({ type: SenhaResetadaResponseDto })
  @ApiNotFoundResponse({ description: 'Administrador nao encontrado' })
  resetarSenha(
    @Param('id') id: string,
    @AdminLogado() solicitante: AdminJwtPayload,
  ) {
    return this.adminService.resetarSenha(id, solicitante.sub);
  }

  @Patch(':id/ativo')
  @ApiOperation({
    summary: 'Ativa ou desativa um administrador',
    description:
      'Duas travas: ninguem desativa a si mesmo, e o ultimo admin ativo nao pode ser desativado — ' +
      'do contrario o sistema ficaria sem acesso administrativo.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminResumoDto })
  @ApiNotFoundResponse({ description: 'Administrador nao encontrado' })
  @ApiBadRequestResponse({
    description:
      'Auto-desativacao, ou tentativa de desativar o ultimo admin ativo',
  })
  definirAtivo(
    @Param('id') id: string,
    @Body() dto: DefinirAtivoDto,
    @AdminLogado() solicitante: AdminJwtPayload,
  ) {
    return this.adminService.definirAtivo(id, dto.ativo, solicitante.sub);
  }

  @Patch(':id/nivel')
  @ApiOperation({
    summary: 'Define o nível de acesso de um administrador',
    description:
      'Duas travas, da mesma familia da auto-desativacao: ninguem altera o proprio nivel, ' +
      'e o ultimo superadministrador ativo nao pode ser rebaixado — do contrario o sistema ' +
      'ficaria sem ninguem capaz de conceder acesso.\n\n' +
      'A mudanca vale no proximo refresh de token da pessoa (no maximo 15 min): o nivel ' +
      'viaja no access token, e o refresh o rele do banco.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminResumoDto })
  @ApiNotFoundResponse({ description: 'Administrador nao encontrado' })
  @ApiBadRequestResponse({
    description:
      'Alteracao do proprio nivel, ou rebaixamento do ultimo superadministrador ativo',
  })
  definirNivel(
    @Param('id') id: string,
    @Body() dto: DefinirNivelDto,
    @AdminLogado() solicitante: AdminJwtPayload,
  ) {
    return this.adminService.definirNivel(id, dto.nivel, solicitante.sub);
  }
}
