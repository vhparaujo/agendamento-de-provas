import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import {
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
  AlunoImportadoDetalheDto,
  PaginaDeAlunosDto,
} from '../dto/aluno-admin.response.dto';
import { AlunoAdminService } from '../service/aluno-admin.service';

/**
 * A consulta do admin sobre quem os CSVs trouxeram.
 *
 * Somente leitura de proposito: a planilha e a fonte de verdade, e um ajuste
 * feito aqui seria apagado pelo proximo upload sem ninguem perceber. Para
 * corrigir um aluno, corrige-se o CSV e reimporta.
 */
@ApiTags(TAGS.ALUNOS)
@Controller('alunos')
@SomenteAdmin()
export class AlunoAdminController {
  constructor(private readonly service: AlunoAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Pesquisa os alunos importados pelos CSVs',
    description:
      'Cada item e um **vinculo** (aluno + curso), nao um aluno: um mesmo RA em ' +
      'dois cursos aparece duas vezes, com modalidades possivelmente diferentes ' +
      'e um agendamento para cada.\n\n' +
      '`busca` casa com **matricula, nome, e-mail ou curso** ao mesmo tempo — e o ' +
      'campo unico do balcao, onde nem sempre se sabe qual dado a pessoa tem em maos.\n\n' +
      'Atencao a `ativo`: ele significa **pode agendar**, derivado de `statusCurso` ' +
      'pela lista de `status-curso.enum.ts`, e nao e o mesmo que STATUS CURSO igual ' +
      'a "Ativo" (transferencia e mudanca de habilitacao tambem agendam).',
  })
  @ApiQuery({
    name: 'busca',
    required: false,
    type: String,
    example: 'UC244',
    description: 'Casa com matricula, nome, e-mail ou curso.',
  })
  @ApiQuery({ name: 'poloId', required: false, type: Number, example: 6 })
  @ApiQuery({ name: 'modalidadeId', required: false, type: Number, example: 1 })
  @ApiQuery({
    name: 'curso',
    required: false,
    type: String,
    example: 'PEDAGOGIA',
    description: 'Nome exato do curso — use `GET /alunos/cursos` no dropdown.',
  })
  @ApiQuery({
    name: 'ativo',
    required: false,
    type: Boolean,
    description: 'true = so os que podem agendar; false = so os bloqueados.',
  })
  @ApiQuery({
    name: 'importacaoId',
    required: false,
    type: Number,
    example: 7,
    description:
      'So os vinculos que vieram deste upload (ver `GET /importacao`).',
  })
  @ApiQuery({
    name: 'agendado',
    required: false,
    type: Boolean,
    description:
      'true = so quem ja tem prova confirmada; false = a lista de quem ainda ' +
      'nao marcou, que e a de quem precisa ser cobrado.',
  })
  @ApiQuery({ name: 'pagina', required: false, type: Number, example: 1 })
  @ApiQuery({
    name: 'porPagina',
    required: false,
    type: Number,
    example: 50,
    description: 'Padrao 50, maximo 200.',
  })
  @ApiOkResponse({ type: PaginaDeAlunosDto })
  listar(@Query() query: Record<string, string>) {
    return this.service.listar(lerFiltro(query));
  }

  /** Antes de `:id` de proposito: senao "cursos" cairia no ParseIntPipe. */
  @Get('cursos')
  @ApiOperation({
    summary: 'Cursos distintos presentes na base',
    description: 'Popula o dropdown de filtro da listagem de alunos.',
  })
  @ApiOkResponse({ type: [String] })
  cursos() {
    return this.service.cursos();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalha um vinculo de aluno',
    description:
      'A tela de atendimento: de qual upload o registro veio, os **outros ' +
      'vinculos da mesma matricula** e as provas ja marcadas — incluindo as ' +
      'canceladas, porque "cancelou dia 12" e uma resposta e sumir nao e.\n\n' +
      'O `id` e o do vinculo, nao a matricula.',
  })
  @ApiParam({ name: 'id', type: Number, example: 3187 })
  @ApiOkResponse({ type: AlunoImportadoDetalheDto })
  @ApiNotFoundResponse({ description: 'Vinculo nao encontrado' })
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.service.buscar(id);
  }
}

/**
 * Os filtros sao lidos a mao, sem DTO, pelo mesmo motivo do relatorio de
 * agendamentos: com `forbidNonWhitelisted`, um parametro a mais na URL derrubaria
 * a requisicao — e URL de busca e coisa que se cola, edita e compartilha.
 */
function lerFiltro(query: Record<string, string>) {
  return {
    busca: query.busca || undefined,
    poloId: inteiro(query.poloId),
    modalidadeId: inteiro(query.modalidadeId),
    curso: query.curso || undefined,
    ativo: booleano(query.ativo),
    importacaoId: inteiro(query.importacaoId),
    agendado: booleano(query.agendado),
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
