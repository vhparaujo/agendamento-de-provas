import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { PeriodoLetivoD2lDto } from '../dto/periodo-letivo.response.dto';
import { D2lEnrollmentsService } from '../service/d2l-enrollments.service';

/** Atual + 3 anteriores — o que o admin precisa ver sem rolar a lista. */
const ANOS_PADRAO = 4;

/**
 * Leituras de CATALOGO do Brightspace, para o admin escolher em vez de digitar.
 *
 * Controller SEPARADO do `D2lController` de proposito. Aquele e `@Publico()` na
 * CLASSE, por causa do callback OAuth — e o `AutenticacaoGuard` checa
 * `PUBLICO_KEY` ANTES do perfil, com `getAllAndOverride([handler, classe])`.
 * Um `@SomenteAdmin()` num metodo de la seria engolido pelo `@Publico()` da
 * classe, e a rota nasceria aberta sem ninguem perceber.
 */
@ApiTags(TAGS.D2L)
@Controller('d2l')
@SomenteAdmin()
export class D2lCatalogoController {
  constructor(private readonly enrollments: D2lEnrollmentsService) {}

  @Get('periodos-letivos')
  @ApiOperation({
    summary: 'Lista os periodos letivos do Brightspace',
    description:
      'Alimenta o **dropdown** onde o admin escolhe o periodo letivo ao criar um periodo de ' +
      'agendamento. O `id` de cada item ja e o valor de `periodoLetivoId` para o ' +
      '`POST /periodos` — **nao ha segunda busca**: o front manda de volta o id que veio na ' +
      'lista.\n\n' +
      'Existe para eliminar um modo de falha silencioso: um `periodoLetivoId` errado **nao da ' +
      'erro nenhum** — a busca de ofertas do periodo responde 200 com lista vazia, a intersecao ' +
      'com as matriculas do aluno da vazia, e todo aluno recebe "nenhuma disciplina sua aparece ' +
      'no periodo letivo vigente".\n\n' +
      'Traz os org units do tipo configurado em `D2L_TIPO_PERIODO_LETIVO` (103 neste tenant — o ' +
      'Semester padrao, 5, nao e usado aqui), **do mais recente para o mais antigo**. A API ' +
      'devolve em ordem de criacao e paginada; aqui ela ja vem completa e ordenada por ' +
      '(ano, semestre).\n\n' +
      '**Exige a integracao D2L ligada e autorizada**: `D2L_HABILITADO=true`, `D2L_BASE_URL` ' +
      'preenchida e o refresh token ja gravado pelo `GET /d2l/callback`.',
  })
  @ApiQuery({
    name: 'anos',
    required: false,
    example: 4,
    description:
      'Quantos anos trazer, contados do mais recente que EXISTE no tenant (nao do relogio). ' +
      'Default 4 = atual + 3 anteriores. Use `0` para a lista completa — que inclui os org ' +
      'units desse tipo sem ano no nome (o tenant tem um "Esperancar"), sempre no fim.',
  })
  @ApiOkResponse({ type: [PeriodoLetivoD2lDto] })
  @ApiBadGatewayResponse({
    description:
      'Integracao desligada ou incompleta, ou a Valence nao respondeu como esperado',
  })
  periodosLetivos(
    @Query('anos') anos?: string,
  ): Promise<PeriodoLetivoD2lDto[]> {
    const pedido = Number(anos);

    return this.enrollments.periodosLetivos({
      // `anos=0` e um pedido legitimo (lista completa); so um valor ausente ou
      // ilegivel cai no default.
      anosRecentes:
        Number.isFinite(pedido) && anos !== undefined && anos !== ''
          ? pedido
          : ANOS_PADRAO,
    });
  }
}
