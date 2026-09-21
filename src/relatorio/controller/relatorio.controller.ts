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
import { NiveisPermitidos, SomenteAdmin } from '../../auth/roles.decorator';
import { NivelAdmin } from '../../generated/prisma/client';
import { TAGS } from '../../config/swagger';
import { SalaComListaDto } from '../dto/sala-com-lista.dto';
import { ListaPresencaService } from '../service/lista-presenca.service';

/** Recorte das duas rotas de lista de presenca. */
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
 * As **listas de presenca** (`listas-de-presenca`): o PDF que o fiscal leva
 * para a sala e devolve assinado. Consumido por PESSOA, em papel.
 *
 * Nao se confunde com `GET /agendamentos/exportacao`, que e a lista de cobranca
 * da administracao (todos os vinculos, agendados ou nao, em Excel) e sai sem
 * recorte de polo ou data.
 *
 * Ate 17/09/2026 este controller tambem servia `grupos-d2l`: um CSV por horario
 * e turma, para o *Groups Import* do Brightspace. Saiu porque os grupos passaram
 * a ser criados e preenchidos pela API do D2L (`src/grupos-d2l/`, a tela
 * Grupos) — o arquivo manual so duplicava esse caminho.
 */
@ApiTags(TAGS.RELATORIOS)
@Controller('relatorios')
@SomenteAdmin()
export class RelatorioController {
  constructor(private readonly listas: ListaPresencaService) {}

  @Get('listas-de-presenca')
  @NiveisPermitidos(NivelAdmin.ASSISTENTE_OPERACIONAL)
  @ApiOperation({
    summary:
      'Lista as salas que terao aplicacao de prova e quantos assinam em cada',
    description:
      'Uma linha por **sala E horario** (a oferta, `SalaFaixa`) — e a tabela ' +
      'da aba Relatorios. Cada linha vira uma PAGINA no PDF.\n\n' +
      'O recorte e a sala porque a folha e fisica: ela vai para a mao do fiscal ' +
      'daquela sala, e nao pode listar quem esta na sala ao lado.\n\n' +
      '`totalAlunos` conta **agendamentos confirmados**, nao pessoas distintas: ' +
      'um RA com dois vinculos no mesmo formato ocupa duas vagas e assina ' +
      'duas vezes. E exatamente o numero de linhas que a folha tera, e bate com ' +
      '`ocupadas` em `GET /agendamentos/resumo`.\n\n' +
      '**Sala sem ninguem agendado nao aparece**: nao havera aplicacao ali, e ' +
      'uma folha em branco no meio da pilha so faz procurar o erro. Para ver a ' +
      'oferta montada, cheia ou vazia, use `GET /agendamentos/resumo`.\n\n' +
      'O recorte e **um periodo letivo** — o de `periodoLetivoId` ou, sem ele, o ' +
      'vigente.',
  })
  @aplicarFiltros()
  @ApiOkResponse({ type: [SalaComListaDto] })
  listarSalas(@Query() query: Record<string, string>) {
    return this.listas.listar(this.lerFiltro(query));
  }

  /**
   * Declarada ANTES da rota com parametro: o Nest casa as rotas na ordem em que
   * sao declaradas.
   */
  @Get('listas-de-presenca/pdf')
  @NiveisPermitidos(NivelAdmin.ASSISTENTE_OPERACIONAL)
  @ApiOperation({
    summary: 'Baixa o PDF com a lista de presenca de todas as salas do recorte',
    description:
      'Uma **pagina por sala**, na ordem em que as folhas sao entregues: dia, ' +
      'horario, polo e sala — a pilha ja sai separavel por campus.\n\n' +
      'Cada pagina traz o cabecalho com polo, data, horario e sala, e a tabela ' +
      'com **Nº · RA · Nome · Formato · Assinatura**. A coluna de assinatura ' +
      'e uma celula vazia com borda: a propria linha da tabela e a linha em que ' +
      'se assina.\n\n' +
      'Sala com muita gente continua na pagina seguinte, com o cabecalho ' +
      'repetido e marcado `(cont.)` — folha solta sem identificacao nao serve ' +
      'para nada, e a numeracao segue de onde parou.\n\n' +
      'A ordem dentro da pagina e **alfabetica por nome**: o fiscal procura pela ' +
      'pessoa que esta na frente dele, e o que ela sabe dizer e o proprio nome.',
  })
  @aplicarFiltros()
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'Arquivo PDF',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({
    description: 'Nenhuma sala com aluno confirmado neste recorte',
  })
  @Header('Content-Type', 'application/pdf')
  async pdfDasListas(
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { nomeArquivo, conteudo } = await this.listas.pdfDoRecorte(
      this.lerFiltro(query),
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return new StreamableFile(conteudo as Buffer);
  }

  @Get('listas-de-presenca/:salaFaixaId/pdf')
  @NiveisPermitidos(NivelAdmin.ASSISTENTE_OPERACIONAL)
  @ApiOperation({
    summary: 'Baixa a lista de presenca de UMA sala',
    description:
      'A folha avulsa — a que faltou na pilha, ou que precisou ser reimpressa. ' +
      'Mesmo conteudo de uma pagina do PDF completo.\n\n' +
      '`de`, `ate` e `poloId` sao **ignorados** aqui: quem pediu esta sala ja ' +
      'escolheu o horario, e um filtro esquecido na URL devolveria 404 em vez ' +
      'do arquivo. `periodoLetivoId` continua valendo — e ele que separa os ' +
      'semestres.',
  })
  @ApiParam({
    name: 'salaFaixaId',
    type: Number,
    example: 31,
    description: 'A oferta (`SalaFaixa`): sala + horario + polo num id so.',
  })
  @aplicarFiltros()
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'Arquivo PDF',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({ description: 'Nenhum aluno confirmado nesta sala' })
  @Header('Content-Type', 'application/pdf')
  async pdfDeUmaSala(
    @Param('salaFaixaId', ParseIntPipe) salaFaixaId: number,
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { nomeArquivo, conteudo } = await this.listas.pdfDeUmaSala(
      salaFaixaId,
      this.lerFiltro(query),
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return new StreamableFile(conteudo as Buffer);
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
      // Lista separada por virgula: uma janela cobre mais de um periodo letivo
      // ao mesmo tempo (o do modulo e o do semestre), e a tela manda a janela
      // inteira. Um id sozinho vira uma lista de um elemento.
      periodoLetivoId: (query.periodoLetivoId ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      de: query.de || undefined,
      ate: query.ate || undefined,
    };
  }
}
