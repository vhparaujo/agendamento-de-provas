import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
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
import {
  PaginaDeTurmasDto,
  RemocaoTurmaDto,
  TurmaImportadaDetalheDto,
} from '../dto/turma-admin.response.dto';
import { TurmaAdminService } from '../service/turma-admin.service';

/**
 * O catalogo do que TEM prova, do jeito que o admin precisa ler: por nome de
 * disciplina, por codigo, ou pelo que ainda nao apareceu em nenhum launch.
 *
 * Leitura, mais UM delete. Editar turma aqui continua fora — a planilha e a
 * fonte de verdade e o proximo upload desfaria a correcao —, mas APAGAR nao
 * tinha substituto: a importacao e upsert e nunca remove o que saiu do CSV,
 * entao a linha errada ficava agendavel para sempre.
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
