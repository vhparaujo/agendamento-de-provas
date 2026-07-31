import {
  Body,
  Controller,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import {
  AtualizarPoloDto,
  CriarPoloDto,
  PoloComContagensDto,
  PoloDto,
} from '../dto/polo.dto';
import { PoloService } from '../service/polo.service';

@ApiTags(TAGS.POLOS)
@Controller('polos')
@SomenteAdmin()
export class PoloController {
  constructor(private readonly poloService: PoloService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os polos',
    description:
      'Popula o dropdown do cadastro de sala. Os 27 polos vem do seed, extraidos ' +
      'da coluna CAMPUS do CSV de alunos. Traz quantas salas e quantos vinculos de ' +
      'aluno cada polo tem, para o admin ver onde ainda falta cadastrar sala.',
  })
  @ApiQuery({
    name: 'apenasAtivos',
    required: false,
    type: Boolean,
    description: 'true devolve so os polos ativos.',
  })
  @ApiOkResponse({ type: [PoloComContagensDto] })
  listar(
    @Query('apenasAtivos', new ParseBoolPipe({ optional: true }))
    apenasAtivos?: boolean,
  ) {
    return this.poloService.listar(apenasAtivos);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um polo' })
  @ApiParam({ name: 'id', type: Number, example: 6 })
  @ApiOkResponse({ type: PoloComContagensDto })
  @ApiNotFoundResponse({ description: 'Polo nao encontrado' })
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.poloService.buscar(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Cadastra um polo',
    description:
      'Para polos que surgirem depois do seed. O nome precisa bater EXATAMENTE com ' +
      'a coluna CAMPUS do CSV de alunos — e a chave de casamento da importacao.',
  })
  @ApiCreatedResponse({ type: PoloDto })
  @ApiConflictResponse({ description: 'Ja existe um polo com este nome' })
  criar(@Body() dto: CriarPoloDto) {
    return this.poloService.criar(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Atualiza cidade e situacao do polo',
    description:
      'O NOME nao pode ser alterado: renomear quebraria em silencio o casamento ' +
      'com o CSV, e o proximo upload rejeitaria o campus inteiro. Se o nome estiver ' +
      'errado, corrija na planilha e cadastre o polo certo.',
  })
  @ApiParam({ name: 'id', type: Number, example: 6 })
  @ApiOkResponse({ type: PoloDto })
  @ApiNotFoundResponse({ description: 'Polo nao encontrado' })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarPoloDto,
  ) {
    return this.poloService.atualizar(id, dto);
  }
}
