import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { PeriodoAdmin } from '../service/periodo.service';

const AJUDA_DATA =
  'ISO 8601 COM fuso (ex: 2026-08-18T23:59:00-03:00). Sem o fuso, a data e lida ' +
  'como UTC e o prazo fecha 3 horas antes do que voce quis.';

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

export class PeriodoAdminDto implements PeriodoAdmin {
  @ApiProperty({ example: 3 })
  id!: number;

  @ApiProperty({ example: '103' })
  periodoLetivoId!: string;

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
    description: 'Agendamentos confirmados neste periodo letivo.',
  })
  totalAgendamentos!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  criadoEm!: Date;
}
