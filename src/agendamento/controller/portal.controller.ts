import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
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
  SituacaoPeriodoDto,
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
}
