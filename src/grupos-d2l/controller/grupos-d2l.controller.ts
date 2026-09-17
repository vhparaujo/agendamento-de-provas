import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import {
  AndamentoDosGruposD2lDto,
  ExecucaoGruposIniciadaDto,
  HorarioResolvidoDto,
  IniciarExecucaoGruposDto,
  PainelDeGruposDto,
  ResolverHorarioDto,
  SalvarNomesDoBlocoDto,
} from '../dto/grupos-d2l.dto';
import { GruposD2lService } from '../service/grupos-d2l.service';
import { NomesDosGruposService } from '../service/nomes-dos-grupos.service';

/**
 * Os grupos de prova no Brightspace, criados e preenchidos pela API.
 *
 * Tres coisas na mesma tela: os NOMES (por bloco, gravados na grade de grupos),
 * as PENDENCIAS de horario (faixa sem janela identica) e os DOIS lotes —
 * criar categorias e grupos, e inscrever os alunos.
 */
@ApiTags(TAGS.GRUPOS_D2L)
@Controller('grupos-d2l')
@SomenteAdmin()
export class GruposD2lController {
  constructor(
    private readonly nomes: NomesDosGruposService,
    private readonly lote: GruposD2lService,
  ) {}

  @Get('painel')
  @ApiOperation({
    summary:
      'Nomes dos grupos, horarios validos, pendencias e ultimas execucoes',
    description:
      'Sem `de`/`ate`, o intervalo e o dos dias de prova ja agendados na rodada ' +
      'vigente.\n\n' +
      'As **linhas** de cada bloco sao as celulas da grade de grupos (dia x ' +
      'janela) — inclusive as digitadas na aba "Senhas e datas". Em Semi/Modular, ' +
      'a mesma sessao com o mesmo nome nos dois formatos e uma linha so.\n\n' +
      'Uma **pendencia de horario** e um horario de faixa sem janela ativa ' +
      'IDENTICA no formato: os alunos dela nao tem como achar o grupo.',
  })
  @ApiQuery({
    name: 'de',
    required: false,
    example: '2026-09-14',
    description: 'AAAA-MM-DD.',
  })
  @ApiQuery({
    name: 'ate',
    required: false,
    example: '2026-09-19',
    description: 'AAAA-MM-DD.',
  })
  @ApiOkResponse({ type: PainelDeGruposDto })
  @ApiBadRequestResponse({
    description: 'Intervalo incompleto, invertido ou longo demais',
  })
  painel(@Query('de') de?: string, @Query('ate') ate?: string) {
    return this.nomes.painel(de, ate);
  }

  @Put('nomes')
  @ApiOperation({
    summary: 'Substitui os nomes de grupo de um bloco no intervalo',
    description:
      'Cada linha (dia + horario de uma janela + nome) vira celula da grade de ' +
      'grupos, com a categoria do bloco. Em Semi/Modular, grava nos dois ' +
      'formatos.\n\n' +
      '**O que nao vier e apagado**, dentro do bloco e do intervalo.\n\n' +
      'Recusa: horario sem janela ativa, dia fora do intervalo, duas linhas para ' +
      'a mesma sessao, o mesmo nome em duas sessoes (cairiam no mesmo grupo), e ' +
      'nomes que gerariam o mesmo codigo no Brightspace.',
  })
  @ApiOkResponse({ type: PainelDeGruposDto })
  @ApiBadRequestResponse({
    description: 'Linha invalida — a mensagem diz qual e por que',
  })
  salvarNomes(
    @Body() dto: SalvarNomesDoBlocoDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.nomes.salvarNomes(
      dto.bloco,
      dto.de,
      dto.ate,
      dto.linhas,
      admin.email,
    );
  }

  @Post('horarios/resolver')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve uma pendencia de horario escolhendo qual cadastro vale',
    description:
      '`vale: FAIXA` muda a JANELA para o horario das faixas (pelo mesmo caminho ' +
      'da aba "Senhas e datas": valida, sobe a versao e audita). Recusada se a ' +
      'nova abertura fizer o disparo passar a armar a prova do outro dia.\n\n' +
      '`vale: JANELA` muda as FAIXAS do intervalo para o horario da janela, uma a ' +
      'uma, com as recusas da tela de faixas (prova que nao cabe, sala ocupada). ' +
      '**Os agendamentos dessas faixas mudam de horario junto.**',
  })
  @ApiOkResponse({ type: HorarioResolvidoDto })
  @ApiBadRequestResponse({
    description:
      'Janela de outro formato ou desativada, nenhuma faixa com o horario, ou ' +
      'disparo que inverteria o dia da prova',
  })
  resolverHorario(
    @Body() dto: ResolverHorarioDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.nomes.resolverHorario(dto, admin.email);
  }

  @Post('execucoes')
  @ApiOperation({
    summary:
      'Cria categorias e grupos, ou inscreve os alunos (simula por padrao)',
    description:
      '**Responde na hora com um `id`**; acompanhe em `GET /grupos-d2l/execucoes/:id`.\n\n' +
      '`CRIAR_GRUPOS`: em cada turma EaD, Semi/Modular ou Presencial com prova no intervalo, ' +
      'garante a categoria do bloco e TODOS os nomes do bloco. Grupo vazio com ' +
      'nome fora da lista e renomeado antes de criar outro.\n\n' +
      '`INSCREVER_ALUNOS`: cada aluno no grupo da sessao dele (horario da faixa -> ' +
      'janela -> nome do dia) e fora dos outros grupos da categoria — e o ' +
      'remanejo. Usuario que o portal nao conhece nunca e removido.\n\n' +
      '**Nada mudou desde a ultima execucao real sem pendencia = nenhuma chamada**: ' +
      'responde `nadaAFazer: true` e `id: null`. `forcar: true` confere mesmo assim.',
  })
  @ApiCreatedResponse({ type: ExecucaoGruposIniciadaDto })
  @ApiBadRequestResponse({
    description:
      'Integracao D2L desligada, sem periodo, sem nomes (na criacao) ou sem turma no intervalo',
  })
  @ApiConflictResponse({
    description: 'Ja existe uma execucao de grupos em andamento',
  })
  iniciar(
    @Body() dto: IniciarExecucaoGruposDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.lote.iniciar(
      {
        tipo: dto.tipo,
        simulacao: dto.simulacao ?? true,
        de: dto.de,
        ate: dto.ate,
        forcar: dto.forcar ?? false,
        orgUnitId: dto.orgUnitId ?? null,
      },
      admin.email,
    );
  }

  @Get('execucoes/:id')
  @ApiOperation({
    summary: 'Acompanha uma execucao de grupos',
    description:
      'A tela consulta enquanto `status` for `EM_ANDAMENTO`. `resultados` conta ' +
      'os itens por resultado; `pendencias` soma os que pedem acao.',
  })
  @ApiParam({ name: 'id', type: Number, example: 6 })
  @ApiOkResponse({ type: AndamentoDosGruposD2lDto })
  @ApiNotFoundResponse({ description: 'Execucao nao encontrada' })
  consultar(@Param('id', ParseIntPipe) id: number) {
    return this.lote.consultar(id);
  }

  @Get('execucoes/:id/relatorio')
  @ApiOperation({
    summary: 'Baixa o CSV da execucao, com as pendencias primeiro',
    description:
      'Uma linha por item: grupo criado, aluno inscrito ou removido, e cada ' +
      'pendencia com o que fazer. Quem ja estava no grupo certo nao vira linha.\n\n' +
      'BOM UTF-8 e `;`, para abrir no Excel em portugues.',
  })
  @ApiParam({ name: 'id', type: Number, example: 6 })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Arquivo CSV',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({ description: 'Execucao nao encontrada' })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async relatorio(
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { nomeArquivo, conteudo } = await this.lote.relatorioCsv(id);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return conteudo;
  }
}
