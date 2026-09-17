import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ResultadoSpecialAccess,
  StatusExecucao,
  TipoMatchQuiz,
} from '../../generated/prisma/client';
import {
  TEMPO_MAXIMO_DA_VALENCE,
  type ConfiguracaoDoSpecialAccess,
  type TempoDaModalidade,
} from '../service/configuracao-special-access.service';
import type {
  AndamentoDoSpecialAccess,
  ExecucaoSpecialAccessIniciada,
  TurmaDoSpecialAccess,
  TurmasDoSpecialAccess,
} from '../service/special-access.service';

// ------------------------------------------------------------------- entrada

export class TempoDaModalidadeEntradaDto {
  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id!: number;

  @ApiProperty({
    example: 180,
    minimum: 1,
    maximum: TEMPO_MAXIMO_DA_VALENCE,
    description: 'O tempo do questionario, em minutos, para este formato.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TEMPO_MAXIMO_DA_VALENCE)
  tempoDeProvaMinutos!: number;
}

export class SalvarConfiguracaoSpecialAccessDto {
  @ApiProperty({
    example: 60,
    minimum: 0,
    maximum: 600,
    description:
      'Minutos a mais para quem e do NIOP: somados ao tempo de prova e ao fim ' +
      'da janela.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600)
  tempoExtraNiopMinutos!: number;

  @ApiProperty({
    example: false,
    description:
      'true = o special access SUBSTITUI a troca de data e grupo: o cron para ' +
      'de aplicar janelas (a senha continua) e o lote manual de datas recusa.',
  })
  @IsBoolean()
  substituiJanelas!: boolean;

  @ApiProperty({
    type: [TempoDaModalidadeEntradaDto],
    description:
      'O tempo de prova de cada formato. Formato que nao vier nao muda.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TempoDaModalidadeEntradaDto)
  modalidades!: TempoDaModalidadeEntradaDto[];
}

export class IniciarSpecialAccessDto {
  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'true = faz as leituras e nenhuma escrita. O padrao e simular.',
  })
  @IsOptional()
  @IsBoolean()
  simulacao?: boolean;

  @ApiPropertyOptional({
    type: [String],
    example: ['156979', '156980'],
    description:
      'So estas turmas. **Vazio ou ausente = todas as que tem reserva na ' +
      'rodada.** Serve para fatiar a carga contra o Brightspace: o lote e uma ' +
      'chamada por aluno em cada questionario. `GET /special-access/turmas` ' +
      'lista as opcoes com o tamanho de cada uma.\n\n' +
      'Se alguma turma da lista nao tiver reserva na rodada, a execucao inteira ' +
      'e recusada — rodar nas outras esconderia a que faltou ate o dia da prova.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @Matches(/^\d+$/, { each: true, message: 'orgUnitIds deve ter so numeros' })
  orgUnitIds?: string[];
}

// ------------------------------------------------------------------- saida

export class TempoDaModalidadeDto implements TempoDaModalidade {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'EAD' })
  codigo!: string;

  @ApiProperty({ example: 'EaD' })
  nome!: string;

  @ApiProperty({
    example: 180,
    description: 'O tamanho de faixa que o formato exige. So leitura aqui.',
  })
  duracaoMinutos!: number;

  @ApiProperty({ example: 180 })
  tempoDeProvaMinutos!: number;
}

export class ConfiguracaoSpecialAccessDto implements ConfiguracaoDoSpecialAccess {
  @ApiProperty({ example: 60 })
  tempoExtraNiopMinutos!: number;

  @ApiProperty({ example: false })
  substituiJanelas!: boolean;

  @ApiProperty({ type: [TempoDaModalidadeDto] })
  modalidades!: TempoDaModalidadeDto[];

  @ApiProperty({ example: 'admin@ucb.br', nullable: true, type: String })
  atualizadoPor!: string | null;

  @ApiProperty({
    example: '2026-09-15T18:00:00.000Z',
    nullable: true,
    type: Date,
  })
  atualizadoEm!: Date | null;
}

export class ExecucaoSpecialAccessIniciadaDto implements ExecucaoSpecialAccessIniciada {
  @ApiProperty({ example: 4 })
  id!: number;

  @ApiProperty({ example: true })
  simulacao!: boolean;

  @ApiProperty({
    example: 152,
    description: 'Turmas que o lote vai percorrer.',
  })
  totalTurmas!: number;
}

export class AndamentoDoSpecialAccessDto implements AndamentoDoSpecialAccess {
  @ApiProperty({ example: 4 })
  id!: number;

  @ApiProperty({ enum: StatusExecucao, example: StatusExecucao.EM_ANDAMENTO })
  status!: StatusExecucao;

  @ApiProperty({ example: true })
  simulacao!: boolean;

  @ApiProperty({
    example: false,
    description:
      'O processo morreu no meio. Rodar de novo continua: o lote so escreve o que falta.',
  })
  interrompida!: boolean;

  @ApiProperty({ example: '156000,156010' })
  periodoLetivoIds!: string;

  @ApiProperty({ example: 'N2' })
  rodada!: string;

  @ApiProperty({
    example: null,
    nullable: true,
    type: String,
    description:
      'As turmas escolhidas, separadas por virgula. Nulo = a rodada inteira.',
  })
  orgUnitIds!: string | null;

  @ApiProperty({ example: 'Prova N2' })
  nomeQuizAlvo!: string;

  @ApiProperty({ enum: TipoMatchQuiz, example: TipoMatchQuiz.CONTEM })
  matchQuizAlvo!: TipoMatchQuiz;

  @ApiProperty({ example: 60 })
  tempoExtraNiopMinutos!: number;

  @ApiProperty({ example: 'admin@ucb.br' })
  iniciadoPor!: string;

  @ApiProperty({ example: 152 })
  totalTurmas!: number;

  @ApiProperty({ example: 40 })
  turmasProcessadas!: number;

  @ApiProperty({ example: 1180, description: 'Acessos criados.' })
  gravados!: number;

  @ApiProperty({
    example: 12,
    description: 'Acessos com horario ou tempo diferente (remanejo).',
  })
  atualizados!: number;

  @ApiProperty({
    example: 3,
    description: 'Acessos tirados (prova cancelada).',
  })
  removidos!: number;

  @ApiProperty({ example: 3400, description: 'Ja estavam certos.' })
  jaCorretos!: number;

  @ApiProperty({ example: 2 })
  pendencias!: number;

  @ApiProperty({
    example: { ACESSO_GRAVADO: 1180, ALUNO_NAO_ENCONTRADO: 2 },
    description:
      'Contagem por resultado. As chaves sao os valores de ResultadoSpecialAccess.',
    additionalProperties: { type: 'number' },
  })
  resultados!: Partial<Record<ResultadoSpecialAccess, number>>;

  @ApiProperty({ example: null, nullable: true, type: String })
  erro!: string | null;

  @ApiProperty({ example: '2026-09-20T13:00:00.000Z' })
  iniciadoEm!: Date;

  @ApiProperty({
    example: '2026-09-20T13:09:00.000Z',
    nullable: true,
    type: Date,
  })
  concluidoEm!: Date | null;

  @ApiProperty({ example: '2026-09-20T13:09:00.000Z' })
  atualizadoEm!: Date;
}

export class TurmaDoSpecialAccessDto implements TurmaDoSpecialAccess {
  @ApiProperty({ example: '156979' })
  orgUnitId!: string;

  @ApiProperty({ example: 'GSPS0I10227', nullable: true, type: String })
  codigoTurma!: string | null;

  @ApiProperty({ example: 'SAUDE COLETIVA', nullable: true, type: String })
  nomeDisciplina!: string | null;

  @ApiProperty({
    example: 38,
    description: 'Matriculas distintas com reserva confirmada nesta turma.',
  })
  alunos!: number;

  @ApiProperty({
    example: 38,
    description:
      'Gravacoes que esta turma custa em CADA questionario da prova. E o numero ' +
      'que dimensiona a fatia.',
  })
  acessos!: number;

  @ApiProperty({
    example: 2,
    description: 'Reservas canceladas: acesso a remover, se houver.',
  })
  cancelados!: number;
}

export class TurmasDoSpecialAccessDto implements TurmasDoSpecialAccess {
  @ApiProperty({ example: 'N2' })
  rodada!: string;

  @ApiProperty({ type: [TurmaDoSpecialAccessDto] })
  turmas!: TurmaDoSpecialAccessDto[];
}
