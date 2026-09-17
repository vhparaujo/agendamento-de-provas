import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  FiltroDeNota,
  LetivoDaModalidade,
  PeriodoAdmin,
  RemocaoPeriodo,
  VigenteDepoisDaRemocao,
} from '../service/periodo.service';

const AJUDA_DATA =
  'ISO 8601 COM fuso (ex: 2026-08-18T23:59:00-03:00). Sem o fuso, a data e lida ' +
  'como UTC e o prazo fecha 3 horas antes do que voce quis.';

const AJUDA_NOTA =
  'OS CRITERIOS DE NOTA que habilitam esta janela — a regra da substitutiva. ' +
  'Informe os DOIS ou nenhum. Com os dois, so entra na prova a disciplina em ' +
  'que o aluno passa nas duas condicoes: N1 >= notaMinimaN1 E nota final ' +
  'calculada < notaMaximaFinal. Sem eles (o padrao, e o caso da N2), a prova ' +
  'cobre todas as disciplinas do semestre e nenhuma nota e consultada no ' +
  'Brightspace.\n\n' +
  'ATENCAO: os dois numeros NAO delimitam um intervalo — eles olham notas ' +
  'DIFERENTES. Nao ha piso na nota final, nem teto na N1.\n\n' +
  'Ler as notas exige os escopos `grades:gradevalues:read` e ' +
  '`grades:gradecategories:read` no consentimento da Valence — acrescenta-los ' +
  'ao `.env` nao basta, e preciso refazer `npm run d2l:autorizar`. A N1 e ' +
  'encontrada pelo NOME da categoria de notas da turma (`D2L_CATEGORIA_N1`, ' +
  'default "N1"): turma que a nomear de outro jeito nao libera ninguem.';

const AJUDA_MAPA =
  'O PERIODO LETIVO DE CADA FORMATO. A UCB corre duas grades ao mesmo ' +
  'tempo: EaD, Semipresencial e Modular andam por MODULO (quatro por ano — ' +
  '2026/1 a 2026/4) e Presencial anda por SEMESTRE (dois — 2026/1 e 2026/2). ' +
  'Em novembro de 2026 o aluno EaD esta sob 2026/4 e o presencial sob 2026/2, ' +
  'que sao org units DIFERENTES e vivos ao mesmo tempo no Brightspace.\n\n' +
  'OMITIR = todos os formatos ficam no `periodoLetivoId` principal, que e o ' +
  'comportamento de quem tem uma grade so.\n\n' +
  'INFORMAR = tem de cobrir TODOS os formatos cadastrados; faltar um ' +
  'responde 400 nomeando quais. Cobrir parcialmente seria pior que nao cobrir: ' +
  'a esquecida cairia no principal em silencio, e um `periodoLetivoId` que nao ' +
  'bate NAO da erro — a busca responde 200 com lista vazia e o formato ' +
  'inteira recebe "nenhuma disciplina sua aparece no periodo letivo vigente".';

export class LetivoDaModalidadeDto {
  @ApiProperty({
    example: 'PRESENCIAL',
    description: 'Codigo do formato: EAD, SEMI, MODULAR ou PRESENCIAL.',
  })
  @IsString()
  @IsNotEmpty({ message: 'Informe o formato.' })
  @MaxLength(50)
  modalidadeCodigo!: string;

  @ApiProperty({
    example: '8790',
    description: 'Id do periodo letivo no Brightspace para este formato.',
  })
  @IsString()
  @IsNotEmpty({ message: 'Informe o período letivo.' })
  @MaxLength(191)
  periodoLetivoId!: string;
}

export class LetivoDaModalidadeResponseDto
  extends LetivoDaModalidadeDto
  implements LetivoDaModalidade
{
  @ApiProperty({ example: 4 })
  modalidadeId!: number;

  @ApiProperty({ example: 'Presencial' })
  modalidadeNome!: string;

  @ApiProperty({
    example: false,
    description:
      'true quando este formato NAO tem entrada propria e caiu no periodo ' +
      'letivo principal da janela. Acontece com formato cadastrado depois da ' +
      'janela. Nao e erro, mas e o que a tela precisa destacar: se ela nao segue ' +
      'a mesma grade, os alunos dela ficam sem disciplina agendavel.',
  })
  herdadoDoPrincipal!: boolean;
}

export class CriarPeriodoDto {
  @ApiProperty({
    example: '103',
    description:
      'Id do periodo letivo no Brightspace. Vai gravado em cada agendamento e e ' +
      'o que separa um semestre do outro nos relatorios.',
  })
  @IsString()
  @IsNotEmpty({ message: 'Informe o período letivo.' })
  @MaxLength(191)
  periodoLetivoId!: string;

  @ApiPropertyOptional({
    example: 'SUB',
    default: 'N2',
    maxLength: 20,
    description:
      'QUAL prova do semestre e esta janela — "N2" (regular), "SUB" ' +
      '(substitutiva), "N1"... O `periodoLetivoId` e o mesmo nas duas, entao e a ' +
      'rodada que as separa: e com ela que o mesmo aluno consegue agendar a ' +
      'regular e a substitutiva no mesmo semestre. Omitir mantem "N2", que e como ' +
      'todos os periodos anteriores foram cadastrados.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  rodada?: string;

  @ApiPropertyOptional({
    type: [LetivoDaModalidadeDto],
    description: AJUDA_MAPA,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LetivoDaModalidadeDto)
  letivosPorModalidade?: LetivoDaModalidadeDto[];

  @ApiPropertyOptional({
    example: 1.5,
    minimum: 0,
    maximum: 10,
    description: `Piso da nota da N1, INCLUSIVE. ${AJUDA_NOTA}`,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  notaMinimaN1?: number;

  @ApiPropertyOptional({
    example: 7,
    minimum: 0,
    maximum: 10,
    description:
      'Teto da NOTA FINAL CALCULADA, EXCLUSIVE — quem alcanca este valor ja ' +
      'atingiu a media, passou, e nao aparece na substitutiva.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  notaMaximaFinal?: number;

  @ApiPropertyOptional({ example: '2026/2 — provas finais', maxLength: 191 })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  descricao?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Padrao false: o periodo nasce FECHADO, para o admin conferir as faixas ' +
      'antes de liberar os alunos.',
  })
  @IsOptional()
  @IsBoolean()
  aberto?: boolean;

  @ApiPropertyOptional({
    example: '2026-08-01T08:00:00-03:00',
    description: `Antes disto o portal responde "ainda nao abriu". ${AJUDA_DATA}`,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  dataAbertura?: string;

  @ApiProperty({
    example: '2026-08-18T23:59:00-03:00',
    description: `Quando o agendamento fecha — e o UNICO jeito de fechar. ${AJUDA_DATA}`,
  })
  @IsISO8601({ strict: true })
  dataFechamento!: string;
}

export class AtualizarPeriodoDto {
  @ApiPropertyOptional({
    type: [LetivoDaModalidadeDto],
    description:
      'Corrige o mapa por formato — **so enquanto a janela nao tiver ' +
      'agendamento nenhum** (cancelados contam), pela mesma razao da `rodada`: ' +
      'o `periodoLetivoId` gravado na reserva e fotografia, e trocar o da janela ' +
      'deixaria as provas orfas. Reenviar o mapa IGUAL ao que ja esta gravado ' +
      'nao dispara a trava, entao editar so as datas de uma janela cheia ' +
      'continua funcionando.\n\n' +
      'O mapa vai INTEIRO: nao ha edicao de uma linha so, porque ele e validado ' +
      'como conjunto (todo formato coberto).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LetivoDaModalidadeDto)
  letivosPorModalidade?: LetivoDaModalidadeDto[];

  @ApiPropertyOptional({
    example: 'SUB',
    maxLength: 20,
    description:
      'Corrige a rodada — **so enquanto a janela nao tiver agendamento nenhum** ' +
      '(cancelados contam). Com provas dentro responde 409: a rodada gravada na ' +
      'reserva e fotografia, e trocar a da janela deixaria as provas orfas do ' +
      'par que as identifica.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  rodada?: string;

  @ApiPropertyOptional({
    example: 1.5,
    nullable: true,
    minimum: 0,
    maximum: 10,
    description:
      `Piso da nota da N1, INCLUSIVE. Envie null nos DOIS campos para desligar ` +
      `o filtro de nota. ${AJUDA_NOTA}\n\n` +
      '**Editavel mesmo com a janela cheia**, ao contrario da `rodada`: os ' +
      'criterios nao sao gravados em reserva nenhuma, entao muda-los so afeta ' +
      'quem agendar daqui para a frente — quem ja marcou continua com o ' +
      'horario, inclusive quem pela regra nova nao seria elegivel. A alteracao ' +
      'vai para a auditoria.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  notaMinimaN1?: number | null;

  @ApiPropertyOptional({
    example: 7,
    nullable: true,
    minimum: 0,
    maximum: 10,
    description: 'Teto da NOTA FINAL CALCULADA, EXCLUSIVE. Ver `notaMinimaN1`.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  notaMaximaFinal?: number | null;

  @ApiPropertyOptional({ example: '2026/2 — provas finais', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  descricao?: string | null;

  @ApiPropertyOptional({
    example: true,
    description: 'Abre ou fecha o agendamento na hora.',
  })
  @IsOptional()
  @IsBoolean()
  aberto?: boolean;

  @ApiPropertyOptional({
    example: '2026-08-01T08:00:00-03:00',
    nullable: true,
    description: `Envie null para remover a data de abertura. ${AJUDA_DATA}`,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  dataAbertura?: string | null;

  @ApiPropertyOptional({
    example: '2026-08-20T23:59:00-03:00',
    description: `Prorrogar ou antecipar o prazo. ${AJUDA_DATA}`,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  dataFechamento?: string;
}

export class FiltroDeNotaDto implements FiltroDeNota {
  @ApiProperty({
    example: 1.5,
    description:
      'Piso da nota da **N1**, INCLUSIVE — quem tirou exatamente isso entra.',
  })
  minimaN1!: number;

  @ApiProperty({
    example: 7,
    description:
      'Teto da **nota final calculada**, EXCLUSIVE — quem o alcanca ja passou. ' +
      'Nao forma intervalo com `minimaN1`: as duas olham notas diferentes.',
  })
  maximaFinal!: number;
}

export class PeriodoAdminDto implements PeriodoAdmin {
  @ApiProperty({ example: 3 })
  id!: number;

  @ApiProperty({
    example: '103',
    description:
      'O periodo letivo PRINCIPAL da janela — o rotulo dela, e o fallback de um ' +
      'formato sem entrada no mapa. Qual vale para cada aluno esta em ' +
      '`letivosPorModalidade`.',
  })
  periodoLetivoId!: string;

  @ApiProperty({
    type: [LetivoDaModalidadeResponseDto],
    description:
      'O mapa `modalidade -> periodo letivo` desta janela, com uma linha por ' +
      'formato cadastrado (inclusive as que herdam o principal). ' +
      'Ver POST /periodos.',
  })
  letivosPorModalidade!: LetivoDaModalidade[];

  @ApiProperty({
    example: 'SUB',
    description:
      'Qual prova do semestre. Junto do `periodoLetivoId` forma a identidade da ' +
      'janela — duas linhas do mesmo semestre so diferem por aqui.',
  })
  rodada!: string;

  @ApiProperty({
    nullable: true,
    type: FiltroDeNotaDto,
    description:
      'Os criterios de nota desta janela, ou null quando ela nao filtra ' +
      '(o caso da N2). Ver `notaMinimaN1` em POST /periodos.',
  })
  filtroDeNota!: FiltroDeNota | null;

  @ApiProperty({ nullable: true, example: '2026/2 — provas finais' })
  descricao!: string | null;

  @ApiProperty({
    example: true,
    description:
      'A chave que o admin liga/desliga. Nao conta as datas sozinha.',
  })
  aberto!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dataAbertura!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  dataFechamento!: Date;

  @ApiProperty({
    example: true,
    description:
      'O periodo mais recente e o vigente — e o unico que o portal do aluno consulta.',
  })
  vigente!: boolean;

  @ApiProperty({
    example: true,
    description:
      'Situacao EFETIVA agora: vigente + aberto + dentro da janela de datas. ' +
      'E este campo que responde "o aluno consegue agendar neste instante?".',
  })
  aceitandoAgendamento!: boolean;

  @ApiProperty({
    example: 412,
    description:
      'Agendamentos confirmados nesta janela — periodo letivo E rodada. A linha ' +
      'da substitutiva nao conta as provas da regular.',
  })
  totalAgendamentos!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  criadoEm!: Date;
}

export class VigenteDepoisDaRemocaoDto implements VigenteDepoisDaRemocao {
  @ApiProperty({ example: 79 })
  id!: number;

  @ApiProperty({ example: '142286' })
  periodoLetivoId!: string;

  @ApiProperty({ example: 'N2', description: 'Qual prova do semestre.' })
  rodada!: string;

  @ApiProperty({ nullable: true, example: '2026/2' })
  descricao!: string | null;
}

export class RemocaoPeriodoDto implements RemocaoPeriodo {
  @ApiProperty({ example: 'Periodo 80 (2026/1) removido' })
  mensagem!: string;

  @ApiProperty({
    type: VigenteDepoisDaRemocaoDto,
    nullable: true,
    description:
      'Quem passou a ser o vigente — o unico periodo que o portal do aluno ' +
      'consulta. `null` quando nao sobrou nenhum, e ai o portal responde que o ' +
      'agendamento nao foi configurado.',
  })
  vigenteAgora!: VigenteDepoisDaRemocaoDto | null;
}
