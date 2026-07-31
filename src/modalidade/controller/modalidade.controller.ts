import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { ModalidadeDto } from '../dto/modalidade.response.dto';
import { ModalidadeService } from '../service/modalidade.service';

@ApiTags(TAGS.MODALIDADES)
@Controller('modalidades')
@SomenteAdmin()
export class ModalidadeController {
  constructor(private readonly modalidadeService: ModalidadeService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista as modalidades',
    description:
      'Popula o dropdown ao montar uma faixa. As modalidades vem do seed e nao ' +
      'sao editaveis pela API: mudar a duracao de prova de um semestre em curso ' +
      'invalidaria faixas ja publicadas aos alunos.',
  })
  @ApiOkResponse({ type: [ModalidadeDto] })
  listar() {
    return this.modalidadeService.listar();
  }
}
