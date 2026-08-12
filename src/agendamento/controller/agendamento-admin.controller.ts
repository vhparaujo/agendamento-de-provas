import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { StatusAgendamento } from '../../generated/prisma/client';
import {
  AgendamentoAdminDto,
  EventoDoHistoricoDto,
  LinhaDoResumoDto,
  MensagemDto,
  PaginaDeAgendamentosDto,
  RemanejarDto,
} from '../dto/agendamento-admin.dto';
import { AgendamentoAdminService } from '../service/agendamento-admin.service';

/** Filtros compartilhados pela listagem, pelo resumo e pela exportacao. */
const FILTROS = [
  { name: 'poloId', type: Number, example: 6 },
  { name: 'faixaId', type: Number, example: 14 },
  { name: 'salaId', type: Number, example: 21 },
  { name: 'modalidadeId', type: Number, example: 1 },
  { name: 'periodoLetivoId', type: String, example: '103' },
  {
    name: 'de',
    type: String,
    example: '2026-08-01',
    description: 'Data da PROVA, nao do agendamento (AAAA-MM-DD).',
  },
  { name: 'ate', type: String, example: '2026-08-31' },
] as const;

/** Os mesmos @ApiQuery nas tres rotas, sem repetir sete blocos em cada uma. */
const aplicarFiltros = () =>
  applyDecorators(...FILTROS.map((f) => ApiQuery({ required: false, ...f })));

/**
 * A visao do admin sobre o que os alunos marcaram. Somente leitura: o
 * agendamento nasce pelo portal do aluno, e o remanejo e um passo a parte.
 */
@ApiTags(TAGS.AGENDAMENTOS)
@Controller('agendamentos')
@SomenteAdmin()
export class AgendamentoAdminController {
  constructor(private readonly service: AgendamentoAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os agendamentos, com filtros e paginacao',
    description:
      'Ordenado por data, horario, ordem da sala e matricula — a mesma ordem em ' +
      'que a prova acontece.\n\n' +
      'Sem `status`, traz apenas os **confirmados**: um cancelado na lista do dia ' +
      'faria alguem procurar um aluno que nao vem.',
  })
  @aplicarFiltros()
  @ApiQuery({
    name: 'busca',
    required: false,
    type: String,
    example: 'UC254',
    description: 'Casa com matricula, nome do aluno ou curso.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: StatusAgendamento,
    description: 'Padrao: CONFIRMADO.',
  })
  @ApiQuery({ name: 'pagina', required: false, type: Number, example: 1 })
  @ApiQuery({
    name: 'porPagina',
    required: false,
    type: Number,
    example: 50,
    description: 'Padrao 50, maximo 200.',
  })
  @ApiOkResponse({ type: PaginaDeAgendamentosDto })
  listar(@Query() query: Record<string, string>) {
    return this.service.listar(this.lerFiltro(query));
  }

  @Get('resumo')
  @ApiOperation({
    summary: 'Ocupacao por sala',
    description:
      'Quantas pessoas em cada sala de cada faixa. E a pergunta operacional do ' +
      'dia da prova: quais salas abrir, quantos fiscais, e quais ficaram vazias.',
  })
  @aplicarFiltros()
  @ApiOkResponse({ type: [LinhaDoResumoDto] })
  resumo(@Query() query: Record<string, string>) {
    return this.service.resumo(this.lerFiltro(query));
  }

  @Get('exportacao')
  @ApiOperation({
    summary: 'Baixa o CSV de TODOS os alunos, agendados ou nao',
    description:
      'Uma linha por **vinculo importado** (aluno + curso), nao por agendamento: ' +
      'quem ainda nao marcou prova sai no arquivo com as colunas da prova vazias ' +
      'e `Status = Não Agendado`. E essa a lista que a secretaria usa para cobrar ' +
      'quem falta.\n\n' +
      'Colunas: Matricula, Aluno, E-mail, Curso, Modalidade, Polo, Data da prova, ' +
      'Inicio, Fim, Sala, Status (`Agendado` | `Não Agendado`) e Agendado em.\n\n' +
      'O arquivo baixa como **`Lista Agendamento-<data>.csv`**.\n\n' +
      'O recorte e **um periodo letivo** — o de `periodoLetivoId` ou, sem ele, o ' +
      'vigente. Um agendamento **cancelado** conta como `Não Agendado`: quem ' +
      'cancelou e nao remarcou precisa ser contatado igual a quem nunca entrou.\n\n' +
      '`faixaId`, `salaId`, `de` e `ate` sao filtros da **prova** e, quando ' +
      'informados, restringem o arquivo a quem tem prova ali. `poloId`, ' +
      '`modalidadeId` e `busca` filtram o aluno e continuam trazendo quem nao ' +
      'agendou. `status` nao se aplica aqui — a coluna e derivada.\n\n' +
      'Sai com BOM UTF-8 e separado por `;`, para abrir direto no Excel em ' +
      'portugues sem estragar os acentos.',
  })
  @aplicarFiltros()
  @ApiQuery({
    name: 'busca',
    required: false,
    type: String,
    description: 'Casa com matricula, nome, e-mail ou curso.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Arquivo CSV',
    schema: { type: 'string', format: 'binary' },
  })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportar(
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.service.exportarCsv(this.lerFiltro(query));

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.service.nomeDoArquivo()}"`,
    );

    return csv;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um agendamento' })
  @ApiParam({ name: 'id', type: Number, example: 501 })
  @ApiOkResponse({ type: AgendamentoAdminDto })
  @ApiNotFoundResponse({ description: 'Agendamento nao encontrado' })
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.service.buscar(id);
  }

  @Get(':id/historico')
  @ApiOperation({
    summary: 'Quem mexeu neste agendamento',
    description:
      'A tela para quando o aluno reclama que mudaram a prova dele sem avisar. ' +
      'Cada linha diz o que aconteceu, **quem fez** (`autorTipo`: ALUNO ou ADMIN, ' +
      'com a matricula ou o e-mail em `autor`) e de que horario para qual.\n\n' +
      'O registro e gravado na mesma transacao da alteracao — nao existe mudanca ' +
      'sem autor.',
  })
  @ApiParam({ name: 'id', type: Number, example: 501 })
  @ApiOkResponse({ type: [EventoDoHistoricoDto] })
  @ApiNotFoundResponse({ description: 'Agendamento nao encontrado' })
  historico(@Param('id', ParseIntPipe) id: number) {
    return this.service.historico(id);
  }

  @Patch(':id/remanejar')
  @ApiOperation({
    summary: 'Move o aluno de sala ou de horario',
    description:
      'A valvula de escape: sala interditada, aluno com necessidade especifica, ' +
      'prazo perdido. Marca `alocadoManual: true`, para ninguem depois achar que ' +
      'a alocacao sequencial produziu aquilo.\n\n' +
      'Informe **`salaFaixaId`** (sala exata) OU **`faixaId`** (outro horario, ' +
      'deixando a alocacao escolher a sala) — um dos dois.\n\n' +
      'Diferente do aluno, o admin **nao depende do periodo estar aberto**: ' +
      'consertar depois do fechamento e justamente o caso de uso.\n\n' +
      'Recusa mudar de **polo** (o aluno viajaria para o campus errado) e de ' +
      '**modalidade** (a prova tem outra duracao). A vaga da sala de destino e ' +
      'conferida sob lock, como no agendamento normal.',
  })
  @ApiParam({ name: 'id', type: Number, example: 501 })
  @ApiOkResponse({ type: AgendamentoAdminDto })
  @ApiBadRequestResponse({
    description:
      'Nenhum ou ambos os destinos informados, polo diferente, ou modalidade diferente',
  })
  @ApiNotFoundResponse({
    description: 'Agendamento, faixa ou oferta inexistente',
  })
  @ApiConflictResponse({
    description: 'Sala lotada, agendamento cancelado, ou ja esta nesta sala',
  })
  remanejar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RemanejarDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.service.remanejar(id, dto, admin.email);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Cancela um agendamento',
    description:
      'Vira `CANCELADO`, **nunca some**: quem aparecer no dia sem estar na lista ' +
      'precisa ser explicavel. A vaga volta a contar como livre na hora.',
  })
  @ApiParam({ name: 'id', type: Number, example: 501 })
  @ApiOkResponse({ type: MensagemDto })
  @ApiNotFoundResponse({ description: 'Agendamento nao encontrado' })
  @ApiConflictResponse({ description: 'Ja estava cancelado' })
  cancelar(
    @Param('id', ParseIntPipe) id: number,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.service.cancelar(id, admin.email);
  }

  /**
   * Os filtros sao lidos a mao, sem DTO, de proposito: com um DTO validado e
   * `forbidNonWhitelisted`, um parametro a mais na URL derrubaria a requisicao —
   * e URL de relatorio e coisa que se cola, edita e compartilha.
   */
  private lerFiltro(query: Record<string, string>) {
    const inteiro = (valor?: string) => {
      const numero = Number(valor);
      return valor !== undefined && Number.isInteger(numero) && numero > 0
        ? numero
        : undefined;
    };

    return {
      poloId: inteiro(query.poloId),
      faixaId: inteiro(query.faixaId),
      salaId: inteiro(query.salaId),
      modalidadeId: inteiro(query.modalidadeId),
      periodoLetivoId: query.periodoLetivoId || undefined,
      de: query.de || undefined,
      ate: query.ate || undefined,
      busca: query.busca || undefined,
      status:
        query.status === StatusAgendamento.CANCELADO ||
        query.status === StatusAgendamento.CONFIRMADO
          ? query.status
          : undefined,
      pagina: inteiro(query.pagina),
      porPagina: inteiro(query.porPagina),
    };
  }
}
