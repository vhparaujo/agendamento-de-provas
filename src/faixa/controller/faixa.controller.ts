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
  ApiBadRequestResponse,
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
  AtualizarFaixaDto,
  CriarFaixaDto,
  FaixaDetalheDto,
  RemocaoFaixaDto,
  SalaDaFaixaDto,
} from '../dto/faixa.dto';
import { FaixaService } from '../service/faixa.service';

/**
 * Faixa e um HORARIO NEUTRO (polo + data + hora), sem formato. A oferta real
 * — formato, vagas e ordem de preenchimento — vive nas SalaFaixa que ela
 * carrega. E o admin quem monta isso ao criar a faixa.
 */
@ApiTags(TAGS.FAIXAS)
@Controller('faixas')
@SomenteAdmin()
export class FaixaController {
  constructor(private readonly faixaService: FaixaService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista as faixas com a ocupacao de cada sala',
    description:
      'Cada faixa vem com suas ofertas (sala + formato + vagas + ordem) e ' +
      'quantas vagas ja foram tomadas.',
  })
  @ApiQuery({ name: 'poloId', required: false, type: Number, example: 6 })
  @ApiQuery({
    name: 'modalidadeId',
    required: false,
    type: Number,
    example: 1,
    description: 'Traz so faixas que ofertam este formato.',
  })
  @ApiQuery({
    name: 'de',
    required: false,
    type: String,
    example: '2026-08-01',
  })
  @ApiQuery({
    name: 'ate',
    required: false,
    type: String,
    example: '2026-08-31',
  })
  @ApiQuery({ name: 'apenasAtivas', required: false, type: Boolean })
  @ApiOkResponse({ type: [FaixaDetalheDto] })
  listar(
    @Query('poloId', new ParseIntPipe({ optional: true })) poloId?: number,
    @Query('modalidadeId', new ParseIntPipe({ optional: true }))
    modalidadeId?: number,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('apenasAtivas', new ParseBoolPipe({ optional: true }))
    apenasAtivas?: boolean,
  ) {
    return this.faixaService.listar({
      poloId,
      modalidadeId,
      de,
      ate,
      apenasAtivas,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma faixa e sua ocupacao' })
  @ApiParam({ name: 'id', type: Number, example: 14 })
  @ApiOkResponse({ type: FaixaDetalheDto })
  @ApiNotFoundResponse({ description: 'Faixa nao encontrada' })
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.faixaService.buscar(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria a faixa e monta a oferta de vagas',
    description:
      'Faixa e salas nascem juntas, numa transacao. Regras verificadas na hora, ' +
      'porque errar aqui so apareceria no dia da prova:\n\n' +
      '- a sala precisa ser do MESMO polo da faixa;\n' +
      '- a janela precisa comportar a prova (faixa de 1h30 nao recebe sala EaD de 3h);\n' +
      '- `vagas` nao passa da capacidade da sala;\n' +
      '- a mesma sala entra uma unica vez por faixa;\n' +
      '- a sala nao pode ter outra prova no mesmo dia em horario que se ' +
      'sobreponha, mesmo que em outra faixa;\n' +
      '- `ordem` e unica dentro de faixa + formato.',
  })
  @ApiCreatedResponse({ type: FaixaDetalheDto })
  @ApiBadRequestResponse({
    description:
      'Sala de outro polo, sala inativa, prova que nao cabe na janela, vagas acima da capacidade ou horario invertido',
  })
  @ApiNotFoundResponse({
    description: 'Polo, sala ou formato nao encontrado',
  })
  @ApiConflictResponse({
    description:
      'Faixa identica ja existe no polo, ordem repetida no formato, ou ' +
      'sala ja ocupada por outra faixa que se sobrepoe no relogio',
  })
  criar(@Body() dto: CriarFaixaDto) {
    return this.faixaService.criar(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Ajusta data, horario ou situacao da faixa',
    description:
      'Encurtar a janela e recusado quando ja existe oferta cuja prova nao caberia ' +
      'mais — do contrario a faixa viraria uma oferta impossivel sem ninguem notar.\n\n' +
      'Mudar data ou horario arrasta TODAS as salas da faixa junto, entao a ' +
      'sobreposicao com outras faixas e reconferida: um horario que nao chocava ' +
      'pode passar a chocar. Um PATCH so de `ativo` nao dispara essa checagem.',
  })
  @ApiParam({ name: 'id', type: Number, example: 14 })
  @ApiOkResponse({ type: FaixaDetalheDto })
  @ApiBadRequestResponse({
    description: 'Horario invertido, ou prova ofertada nao cabe mais',
  })
  @ApiNotFoundResponse({ description: 'Faixa nao encontrada' })
  @ApiConflictResponse({
    description:
      'O novo horario poria alguma sala da faixa em duas provas ao mesmo tempo',
  })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarFaixaDto,
  ) {
    return this.faixaService.atualizar(id, dto);
  }

  @Post(':id/salas')
  @ApiOperation({
    summary: 'Adiciona uma sala a uma faixa existente',
    description:
      'Mesmas regras da criacao. Sem `ordem`, entra no fim da fila de ' +
      'preenchimento daquele formato.',
  })
  @ApiParam({ name: 'id', type: Number, example: 14 })
  @ApiCreatedResponse({ type: FaixaDetalheDto })
  @ApiBadRequestResponse({
    description: 'Sala de outro polo, inativa, ou prova que nao cabe',
  })
  @ApiNotFoundResponse({
    description: 'Faixa, sala ou formato nao encontrado',
  })
  @ApiConflictResponse({
    description:
      'Sala ja esta nesta faixa, ordem repetida, ou a sala ja tem prova em ' +
      'outra faixa que se sobrepoe no relogio',
  })
  adicionarSala(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SalaDaFaixaDto,
  ) {
    return this.faixaService.adicionarSala(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove uma faixa sem agendamentos',
    description:
      'Com agendamentos, o caminho e desativar: apagar levaria junto o registro ' +
      'de alunos que ja tem prova marcada.',
  })
  @ApiParam({ name: 'id', type: Number, example: 14 })
  @ApiOkResponse({ type: RemocaoFaixaDto })
  @ApiNotFoundResponse({ description: 'Faixa nao encontrada' })
  @ApiConflictResponse({
    description: 'Faixa com agendamentos — desative em vez de apagar',
  })
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.faixaService.remover(id);
  }
}
