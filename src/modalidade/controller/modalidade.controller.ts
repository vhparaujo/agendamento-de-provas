import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NiveisPermitidos, SomenteAdmin } from '../../auth/roles.decorator';
import { NivelAdmin } from '../../generated/prisma/client';
import { TAGS } from '../../config/swagger';
import { ModalidadeDto } from '../dto/modalidade.response.dto';
import { ModalidadeService } from '../service/modalidade.service';

@ApiTags(TAGS.MODALIDADES)
@Controller('modalidades')
@SomenteAdmin()
export class ModalidadeController {
  constructor(private readonly modalidadeService: ModalidadeService) {}

  @Get()
  @NiveisPermitidos(NivelAdmin.ASSISTENTE_OPERACIONAL)
  @ApiOperation({
    summary: 'Lista os formatos',
    description:
      'Popula o dropdown ao montar uma faixa. Os formatos vem do seed e nao ' +
      'sao editaveis pela API: mudar a duracao de prova de um semestre em curso ' +
      'invalidaria faixas ja publicadas aos alunos.',
  })
  @ApiOkResponse({ type: [ModalidadeDto] })
  listar() {
    return this.modalidadeService.listar();
  }
}
