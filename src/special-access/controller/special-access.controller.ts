import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Put,
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
  AndamentoDoSpecialAccessDto,
  ConfiguracaoSpecialAccessDto,
  ExecucaoSpecialAccessIniciadaDto,
  IniciarSpecialAccessDto,
  SalvarConfiguracaoSpecialAccessDto,
  TurmasDoSpecialAccessDto,
} from '../dto/special-access.dto';
import { ConfiguracaoSpecialAccessService } from '../service/configuracao-special-access.service';
import { SpecialAccessService } from '../service/special-access.service';

/**
 * Special access por agendamento (15/09/2026): a configuracao e o lote que grava
 * o acesso de cada aluno.
 *
 * O PREPARO dos questionarios (tirar a data, restringir, tirar a condicao de
 * grupo) NAO mora aqui: e `POST /senhas-de-prova/execucoes` com `tipo: PREPARO`,
 * porque escreve no mesmo questionario que os lotes de senha e data e precisa
 * da trava deles.
 */
@ApiTags(TAGS.SPECIAL_ACCESS)
@Controller('special-access')
@SomenteAdmin()
export class SpecialAccessController {
  constructor(
    private readonly configuracao: ConfiguracaoSpecialAccessService,
    private readonly lote: SpecialAccessService,
  ) {}

  @Get('configuracao')
  @ApiOperation({
    summary: 'Tempo de prova por modalidade, extra do NIOP e modo',
    description:
      'Sem configuracao salva, o extra do NIOP e 60 minutos e o special access ' +
      'nao substitui as janelas.',
  })
  @ApiOkResponse({ type: ConfiguracaoSpecialAccessDto })
  lerConfiguracao() {
    return this.configuracao.ler();
  }

  @Put('configuracao')
  @ApiOperation({
    summary: 'Salva a configuracao do special access',
    description:
      '`tempoDeProvaMinutos` e o `TimeLimitValue` que o lote grava para cada ' +
      'modalidade; o aluno do NIOP recebe esse valor mais `tempoExtraNiopMinutos`, ' +
      'e a janela dele fecha a mesma quantidade de minutos depois do fim da faixa.\n\n' +
      '`substituiJanelas: true` faz o cron parar de aplicar datas e grupos (a ' +
      'senha continua) e o lote manual de datas recusar.\n\n' +
      'Vale no PROXIMO lote: nada ja gravado no Brightspace muda sozinho.',
  })
  @ApiOkResponse({ type: ConfiguracaoSpecialAccessDto })
  @ApiBadRequestResponse({
    description:
      'Modalidade inexistente ou repetida, ou tempo + extra acima de 9999 minutos',
  })
  salvarConfiguracao(
    @Body() dto: SalvarConfiguracaoSpecialAccessDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.configuracao.salvar(dto, admin.email);
  }

  @Get('turmas')
  @ApiOperation({
    summary: 'As turmas com reserva na rodada, e o tamanho de cada uma',
    description:
      'A lista do seletor da tela. **So banco, nenhuma chamada ao Brightspace** ' +
      '— e o que permite escolher as turmas antes de gastar requisicao.\n\n' +
      '`acessos` e quantas gravacoes a turma custa em CADA questionario da prova.',
  })
  @ApiOkResponse({ type: TurmasDoSpecialAccessDto })
  @ApiBadRequestResponse({
    description: 'Nenhum periodo de agendamento cadastrado',
  })
  turmas() {
    return this.lote.turmasDisponiveis();
  }

  @Post('execucoes')
  @ApiOperation({
    summary: 'Grava o special access dos alunos agendados (simula por padrao)',
    description:
      '**Responde na hora com um `id`**; acompanhe em `GET /special-access/execucoes/:id`.\n\n' +
      'Para cada turma com reserva na rodada vigente, acha o questionario-alvo ' +
      '(o mesmo de "Senhas e datas") e, em cada um, compara os special access ' +
      'que existem com os que deveriam existir:\n\n' +
      '- reserva confirmada -> **inicio** e **fim** da faixa no fuso do polo, ' +
      '**tempo** da modalidade (+ extra e fim estendido para o NIOP);\n' +
      '- acesso com outro horario ou tempo -> atualizado (remanejo);\n' +
      '- reserva cancelada com acesso -> removido;\n' +
      '- acesso de quem nao tem reserva -> **nunca tocado**.\n\n' +
      'Escreve so a diferenca: rodar de novo continua de onde parou. ' +
      '`QUESTIONARIO_NAO_RESTRITO` avisa quando a prova ainda esta aberta a turma ' +
      'toda — rode o preparo.',
  })
  @ApiCreatedResponse({ type: ExecucaoSpecialAccessIniciadaDto })
  @ApiBadRequestResponse({
    description:
      'Integracao D2L desligada, sem periodo, sem questionario-alvo ou sem reserva',
  })
  @ApiConflictResponse({
    description: 'Ja existe uma execucao de special access em andamento',
  })
  iniciar(
    @Body() dto: IniciarSpecialAccessDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.lote.iniciar(
      { simulacao: dto.simulacao ?? true, orgUnitIds: dto.orgUnitIds ?? [] },
      admin.email,
    );
  }

  /** Antes de `:id` de proposito: senao "ultima" cairia no ParseIntPipe. */
  @Get('execucoes/ultima')
  @ApiOperation({
    summary: 'A execucao mais recente',
    description:
      'Corpo vazio (200) quando nunca houve execucao — e o estado normal de um ' +
      'ambiente recem-configurado, nao um 404.',
  })
  @ApiOkResponse({ type: AndamentoDoSpecialAccessDto })
  ultima() {
    return this.lote.ultima();
  }

  @Get('execucoes/:id')
  @ApiOperation({
    summary: 'Acompanha uma execucao de special access',
    description:
      'A tela consulta enquanto `status` for `EM_ANDAMENTO`. `resultados` conta ' +
      'os itens por resultado; `pendencias` soma os que pedem acao.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({ type: AndamentoDoSpecialAccessDto })
  @ApiNotFoundResponse({ description: 'Execucao nao encontrada' })
  consultar(@Param('id', ParseIntPipe) id: number) {
    return this.lote.consultar(id);
  }

  @Get('execucoes/:id/relatorio')
  @ApiOperation({
    summary: 'Baixa o CSV da execucao, com as pendencias primeiro',
    description:
      'Uma linha por acesso gravado, atualizado ou removido, e por pendencia. ' +
      'Os horarios saem no relogio de Brasilia. BOM UTF-8 e `;`.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
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
