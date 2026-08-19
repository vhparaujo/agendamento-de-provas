import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { LIMITE_AUTENTICACAO } from '../../config/throttler.config';
import {
  AlvoDoQuizDto,
  CelulaDaGradeDto,
  DefinirSenhaDto,
  HorariosDoCronDto,
  SalvarAlvoDto,
  SalvarHorariosDto,
  SenhaReveladaDto,
  TurmasDoLoteDto,
} from '../dto/grade-senhas.dto';
import { GradeSenhasService } from '../service/grade-senhas.service';
import { ResolucaoOrgUnitService } from '../service/resolucao-orgunit.service';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { BadRequestException } from '@nestjs/common';

/**
 * A grade dia x turno que a secretaria preenche, e a pre-visualizacao do que
 * o lote vai tocar.
 *
 * **A senha nunca sai na listagem.** `GET /senhas-de-prova` devolve `temSenha`;
 * o valor so vem de `/:id/revelar`, que e auditada em toda chamada. A grade fica
 * aberta num monitor compartilhado da secretaria — revelar precisa ser um ATO,
 * e um ato com rastro.
 */
@ApiTags(TAGS.SENHAS_QUIZ)
@Controller('senhas-de-prova')
@SomenteAdmin()
export class GradeSenhasController {
  constructor(
    private readonly grade: GradeSenhasService,
    private readonly resolucao: ResolucaoOrgUnitService,
    private readonly periodo: PeriodoService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'A grade de senhas do intervalo (sem os valores)',
    description:
      'Uma linha por celula CADASTRADA. A tela desenha as colunas do intervalo e ' +
      'preenche com o que vier — celula ausente e celula vazia.\n\n' +
      '`situacao` responde a pergunta operacional: `DESATUALIZADA` significa que ' +
      'a senha foi editada DEPOIS de aplicada, ou seja, o Brightspace ainda esta ' +
      'com a anterior.',
  })
  @ApiQuery({ name: 'de', example: '2026-09-10', description: 'AAAA-MM-DD.' })
  @ApiQuery({ name: 'ate', example: '2026-09-16', description: 'AAAA-MM-DD.' })
  @ApiOkResponse({ type: [CelulaDaGradeDto] })
  @ApiBadRequestResponse({ description: 'Intervalo ausente ou invalido' })
  listar(@Query('de') de?: string, @Query('ate') ate?: string) {
    if (!de || !ate) {
      throw new BadRequestException(
        'Informe `de` e `ate` (AAAA-MM-DD): a grade e sempre de um intervalo.',
      );
    }

    return this.grade.listar(de, ate);
  }

  @Put()
  @ApiOperation({
    summary: 'Cadastra ou atualiza a senha de uma celula',
    description:
      'Upsert por (data, turno).\n\n' +
      'A `versao` sobe **so quando o valor muda** — salvar a mesma senha de novo ' +
      'nao pode fazer a tela alegar que o Brightspace ficou para tras.\n\n' +
      'Recusa senha vazia, com espaco nas pontas ou com caractere invisivel. A do ' +
      'meio e a que mais importa: o Brightspace ACEITA, e quem descobriria seriam ' +
      'os alunos, no dia, digitando a senha da folha impressa.',
  })
  @ApiOkResponse({ type: CelulaDaGradeDto })
  @ApiBadRequestResponse({
    description: 'Senha invalida, ou data fora do formato',
  })
  definir(@Body() dto: DefinirSenhaDto, @AdminLogado() admin: AdminJwtPayload) {
    return this.grade.definir(dto, admin.email);
  }

  @Get('turmas')
  @ApiOperation({
    summary: 'Pre-visualiza quais turmas o lote vai tocar',
    description:
      'O conjunto e **CSV de turmas ∩ ofertas do periodo letivo vigente**. Nao ' +
      'depende de turno: ele e o mesmo em toda execucao — o turno so decide qual ' +
      'senha entra.\n\n' +
      'Uma oferta do semestre que **nao** esta no CSV e ignorada: ela nao tem prova.\n\n' +
      '**Revise `naoResolvidas` antes do primeiro dia.** Cada linha ali e uma ' +
      'turma do CSV cujo `orgUnitId` nao foi descoberto — e ela ficaria sem senha, ' +
      'silenciosamente.\n\n' +
      'Esta rota tambem APRENDE: o `orgUnitId` descoberto e gravado em ' +
      '`turma_importada`, nunca sobrescrevendo o que ja existia.',
  })
  @ApiOkResponse({ type: TurmasDoLoteDto })
  @ApiBadRequestResponse({
    description:
      'Integracao D2L desligada, ou nenhum periodo letivo cadastrado',
  })
  async turmas(): Promise<TurmasDoLoteDto> {
    const periodoLetivoId = await this.periodo.periodoLetivoVigente();

    if (!periodoLetivoId) {
      throw new BadRequestException(
        'Nenhum periodo letivo cadastrado. Sem ele nao ha como separar as turmas ' +
          'deste semestre das dos semestres passados.',
      );
    }

    return this.resolucao.resolver(periodoLetivoId);
  }

  @Get('alvo')
  @ApiOperation({
    summary: 'Qual questionario o lote procura',
    description:
      'Fica no BANCO e nao no `.env` porque o nome da prova muda por semestre e a ' +
      'secretaria precisa troca-lo sem deploy.\n\n' +
      '**Nao ha valor padrao.** Enquanto ninguem escolher, `nomeQuiz` vem nulo, ' +
      '`configurado` vem `false` e o lote recusa comecar — um alvo que ja viesse ' +
      'preenchido faria o lote rodar com o nome errado, em silencio, em toda ' +
      'turma do CSV de uma vez.',
  })
  @ApiOkResponse({ type: AlvoDoQuizDto })
  lerAlvo() {
    return this.grade.lerAlvo();
  }

  @Get('horarios')
  @ApiOperation({
    summary: 'A que horas o cron aplica cada turno',
    description:
      'Saiu do `.env` em 19/08/2026: o calendario dos turnos muda por semestre, e ' +
      'quem o conhece e a secretaria. Turno sem horario **nao dispara** — e assim ' +
      'que sabado a noite, que nao tem prova, fica de fora.\n\n' +
      '`cronHabilitado` e `toleranciaMin` vem do `.env` e sao **so leitura**: ' +
      'a tela precisa poder avisar que esta instancia nao dispara nada, senao o ' +
      'admin cadastra 07:30 e espera por um cron desligado.',
  })
  @ApiOkResponse({ type: HorariosDoCronDto })
  lerHorarios() {
    return this.grade.lerHorarios();
  }

  @Put('horarios')
  @ApiOperation({
    summary: 'Define os horarios do cron',
    description:
      'Vale a partir do minuto seguinte, sem reiniciar o servidor: o cron le ' +
      'estes valores a cada tick.\n\n' +
      'Campo vazio desliga o turno. Formato invalido e **recusado** de proposito: ' +
      'um "7:30" aceito calado viraria um turno que nunca dispara, e ninguem ' +
      'descobriria antes do dia da prova.',
  })
  @ApiOkResponse({ type: HorariosDoCronDto })
  @ApiBadRequestResponse({ description: 'Horario fora do formato HH:MM' })
  salvarHorarios(
    @Body() dto: SalvarHorariosDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.grade.salvarHorarios(dto, admin.email);
  }

  @Put('alvo')
  @ApiOperation({
    summary: 'Define o questionario que o lote procura',
    description:
      '**Cuidado com `CONTEM`**: "Prova" casa "Prova N1", "Prova N2" e "Prova de ' +
      'recuperacao". O lote nao escolhe turma por turma, entao um nome generico ' +
      'troca a senha de simulados e atividades em toda turma do CSV de uma vez. ' +
      'Confira no dry-run, que lista cada questionario casado.',
  })
  @ApiOkResponse({ type: AlvoDoQuizDto })
  @ApiBadRequestResponse({ description: 'Nome vazio ou matchQuiz invalido' })
  salvarAlvo(
    @Body() dto: SalvarAlvoDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.grade.salvarAlvo(dto, admin.email);
  }

  @Get(':id/revelar')
  // Mesmo limite das rotas de credencial: e a unica rota do sistema que devolve
  // uma senha de prova em texto claro, e o uso legitimo e um clique de cada vez.
  @Throttle(LIMITE_AUTENTICACAO)
  @ApiOperation({
    summary: 'Revela a senha de uma celula (auditado)',
    description:
      'A **unica** rota que devolve o valor. Existe separada da listagem de ' +
      'proposito: a grade fica aberta num monitor compartilhado da secretaria, e ' +
      'ver a senha precisa ser um ato deliberado.\n\n' +
      'Toda chamada vira `SENHA_QUIZ_REVELADA` no log de seguranca, com quem ' +
      'pediu e qual celula.',
  })
  @ApiParam({ name: 'id', type: Number, example: 3 })
  @ApiOkResponse({ type: SenhaReveladaDto })
  @ApiNotFoundResponse({ description: 'Celula nao encontrada' })
  revelar(
    @Param('id', ParseIntPipe) id: number,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.grade.revelar(id, admin.email);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Apaga a senha de uma celula',
    description:
      'Retencao: uma tabela com as senhas de um semestre inteiro e um passivo.\n\n' +
      'A execucao historica **sobrevive** (a FK vira nula e data/turno ficam ' +
      'gravados na propria execucao): apagar o segredo nao pode apagar a prova de ' +
      'que o lote rodou.',
  })
  @ApiParam({ name: 'id', type: Number, example: 3 })
  @ApiNoContentResponse({ description: 'Celula apagada' })
  @ApiNotFoundResponse({ description: 'Celula nao encontrada' })
  async remover(
    @Param('id', ParseIntPipe) id: number,
    @AdminLogado() admin: AdminJwtPayload,
  ): Promise<void> {
    await this.grade.remover(id, admin.email);
  }
}
