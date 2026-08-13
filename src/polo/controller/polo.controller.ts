import {
  Body,
  Controller,
  Delete,
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
  RemocaoPoloDto,
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
      'Popula o dropdown do cadastro de sala. Os polos vem do seed, extraidos ' +
      'da coluna CAMPUS do CSV de alunos. Traz quantas salas, faixas e vinculos de ' +
      'aluno cada polo tem — serve para ver onde falta cadastrar sala e para saber ' +
      'se o polo ainda pode ser apagado (as tres contagens em zero).',
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
    summary: 'Cadastra (ou reativa) um polo',
    description:
      'Para polos que surgirem depois do seed. O nome precisa bater EXATAMENTE com ' +
      'a coluna CAMPUS do CSV de alunos — e a chave de casamento da importacao. ' +
      'Se ja existir um polo INATIVO com esse nome, ele e REATIVADO com o mesmo id: ' +
      'e assim que um campus que saiu da oferta volta, sem perder salas, faixas ' +
      'passadas nem os alunos ja importados. So conflita com polo ativo.',
  })
  @ApiCreatedResponse({ type: PoloDto })
  @ApiConflictResponse({ description: 'Ja existe um polo ATIVO com este nome' })
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

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove um polo sem sala, faixa nem aluno',
    description:
      'Serve para desfazer cadastro errado — como o nome nao pode ser editado, ' +
      'um polo digitado errado ficaria no banco para sempre. Campus que apenas ' +
      'saiu da oferta NAO se apaga: ele sustenta os alunos importados e as provas ' +
      'ja realizadas. Para esse caso, desative (PATCH ativo=false) e cadastre de ' +
      'novo com o mesmo nome quando voltar a ter prova.',
  })
  @ApiParam({ name: 'id', type: Number, example: 6 })
  @ApiOkResponse({ type: RemocaoPoloDto })
  @ApiNotFoundResponse({ description: 'Polo nao encontrado' })
  @ApiConflictResponse({
    description: 'Polo com salas, faixas ou alunos — desative em vez de apagar',
  })
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.poloService.remover(id);
  }
}
