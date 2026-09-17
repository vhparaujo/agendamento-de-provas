import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { LIMITE_AUTENTICACAO } from '../../config/throttler.config';
import {
  AlvoDoQuizDto,
  CelulaDaGradeDto,
  DefinirSenhaDto,
  EscolherModalidadeDaTurmaDto,
  HorariosDoCronDto,
  JanelasDeProvaDto,
  SalvarAlvoDto,
  SalvarHorariosDto,
  SalvarJanelasDto,
  SenhaReveladaDto,
  TurmaDoLoteDto,
  TurmasDoLoteDto,
} from '../dto/grade-senhas.dto';
import { GradeSenhasService } from '../service/grade-senhas.service';
import {
  ModalidadeDaTurma,
  ModalidadeDaTurmaService,
  TurmaDesempatada,
} from '../service/modalidade-da-turma.service';
import { ResolucaoOrgUnitService } from '../service/resolucao-orgunit.service';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { BadRequestException } from '@nestjs/common';

/**
 * A grade dia x turno que a secretaria preenche, e a pre-visualizacao do que
 * o lote vai tocar.
 *
 * **A senha nunca sai na listagem.** `GET /senhas-de-prova` devolve `temSenha`;
 * o valor so vem de `/:id/revelar`, que e auditada em toda chamada. A grade fica
 * aberta num monitor compartilhado da secretaria — revelar precisa ser um ATO,
 * e um ato com rastro.
 */
@ApiTags(TAGS.SENHAS_QUIZ)
@Controller('senhas-de-prova')
@SomenteAdmin()
export class GradeSenhasController {
  constructor(
    private readonly grade: GradeSenhasService,
    private readonly resolucao: ResolucaoOrgUnitService,
    private readonly modalidades: ModalidadeDaTurmaService,
    private readonly periodo: PeriodoService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'A grade de senhas do intervalo (sem os valores)',
    description:
      'Uma linha por celula CADASTRADA. A tela desenha as colunas do intervalo e ' +
      'preenche com o que vier — celula ausente e celula vazia.\n\n' +
      '`situacao` responde a pergunta operacional: `DESATUALIZADA` significa que ' +
      'a senha foi editada DEPOIS de aplicada, ou seja, o Brightspace ainda esta ' +
      'com a anterior.',
  })
  @ApiQuery({ name: 'de', example: '2026-09-10', description: 'AAAA-MM-DD.' })
  @ApiQuery({ name: 'ate', example: '2026-09-16', description: 'AAAA-MM-DD.' })
  @ApiOkResponse({ type: [CelulaDaGradeDto] })
  @ApiBadRequestResponse({ description: 'Intervalo ausente ou invalido' })
  listar(@Query('de') de?: string, @Query('ate') ate?: string) {
    if (!de || !ate) {
      throw new BadRequestException(
        'Informe `de` e `ate` (AAAA-MM-DD): a grade e sempre de um intervalo.',
      );
    }

    return this.grade.listar(de, ate);
  }

  @Put()
  @ApiOperation({
    summary: 'Cadastra ou atualiza a senha de uma celula',
    description:
      'Upsert por (data, turno).\n\n' +
      'A `versao` sobe **so quando o valor muda** — salvar a mesma senha de novo ' +
      'nao pode fazer a tela alegar que o Brightspace ficou para tras.\n\n' +
      'Recusa senha vazia, com espaco nas pontas ou com caractere invisivel. A do ' +
      'meio e a que mais importa: o Brightspace ACEITA, e quem descobriria seriam ' +
      'os alunos, no dia, digitando a senha da folha impressa.',
  })
  @ApiOkResponse({ type: CelulaDaGradeDto })
  @ApiBadRequestResponse({
    description: 'Senha invalida, ou data fora do formato',
  })
  definir(@Body() dto: DefinirSenhaDto, @AdminLogado() admin: AdminJwtPayload) {
    return this.grade.definir(dto, admin.email);
  }

  @Get('turmas')
  @ApiOperation({
    summary: 'Pre-visualiza quais turmas o lote vai tocar',
    description:
      'O conjunto e **CSV de turmas ∩ ofertas do periodo letivo vigente**. Nao ' +
      'depende de turno: ele e o mesmo em toda execucao — o turno so decide qual ' +
      'senha entra.\n\n' +
      'Uma oferta do semestre que **nao** esta no CSV e ignorada: ela nao tem prova.\n\n' +
      '**Revise `naoResolvidas` antes do primeiro dia.** Cada linha ali e uma ' +
      'turma do CSV cujo `orgUnitId` nao foi descoberto — e ela ficaria sem senha, ' +
      'silenciosamente.\n\n' +
      'Esta rota tambem APRENDE: o `orgUnitId` descoberto e gravado em ' +
      '`turma_importada`, nunca sobrescrevendo o que ja existia.\n\n' +
      '### O formato de cada turma\n\n' +
      'Cada turma resolvida traz tambem o **formato derivado**, que e o que ' +
      'decide qual janela de horario o lote de datas aplica nela. Ela NAO vem do ' +
      'cadastro: `turma_importada` nao tem essa coluna, e nao deve ter (uma turma ' +
      'tem alunos de varios cursos, decisao de 10/08/2026). Ela e derivada dos ' +
      '**agendamentos confirmados** da rodada vigente.\n\n' +
      '**Revise as turmas sem formato antes do primeiro dia**, com o mesmo ' +
      'cuidado de `naoResolvidas`. `MODALIDADE_AMBIGUA` (alunos de dois ' +
      'formatos na mesma turma) e `SEM_AGENDAMENTO` (ninguem agendou ali) ' +
      'ficam **de fora do lote de datas** — nada e chutado, porque o questionario ' +
      'tem uma janela so e a escolha errada trancaria a prova de quem sobrou.',
  })
  @ApiOkResponse({ type: TurmasDoLoteDto })
  @ApiBadRequestResponse({
    description:
      'Integracao D2L desligada, ou nenhum periodo letivo cadastrado',
  })
  async turmas(): Promise<TurmasDoLoteDto> {
    // Os dois periodos letivos da janela: a lista precisa mostrar as turmas das
    // DUAS grades, senao as presenciais somem da tela do admin.
    const { periodoLetivoIds, rodada } = await this.janelaOuRecusar();

    const resolucao = await this.resolucao.resolver(periodoLetivoIds);
    const mapa = await this.modalidades.resolver(periodoLetivoIds, rodada);

    return {
      ...resolucao,
      resolvidas: resolucao.resolvidas.map((turma) =>
        linhaDaTurma(turma, mapa.de(turma.orgUnitId)),
      ),
    };
  }

  @Put('turmas/:turmaId/modalidade')
  @ApiOperation({
    summary: 'Decide o formato de uma turma AMBIGUA',
    description:
      'A saida para a turma que tem alunos de dois formatos e por isso fica ' +
      'de fora do lote de datas — com a prova presa no horario antigo para a ' +
      'turma inteira, e nao so para a minoria.\n\n' +
      '**O sistema continua sem escolher.** Quem escolhe e uma pessoa, e a ' +
      'decisao fica gravada com o e-mail dela e a hora ' +
      '(`DATA_QUIZ_MODALIDADE_ESCOLHIDA` na auditoria).\n\n' +
      '### As duas travas, reconferidas a cada gravacao\n\n' +
      '1. **A turma precisa estar ambigua AGORA.** Turma cujo formato ja se ' +
      'deriva sozinha responde 400 — sem isso, isto viraria "definir o ' +
      'formato de qualquer turma", que e a coluna de cadastro recusada em ' +
      '10/08/2026 com outro nome.\n' +
      '2. **O formato precisa estar em `candidatas`**, isto e, ter aluno ' +
      'com prova confirmada ali. Aplicar a janela de um formato que ' +
      'ninguem cursa fecharia a prova para TODOS, e nao so para a minoria.\n\n' +
      'A escolha tambem **caduca sozinha na leitura**: se a turma voltar a ter ' +
      'um formato so, a derivacao vence; se o formato escolhido ficar ' +
      'sem nenhuma reserva, a turma reaparece como ambigua na conferencia. ' +
      'Nao e preciso desfazer nada a mao.\n\n' +
      'Vale para a **rodada vigente** — a decisao da N2 nao decide a ' +
      'substitutiva, que tem outro publico sob o mesmo org unit.',
  })
  @ApiParam({ name: 'turmaId', type: Number, example: 41 })
  @ApiOkResponse({ type: TurmaDoLoteDto })
  @ApiBadRequestResponse({
    description:
      'A turma nao esta ambigua, nao tem agendamento nenhum, nao teve o ' +
      'orgUnitId resolvido, ou o formato informado nao tem aluno com prova ' +
      'nela',
  })
  @ApiNotFoundResponse({ description: 'Turma nao encontrada' })
  async escolherModalidade(
    @Param('turmaId', ParseIntPipe) turmaId: number,
    @Body() dto: EscolherModalidadeDaTurmaDto,
    @AdminLogado() admin: AdminJwtPayload,
  ): Promise<TurmaDoLoteDto> {
    const { periodoLetivoIds, rodada } = await this.janelaOuRecusar();

    return linhaDesempatada(
      await this.modalidades.escolher(
        turmaId,
        dto.modalidadeId,
        periodoLetivoIds,
        rodada,
        admin.email,
      ),
    );
  }

  // ⚠️ ANTES de `@Delete(':id')`, la embaixo. Declarado depois, o `:id` engoliria
  // a palavra "turmas" e o desfazer viraria "apagar a senha da celula 'turmas'"
  // — mesma armadilha ja documentada em `senha-quiz.module.ts`.
  @Delete('turmas/:turmaId/modalidade')
  @ApiOperation({
    summary: 'Desfaz a decisao de formato de uma turma',
    description:
      'A turma volta a aparecer como ambigua na conferencia e sai do lote de ' +
      'datas de novo.\n\n' +
      'Ao contrario do PUT, **nao exige que a turma continue ambigua**: apagar ' +
      'uma decisao nunca aplica nada em prova nenhuma, e exigir a ambiguidade ' +
      'prenderia a linha no banco justamente quando ela ja nao vale.\n\n' +
      'Apagar o que nao existe **nao e erro** — dois cliques no mesmo botao ' +
      'devolvem o mesmo estado.',
  })
  @ApiParam({ name: 'turmaId', type: Number, example: 41 })
  @ApiOkResponse({ type: TurmaDoLoteDto })
  @ApiBadRequestResponse({
    description: 'A turma nao teve o orgUnitId resolvido',
  })
  @ApiNotFoundResponse({ description: 'Turma nao encontrada' })
  async esquecerModalidade(
    @Param('turmaId', ParseIntPipe) turmaId: number,
    @AdminLogado() admin: AdminJwtPayload,
  ): Promise<TurmaDoLoteDto> {
    const { periodoLetivoIds, rodada } = await this.janelaOuRecusar();

    return linhaDesempatada(
      await this.modalidades.esquecer(
        turmaId,
        periodoLetivoIds,
        rodada,
        admin.email,
      ),
    );
  }

  /**
   * A janela vigente, ou a recusa com o motivo — a mesma frase de `turmas`.
   *
   * Sem periodo cadastrado nao ha rodada, e sem rodada a decisao nao teria a
   * que se aplicar: ela e gravada por `(orgUnitId, rodada)`.
   */
  private async janelaOuRecusar(): Promise<{
    periodoLetivoIds: string[];
    rodada: string;
  }> {
    const { periodoLetivoIds, rodada } =
      (await this.periodo.janelaVigente()) ?? {};

    if (!periodoLetivoIds || !rodada) {
      throw new BadRequestException(
        'Nenhum periodo letivo cadastrado. Sem ele nao ha como separar as turmas ' +
          'deste semestre das dos semestres passados.',
      );
    }

    return { periodoLetivoIds, rodada };
  }

  @Get('alvo')
  @ApiOperation({
    summary: 'Qual questionario o lote procura',
    description:
      'Fica no BANCO e nao no `.env` porque o nome da prova muda por semestre e a ' +
      'secretaria precisa troca-lo sem deploy.\n\n' +
      '**Nao ha valor padrao.** Enquanto ninguem escolher, `nomeQuiz` vem nulo, ' +
      '`configurado` vem `false` e o lote recusa comecar — um alvo que ja viesse ' +
      'preenchido faria o lote rodar com o nome errado, em silencio, em toda ' +
      'turma do CSV de uma vez.',
  })
  @ApiOkResponse({ type: AlvoDoQuizDto })
  lerAlvo() {
    return this.grade.lerAlvo();
  }

  @Get('horarios')
  @ApiOperation({
    summary: 'A que horas o cron aplica cada turno',
    description:
      'Saiu do `.env` em 19/08/2026: o calendario dos turnos muda por semestre, e ' +
      'quem o conhece e a secretaria. Turno sem horario **nao dispara** — e assim ' +
      'que sabado a noite, que nao tem prova, fica de fora.\n\n' +
      '`cronHabilitado` e `toleranciaMin` vem do `.env` e sao **so leitura**: ' +
      'a tela precisa poder avisar que esta instancia nao dispara nada, senao o ' +
      'admin cadastra 07:30 e espera por um cron desligado.',
  })
  @ApiOkResponse({ type: HorariosDoCronDto })
  lerHorarios() {
    return this.grade.lerHorarios();
  }

  @Put('horarios')
  @ApiOperation({
    summary: 'Define os horarios do cron',
    description:
      'Vale a partir do minuto seguinte, sem reiniciar o servidor: o cron le ' +
      'estes valores a cada tick.\n\n' +
      'Campo vazio desliga o turno. Formato invalido e **recusado** de proposito: ' +
      'um "7:30" aceito calado viraria um turno que nunca dispara, e ninguem ' +
      'descobriria antes do dia da prova.',
  })
  @ApiOkResponse({ type: HorariosDoCronDto })
  @ApiBadRequestResponse({ description: 'Horario fora do formato HH:MM' })
  salvarHorarios(
    @Body() dto: SalvarHorariosDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.grade.salvarHorarios(dto, admin.email);
  }

  @Get('janelas')
  @ApiOperation({
    summary: 'As janelas do questionario, por formato',
    description:
      'A que horas a prova ABRE e FECHA no dia, e a que horas o cron aplica ' +
      'cada uma dessas mudancas.\n\n' +
      'E **por formato** porque a duracao da prova vem dele: EaD (3h) cabe ' +
      'em tres sessoes por dia, Semi/Modular (1h30) em seis. Nao ha calendario ' +
      'unico possivel.\n\n' +
      'Devolve tambem as janelas **inativas** — a tela precisa mostrar o ' +
      'horario guardado de uma sessao desligada, senao reativa-la significaria ' +
      'digitar tudo de novo.',
  })
  @ApiOkResponse({ type: JanelasDeProvaDto })
  lerJanelas() {
    return this.grade.lerJanelas();
  }

  @Put('janelas')
  @ApiOperation({
    summary: 'Define o calendario de UM formato',
    description:
      'Substitui as janelas do formato informado; as demais nao sao ' +
      'tocadas. Sessao que **nao vier** no corpo e removida — e assim que a ' +
      'tela apaga uma janela. Para apenas desligar uma sessao sem perder o ' +
      'horario, mande-a com `ativo: false`.\n\n' +
      'Vale a partir do minuto seguinte, sem reiniciar nada: o cron le as ' +
      'janelas a cada tick.\n\n' +
      '**`turno` nao e enfeite de relatorio.** O PUT do questionario no ' +
      'Brightspace substitui o objeto inteiro, entao aplicar a janela obriga a ' +
      'reenviar a senha — e a leitura da API pode devolver a senha nula num ' +
      'quiz que tem senha. Por isso o lote de datas le a senha da **grade**, ' +
      'na celula daquele turno, em vez de confiar no que leu. Sem senha ' +
      'cadastrada ali, a janela nao e aplicada.',
  })
  @ApiOkResponse({ type: JanelasDeProvaDto })
  @ApiBadRequestResponse({
    description:
      'Hora fora de HH:MM, fechamento antes da abertura, ordem repetida, ' +
      'dois disparos ativos no mesmo minuto, ou formato inexistente',
  })
  salvarJanelas(
    @Body() dto: SalvarJanelasDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.grade.salvarJanelas(dto.modalidadeId, dto.janelas, admin.email);
  }

  @Put('alvo')
  @ApiOperation({
    summary: 'Define o questionario que o lote procura',
    description:
      '**Cuidado com `CONTEM`**: "Prova" casa "Prova N1", "Prova N2" e "Prova de ' +
      'recuperacao". O lote nao escolhe turma por turma, entao um nome generico ' +
      'troca a senha de simulados e atividades em toda turma do CSV de uma vez. ' +
      'Confira no dry-run, que lista cada questionario casado.',
  })
  @ApiOkResponse({ type: AlvoDoQuizDto })
  @ApiBadRequestResponse({ description: 'Nome vazio ou matchQuiz invalido' })
  salvarAlvo(
    @Body() dto: SalvarAlvoDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.grade.salvarAlvo(dto, admin.email);
  }

  @Get(':id/revelar')
  // Mesmo limite das rotas de credencial: e a unica rota do sistema que devolve
  // uma senha de prova em texto claro, e o uso legitimo e um clique de cada vez.
  @Throttle(LIMITE_AUTENTICACAO)
  @ApiOperation({
    summary: 'Revela a senha de uma celula (auditado)',
    description:
      'A **unica** rota que devolve o valor. Existe separada da listagem de ' +
      'proposito: a grade fica aberta num monitor compartilhado da secretaria, e ' +
      'ver a senha precisa ser um ato deliberado.\n\n' +
      'Toda chamada vira `SENHA_QUIZ_REVELADA` no log de seguranca, com quem ' +
      'pediu e qual celula.',
  })
  @ApiParam({ name: 'id', type: Number, example: 3 })
  @ApiOkResponse({ type: SenhaReveladaDto })
  @ApiNotFoundResponse({ description: 'Celula nao encontrada' })
  revelar(
    @Param('id', ParseIntPipe) id: number,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    return this.grade.revelar(id, admin.email);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Apaga a senha de uma celula',
    description:
      'Retencao: uma tabela com as senhas de um semestre inteiro e um passivo.\n\n' +
      'A execucao historica **sobrevive** (a FK vira nula e data/turno ficam ' +
      'gravados na propria execucao): apagar o segredo nao pode apagar a prova de ' +
      'que o lote rodou.',
  })
  @ApiParam({ name: 'id', type: Number, example: 3 })
  @ApiNoContentResponse({ description: 'Celula apagada' })
  @ApiNotFoundResponse({ description: 'Celula nao encontrada' })
  async remover(
    @Param('id', ParseIntPipe) id: number,
    @AdminLogado() admin: AdminJwtPayload,
  ): Promise<void> {
    await this.grade.remover(id, admin.email);
  }
}

/**
 * Uma turma resolvida + a decisao de formato, no formato da tela.
 *
 * Funcao livre e compartilhada pelas tres rotas de proposito: a conferencia e as
 * duas rotas de escrita mostram A MESMA linha, e duas montagens acabariam
 * divergindo justamente no campo que diz se a turma recebe data ou nao.
 */
function linhaDaTurma(
  turma: {
    turmaId: number;
    orgUnitId: string;
    codigoTurma: string;
    nomeDisciplina: string;
  },
  decisao: ModalidadeDaTurma,
): TurmaDoLoteDto {
  const encontrada = decisao.situacao === 'ENCONTRADA';

  return {
    turmaId: turma.turmaId,
    orgUnitId: turma.orgUnitId,
    codigoTurma: turma.codigoTurma,
    nomeDisciplina: turma.nomeDisciplina,
    modalidadeCodigo: encontrada ? decisao.codigo : null,
    modalidadeNome: encontrada ? decisao.nome : null,
    // A frase que explica a ausencia — a mesma que iria para o CSV do relatorio
    // se o lote rodasse agora.
    motivoSemModalidade: encontrada ? null : decisao.detalhe,
    // Vazio quando nao ha o que escolher. E este array que a tela usa para
    // decidir se desenha o seletor de desempate.
    candidatas: decisao.candidatas,
    modalidadeEscolhidaPor:
      encontrada && decisao.escolha ? decisao.escolha.escolhidaPor : null,
    modalidadeEscolhidaEm:
      encontrada && decisao.escolha
        ? decisao.escolha.escolhidaEm.toISOString()
        : null,
  };
}

/** O mesmo, para o que as rotas de escrita devolvem. */
function linhaDesempatada(turma: TurmaDesempatada): TurmaDoLoteDto {
  return linhaDaTurma(turma, turma.decisao);
}
