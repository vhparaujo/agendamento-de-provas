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
import { AgendamentosDoAlunoDto } from '../dto/agendamentos-do-aluno.response.dto';
import {
  IntegracaoService,
  type RecorteDoPeriodo,
} from '../service/integracao.service';

/** O RA e alfanumerico por construcao ("0009552430", "A06103080", "UC25426847"). */
const FORMATO_DA_MATRICULA = /^[A-Za-z0-9]{1,30}$/;

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
      'polo da matricula) e cada prova confirmada com rodada, periodo, data, ' +
      'horario, polo, sala e disciplinas.\n\n' +
      '**Recorte:** historico completo da matricula, **so provas ' +
      'CONFIRMADAS**, da mais recente para a mais antiga. `?periodo=atual` ' +
      'estreita para a janela vigente — a mesma que o aluno ve no portal.\n\n' +
      '**So emita a declaracao quando `periodo.prazoEncerrado` for `true`.** ' +
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
