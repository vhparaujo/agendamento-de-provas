import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
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
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { TAGS } from '../../config/swagger';
import {
  AtualizarPeriodoDto,
  CriarPeriodoDto,
  PeriodoAdminDto,
  RemocaoPeriodoDto,
} from '../dto/periodo.dto';
import { PeriodoService } from '../service/periodo.service';

/**
 * A janela em que se pode agendar — nao confundir com as datas das provas, que
 * sao as faixas. Sao duas linhas do tempo independentes.
 *
 * O periodo fecha SO por data/hora. Vaga esgotando e problema de capacidade (o
 * admin abre mais salas), nunca motivo para encerrar o agendamento de quem ainda
 * nao escolheu.
 */
@ApiTags(TAGS.PERIODO)
@Controller('periodos')
@SomenteAdmin()
export class PeriodoController {
  constructor(private readonly periodoService: PeriodoService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os periodos, do mais recente para o mais antigo',
    description:
      'O primeiro da lista e o vigente — e o unico que o portal do aluno consulta. ' +
      'Os anteriores ficam para consulta e exportacao.',
  })
  @ApiOkResponse({ type: [PeriodoAdminDto] })
  listar() {
    return this.periodoService.listar();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um periodo' })
  @ApiParam({ name: 'id', type: Number, example: 3 })
  @ApiOkResponse({ type: PeriodoAdminDto })
  @ApiNotFoundResponse({ description: 'Periodo nao encontrado' })
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.periodoService.buscar(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria o periodo de agendamento de um semestre',
    description:
      'Nasce FECHADO por padrao, para o admin conferir as faixas antes de liberar ' +
      'os alunos — abra com PATCH quando estiver pronto.\n\n' +
      'Criar um periodo novo TROCA o vigente, porque vigente = mais recente. ' +
      'Repetir o `periodoLetivoId` do vigente e recusado com 409: quase sempre e ' +
      'tentativa de corrigir o atual, e criar outro deixaria dois periodos ' +
      'disputando o mesmo semestre.',
  })
  @ApiCreatedResponse({ type: PeriodoAdminDto })
  @ApiBadRequestResponse({
    description: 'Data invalida, ou dataAbertura depois de dataFechamento',
  })
  @ApiConflictResponse({
    description:
      'Ja existe periodo vigente para este periodo letivo NA MESMA rodada — ' +
      'repetir o semestre com outra rodada e o cadastro da proxima prova dele',
  })
  criar(@Body() dto: CriarPeriodoDto) {
    return this.periodoService.criar(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Abre, fecha ou ajusta o prazo',
    description:
      'Antecipar o fechamento encerra o agendamento na hora, mas **nao desfaz nada**: ' +
      'quem ja marcou continua com a prova. O periodo so barra quem ainda nao escolheu.\n\n' +
      'A `rodada` so pode ser corrigida enquanto a janela estiver **vazia** ' +
      '(sem agendamento nenhum, cancelados inclusive) — depois disso, 409. O ' +
      '`periodoLetivoId` nunca muda.',
  })
  @ApiParam({ name: 'id', type: Number, example: 3 })
  @ApiOkResponse({ type: PeriodoAdminDto })
  @ApiBadRequestResponse({ description: 'Data invalida ou janela invertida' })
  @ApiNotFoundResponse({ description: 'Periodo nao encontrado' })
  @ApiConflictResponse({
    description:
      'Tentou trocar a `rodada` de uma janela que ja tem agendamento — a rodada ' +
      'da reserva e fotografia, e as provas ficariam orfas do par',
  })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarPeriodoDto,
  ) {
    return this.periodoService.atualizar(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove um periodo que ainda nao tem agendamento nenhum',
    description:
      'Serve para desfazer cadastro errado, e para o caso em que o semestre ' +
      'seguinte foi criado cedo demais: vigente = **o cadastrado mais ' +
      'recentemente**, entao a linha nova ROUBA o vigente do periodo em curso, ' +
      'e nao ha como marcar outro no lugar.\n\n' +
      '**Apagar o vigente entrega o portal ao periodo anterior** — em geral com ' +
      'o prazo ja vencido. Quem assumiu volta em `vigenteAgora`; confira antes ' +
      'de sair da tela.\n\n' +
      'Periodo letivo com agendamento (**contando os cancelados**) e recusado ' +
      'com 409: a linha some, as provas nao — elas ficariam sem a janela que as ' +
      'identifica e sumiriam do portal do aluno. Para encerrar o prazo sem ' +
      'perder o historico, use o PATCH.',
  })
  @ApiParam({ name: 'id', type: Number, example: 80 })
  @ApiOkResponse({ type: RemocaoPeriodoDto })
  @ApiNotFoundResponse({ description: 'Periodo nao encontrado' })
  @ApiConflictResponse({
    description:
      'O periodo letivo ja tem agendamentos — encerre pelo PATCH em vez de apagar',
  })
  remover(
    @Param('id', ParseIntPipe) id: number,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.periodoService.remover(id, admin.email);
  }
}
