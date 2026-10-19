import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { IntegracaoPayload } from '../../auth/jwt/jwt.types';
import {
  IntegracaoLogada,
  SomenteIntegracao,
} from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { extrairIp } from '../../seguranca/requisicao.util';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import {
  AgendamentosDoAlunoDto,
  PaginaDeAgendamentosIntegracaoDto,
} from '../dto/agendamentos-do-aluno.response.dto';
import {
  IntegracaoService,
  MAXIMO_POR_PAGINA,
  PADRAO_POR_PAGINA,
  type FiltroDaLista,
  type RecorteDoPeriodo,
} from '../service/integracao.service';

/** O RA e alfanumerico por construcao ("0009552430", "A06103080", "UC25426847"). */
const FORMATO_DA_MATRICULA = /^[A-Za-z0-9]{1,30}$/;

/** Org unit do Brightspace ("12345"); hifen e sublinhado para os ids de teste. */
const FORMATO_DO_PERIODO_LETIVO = /^[A-Za-z0-9_-]{1,191}$/;

/** As duas grades de uma janela cabem com folga; mais que isso e varredura. */
const MAXIMO_DE_PERIODOS_LETIVOS = 10;

/** Texto livre no cadastro, ate 20 caracteres ("N2", "SUB", "N1"...). */
const FORMATO_DA_RODADA = /^[\p{L}\p{N} _-]{1,20}$/u;

@ApiTags(TAGS.INTEGRACAO)
@Controller('integracao')
@SomenteIntegracao()
export class IntegracaoController {
  constructor(
    private readonly service: IntegracaoService,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get('alunos/:matricula/agendamentos')
  @ApiOperation({
    summary: 'Dados de agendamento de um aluno, para o emissor da declaracao',
    description:
      'Tudo o que a declaracao de agendamento e a tela "Prova agendada" do ' +
      'portal mostram, por RA, num endpoint so: nome, cursos (com formato e ' +
      'polo da matricula), as janelas de agendamento em `periodos[]` (rodada, ' +
      'datas, `prazoEncerrado`) e cada prova confirmada com data, horario, ' +
      'polo, sala e disciplinas, apontando para a sua janela pelo ' +
      '`periodoId`.\n\n' +
      '**Recorte:** historico completo da matricula, **so provas ' +
      'CONFIRMADAS**, da mais recente para a mais antiga. `?periodo=atual` ' +
      'estreita para a janela vigente — a mesma que o aluno ve no portal.\n\n' +
      '**So emita a declaracao quando a janela da prova tiver ' +
      '`prazoEncerrado: true`.** ' +
      'Com o prazo aberto o aluno ainda troca de horario, e o documento ' +
      'afirmaria uma data que ele pode mudar.\n\n' +
      'Autentica por **API key** (`X-API-Key`), nunca por JWT. Toda consulta ' +
      'fica na auditoria com o sistema e a matricula consultada.',
  })
  @ApiParam({ name: 'matricula', type: String, example: 'UC2642816' })
  @ApiQuery({
    name: 'periodo',
    required: false,
    enum: ['atual'],
    description:
      'Ausente = historico completo. `atual` = so a janela de agendamento ' +
      'vigente (N2 **ou** SUB, a cadastrada por ultimo).',
  })
  @ApiOkResponse({ type: AgendamentosDoAlunoDto })
  @ApiBadRequestResponse({
    description: 'Matricula fora do formato, ou `periodo` diferente de `atual`',
  })
  @ApiNotFoundResponse({
    description: 'Matricula nao existe entre os alunos importados',
  })
  async agendamentosDoAluno(
    @IntegracaoLogada() integracao: IntegracaoPayload,
    @Param('matricula') matricula: string,
    @Query('periodo') periodo: string | undefined,
    @Req() req: Request,
  ): Promise<AgendamentosDoAlunoDto> {
    if (!FORMATO_DA_MATRICULA.test(matricula)) {
      throw new BadRequestException(
        'Matricula invalida: use so letras e numeros (ex: UC2642816).',
      );
    }

    const recorte = lerRecorte(periodo);

    const registrar = (detalhe: string) =>
      this.auditoria.registrar('INTEGRACAO_CONSULTA', {
        ator: `integracao:${integracao.sistema}`,
        rota: `${req.method} ${req.originalUrl}`,
        ip: extrairIp(req),
        detalhe: `matricula=${matricula} periodo=${recorte ?? 'todos'} ${detalhe}`,
      });

    try {
      const resposta = await this.service.agendamentosPorMatricula(
        matricula,
        recorte,
      );

      registrar(`agendamentos=${resposta.agendamentos.length}`);

      return resposta;
    } catch (erro) {
      // A consulta a um RA inexistente tambem e leitura por terceiro — e uma
      // sequencia delas e exatamente o que se quer enxergar numa varredura.
      if (erro instanceof NotFoundException) {
        registrar('resultado=matricula-nao-encontrada');
      }

      throw erro;
    }
  }

  @Get('agendamentos')
  @ApiOperation({
    summary: 'Todas as provas confirmadas de um periodo, paginadas',
    description:
      'A lista geral, sem matricula. Os dados da janela de agendamento ' +
      '(rodada, datas, `prazoEncerrado`) vem **uma vez**, em `periodos[]`; ' +
      'cada prova traz so o que e do aluno e aponta para a sua janela pelo ' +
      '`periodoId`.\n\n' +
      '**Recorte obrigatorio — um dos dois:**\n' +
      '- `?periodo=atual` — a janela vigente (N2 **ou** SUB, a cadastrada por ' +
      'ultimo), nas duas grades;\n' +
      '- `?periodoLetivoId=12345` — um periodo letivo do Brightspace, para ' +
      'consultar um anterior. Aceita varios separados por virgula (o modulo do ' +
      'EaD e o semestre do Presencial). `&rodada=SUB` estreita para uma prova ' +
      'so; sem ela vem a N2 e a SUB juntas.\n\n' +
      'Sem recorte, ou com os dois, responde 400: o historico de todos os ' +
      'alunos de uma vez nao e oferecido.\n\n' +
      'Ordenada por data, horario e matricula. Percorra `pagina` ate ' +
      '`totalPaginas`.\n\n' +
      '**So emita declaracao de prova cuja janela tenha `prazoEncerrado: ' +
      'true`.** ' +
      'Autentica por **API key** (`X-API-Key`). Toda consulta fica na auditoria.',
  })
  @ApiQuery({
    name: 'periodo',
    required: false,
    enum: ['atual'],
    description: 'A janela vigente. Nao combina com `periodoLetivoId`.',
  })
  @ApiQuery({
    name: 'periodoLetivoId',
    required: false,
    type: String,
    example: '12345',
    description: `Um ou mais (ate ${MAXIMO_DE_PERIODOS_LETIVOS}), separados por virgula.`,
  })
  @ApiQuery({
    name: 'rodada',
    required: false,
    type: String,
    example: 'SUB',
    description: 'So com `periodoLetivoId`. Ausente = todas as rodadas.',
  })
  @ApiQuery({ name: 'pagina', required: false, type: Number, example: 1 })
  @ApiQuery({
    name: 'porPagina',
    required: false,
    type: Number,
    example: PADRAO_POR_PAGINA,
    description: `Padrao ${PADRAO_POR_PAGINA}, maximo ${MAXIMO_POR_PAGINA}.`,
  })
  @ApiOkResponse({ type: PaginaDeAgendamentosIntegracaoDto })
  @ApiBadRequestResponse({
    description:
      'Sem recorte, com os dois recortes, `rodada` sem `periodoLetivoId`, ' +
      'parametro fora do formato ou paginacao invalida',
  })
  async listarAgendamentos(
    @IntegracaoLogada() integracao: IntegracaoPayload,
    @Query('periodo') periodo: string | undefined,
    @Query('periodoLetivoId') periodoLetivoId: string | undefined,
    @Query('rodada') rodada: string | undefined,
    @Query('pagina') pagina: string | undefined,
    @Query('porPagina') porPagina: string | undefined,
    @Req() req: Request,
  ): Promise<PaginaDeAgendamentosIntegracaoDto> {
    const filtro = lerFiltroDaLista(periodo, periodoLetivoId, rodada);
    const numeroDaPagina = lerInteiro(pagina, 'pagina') ?? 1;
    const tamanho = Math.min(
      lerInteiro(porPagina, 'porPagina') ?? PADRAO_POR_PAGINA,
      MAXIMO_POR_PAGINA,
    );

    const resposta = await this.service.listarAgendamentos(
      filtro,
      numeroDaPagina,
      tamanho,
    );

    // Sem matricula no detalhe: a lista e de todo mundo, e o que importa para
    // enxergar uma varredura e QUAL recorte foi lido e quantas paginas.
    this.auditoria.registrar('INTEGRACAO_CONSULTA', {
      ator: `integracao:${integracao.sistema}`,
      rota: `${req.method} ${req.originalUrl}`,
      ip: extrairIp(req),
      detalhe:
        `lista periodo=${resposta.filtro.periodo ?? 'letivo'} ` +
        `letivos=${resposta.filtro.periodoLetivoIds.join(',') || '-'} ` +
        `rodada=${resposta.filtro.rodada ?? 'todas'} ` +
        `pagina=${resposta.pagina}/${resposta.totalPaginas} ` +
        `itens=${resposta.itens.length} total=${resposta.total}`,
    });

    return resposta;
  }
}

/**
 * Lido a mao, e nao por DTO, como os filtros do relatorio: com
 * `forbidNonWhitelisted`, um parametro a mais na URL derrubaria a chamada de um
 * sistema que nao controlamos.
 */
function lerRecorte(periodo: string | undefined): RecorteDoPeriodo {
  if (periodo === undefined || periodo === '') return null;
  if (periodo === 'atual') return 'atual';

  throw new BadRequestException(
    'Parametro `periodo` invalido: o unico valor aceito e `atual`.',
  );
}

/** O recorte da lista geral: exatamente um entre `periodo=atual` e `periodoLetivoId`. */
function lerFiltroDaLista(
  periodo: string | undefined,
  periodoLetivoId: string | undefined,
  rodada: string | undefined,
): FiltroDaLista {
  const recorte = lerRecorte(periodo);
  const letivos = (periodoLetivoId ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const rodadaLida = rodada?.trim() || null;

  if (recorte === 'atual' && letivos.length > 0) {
    throw new BadRequestException(
      'Use `periodo=atual` ou `periodoLetivoId`, nao os dois.',
    );
  }

  if (recorte === 'atual') {
    // A rodada do `atual` e a da janela vigente; aceitar outra aqui faria a
    // URL pedir uma coisa e a resposta entregar outra.
    if (rodadaLida) {
      throw new BadRequestException(
        '`rodada` so vale com `periodoLetivoId`: no `periodo=atual` ela e a da janela vigente.',
      );
    }

    return { periodo: 'atual' };
  }

  if (letivos.length === 0) {
    throw new BadRequestException(
      'Informe o recorte: `periodo=atual` ou `periodoLetivoId=<id do Brightspace>`.',
    );
  }

  if (letivos.length > MAXIMO_DE_PERIODOS_LETIVOS) {
    throw new BadRequestException(
      `No maximo ${MAXIMO_DE_PERIODOS_LETIVOS} periodos letivos por consulta.`,
    );
  }

  if (!letivos.every((id) => FORMATO_DO_PERIODO_LETIVO.test(id))) {
    throw new BadRequestException(
      '`periodoLetivoId` invalido: use letras, numeros, hifen ou sublinhado, separados por virgula.',
    );
  }

  if (rodadaLida && !FORMATO_DA_RODADA.test(rodadaLida)) {
    throw new BadRequestException(
      '`rodada` invalida: ate 20 letras ou numeros (ex: N2, SUB).',
    );
  }

  return {
    periodo: null,
    periodoLetivoIds: [...new Set(letivos)],
    rodada: rodadaLida,
  };
}

/** Inteiro positivo da URL, ou `undefined` quando ausente. Lixo responde 400. */
function lerInteiro(
  valor: string | undefined,
  nome: string,
): number | undefined {
  if (valor === undefined || valor === '') return undefined;

  if (!/^\d{1,9}$/.test(valor) || Number(valor) < 1) {
    throw new BadRequestException(
      `Parametro \`${nome}\` invalido: use um inteiro a partir de 1.`,
    );
  }

  return Number(valor);
}
