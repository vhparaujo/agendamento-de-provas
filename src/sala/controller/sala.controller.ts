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
  AtualizarSalaDto,
  CriarSalaDto,
  RemocaoDto,
  SalaComPoloDto,
  SalaDto,
} from '../dto/sala.dto';
import { SalaService } from '../service/sala.service';

/**
 * Sala e FISICA e NEUTRA: polo + nome + capacidade, sem modalidade. A modalidade
 * e as vagas so existem quando a sala entra numa faixa (SalaFaixa).
 */
@ApiTags(TAGS.SALAS)
@Controller('salas')
@SomenteAdmin()
export class SalaController {
  constructor(private readonly salaService: SalaService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista as salas',
    description: 'Filtre por polo para montar uma faixa daquele polo.',
  })
  @ApiQuery({ name: 'poloId', required: false, type: Number, example: 6 })
  @ApiQuery({ name: 'apenasAtivas', required: false, type: Boolean })
  @ApiOkResponse({ type: [SalaComPoloDto] })
  listar(
    @Query('poloId', new ParseIntPipe({ optional: true })) poloId?: number,
    @Query('apenasAtivas', new ParseBoolPipe({ optional: true }))
    apenasAtivas?: boolean,
  ) {
    return this.salaService.listar({ poloId, apenasAtivas });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma sala' })
  @ApiParam({ name: 'id', type: Number, example: 21 })
  @ApiOkResponse({ type: SalaComPoloDto })
  @ApiNotFoundResponse({ description: 'Sala nao encontrada' })
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.salaService.buscar(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Cadastra uma sala',
    description:
      'Cadastro manual e o caminho padrao (nao ha import de sala por CSV no MVP). ' +
      'A sala nasce sem modalidade — ela so ganha modalidade e vagas ao entrar numa faixa.',
  })
  @ApiCreatedResponse({ type: SalaDto })
  @ApiNotFoundResponse({ description: 'Polo nao encontrado' })
  @ApiConflictResponse({ description: 'O polo ja tem uma sala com este nome' })
  criar(@Body() dto: CriarSalaDto) {
    return this.salaService.criar(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Atualiza nome, capacidade ou situacao',
    description:
      'O POLO nao muda: sala e espaco fisico, nao se transfere de campus — e mover ' +
      'uma sala ja ofertada mandaria alunos para o polo errado. Sala no lugar errado: ' +
      'crie no polo certo e desative esta.',
  })
  @ApiParam({ name: 'id', type: Number, example: 21 })
  @ApiOkResponse({ type: SalaDto })
  @ApiNotFoundResponse({ description: 'Sala nao encontrada' })
  @ApiConflictResponse({
    description: 'Ja existe outra sala com este nome no polo',
  })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarSalaDto,
  ) {
    return this.salaService.atualizar(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove uma sala nunca ofertada',
    description:
      'So funciona se a sala nunca tiver entrado numa faixa. Com historico, o ' +
      'caminho e desativar: agendamentos passados precisam continuar apontando ' +
      'para um lugar com nome.',
  })
  @ApiParam({ name: 'id', type: Number, example: 21 })
  @ApiOkResponse({ type: RemocaoDto })
  @ApiNotFoundResponse({ description: 'Sala nao encontrada' })
  @ApiConflictResponse({
    description: 'Sala ja usada em faixas — desative em vez de apagar',
  })
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.salaService.remover(id);
  }
}
