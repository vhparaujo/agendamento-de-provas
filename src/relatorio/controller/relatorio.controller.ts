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
import { FaixaExportavelDto } from '../dto/faixa-exportavel.dto';
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
    summary: 'Lista as faixas exportaveis e quantos alunos cada uma tem',
    description:
      'Uma linha por **faixa de horario** — e a tabela da aba Relatorios. Cada ' +
      'linha vira um arquivo no import de Grupos do Brightspace.\n\n' +
      '`totalAlunos` conta **matriculas distintas com prova confirmada**, ' +
      'somando todas as salas da faixa, e e exatamente o numero de linhas que o ' +
      'arquivo tera. Faixa sem ninguem aparece com `0` (a informacao e util na ' +
      'tela), mas fica de fora do zip.\n\n' +
      'O recorte e **um periodo letivo** — o de `periodoLetivoId` ou, sem ele, o ' +
      'vigente. Sem isso, prova do semestre passado entraria no grupo deste.',
  })
  @aplicarFiltros()
  @ApiOkResponse({ type: [FaixaExportavelDto] })
  listar(@Query() query: Record<string, string>) {
    return this.service.listarFaixas(this.lerFiltro(query));
  }

  /**
   * Declarada ANTES de `:faixaId`: o Nest casa as rotas na ordem em que sao
   * declaradas, e `zip` seria engolido pelo parametro.
   */
  @Get('grupos-d2l/zip')
  @ApiOperation({
    summary: 'Baixa um zip com o CSV de todas as faixas do recorte',
    description:
      'Um arquivo por faixa, nomeado `20-08-2026 08h30-11h30.csv`. Faixa **sem ' +
      'aluno nenhum fica de fora** — um arquivo so de cabecalho nao tem o que ' +
      'importar.\n\n' +
      'Duas faixas do mesmo dia e horario em polos diferentes gerariam o mesmo ' +
      'nome (o polo nao entra no nome); a partir da segunda, o id da faixa entra ' +
      'como desempate (`... #14.csv`).',
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
    const { nomeArquivo, conteudo } = await this.service.zipDasFaixas(
      this.lerFiltro(query),
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return new StreamableFile(conteudo as Buffer);
  }

  @Get('grupos-d2l/:faixaId')
  @ApiOperation({
    summary: 'Baixa o CSV de uma faixa para o import de Grupos do Brightspace',
    description:
      'Duas colunas: **`Nome de usuário`** com a matricula (RA) e ' +
      '**`Código do Grupo`** VAZIA — o codigo e preenchido a mao depois de criar ' +
      'o grupo no D2L.\n\n' +
      'Entram apenas os agendamentos **confirmados** do periodo letivo do ' +
      'recorte, e cada matricula aparece **uma unica vez**: o grupo no D2L e por ' +
      'usuario, e um RA com dois vinculos na mesma faixa nao pode virar duas ' +
      'linhas.\n\n' +
      'Sai separado por **virgula** e **sem BOM** — ao contrario do CSV da ' +
      'secretaria (`;` + BOM), porque quem le este arquivo e o Brightspace, nao ' +
      'o Excel.\n\n' +
      'O arquivo baixa como **`20-08-2026 08h30-11h30.csv`**.',
  })
  @ApiParam({ name: 'faixaId', type: Number, example: 14 })
  @aplicarFiltros()
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Arquivo CSV',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({ description: 'Faixa nao encontrada' })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async csv(
    @Param('faixaId', ParseIntPipe) faixaId: number,
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { nomeArquivo, conteudo } = await this.service.csvDaFaixa(
      faixaId,
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
