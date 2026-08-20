import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  FiltroDeNota,
  PeriodoAdmin,
  RemocaoPeriodo,
  VigenteDepoisDaRemocao,
} from '../service/periodo.service';

const AJUDA_DATA =
  'ISO 8601 COM fuso (ex: 2026-08-18T23:59:00-03:00). Sem o fuso, a data e lida ' +
  'como UTC e o prazo fecha 3 horas antes do que voce quis.';

const AJUDA_NOTA =
  'A FAIXA DE NOTA que habilita esta janela — a regra da substitutiva. Informe ' +
  'as DUAS ou nenhuma. Com as duas, so entra na prova a disciplina em que a ' +
  'nota final do aluno esta em [notaMinima, notaMaxima): `>=` na minima e `<` ' +
  'na maxima. Sem elas (o padrao, e o caso da N2), a prova cobre todas as ' +
  'disciplinas do semestre e nenhuma nota e consultada no Brightspace.\n\n' +
  'Ler a nota exige o escopo `grades:gradevalues:read` no consentimento da ' +
  'Valence — acrescenta-lo ao `.env` nao basta, e preciso refazer ' +
  '`npm run d2l:autorizar`.';

export class CriarPeriodoDto {
  @ApiProperty({
    example: '103',
    description:
      'Id do periodo letivo no Brightspace. Vai gravado em cada agendamento e e ' +
      'o que separa um semestre do outro nos relatorios.',
  })
  @IsString()
  @IsNotEmpty({ message: 'periodoLetivoId e obrigatorio' })
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
    example: 1.5,
    minimum: 0,
    maximum: 10,
    description: `Piso da faixa, INCLUSIVE. ${AJUDA_NOTA}`,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  notaMinima?: number;

  @ApiPropertyOptional({
    example: 6.75,
    minimum: 0,
    maximum: 10,
    description:
      'Teto da faixa, EXCLUSIVE — quem alcanca este valor ja passou e nao ' +
      'aparece na substitutiva.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  notaMaxima?: number;

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
      `Piso da faixa, INCLUSIVE. Envie null nos DOIS campos para desligar o ` +
      `filtro de nota. ${AJUDA_NOTA}\n\n` +
      '**Editavel mesmo com a janela cheia**, ao contrario da `rodada`: a faixa ' +
      'nao e gravada em reserva nenhuma, entao muda-la so afeta quem agendar ' +
      'daqui para a frente — quem ja marcou continua com o horario, inclusive ' +
      'quem pela faixa nova nao seria elegivel. A alteracao vai para a auditoria.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  notaMinima?: number | null;

  @ApiPropertyOptional({
    example: 6.75,
    nullable: true,
    minimum: 0,
    maximum: 10,
    description: 'Teto da faixa, EXCLUSIVE. Ver `notaMinima`.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  notaMaxima?: number | null;

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
  @ApiProperty({ example: 1.5, description: 'Piso da faixa, INCLUSIVE.' })
  minima!: number;

  @ApiProperty({ example: 6.75, description: 'Teto da faixa, EXCLUSIVE.' })
  maxima!: number;
}

export class PeriodoAdminDto implements PeriodoAdmin {
  @ApiProperty({ example: 3 })
  id!: number;

  @ApiProperty({ example: '103' })
  periodoLetivoId!: string;

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
      'A faixa de nota desta janela, ou null quando ela nao filtra por nota ' +
      '(o caso da N2). Ver `notaMinima` em POST /periodos.',
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
