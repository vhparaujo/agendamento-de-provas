import {
  Body,
  Controller,
  Get,
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
  AndamentoDaSenhaQuizDto,
  ExecucaoSenhaIniciadaDto,
  IniciarSenhaQuizDto,
} from '../dto/senha-quiz.dto';
import { SenhaQuizService } from '../service/senha-quiz.service';

/**
 * O lote que aplica a senha de UMA celula da grade em todas as turmas do CSV.
 *
 * Tres rotas e nao uma porque o lote leva minutos: dispara, acompanha, baixa o
 * relatorio. Mesmo desenho do compulsorio, e pelo mesmo motivo.
 *
 * ⚠️ Este controller precisa ser declarado ANTES do `GradeSenhasController` no
 * modulo: as rotas dele sao `senhas-de-prova/execucoes/...` e as de la tem
 * `senhas-de-prova/:id`, que casaria com a palavra "execucoes". Mesma armadilha
 * ja documentada em `agendamento.module.ts`.
 */
@ApiTags(TAGS.SENHAS_QUIZ)
@Controller('senhas-de-prova/execucoes')
@SomenteAdmin()
export class SenhaQuizController {
  constructor(private readonly service: SenhaQuizService) {}

  @Post()
  @ApiOperation({
    summary:
      'Aplica a senha de um dia/turno nos questionarios (simula por padrao)',
    description:
      'Troca o campo `Password` do questionario da prova em **todas as turmas ' +
      'do CSV importado que pertencem ao periodo letivo vigente**. Nao verifica ' +
      'se ha agendamento na turma.\n\n' +
      '**Responde na hora com um `id`, sem esperar o fim** — sao ~3 chamadas ao ' +
      'Brightspace por turma. Acompanhe em `GET /senhas-de-prova/execucoes/:id`.\n\n' +
      '**`simulacao: true` e o padrao e nao emite nenhum PUT.** Ela percorre tudo ' +
      'e mostra quais questionarios casaram com o nome configurado — a unica ' +
      'conferencia possivel antes de mexer na prova de toda a instituicao.\n\n' +
      '**Sobrescrever a senha de um turno anterior e o objetivo**, nao um efeito ' +
      'colateral: a senha vale um turno, e troca-la a cada turno e o que impede o ' +
      'aluno da manha de repassar a dele para o da tarde.\n\n' +
      'Exige `D2L_HABILITADO`: e a integracao que descobre o `orgUnitId` das ' +
      'turmas do CSV e grava no questionario.',
  })
  @ApiCreatedResponse({ type: ExecucaoSenhaIniciadaDto })
  @ApiBadRequestResponse({
    description:
      'Integracao D2L desligada, nenhum periodo letivo cadastrado, ou celula da grade sem senha',
  })
  @ApiConflictResponse({
    description:
      'Ja existe uma execucao em andamento, ou esta senha ja foi aplicada (use `forcar`)',
  })
  iniciar(
    @Body() dto: IniciarSenhaQuizDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.service.iniciar(
      {
        data: dto.data,
        turno: dto.turno,
        simulacao: dto.simulacao ?? true,
        forcar: dto.forcar ?? false,
      },
      admin.email,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Acompanha uma execucao',
    description:
      'A tela consulta esta rota de tempos em tempos enquanto `status` for ' +
      '`EM_ANDAMENTO`.\n\n' +
      '`interrompida: true` significa que o processo morreu no meio: o que ja foi ' +
      'gravado no Brightspace permanece, e o resto nao foi aplicado.\n\n' +
      'Repare em `naoEncontradas`: sao turmas sem questionario com o nome ' +
      'configurado. **Nao contam como falha e sao o resultado que mais dói** — ' +
      'cada uma e uma turma inteira que nao abriria a prova.',
  })
  @ApiParam({ name: 'id', type: Number, example: 12 })
  @ApiOkResponse({ type: AndamentoDaSenhaQuizDto })
  @ApiNotFoundResponse({ description: 'Execucao nao encontrada' })
  consultar(@Param('id', ParseIntPipe) id: number) {
    return this.service.consultar(id);
  }

  @Get(':id/relatorio')
  @ApiOperation({
    summary: 'Baixa o CSV do que aconteceu em cada turma',
    description:
      'Uma linha por (turma, questionario), ordenada por resultado: cada bloco ' +
      'do arquivo e uma acao diferente.\n\n' +
      '`QUIZ_NAO_ENCONTRADO` pede conferir o nome da prova no AVA; ' +
      '`ORGUNIT_NAO_RESOLVIDO` pede conferir o CSV de turmas; `FALHA_AO_GRAVAR` ' +
      'costuma ser escopo ou permissao do usuario da integracao.\n\n' +
      '**Nao ha coluna de senha**, nem a antiga nem a nova: o arquivo circula por ' +
      'e-mail e fica no disco de quem baixou. `Tinha senha antes` responde a ' +
      'unica pergunta util sem revelar nada.\n\n' +
      'Sai com BOM UTF-8 e separado por `;`, para abrir direto no Excel em ' +
      'portugues sem estragar os acentos.',
  })
  @ApiParam({ name: 'id', type: Number, example: 12 })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Arquivo CSV',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({ description: 'Execucao nao encontrada' })
  async relatorio(
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) resposta: Response,
  ): Promise<string> {
    const execucao = await this.service.dadosDaExecucao(id);
    const csv = await this.service.relatorioCsv(id);

    resposta.setHeader('Content-Type', 'text/csv; charset=utf-8');
    resposta.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.service.nomeDoArquivo(execucao)}"`,
    );

    return csv;
  }
}
