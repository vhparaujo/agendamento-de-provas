import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
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
  ApiProduces,
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
  TrocarHorarioDto,
} from '../dto/portal.dto';
import { AgendamentoService } from '../service/agendamento.service';
import { DeclaracaoService } from '../service/declaracao.service';

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
    private readonly declaracao: DeclaracaoService,
  ) {}

  @Get('periodo')
  @ApiOperation({
    summary: 'Diz se o agendamento esta aberto',
    description:
      'Fecha so por data/hora, nunca por vagas esgotadas. Fechado, `motivo` ja ' +
      'traz o texto a exibir (ainda nao abriu / prazo encerrado / nao configurado).\n\n' +
      '`encerrado` separa esses tres casos para a tela: ele e `true` **so** ' +
      'quando o prazo acabou (ou o admin o fechou), e e a condicao que libera o ' +
      'botao da declaracao de agendamento. "Ainda nao abriu" e "nao configurado" ' +
      'tambem sao `aberto: false`, mas nao sao `encerrado`.',
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

  @Get('agendamentos/:id/declaracao')
  @ApiOperation({
    summary: 'Baixa a declaracao de agendamento em PDF',
    description:
      'Uma folha A4 declarando que o aluno esta matriculado sob aquele RA e ' +
      'marcou a prova presencial para tal dia e hora. E o papel que ele leva ao ' +
      'trabalho para justificar a ausencia.\n\n' +
      '**So depois de o prazo de agendamento ENCERRAR** (`encerrado: true` em ' +
      '`GET /portal/periodo`). Com o prazo aberto o proprio aluno ainda troca de ' +
      'horario e cancela, entao o documento afirmaria uma data que ele mesmo pode ' +
      'mudar cinco minutos depois — e quem recebeu o papel nao tem como conferir.\n\n' +
      'O recorte e o mesmo de `GET /portal/agendamentos`: prova sua, confirmada, ' +
      'do semestre vigente. Cancelada nao emite.',
  })
  @ApiParam({ name: 'id', type: Number, example: 501 })
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'Arquivo PDF',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiForbiddenResponse({
    description: 'O prazo de agendamento ainda nao encerrou',
  })
  @ApiNotFoundResponse({
    description:
      'Agendamento inexistente, de outra pessoa, cancelado ou de outro semestre',
  })
  @ApiConflictResponse({
    description: 'Cadastro sem nome — a declaracao precisa nomear o aluno',
  })
  async declaracaoDeAgendamento(
    @AlunoLogado() aluno: AlunoJwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<StreamableFile> {
    const { nomeArquivo, conteudo } = await this.declaracao.declaracaoDoAluno(
      aluno,
      id,
    );

    /**
     * O tipo e a disposicao vao no PROPRIO arquivo, e nao num `@Header` da rota
     * nem num `res.setHeader`.
     *
     * `@Header('Content-Type', 'application/pdf')` — o jeito que as rotas de
     * relatorio usam — marca TODA resposta da rota, inclusive o 403 de prazo
     * aberto e o 404 de prova alheia, que sao JSON. Aqui isso importa: as
     * recusas desta rota sao frequentes e esperadas (o aluno chega antes do
     * fechamento), e um corpo JSON rotulado como PDF e o tipo de detalhe que
     * quebra o cliente de um jeito dificil de ler.
     */
    return new StreamableFile(conteudo, {
      type: 'application/pdf',
      disposition: `attachment; filename="${nomeArquivo}"`,
    });
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
      'A **unica** alteracao que o aluno faz na propria prova: nao existe ' +
      'cancelamento pelo portal (decisao de 17/08/2026) — quem precisa desmarcar ' +
      'procura a secretaria, que tem `DELETE /agendamentos/:id`.\n\n' +
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

  /*
   * NAO existe `DELETE agendamentos/:id` aqui (removido em 17/08/2026).
   *
   * A rota existia e era o par da troca, mas o cancelamento pelo aluno tem um
   * efeito que a troca nao tem: ele devolve a vaga e o deixa SEM prova. Num
   * periodo que ja esta lotando, a vaga liberada e ocupada por outra pessoa em
   * segundos, e o aluno que so queria mudar de dia fica de fora — chegando ao
   * balcao sem horario nenhum, quando a troca resolvia o caso dele sem risco.
   *
   * Desmarcar de verdade passou a ser decisao da secretaria, em
   * `DELETE /agendamentos/:id`, que grava o e-mail de quem cancelou no
   * historico. Nao reintroduza esta rota sem o cliente pedir: tirar o botao da
   * tela e deixar o endpoint de pe seria a mesma regra valendo em um lugar so.
   */
}
