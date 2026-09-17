import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import {
  CelulaDeGrupoResponseDto,
  SalvarGradeDeGruposDto,
} from '../dto/grade-grupos.dto';
import { GradeGruposService } from '../service/grade-grupos.service';

/**
 * A grade dia x janela dos grupos que liberam a prova (14/09/2026).
 *
 * Vive em `senhas-de-prova/grupos` porque e parte da mesma aba e do mesmo lote
 * de datas. ⚠️ Registrado ANTES de `GradeSenhasController` no modulo: aquele tem
 * `:id` como primeiro segmento, e a ordem e o que impede "grupos" de ser lido
 * como id de celula de senha.
 */
@ApiTags(TAGS.SENHAS_QUIZ)
@Controller('senhas-de-prova/grupos')
@SomenteAdmin()
export class GradeGruposController {
  constructor(private readonly grade: GradeGruposService) {}

  @Get()
  @ApiOperation({
    summary: 'A grade de grupos do intervalo',
    description:
      'Uma linha por celula CADASTRADA (dia x janela). A tela desenha as vazias.\n\n' +
      'Celula ausente nao significa "sem grupo": o dia usa o nome fixo da ' +
      'janela, se houver. Sem os dois, numa janela que ja usou a grade, o ' +
      'disparo registra `SEM_GRUPO_NO_DIA` em cada questionario — a prova abre ' +
      'no horario certo, mas para o grupo da sessao anterior.',
  })
  @ApiQuery({ name: 'de', example: '2026-09-14', description: 'AAAA-MM-DD.' })
  @ApiQuery({ name: 'ate', example: '2026-09-19', description: 'AAAA-MM-DD.' })
  @ApiOkResponse({ type: [CelulaDeGrupoResponseDto] })
  @ApiBadRequestResponse({ description: 'Intervalo ausente ou invalido' })
  listar(@Query('de') de?: string, @Query('ate') ate?: string) {
    const dia = /^\d{4}-\d{2}-\d{2}$/;

    if (!de || !ate || !dia.test(de) || !dia.test(ate)) {
      throw new BadRequestException(
        'Informe as datas De e Até: a grade é sempre de um intervalo.',
      );
    }

    return this.grade.listar(de, ate);
  }

  @Put()
  @ApiOperation({
    summary: 'Grava celulas da grade de grupos',
    description:
      'Upsert por (data, janela), em lote e numa transacao. Celula que nao vier ' +
      'no corpo nao e tocada; celula com `nomeGrupo` vazio e **apagada**.\n\n' +
      'A `versao` sobe so quando o nome ou a categoria mudam — e o que libera a ' +
      'janela para disparar de novo HOJE depois de uma correcao, sem fazer um ' +
      'simples "salvar" reprocessar a instituicao.\n\n' +
      'Devolve as celulas do intervalo coberto pelo corpo.',
  })
  @ApiOkResponse({ type: [CelulaDeGrupoResponseDto] })
  @ApiBadRequestResponse({
    description:
      'Data fora de AAAA-MM-DD, janela inexistente, ou a mesma celula duas vezes',
  })
  salvar(
    @Body() dto: SalvarGradeDeGruposDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.grade.salvar(dto.celulas, admin.email);
  }
}
