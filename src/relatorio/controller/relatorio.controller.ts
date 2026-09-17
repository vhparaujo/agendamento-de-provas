import {
  applyDecorators,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { GrupoExportavelDto } from '../dto/grupo-exportavel.dto';
import { SalaComListaDto } from '../dto/sala-com-lista.dto';
import { ListaPresencaService } from '../service/lista-presenca.service';
import { RelatorioService } from '../service/relatorio.service';

/** Recorte compartilhado pelas tres rotas. */
const FILTROS = [
  { name: 'poloId', type: Number, example: 6 },
  { name: 'periodoLetivoId', type: String, example: '103' },
  {
    name: 'de',
    type: String,
    example: '2026-08-01',
    description: 'Data da PROVA, nao do agendamento (AAAA-MM-DD).',
  },
  { name: 'ate', type: String, example: '2026-08-31' },
] as const;

const aplicarFiltros = () =>
  applyDecorators(...FILTROS.map((f) => ApiQuery({ required: false, ...f })));

/**
 * Os documentos prontos da aba Relatorios. Sao DOIS, com publicos opostos:
 *
 * - **Grupos do Brightspace** (`grupos-d2l`): consumido por MAQUINA, no formato
 *   que o *Groups Import* do D2L exige.
 * - **Listas de presenca** (`listas-de-presenca`): consumido por PESSOA, em
 *   papel — o PDF que o fiscal leva para a sala e devolve assinado.
 *
 * Nenhum dos dois se confunde com `GET /agendamentos/exportacao`, que e a lista
 * de cobranca da administracao (todos os vinculos, agendados ou nao, em Excel).
 */
@ApiTags(TAGS.RELATORIOS)
@Controller('relatorios')
@SomenteAdmin()
export class RelatorioController {
  constructor(
    private readonly service: RelatorioService,
    private readonly listas: ListaPresencaService,
  ) {}

  @Get('grupos-d2l')
  @ApiOperation({
    summary:
      'Lista os grupos exportaveis (horario x turma) e o tamanho de cada',
    description:
      'Uma linha por **horario de prova E turma** — e a tabela da aba ' +
      'Relatorios. Cada linha vira um arquivo no import de Grupos do ' +
      'Brightspace.\n\n' +
      'O par (janela, turma) e o recorte porque o grupo vive DENTRO de uma ' +
      'disciplina do D2L: um arquivo com o horario inteiro levaria para o grupo ' +
      'de uma disciplina tambem quem nao a cursa, liberando a prova dela para ' +
      'essa gente. O mesmo aluno aparece em varias linhas — uma por disciplina ' +
      'que a prova dele cobre.\n\n' +
      '**Janela = dia + hora de inicio + hora de fim, e nao a faixa.** O grupo ' +
      'libera o quiz num intervalo de tempo, e onde a pessoa senta nao muda o ' +
      'acesso — nem a sala, nem o CAMPUS. Dois polos que aplicam a mesma prova ' +
      'no mesmo dia e horario sao **uma linha so**, com os dois nomes em ' +
      '`polos`; dois grupos ali seriam dois imports identicos, cada um com ' +
      'metade da turma.\n\n' +
      '⚠️ Por isso **`poloId` estreita esta lista, nunca o conteudo do ' +
      'arquivo**: ele escolhe quais janelas aparecem, e o CSV daquela janela ' +
      'sai sempre com todos os campi. Filtrar o conteudo produziria um arquivo ' +
      'incompleto com nome de arquivo completo.\n\n' +
      '`totalAlunos` conta **matriculas distintas com prova confirmada**, ' +
      'somando todas as salas de todos os polos da janela, e e exatamente o ' +
      'numero de linhas que o arquivo tera.\n\n' +
      'As linhas nascem dos agendamentos: horario **sem ninguem agendado nao ' +
      'aparece**, porque nao ha turma para listar. Ocupacao por horario e ' +
      '`GET /agendamentos/resumo`.\n\n' +
      'O recorte e **um periodo letivo** — o de `periodoLetivoId` ou, sem ele, o ' +
      'vigente. Sem isso, prova do semestre passado entraria no grupo deste.',
  })
  @aplicarFiltros()
  @ApiOkResponse({ type: [GrupoExportavelDto] })
  listar(@Query() query: Record<string, string>) {
    return this.service.listarGrupos(this.lerFiltro(query));
  }

  /**
   * Declarada ANTES da rota com parametros: o Nest casa as rotas na ordem em que
   * sao declaradas.
   */
  @Get('grupos-d2l/zip')
  @ApiOperation({
    summary: 'Baixa um zip com o CSV de todos os grupos do recorte',
    description:
      'Organizado em **uma pasta por turma**, com o horario no nome do ' +
      'arquivo:\n\n' +
      '```\n' +
      'GSPS0I10227 - HISTORIA E CULTURA DO CORPO/\n' +
      '    20-08-2026 08h30-11h30.csv\n' +
      '    20-08-2026 14h00-17h00.csv\n' +
      '```\n\n' +
      'A pasta acompanha o trabalho real: abre-se a turma no Brightspace e ' +
      'importam-se os horarios dela, um a um.\n\n' +
      'Um arquivo por **janela e turma**: dois polos que aplicam a mesma prova ' +
      'no mesmo dia e horario saem juntos, num arquivo so. O sufixo ' +
      '`#<orgUnitId>` so aparece no caso raro de duas disciplinas gerarem a ' +
      'mesma pasta depois do corte de 60 caracteres do nome.',
  })
  @aplicarFiltros()
  @ApiProduces('application/zip')
  @ApiOkResponse({
    description: 'Arquivo ZIP',
    schema: { type: 'string', format: 'binary' },
  })
  @Header('Content-Type', 'application/zip')
  async zip(
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { nomeArquivo, conteudo } = await this.service.zipDosGrupos(
      this.lerFiltro(query),
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return new StreamableFile(conteudo as Buffer);
  }

  @Get('grupos-d2l/:faixaId/:orgUnitId')
  @ApiOperation({
    summary: 'Baixa o CSV de um grupo para o import de Grupos do Brightspace',
    description:
      'Os alunos de UMA turma (`orgUnitId`) em UM horario de prova. Duas ' +
      'colunas: **`Nome de usuário`** com a matricula (RA) e **`Código do ' +
      'Grupo`** VAZIA — o codigo e preenchido a mao depois de criar o grupo no ' +
      'D2L.\n\n' +
      '⚠️ **`faixaId` e um handle da JANELA, nao o recorte.** O arquivo leva ' +
      'quem faz aquela prova naquele dia e horario em **qualquer campus** — o ' +
      'acesso ao quiz nao depende de onde a pessoa senta. Duas faixas irmas ' +
      '(mesmo dia e horario, polos diferentes) devolvem o mesmo arquivo, com o ' +
      'mesmo nome, de proposito.\n\n' +
      'Entram apenas os agendamentos **confirmados** do periodo letivo do ' +
      'recorte cuja prova cobre aquela disciplina, e cada matricula aparece ' +
      '**uma unica vez**: o grupo no D2L e por usuario, e um RA com dois ' +
      'vinculos na mesma janela nao pode virar duas linhas.\n\n' +
      'Sai separado por **virgula** e **sem BOM** — ao contrario do CSV da ' +
      'administracao (`;` + BOM), porque quem le este arquivo e o Brightspace, nao ' +
      'o Excel.\n\n' +
      'Baixa como **`20-08-2026 08h30-11h30 - GSPS0I10227 - HISTORIA E ' +
      'CULTURA.csv`**, sem acento (ver `nome-de-arquivo.ts`).\n\n' +
      '`de`, `ate` e `poloId` sao **ignorados** aqui: quem pediu este grupo ja ' +
      'escolheu a janela, e um filtro esquecido na URL devolveria 404 — ou, ' +
      'pior, um arquivo sem os alunos do outro campus. `periodoLetivoId` ' +
      'continua valendo — e ele que separa os semestres.',
  })
  @ApiParam({
    name: 'faixaId',
    type: Number,
    example: 14,
    description:
      'Qualquer faixa da janela desejada — e ela que identifica o dia e o ' +
      'horario. O arquivo nao se limita ao polo dessa faixa.',
  })
  @ApiParam({
    name: 'orgUnitId',
    type: String,
    example: '445566',
    description: 'A disciplina no Brightspace, como veio no launch.',
  })
  @aplicarFiltros()
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Arquivo CSV',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({
    description: 'Nenhum aluno confirmado nesta turma e neste horario',
  })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async csv(
    @Param('faixaId', ParseIntPipe) faixaId: number,
    @Param('orgUnitId') orgUnitId: string,
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { nomeArquivo, conteudo } = await this.service.csvDoGrupo(
      faixaId,
      orgUnitId,
      this.lerFiltro(query),
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return conteudo as string;
  }

  // ==========================================================================
  // LISTAS DE PRESENCA — o PDF que vai para a sala
  // ==========================================================================

  @Get('listas-de-presenca')
  @ApiOperation({
    summary:
      'Lista as salas que terao aplicacao de prova e quantos assinam em cada',
    description:
      'Uma linha por **sala E horario** (a oferta, `SalaFaixa`) — e a tabela ' +
      'da aba Relatorios. Cada linha vira uma PAGINA no PDF.\n\n' +
      'O recorte e a sala porque a folha e fisica: ela vai para a mao do fiscal ' +
      'daquela sala, e nao pode listar quem esta na sala ao lado.\n\n' +
      '`totalAlunos` conta **agendamentos confirmados**, nao pessoas distintas: ' +
      'um RA com dois vinculos no mesmo formato ocupa duas vagas e assina ' +
      'duas vezes. E exatamente o numero de linhas que a folha tera, e bate com ' +
      '`ocupadas` em `GET /agendamentos/resumo`.\n\n' +
      '**Sala sem ninguem agendado nao aparece**: nao havera aplicacao ali, e ' +
      'uma folha em branco no meio da pilha so faz procurar o erro. Para ver a ' +
      'oferta montada, cheia ou vazia, use `GET /agendamentos/resumo`.\n\n' +
      'O recorte e **um periodo letivo** — o de `periodoLetivoId` ou, sem ele, o ' +
      'vigente.',
  })
  @aplicarFiltros()
  @ApiOkResponse({ type: [SalaComListaDto] })
  listarSalas(@Query() query: Record<string, string>) {
    return this.listas.listar(this.lerFiltro(query));
  }

  /**
   * Declarada ANTES da rota com parametro: o Nest casa as rotas na ordem em que
   * sao declaradas.
   */
  @Get('listas-de-presenca/pdf')
  @ApiOperation({
    summary: 'Baixa o PDF com a lista de presenca de todas as salas do recorte',
    description:
      'Uma **pagina por sala**, na ordem em que as folhas sao entregues: dia, ' +
      'horario, polo e sala — a pilha ja sai separavel por campus.\n\n' +
      'Cada pagina traz o cabecalho com polo, data, horario e sala, e a tabela ' +
      'com **Nº · RA · Nome · Formato · Assinatura**. A coluna de assinatura ' +
      'e uma celula vazia com borda: a propria linha da tabela e a linha em que ' +
      'se assina.\n\n' +
      'Sala com muita gente continua na pagina seguinte, com o cabecalho ' +
      'repetido e marcado `(cont.)` — folha solta sem identificacao nao serve ' +
      'para nada, e a numeracao segue de onde parou.\n\n' +
      'A ordem dentro da pagina e **alfabetica por nome**: o fiscal procura pela ' +
      'pessoa que esta na frente dele, e o que ela sabe dizer e o proprio nome.',
  })
  @aplicarFiltros()
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'Arquivo PDF',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({
    description: 'Nenhuma sala com aluno confirmado neste recorte',
  })
  @Header('Content-Type', 'application/pdf')
  async pdfDasListas(
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { nomeArquivo, conteudo } = await this.listas.pdfDoRecorte(
      this.lerFiltro(query),
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return new StreamableFile(conteudo as Buffer);
  }

  @Get('listas-de-presenca/:salaFaixaId/pdf')
  @ApiOperation({
    summary: 'Baixa a lista de presenca de UMA sala',
    description:
      'A folha avulsa — a que faltou na pilha, ou que precisou ser reimpressa. ' +
      'Mesmo conteudo de uma pagina do PDF completo.\n\n' +
      '`de`, `ate` e `poloId` sao **ignorados** aqui: quem pediu esta sala ja ' +
      'escolheu o horario, e um filtro esquecido na URL devolveria 404 em vez ' +
      'do arquivo. `periodoLetivoId` continua valendo — e ele que separa os ' +
      'semestres.',
  })
  @ApiParam({
    name: 'salaFaixaId',
    type: Number,
    example: 31,
    description: 'A oferta (`SalaFaixa`): sala + horario + polo num id so.',
  })
  @aplicarFiltros()
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'Arquivo PDF',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({ description: 'Nenhum aluno confirmado nesta sala' })
  @Header('Content-Type', 'application/pdf')
  async pdfDeUmaSala(
    @Param('salaFaixaId', ParseIntPipe) salaFaixaId: number,
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { nomeArquivo, conteudo } = await this.listas.pdfDeUmaSala(
      salaFaixaId,
      this.lerFiltro(query),
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeArquivo}"`,
    );

    return new StreamableFile(conteudo as Buffer);
  }

  /**
   * Os filtros sao lidos a mao, sem DTO, pelo mesmo motivo do relatorio de
   * agendamentos: com `forbidNonWhitelisted`, um parametro a mais na URL
   * derrubaria a requisicao — e URL de relatorio e coisa que se cola e edita.
   */
  private lerFiltro(query: Record<string, string>) {
    const inteiro = (valor?: string) => {
      const numero = Number(valor);
      return valor !== undefined && Number.isInteger(numero) && numero > 0
        ? numero
        : undefined;
    };

    return {
      poloId: inteiro(query.poloId),
      // Lista separada por virgula: uma janela cobre mais de um periodo letivo
      // ao mesmo tempo (o do modulo e o do semestre), e a tela manda a janela
      // inteira. Um id sozinho vira uma lista de um elemento.
      periodoLetivoId: (query.periodoLetivoId ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      de: query.de || undefined,
      ate: query.ate || undefined,
    };
  }
}
