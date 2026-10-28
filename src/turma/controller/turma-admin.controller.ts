import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { RenomearTurmaDto } from '../dto/turma-admin.dto';
import {
  PaginaDeTurmasDto,
  RemocaoTurmaDto,
  RenomeacaoTurmaDto,
  TurmaImportadaDetalheDto,
} from '../dto/turma-admin.response.dto';
import { TurmaAdminService } from '../service/turma-admin.service';

/**
 * O catalogo do que TEM prova, do jeito que o admin precisa ler: por nome de
 * disciplina, por codigo, ou pelo que ainda nao apareceu em nenhum launch.
 *
 * Leitura, mais o delete e a troca de nome. APAGAR nao tinha substituto: a
 * importacao e upsert e nunca remove o que saiu do CSV, entao a linha errada
 * ficava agendavel para sempre. RENOMEAR tambem nao: reimportar com outro nome
 * cria uma turma nova, sem o orgUnitId aprendido. Os codigos nao se editam —
 * sao eles que casam a turma com a oferta do Brightspace.
 */
@ApiTags(TAGS.TURMAS)
@Controller('turmas')
@SomenteAdmin()
export class TurmaAdminController {
  constructor(private readonly service: TurmaAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Pesquisa as turmas/disciplinas importadas pelo CSV',
    description:
      'Estas sao as turmas que **efetivamente terao prova** — o filtro final do ' +
      'que o aluno consegue agendar. Se uma disciplina nao esta aqui, ela nao ' +
      'aparece para ninguem (com `TURMAS_FILTER_ENABLED=true`, o default).\n\n' +
      '`busca` casa com **codigo da turma, nome da disciplina, codigo EAD ou ' +
      'orgUnitId** ao mesmo tempo: a mesma turma e chamada por nomes diferentes ' +
      'dependendo de quem pergunta.\n\n' +
      'O `orgUnitId` nao vem da planilha — ele e **aprendido** a cada launch e vai ' +
      'completando a tabela sozinho ao longo do periodo. Use `comOrgUnitId=false` ' +
      'para ver o que ainda nao foi visto por nenhum aluno.',
  })
  @ApiQuery({
    name: 'busca',
    required: false,
    type: String,
    example: 'SAUDE',
    description:
      'Casa com codigo da turma, nome da disciplina, codigo EAD ou orgUnitId.',
  })
  @ApiQuery({
    name: 'importacaoId',
    required: false,
    type: Number,
    example: 8,
    description:
      'So as turmas que vieram deste upload (ver `GET /importacao`).',
  })
  @ApiQuery({
    name: 'comOrgUnitId',
    required: false,
    type: Boolean,
    description:
      'true = so as que ja foram identificadas no D2L; false = as que nenhum ' +
      'launch alcancou ainda.',
  })
  @ApiQuery({ name: 'pagina', required: false, type: Number, example: 1 })
  @ApiQuery({
    name: 'porPagina',
    required: false,
    type: Number,
    example: 50,
    description: 'Padrao 50, maximo 200.',
  })
  @ApiOkResponse({ type: PaginaDeTurmasDto })
  listar(@Query() query: Record<string, string>) {
    return this.service.listar(lerFiltro(query));
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalha uma turma importada',
    description:
      'Alem dos codigos, diz de qual upload ela veio e quantos agendamentos ' +
      'confirmados a cobrem — este ultimo so quando o `orgUnitId` ja foi ' +
      'aprendido, porque e por ele que o agendamento aponta para a disciplina.',
  })
  @ApiParam({ name: 'id', type: Number, example: 214 })
  @ApiOkResponse({ type: TurmaImportadaDetalheDto })
  @ApiNotFoundResponse({ description: 'Turma nao encontrada' })
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.service.buscar(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Renomeia a disciplina de uma turma importada',
    description:
      'Troca o nome **sem perder as ligacoes**: o id, o `orgUnitId` aprendido, ' +
      'o formato escolhido e as provas marcadas continuam apontando para a ' +
      'turma. Os agendamentos **confirmados** dela passam a mostrar o nome novo ' +
      '(cancelados e relatorios de execucao ficam como estavam).\n\n' +
      '⚠️ **O nome entra no cruzamento com o Brightspace** quando o codigo nao ' +
      'resolve sozinho (`turma-match.ts`): um nome que nao bata com o titulo da ' +
      'disciplina no AVA pode deixar a turma `DIVERGENTE` e impedir o ' +
      'agendamento.\n\n' +
      'A reimportacao **nao duplica**: o nome da planilha fica guardado em ' +
      '`nomeNaPlanilha`, e o upload reconhece a turma por ele, mantendo o nome ' +
      'dado aqui.',
  })
  @ApiParam({ name: 'id', type: Number, example: 214 })
  @ApiOkResponse({ type: RenomeacaoTurmaDto })
  @ApiBadRequestResponse({ description: 'Nome vazio ou longo demais' })
  @ApiNotFoundResponse({ description: 'Turma nao encontrada' })
  @ApiConflictResponse({
    description:
      'Ja existe outra turma com o mesmo codigo e este nome — o par e unico',
  })
  renomear(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RenomearTurmaDto,
  ) {
    return this.service.renomear(id, dto.nomeDisciplina);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Tira uma turma do catalogo (ela deixa de ser agendavel)',
    description:
      'Para desfazer carga errada — linha duplicada, turma que entrou na ' +
      'planilha sem ter prova. O efeito e imediato: a disciplina some do filtro ' +
      'final e nenhum aluno consegue mais agenda-la.\n\n' +
      '⚠️ **Nao substitui corrigir a planilha.** A importacao de turmas e ' +
      '`upsert` — ela nunca apaga o que saiu do CSV —, entao se a linha ' +
      'continuar la o proximo upload traz a turma de volta, com id novo e sem o ' +
      '`orgUnitId` ja aprendido nos launches.\n\n' +
      'Turma com prova marcada e recusada (409). Apagar nao desmarcaria nada — ' +
      'o agendamento guarda o `orgUnitId` como fotografia, sem chave ' +
      'estrangeira —, so tiraria o nome da turma do relatorio.',
  })
  @ApiParam({ name: 'id', type: Number, example: 214 })
  @ApiOkResponse({ type: RemocaoTurmaDto })
  @ApiNotFoundResponse({ description: 'Turma nao encontrada' })
  @ApiConflictResponse({
    description:
      'Turma com agendamentos confirmados — cancele as provas antes de apagar',
  })
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.service.remover(id);
  }
}

/** Filtros lidos a mao pelo mesmo motivo da listagem de alunos: URL de busca se cola e edita. */
function lerFiltro(query: Record<string, string>) {
  return {
    busca: query.busca || undefined,
    importacaoId: inteiro(query.importacaoId),
    comOrgUnitId: booleano(query.comOrgUnitId),
    pagina: inteiro(query.pagina),
    porPagina: inteiro(query.porPagina),
  };
}

function inteiro(valor?: string): number | undefined {
  const numero = Number(valor);

  return valor !== undefined && Number.isInteger(numero) && numero > 0
    ? numero
    : undefined;
}

/** Qualquer coisa fora de "true"/"false" e tratada como filtro ausente. */
function booleano(valor?: string): boolean | undefined {
  if (valor === 'true') return true;
  if (valor === 'false') return false;

  return undefined;
}
