import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import { AlunoLogado, SomenteAluno } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { PeriodoService } from '../../periodo/service/periodo.service';
import {
  AgendamentoConfirmadoDto,
  AgendarDto,
  DisciplinasAgendaveisDto,
  FaixaDisponivelDto,
  MensagemPortalDto,
  SituacaoPeriodoDto,
  TrocarHorarioDto,
} from '../dto/portal.dto';
import { AgendamentoService } from '../service/agendamento.service';

const DESCRICAO_ALUNO_ID =
  'Vinculo (curso) desta prova. Obrigatorio para quem tem mais de um curso — ' +
  '`precisaEscolherCurso: true` no launch.';

/**
 * O que o ALUNO acessa depois do launch LTI. Tudo aqui e filtrado pelo vinculo:
 * ele nunca escolhe polo nem modalidade, que vem do CSV importado.
 */
@ApiTags(TAGS.PORTAL)
@Controller('portal')
@SomenteAluno()
export class PortalController {
  constructor(
    private readonly agendamento: AgendamentoService,
    private readonly periodo: PeriodoService,
  ) {}

  @Get('periodo')
  @ApiOperation({
    summary: 'Diz se o agendamento esta aberto',
    description:
      'Fecha so por data/hora, nunca por vagas esgotadas. Fechado, `motivo` ja ' +
      'traz o texto a exibir (ainda nao abriu / prazo encerrado / nao configurado).',
  })
  @ApiOkResponse({ type: SituacaoPeriodoDto })
  situacaoDoPeriodo() {
    return this.periodo.situacaoAtual();
  }

  @Get('disciplinas')
  @ApiOperation({
    summary: 'As disciplinas que a prova vai cobrir',
    description:
      'Disciplinas do aluno ∩ turmas com prova (CSV de turmas) ∩ periodo letivo. ' +
      'Nao sao todas as disciplinas dele. Lista vazia = nao ha o que agendar, e ' +
      '`motivo` explica.',
  })
  @ApiQuery({
    name: 'alunoId',
    required: false,
    type: Number,
    example: 4821,
    description: DESCRICAO_ALUNO_ID,
  })
  @ApiOkResponse({ type: DisciplinasAgendaveisDto })
  @ApiBadRequestResponse({
    description: 'Aluno com mais de um curso e sem `alunoId`',
  })
  @ApiForbiddenResponse({
    description: 'Vinculo nao pertence a esta matricula',
  })
  disciplinas(
    @AlunoLogado() aluno: AlunoJwtPayload,
    @Query('alunoId', new ParseIntPipe({ optional: true })) alunoId?: number,
  ) {
    return this.agendamento.disciplinas(aluno, alunoId);
  }

  @Get('faixas')
  @ApiOperation({
    summary: 'Os horarios que este aluno pode escolher',
    description:
      'Faixas do polo do aluno que ofertam a modalidade dele, ativas e ainda por ' +
      'acontecer. Sem sala: a sala e definida pela alocacao na hora de confirmar. ' +
      'Horario lotado vem com `temVaga: false` em vez de sumir da lista.',
  })
  @ApiQuery({
    name: 'alunoId',
    required: false,
    type: Number,
    example: 4821,
    description: DESCRICAO_ALUNO_ID,
  })
  @ApiOkResponse({ type: [FaixaDisponivelDto] })
  @ApiBadRequestResponse({
    description: 'Aluno com mais de um curso e sem `alunoId`',
  })
  @ApiForbiddenResponse({
    description: 'Vinculo nao pertence a esta matricula',
  })
  faixas(
    @AlunoLogado() aluno: AlunoJwtPayload,
    @Query('alunoId', new ParseIntPipe({ optional: true })) alunoId?: number,
  ) {
    return this.agendamento.listarFaixas(aluno, alunoId);
  }

  @Get('agendamentos')
  @ApiOperation({
    summary: 'As provas que esta matricula ja marcou',
    description:
      'Um agendamento por curso: quem tem dois vinculos e marcou os dois recebe dois.',
  })
  @ApiOkResponse({ type: [AgendamentoConfirmadoDto] })
  meusAgendamentos(@AlunoLogado() aluno: AlunoJwtPayload) {
    return this.agendamento.meusAgendamentos(aluno);
  }

  @Post('agendamentos')
  @ApiOperation({
    summary: 'Confirma a prova no horario escolhido',
    description:
      'A sala e escolhida pelo sistema: enche a de menor ordem antes de abrir a ' +
      'proxima. A reserva cobre TODAS as disciplinas agendaveis do vinculo, e ja ' +
      'enfileira a liberacao no Brightspace.\n\n' +
      'Recusa, nesta ordem: situacao no curso, periodo fechado, nenhuma ' +
      'disciplina com prova, horario de outro polo, horario inativo ou passado, ' +
      'prova ja marcada para o curso, vagas esgotadas.',
  })
  @ApiCreatedResponse({ type: AgendamentoConfirmadoDto })
  @ApiBadRequestResponse({
    description: 'Aluno com mais de um curso e sem `alunoId`',
  })
  @ApiForbiddenResponse({
    description:
      'Situacao no curso nao permite, periodo de agendamento fechado, nenhuma ' +
      'disciplina com prova, ou horario de outro polo',
  })
  @ApiNotFoundResponse({ description: 'Horario inexistente' })
  @ApiConflictResponse({
    description:
      'Vagas esgotadas, prova ja marcada para este curso, ou horario inativo/ja realizado',
  })
  agendar(@AlunoLogado() aluno: AlunoJwtPayload, @Body() dto: AgendarDto) {
    return this.agendamento.agendar(aluno, dto);
  }

  @Patch('agendamentos/:id')
  @ApiOperation({
    summary: 'Troca o horario da prova',
    description:
      'A troca e **atomica**: se o horario novo nao tiver vaga, voce continua com ' +
      'o que ja tinha. Cancelar e marcar de novo, por conta propria, poderia ' +
      'deixar o aluno sem nenhum horario no meio do caminho.\n\n' +
      'Vale enquanto o prazo estiver aberto. Depois disso, so a secretaria remaneja.',
  })
  @ApiParam({ name: 'id', type: Number, example: 501 })
  @ApiOkResponse({ type: AgendamentoConfirmadoDto })
  @ApiForbiddenResponse({
    description: 'Prazo encerrado, ou o agendamento nao e seu',
  })
  @ApiNotFoundResponse({ description: 'Agendamento ou horario inexistente' })
  @ApiConflictResponse({
    description:
      'Vagas esgotadas no horario novo, ja esta neste horario, ou agendamento cancelado',
  })
  trocar(
    @AlunoLogado() aluno: AlunoJwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TrocarHorarioDto,
  ) {
    return this.agendamento.trocar(aluno, id, dto.faixaId);
  }

  @Delete('agendamentos/:id')
  @ApiOperation({
    summary: 'Cancela a propria prova',
    description:
      'A vaga volta a ficar disponivel na hora. So enquanto o prazo estiver ' +
      'aberto: depois do fechamento, cancelar deixaria um lugar vago que mais ' +
      'ninguem consegue ocupar.\n\n' +
      'Para apenas mudar de horario, use a troca — ela nao corre o risco de ' +
      'deixar voce sem vaga nenhuma.',
  })
  @ApiParam({ name: 'id', type: Number, example: 501 })
  @ApiOkResponse({ type: MensagemPortalDto })
  @ApiForbiddenResponse({
    description: 'Prazo encerrado, ou o agendamento nao e seu',
  })
  @ApiNotFoundResponse({ description: 'Agendamento inexistente' })
  @ApiConflictResponse({ description: 'Ja estava cancelado' })
  cancelar(
    @AlunoLogado() aluno: AlunoJwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.agendamento.cancelar(aluno, id);
  }
}
