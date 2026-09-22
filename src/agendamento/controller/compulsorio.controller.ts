import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
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
  AndamentoDoCompulsorioDto,
  ExecucaoIniciadaDto,
  IniciarCompulsorioDto,
  PaginaDeExecucoesCompulsorioDto,
} from '../dto/compulsorio.dto';
import { CompulsorioService } from '../service/compulsorio.service';

/**
 * O lote que agenda por quem nao agendou. Quatro rotas: dispara, lista o
 * historico, acompanha uma execucao, baixa o relatorio de quem ficou de fora.
 *
 * Sao varias e nao uma porque o lote demora dezenas de minutos — nenhum navegador
 * segura a conexao aberta ate o fim, e o id que o POST devolve nao sobrevive a
 * aba fechada (dai o historico, cuja primeira linha e a execucao mais recente).
 */
@ApiTags(TAGS.AGENDAMENTOS)
@Controller('agendamentos/compulsorio')
@SomenteAdmin()
export class CompulsorioController {
  constructor(private readonly service: CompulsorioService) {}

  @Post()
  @ApiOperation({
    summary: 'Dispara o agendamento compulsorio (simula por padrao)',
    description:
      'Aloca automaticamente todo vinculo **ativo** que nao tem prova ' +
      'confirmada no periodo letivo vigente. Enche a sala de menor `ordem` ate ' +
      'lotar antes de abrir a proxima, e as datas da **mais proxima para a mais ' +
      'distante**.\n\n' +
      '**Responde na hora com um `id`, sem esperar o fim** — sao ~1,5s por aluno ' +
      '(duas chamadas ao Brightspace: achar o usuario e ler as disciplinas). ' +
      'Acompanhe em `GET /agendamentos/compulsorio/:id`.\n\n' +
      '**`simulacao: true` e o padrao e nao grava nada.** Ela percorre a ' +
      'alocacao inteira contando as vagas e responde "cabe todo mundo?" — a ' +
      'pergunta que, respondida no meio de uma execucao real, deixaria metade ' +
      'dos alunos alocados e a outra metade nao.\n\n' +
      '**Quem NAO entra:** vinculo inativo (STATUS CURSO bloqueia), quem ja tem ' +
      'prova confirmada, e quem **cancelou e nao remarcou** — este ultimo por ' +
      'decisao da administracao, e sai no relatorio para ser tratado caso a caso.\n\n' +
      'Exige `D2L_HABILITADO=true`: e a integracao que sabe as disciplinas de ' +
      'quem nunca entrou pelo link do Brightspace.',
  })
  @ApiCreatedResponse({ type: ExecucaoIniciadaDto })
  @ApiBadRequestResponse({
    description:
      'Integracao D2L desligada, ou nenhum periodo letivo cadastrado',
  })
  @ApiConflictResponse({ description: 'Ja existe uma execucao em andamento' })
  iniciar(
    @Body() dto: IniciarCompulsorioDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.service.iniciar(
      { simulacao: dto.simulacao ?? true, poloId: dto.poloId },
      admin.email,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'O historico de execucoes, da mais recente para a mais antiga',
    description:
      'O `id` do POST so existe para quem disparou e so enquanto a aba estiver ' +
      'aberta — e a propria tela manda fechar a aba, porque o lote leva dezenas ' +
      'de minutos. Sem esta rota, um F5, um colega em outra maquina ou a volta ' +
      'no dia seguinte encontravam a tela em branco, com o resultado de horas de ' +
      'processamento visivel so no log do servidor. **A primeira linha e a ' +
      'execucao mais recente**, e e por ela que a tela abre.\n\n' +
      'A outra pergunta e de **comparacao**: a simulacao ' +
      'disse "130 sem vaga", a administracao abriu sala, rodou de novo — ' +
      'melhorou? Com so a ultima execucao visivel, o lote anterior (que e a base ' +
      'da comparacao) so existia no log do servidor.\n\n' +
      'Cada item tem o **mesmo formato** de `GET /:id`, contagem de excecoes ' +
      'inclusive: a tela mostra a linha escolhida no cartao de detalhe sem ' +
      'buscar de novo.',
  })
  @ApiQuery({
    name: 'pagina',
    required: false,
    type: Number,
    example: 1,
    description: 'Padrao 1.',
  })
  @ApiQuery({
    name: 'porPagina',
    required: false,
    type: Number,
    example: 10,
    description: 'Padrao 10, maximo 50.',
  })
  @ApiOkResponse({ type: PaginaDeExecucoesCompulsorioDto })
  listar(
    @Query('pagina', new ParseIntPipe({ optional: true })) pagina?: number,
    @Query('porPagina', new ParseIntPipe({ optional: true }))
    porPagina?: number,
  ) {
    return this.service.listar({ pagina, porPagina });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Acompanha uma execucao',
    description:
      'A tela consulta esta rota de tempos em tempos enquanto `status` for ' +
      '`EM_ANDAMENTO`.\n\n' +
      '`interrompida: true` significa que o processo morreu no meio (reinicio do ' +
      'servidor, por exemplo): o que ja foi gravado permanece, e o resto nao foi ' +
      'processado. Rodar de novo retoma de onde parou, porque quem ja tem prova ' +
      'confirmada nao entra na lista.',
  })
  @ApiParam({ name: 'id', type: Number, example: 3 })
  @ApiOkResponse({ type: AndamentoDoCompulsorioDto })
  @ApiNotFoundResponse({ description: 'Execucao nao encontrada' })
  consultar(@Param('id', ParseIntPipe) id: number) {
    return this.service.consultar(id);
  }

  @Get(':id/relatorio')
  @ApiOperation({
    summary: 'Baixa o CSV de quem ficou de fora',
    description:
      'Uma linha por vinculo NAO alocado, com o motivo e o que fazer a ' +
      'respeito. Ordenado por motivo: cada bloco do arquivo e uma acao ' +
      'diferente — `SEM_VAGA` pede abrir sala, `SEM_CONTA_D2L` pede chamado no ' +
      'suporte do LMS, `SEM_DISCIPLINA_AGENDAVEL` pede conferir o CSV de ' +
      'turmas.\n\n' +
      '`NAO_ELEGIVEL_PELA_NOTA` e a excecao que NAO pede acao nenhuma: a janela ' +
      'filtra por nota (a substitutiva) e a nota final do aluno esta fora da ' +
      'faixa em todas as disciplinas dele. No lote da substitutiva ele tende a ' +
      'ser o motivo mais numeroso, porque quem passou de ano e a maioria — e e ' +
      'justamente por isso que ele nao se mistura com `SEM_DISCIPLINA_AGENDAVEL`, ' +
      'que e fila de trabalho.\n\n' +
      '`AVISO_CONTA_INATIVA_D2L` e o unico motivo que aparece para quem **foi** ' +
      'alocado: tem lugar na sala, mas a conta esta desativada no Brightspace e ' +
      'do jeito que esta nao conseguiria abrir a prova.\n\n' +
      'Sai com BOM UTF-8 e separado por `;`, para abrir direto no Excel em ' +
      'portugues sem estragar os acentos.',
  })
  @ApiParam({ name: 'id', type: Number, example: 3 })
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
    const csv = await this.service.relatorioCsv(id);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.service.nomeDoArquivo(id)}"`,
    );

    return csv;
  }
}
