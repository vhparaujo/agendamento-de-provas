import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import {
  AtualizarOfertaDto,
  OfertaDetalheDto,
  RemocaoFaixaDto,
} from '../../faixa/dto/faixa.dto';
import { SalaFaixaService } from '../service/sala-faixa.service';

/**
 * Uma oferta = Sala + Faixa + Modalidade + vagas + ordem (SalaFaixa). E o nucleo
 * do modelo: e aqui que modalidade e vaga existem de fato.
 *
 * Criar oferta e feito pelas rotas de faixa (POST /faixas e POST /faixas/:id/salas),
 * porque oferta nasce sempre dentro de uma faixa.
 */
@ApiTags(TAGS.FAIXAS)
@Controller('sala-faixas')
@SomenteAdmin()
export class SalaFaixaController {
  constructor(private readonly salaFaixaService: SalaFaixaService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma oferta e sua ocupacao' })
  @ApiParam({ name: 'id', type: Number, example: 55 })
  @ApiOkResponse({ type: OfertaDetalheDto })
  @ApiNotFoundResponse({ description: 'Oferta nao encontrada' })
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.salaFaixaService.buscar(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Ajusta vagas e ordem de preenchimento',
    description:
      'A MODALIDADE nao muda por aqui: dentro de uma faixa a sala fica travada ' +
      'numa modalidade, e troca-la depois de haver agendamento colocaria alunos ' +
      'numa prova de outra duracao. Para mudar, remova a oferta e adicione de novo.\n\n' +
      'Reduzir `vagas` abaixo do numero de alunos ja agendados e recusado.',
  })
  @ApiParam({ name: 'id', type: Number, example: 55 })
  @ApiOkResponse({ type: OfertaDetalheDto })
  @ApiBadRequestResponse({ description: 'vagas acima da capacidade da sala' })
  @ApiNotFoundResponse({ description: 'Oferta nao encontrada' })
  @ApiConflictResponse({
    description:
      'Ordem ja usada na modalidade, ou vagas abaixo dos agendamentos existentes',
  })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarOfertaDto,
  ) {
    return this.salaFaixaService.atualizar(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Tira uma sala da faixa',
    description: 'So enquanto nenhum aluno tiver sido alocado nela.',
  })
  @ApiParam({ name: 'id', type: Number, example: 55 })
  @ApiOkResponse({ type: RemocaoFaixaDto })
  @ApiNotFoundResponse({ description: 'Oferta nao encontrada' })
  @ApiConflictResponse({ description: 'Ja ha alunos agendados nesta sala' })
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.salaFaixaService.remover(id);
  }
}
