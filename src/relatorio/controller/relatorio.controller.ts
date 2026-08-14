import {
  applyDecorators,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { GrupoExportavelDto } from '../dto/grupo-exportavel.dto';
import { RelatorioService } from '../service/relatorio.service';

/** Recorte compartilhado pelas tres rotas. */
const FILTROS = [
  { name: 'poloId', type: Number, example: 6 },
  { name: 'periodoLetivoId', type: String, example: '103' },
  {
    name: 'de',
    type: String,
    example: '2026-08-01',
    description: 'Data da PROVA, nao do agendamento (AAAA-MM-DD).',
  },
  { name: 'ate', type: String, example: '2026-08-31' },
] as const;

const aplicarFiltros = () =>
  applyDecorators(...FILTROS.map((f) => ApiQuery({ required: false, ...f })));

/**
 * Exportacoes prontas para levar a outro sistema — hoje, os grupos do
 * Brightspace.
 *
 * Nao confunda com `GET /agendamentos/exportacao`: aquele e a lista de cobranca
 * da secretaria (todos os vinculos, agendados ou nao, formato de Excel). Aqui o
 * arquivo e consumido por MAQUINA, e o formato e o que o D2L exige.
 */
@ApiTags(TAGS.RELATORIOS)
@Controller('relatorios')
@SomenteAdmin()
export class RelatorioController {
  constructor(private readonly service: RelatorioService) {}

  @Get('grupos-d2l')
  @ApiOperation({
    summary:
      'Lista os grupos exportaveis (horario x turma) e o tamanho de cada',
    description:
      'Uma linha por **horario de prova E turma** — e a tabela da aba ' +
      'Relatorios. Cada linha vira um arquivo no import de Grupos do ' +
      'Brightspace.\n\n' +
      'O par (faixa, turma) e o recorte porque o grupo vive DENTRO de uma ' +
      'disciplina do D2L: um arquivo com a faixa inteira levaria para o grupo de ' +
      'uma disciplina tambem quem nao a cursa, liberando a prova dela para essa ' +
      'gente. O mesmo aluno aparece em varias linhas — uma por disciplina que a ' +
      'prova dele cobre.\n\n' +
      '`totalAlunos` conta **matriculas distintas com prova confirmada**, ' +
      'somando todas as salas da faixa, e e exatamente o numero de linhas que o ' +
      'arquivo tera.\n\n' +
      'As linhas nascem dos agendamentos: horario **sem ninguem agendado nao ' +
      'aparece**, porque nao ha turma para listar. Ocupacao por horario e ' +
      '`GET /agendamentos/resumo`.\n\n' +
      'O recorte e **um periodo letivo** — o de `periodoLetivoId` ou, sem ele, o ' +
      'vigente. Sem isso, prova do semestre passado entraria no grupo deste.',
  })
  @aplicarFiltros()
  @ApiOkResponse({ type: [GrupoExportavelDto] })
  listar(@Query() query: Record<string, string>) {
    return this.service.listarGrupos(this.lerFiltro(query));
  }

  /**
   * Declarada ANTES da rota com parametros: o Nest casa as rotas na ordem em que
   * sao declaradas.
   */
  @Get('grupos-d2l/zip')
  @ApiOperation({
    summary: 'Baixa um zip com o CSV de todos os grupos do recorte',
    description:
      'Organizado em **uma pasta por turma**, com o horario no nome do ' +
      'arquivo:\n\n' +
      '```\n' +
      'GSPS0I10227 - HISTORIA E CULTURA DO CORPO/\n' +
      '    20-08-2026 08h30-11h30.csv\n' +
      '    20-08-2026 14h00-17h00.csv\n' +
      '```\n\n' +
      'A pasta acompanha o trabalho real: abre-se a turma no Brightspace e ' +
      'importam-se os horarios dela, um a um.\n\n' +
      'Duas faixas do mesmo dia e horario em polos diferentes gerariam o mesmo ' +
      'caminho (o polo nao entra no nome); a partir da segunda, o id da faixa ' +
      'entra como desempate (`... #14.csv`).',
  })
  @aplicarFiltros()
  @ApiProduces('application/zip')
  @ApiOkResponse({
    description: 'Arquivo ZIP',
    schema: { type: 'string', format: 'binary' },
  })
  @Header('Content-Type', 'application/zip')
  async zip(
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { nomeArquivo, conteudo } = await this.service.zipDosGrupos(
      this.lerFiltro(query),
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return new StreamableFile(conteudo as Buffer);
  }

  @Get('grupos-d2l/:faixaId/:orgUnitId')
  @ApiOperation({
    summary: 'Baixa o CSV de um grupo para o import de Grupos do Brightspace',
    description:
      'Os alunos de UMA turma (`orgUnitId`) em UM horario de prova ' +
      '(`faixaId`). Duas colunas: **`Nome de usuário`** com a matricula (RA) e ' +
      '**`Código do Grupo`** VAZIA — o codigo e preenchido a mao depois de criar ' +
      'o grupo no D2L.\n\n' +
      'Entram apenas os agendamentos **confirmados** do periodo letivo do ' +
      'recorte cuja prova cobre aquela disciplina, e cada matricula aparece ' +
      '**uma unica vez**: o grupo no D2L e por usuario, e um RA com dois ' +
      'vinculos na mesma faixa nao pode virar duas linhas.\n\n' +
      'Sai separado por **virgula** e **sem BOM** — ao contrario do CSV da ' +
      'secretaria (`;` + BOM), porque quem le este arquivo e o Brightspace, nao ' +
      'o Excel.\n\n' +
      'Baixa como **`20-08-2026 08h30-11h30 - GSPS0I10227 - HISTORIA E ' +
      'CULTURA.csv`**, sem acento (ver `nome-de-arquivo.ts`).\n\n' +
      '`de`, `ate` e `poloId` sao **ignorados** aqui: quem pediu este grupo ja ' +
      'escolheu a faixa, e um filtro esquecido na URL devolveria 404 em vez do ' +
      'arquivo. `periodoLetivoId` continua valendo — e ele que separa os ' +
      'semestres.',
  })
  @ApiParam({ name: 'faixaId', type: Number, example: 14 })
  @ApiParam({
    name: 'orgUnitId',
    type: String,
    example: '445566',
    description: 'A disciplina no Brightspace, como veio no launch.',
  })
  @aplicarFiltros()
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Arquivo CSV',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({
    description: 'Nenhum aluno confirmado nesta turma e neste horario',
  })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async csv(
    @Param('faixaId', ParseIntPipe) faixaId: number,
    @Param('orgUnitId') orgUnitId: string,
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { nomeArquivo, conteudo } = await this.service.csvDoGrupo(
      faixaId,
      orgUnitId,
      this.lerFiltro(query),
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return conteudo as string;
  }

  /**
   * Os filtros sao lidos a mao, sem DTO, pelo mesmo motivo do relatorio de
   * agendamentos: com `forbidNonWhitelisted`, um parametro a mais na URL
   * derrubaria a requisicao — e URL de relatorio e coisa que se cola e edita.
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
      periodoLetivoId: query.periodoLetivoId || undefined,
      de: query.de || undefined,
      ate: query.ate || undefined,
    };
  }
}
