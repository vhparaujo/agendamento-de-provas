import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
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
} from '../dto/compulsorio.dto';
import { CompulsorioService } from '../service/compulsorio.service';

/**
 * O lote que agenda por quem nao agendou. Tres rotas: dispara, acompanha, baixa
 * o relatorio de quem ficou de fora.
 *
 * Sao tres e nao uma porque o lote demora dezenas de minutos — nenhum navegador
 * segura a conexao aberta ate o fim.
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
