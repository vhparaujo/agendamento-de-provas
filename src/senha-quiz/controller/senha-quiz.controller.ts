import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import {
  OrigemExecucao,
  TipoExecucaoQuiz,
} from '../../generated/prisma/client';
import {
  AndamentoDaSenhaQuizDto,
  ExecucaoSenhaIniciadaDto,
  UltimaDataPorModalidadeDto,
  IniciarSenhaQuizDto,
} from '../dto/senha-quiz.dto';
import { SenhaQuizService } from '../service/senha-quiz.service';

/**
 * O lote que aplica UMA sessao do calendario nas turmas do formato dela.
 *
 * Tres rotas e nao uma porque o lote leva minutos: dispara, acompanha, baixa o
 * relatorio. Mesmo desenho do compulsorio, e pelo mesmo motivo.
 *
 * ⚠️ Este controller precisa ser declarado ANTES do `GradeSenhasController` no
 * modulo: as rotas dele sao `senhas-de-prova/execucoes/...` e as de la tem
 * `senhas-de-prova/:id`, que casaria com a palavra "execucoes". Mesma armadilha
 * ja documentada em `agendamento.module.ts`.
 */
@ApiTags(TAGS.SENHAS_QUIZ)
@Controller('senhas-de-prova/execucoes')
@SomenteAdmin()
export class SenhaQuizController {
  constructor(private readonly service: SenhaQuizService) {}

  @Post()
  @ApiOperation({
    summary:
      'Aplica uma sessao do calendario: so a senha, ou a janela inteira ' +
      '(simula por padrao)',
    description:
      '### Dois lotes, a mesma maquinaria\n\n' +
      'Os dois primeiros partem da MESMA sessao (`janelaId` + `data`) e tocam ' +
      'as MESMAS turmas: as do formato daquela janela. O que muda e o que cada ' +
      'um grava.\n\n' +
      '`tipo: SENHA` (padrao) troca so o campo `Password` do questionario. Ate ' +
      '21/09/2026 ele alcancava todas as turmas do CSV e era chaveado por ' +
      'TURNO; nao da mais para ser assim, porque as 12:01 o EaD e o Semi trocam ' +
      'de senha ao mesmo tempo com senhas diferentes.\n\n' +
      '`tipo: DATA` troca `StartDate`/`EndDate` — a janela em que a prova fica ' +
      'aberta —, o grupo que a libera **e** a senha, tudo na mesma execucao. E ' +
      'este o lote que o cron dispara no calendario normal.\n\n' +
      'O formato de cada turma e DERIVADO dos agendamentos confirmados; turma ' +
      'sem formato derivavel fica de fora e vira linha de relatorio ' +
      '(`SEM_AGENDAMENTO` / `MODALIDADE_AMBIGUA`).\n\n' +
      '`tipo: PREPARO` deixa o questionario pronto para o **special access** em ' +
      'todas as turmas do CSV (ou so nas de `orgUnitIds`): apaga `StartDate`/`EndDate`, ' +
      'liga `AllowOnlyUsersWithSpecialAccess` e tira as condicoes de liberacao ' +
      'por grupo (com backup). O quiz e gravado ANTES das condicoes: se ele ' +
      'falhar, elas nao sao tocadas. Grava a senha da celula `data` + ' +
      '`janelaId` como valor PROVISORIO — no dia, o disparo da sessao de cada ' +
      'turma poe a senha do formato dela por cima.\n\n' +
      'Com o special access substituindo as janelas (Special access > ' +
      'Configuracao), `tipo: DATA` recusa com 400.\n\n' +
      '**`DATA` grava a senha tambem.** Nao e escopo a mais: o PUT do ' +
      'questionario substitui o objeto inteiro, e a leitura da API pode devolver ' +
      '`Password` nulo num quiz que TEM senha — preservar essa leitura apagaria ' +
      'a senha de toda prova do CSV, em silencio. Por isso o lote le a senha da ' +
      'grade, na celula do turno da janela, e recusa comecar sem ela.\n\n' +
      '**Um lote por vez, os dois tipos juntos.** Eles escrevem no mesmo ' +
      'questionario; rodando em paralelo, o segundo PUT desfaria o primeiro. ' +
      'Uma execucao em andamento faz a proxima receber 409, seja de que tipo for.\n\n' +
      '**Responde na hora com um `id`, sem esperar o fim** — sao ~3 chamadas ao ' +
      'Brightspace por turma. Acompanhe em `GET /senhas-de-prova/execucoes/:id`.\n\n' +
      '**`simulacao: true` e o padrao e nao emite nenhum PUT.** Ela percorre tudo ' +
      'e mostra quais questionarios casaram com o nome configurado — a unica ' +
      'conferencia possivel antes de mexer na prova de toda a instituicao.\n\n' +
      '**Sobrescrever a senha de um turno anterior e o objetivo**, nao um efeito ' +
      'colateral: a senha vale um turno, e troca-la a cada turno e o que impede o ' +
      'aluno da manha de repassar a dele para o da tarde.\n\n' +
      'Exige `D2L_HABILITADO`: e a integracao que descobre o `orgUnitId` das ' +
      'turmas do CSV e grava no questionario.',
  })
  @ApiCreatedResponse({ type: ExecucaoSenhaIniciadaDto })
  @ApiBadRequestResponse({
    description:
      'Integracao D2L desligada, nenhum periodo letivo cadastrado, ou celula da grade sem senha',
  })
  @ApiConflictResponse({
    description:
      'Ja existe uma execucao em andamento, ou esta senha ja foi aplicada (use `forcar`)',
  })
  iniciar(
    @Body() dto: IniciarSenhaQuizDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    const comum = {
      data: dto.data,
      simulacao: dto.simulacao ?? true,
      forcar: dto.forcar ?? false,
    };

    // ⚠️ **Os TRES tipos pedem a janela desde 21/09/2026.** A celula da grade
    // pertence a uma SESSAO, entao ate o preparo — que nao recorta turma por
    // formato — precisa dizer de qual sessao tira a senha que vai no PUT.
    //
    // `ValidateIf` no DTO ja garante a presenca do campo; o `!` aqui seria a
    // unica alternativa, e trocar um contrato validado por uma assercao e o que
    // faz um 500 nascer de um corpo malformado.
    if (dto.janelaId === undefined) {
      throw new BadRequestException(
        'Escolha a sessão: cada execução aplica UMA janela do questionário, e ' +
          'é dela que sai a senha.',
      );
    }

    const comJanela = { ...comum, janelaId: dto.janelaId };

    if (dto.tipo === TipoExecucaoQuiz.DATA) {
      return this.service.iniciar(
        { ...comJanela, tipo: TipoExecucaoQuiz.DATA },
        admin.email,
      );
    }

    if (dto.tipo === TipoExecucaoQuiz.PREPARO) {
      return this.service.iniciar(
        {
          ...comJanela,
          tipo: TipoExecucaoQuiz.PREPARO,
          orgUnitIds: dto.orgUnitIds ?? [],
        },
        admin.email,
      );
    }

    return this.service.iniciar(comJanela, admin.email);
  }

  /**
   * ⚠️ Precisa vir ANTES de `@Get(':id')`: as rotas sao avaliadas na ordem de
   * declaracao, e `:id` casaria com a palavra "ultima" — o `ParseIntPipe`
   * devolveria 400 numa rota que existe. Mesma armadilha do cabecalho da classe,
   * um nivel abaixo.
   */
  @Get('ultima')
  @ApiOperation({
    summary: 'A execucao mais recente (a tela usa para enxergar o cron)',
    description:
      'O disparo manual e acompanhado pelo id que o POST devolveu. O do **cron** ' +
      'nao tem quem o acompanhe: ele roda as 07:30, sozinho, e sem esta rota a ' +
      'tela nao dizia nada nem enquanto a troca acontecia nem depois dela.\n\n' +
      'Use `origem=CRON` para perguntar so pelo disparo automatico — senao um ' +
      'lote manual rodado depois esconderia o resultado do cron.\n\n' +
      'Use `tipo` pelo mesmo motivo, um nivel acima: a tela acompanha os dois ' +
      'calendarios lado a lado, e sem o filtro a troca de senha das 07:30 ' +
      'esconderia a mudanca de janela das 12:01.\n\n' +
      '**Corpo vazio (200) quando nunca houve execucao.** Nao e 404: "nunca ' +
      'rodou" e o estado normal de um ambiente recem-configurado, e a tela ' +
      'precisa distingui-lo de "nao consegui perguntar".',
  })
  @ApiQuery({
    name: 'origem',
    required: false,
    enum: OrigemExecucao,
    description:
      'MANUAL ou CRON. Ausente = a mais recente, de qualquer origem.',
  })
  @ApiQuery({
    name: 'tipo',
    required: false,
    enum: TipoExecucaoQuiz,
    description: 'SENHA ou DATA. Ausente = a mais recente, de qualquer tipo.',
  })
  @ApiOkResponse({ type: AndamentoDaSenhaQuizDto })
  @ApiBadRequestResponse({ description: 'Origem ou tipo invalido' })
  ultima(@Query('origem') origem?: string, @Query('tipo') tipo?: string) {
    if (origem !== undefined && !(origem in OrigemExecucao)) {
      throw new BadRequestException(
        `Origem inválida: use ${Object.keys(OrigemExecucao).join(' ou ')}.`,
      );
    }

    if (tipo !== undefined && !(tipo in TipoExecucaoQuiz)) {
      throw new BadRequestException(
        `Tipo inválido: use ${Object.keys(TipoExecucaoQuiz).join(' ou ')}.`,
      );
    }

    return this.service.ultima(
      origem as OrigemExecucao | undefined,
      tipo as TipoExecucaoQuiz | undefined,
    );
  }

  /**
   * ⚠️ Como `ultima`, precisa vir ANTES de `@Get(':id')`.
   */
  @Get('datas-por-modalidade')
  @ApiOperation({
    summary: 'A ultima mudanca de datas de CADA formato',
    description:
      '`/ultima` responde "qual foi a mais recente?", e essa nao e a pergunta ' +
      'que a administracao faz.\n\n' +
      'Um unico minuto de disparo produz **varias** execucoes: as 12:01 sao ' +
      'tres (EaD 15:00-18:00, Semi e Modular 14:00-15:30), aplicadas em ticks ' +
      'seguidos porque os dois lotes escrevem no mesmo questionario e o servidor ' +
      'serializa. Mostrar so a mais recente exibe a terceira delas e esconde as ' +
      'outros dois — quem le conclui que a janela errada foi aplicada.\n\n' +
      'A pergunta util e por formato: **cada um esta com a janela certa?**\n\n' +
      'So lista formatos que tem calendario cadastrado. `execucao: null` ' +
      'significa "nunca rodou", que e o estado normal de um formato sem ' +
      'aluno importado — nao um erro.',
  })
  @ApiQuery({
    name: 'origem',
    required: false,
    enum: OrigemExecucao,
    description:
      'MANUAL ou CRON. Ausente = a mais recente de cada formato, de qualquer ' +
      'origem.',
  })
  @ApiOkResponse({ type: [UltimaDataPorModalidadeDto] })
  @ApiBadRequestResponse({ description: 'Origem invalida' })
  datasPorModalidade(@Query('origem') origem?: string) {
    if (origem !== undefined && !(origem in OrigemExecucao)) {
      throw new BadRequestException(
        `Origem inválida: use ${Object.keys(OrigemExecucao).join(' ou ')}.`,
      );
    }

    return this.service.ultimasDatasPorModalidade(
      origem as OrigemExecucao | undefined,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Acompanha uma execucao',
    description:
      'A tela consulta esta rota de tempos em tempos enquanto `status` for ' +
      '`EM_ANDAMENTO`.\n\n' +
      '`interrompida: true` significa que o processo morreu no meio: o que ja foi ' +
      'gravado no Brightspace permanece, e o resto nao foi aplicado.\n\n' +
      'Repare em `naoEncontradas`: sao turmas sem questionario com o nome ' +
      'configurado. **Nao contam como falha e sao o resultado que mais dói** — ' +
      'cada uma e uma turma inteira que nao abriria a prova.',
  })
  @ApiParam({ name: 'id', type: Number, example: 12 })
  @ApiOkResponse({ type: AndamentoDaSenhaQuizDto })
  @ApiNotFoundResponse({ description: 'Execucao nao encontrada' })
  consultar(@Param('id', ParseIntPipe) id: number) {
    return this.service.consultar(id);
  }

  @Get(':id/relatorio')
  @ApiOperation({
    summary: 'Baixa o CSV do que aconteceu em cada turma',
    description:
      'Uma linha por (turma, questionario), ordenada por resultado: cada bloco ' +
      'do arquivo e uma acao diferente.\n\n' +
      '`QUIZ_NAO_ENCONTRADO` pede conferir o nome da prova no AVA; ' +
      '`ORGUNIT_NAO_RESOLVIDO` pede conferir o CSV de turmas; `FALHA_AO_GRAVAR` ' +
      'costuma ser escopo ou permissao do usuario da integracao.\n\n' +
      '**Nao ha coluna de senha**, nem a antiga nem a nova: o arquivo circula por ' +
      'e-mail e fica no disco de quem baixou. `Tinha senha antes` responde a ' +
      'unica pergunta util sem revelar nada.\n\n' +
      'Sai com BOM UTF-8 e separado por `;`, para abrir direto no Excel em ' +
      'portugues sem estragar os acentos.',
  })
  @ApiParam({ name: 'id', type: Number, example: 12 })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Arquivo CSV',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({ description: 'Execucao nao encontrada' })
  async relatorio(
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) resposta: Response,
  ): Promise<string> {
    const execucao = await this.service.dadosDaExecucao(id);
    const csv = await this.service.relatorioCsv(id);

    resposta.setHeader('Content-Type', 'text/csv; charset=utf-8');
    resposta.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.service.nomeDoArquivo(execucao)}"`,
    );

    return csv;
  }
}
