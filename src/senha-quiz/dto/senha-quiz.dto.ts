import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsEnum, IsOptional } from 'class-validator';
import {
  ResultadoSenhaQuiz,
  StatusExecucao,
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';

export class IniciarSenhaQuizDto {
  @ApiProperty({
    example: '2026-09-16',
    description: 'Dia da prova (AAAA-MM-DD).',
  })
  @IsDateString()
  data!: string;

  @ApiProperty({ enum: Turno, example: Turno.MANHA })
  @IsEnum(Turno)
  turno!: Turno;

  /**
   * `true` e o PADRAO, como no compulsorio: a simulacao percorre tudo e nao
   * emite nenhum PUT. E a unica conferencia possivel antes de mexer na prova de
   * toda a instituicao.
   */
  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'true = simula (nenhum PUT sai daqui). false = aplica de verdade. O padrao e simular.',
  })
  @IsOptional()
  @IsBoolean()
  simulacao?: boolean;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Aplica de novo uma senha ja aplicada. O PUT e idempotente, entao repetir ' +
      'nao corrompe nada — a trava existe contra repeticao sem querer.',
  })
  @IsOptional()
  @IsBoolean()
  forcar?: boolean;
}

export class ExecucaoSenhaIniciadaDto {
  @ApiProperty({ example: 12, description: 'Id da execucao, para acompanhar.' })
  id!: number;

  @ApiProperty({ example: true })
  simulacao!: boolean;

  @ApiProperty({ example: 320, description: 'Linhas do CSV de turmas.' })
  turmasNoCsv!: number;

  @ApiProperty({
    example: 312,
    description: 'Turmas que serao tocadas (CSV ∩ periodo letivo vigente).',
  })
  totalTurmas!: number;

  @ApiProperty({
    example: 8,
    description:
      'Turmas do CSV sem orgUnitId resolvido. **Cada uma ficaria sem senha** — ' +
      'saem detalhadas no relatorio.',
  })
  naoResolvidas!: number;
}

export class AndamentoDaSenhaQuizDto {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({ enum: StatusExecucao, example: StatusExecucao.EM_ANDAMENTO })
  status!: StatusExecucao;

  @ApiProperty({ example: false })
  simulacao!: boolean;

  @ApiProperty({ example: 'MANUAL', description: 'MANUAL ou CRON.' })
  origem!: string;

  @ApiProperty({ example: 'admin@ucb.br' })
  iniciadoPor!: string;

  @ApiProperty({ example: '2026-09-16' })
  data!: string;

  @ApiProperty({ enum: Turno, example: Turno.MANHA })
  turno!: Turno;

  @ApiProperty({ example: 'Prova' })
  nomeQuizAlvo!: string;

  @ApiProperty({ enum: TipoMatchQuiz, example: TipoMatchQuiz.CONTEM })
  matchQuizAlvo!: TipoMatchQuiz;

  @ApiProperty({ example: 320 })
  turmasNoCsv!: number;

  @ApiProperty({ example: 312 })
  turmasResolvidas!: number;

  @ApiProperty({ example: 12 })
  orgUnitsAprendidos!: number;

  @ApiProperty({ example: 200 })
  processadas!: number;

  @ApiProperty({ example: 198 })
  definidas!: number;

  @ApiProperty({
    example: 4,
    description:
      '**O contador que mais dói e o que menos aparece**: sao turmas cujos ' +
      'alunos nao conseguiriam abrir a prova, e nao contam como falha.',
  })
  naoEncontradas!: number;

  @ApiProperty({ example: 2 })
  falhas!: number;

  @ApiProperty({
    example: 190,
    description: 'Quantos questionarios devolveram a senha anterior no GET.',
  })
  comSenhaLida!: number;

  @ApiProperty({
    example: false,
    description:
      'Nenhum questionario devolveu a senha anterior. E DIAGNOSTICO, nao alarme: ' +
      'este lote sempre define uma senha nova, entao nao ha risco de apagar nada. ' +
      'Serve para descobrir que a API esconde o campo antes de alguem confiar nele.',
  })
  avisoSenhaInvisivel!: boolean;

  @ApiProperty({
    example: true,
    description:
      'O processo morreu no meio (reinicio do servidor). O que ja foi gravado ' +
      'permanece; rodar de novo refaz o resto.',
  })
  interrompida!: boolean;

  @ApiProperty({
    example: { DEFINIDA: 198, QUIZ_NAO_ENCONTRADO: 4 },
    description: 'Contagem por resultado.',
    additionalProperties: { type: 'number' },
  })
  itens!: Partial<Record<ResultadoSenhaQuiz, number>>;

  @ApiProperty({ example: null, nullable: true })
  erro!: string | null;

  @ApiProperty({ example: '2026-09-16T10:30:00.000Z' })
  iniciadoEm!: Date;

  @ApiProperty({ example: '2026-09-16T10:36:00.000Z', nullable: true })
  concluidoEm!: Date | null;
}
