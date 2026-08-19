import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';
import { MotivoExcecao, StatusExecucao } from '../../generated/prisma/client';

export class IniciarCompulsorioDto {
  /**
   * `true` (padrao) percorre a alocacao inteira e NAO grava nada — e como se
   * responde "cabe todo mundo?" antes de descobrir no meio que nao cabia.
   * Mande `false` so depois de olhar o resultado da simulacao.
   */
  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'true = simula (nada e gravado). false = aloca de verdade. O padrao e simular.',
  })
  @IsOptional()
  @IsBoolean()
  simulacao?: boolean;

  /**
   * Restringe o lote a um polo. Sem isso, roda para todos.
   */
  @ApiPropertyOptional({
    example: 6,
    description:
      'Roda so para um polo. Util para tratar um campus de cada vez quando ' +
      'faltarem vagas em algum deles.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  poloId?: number;
}

export class ExecucaoIniciadaDto {
  @ApiProperty({ example: 3, description: 'Id da execucao, para acompanhar.' })
  id!: number;

  @ApiProperty({ example: true, description: 'Se nada sera gravado.' })
  simulacao!: boolean;

  @ApiProperty({
    example: 4812,
    description: 'Quantos vinculos o lote vai tentar alocar.',
  })
  totalElegiveis!: number;
}

export class AndamentoDoCompulsorioDto {
  @ApiProperty({ example: 3 })
  id!: number;

  @ApiProperty({ enum: StatusExecucao, example: StatusExecucao.EM_ANDAMENTO })
  status!: StatusExecucao;

  @ApiProperty({ example: true })
  simulacao!: boolean;

  @ApiProperty({
    example: false,
    description:
      'true = o processo morreu no meio (reinicio do servidor). O que ja tinha ' +
      'sido gravado permanece; o resto nao foi processado.',
  })
  interrompida!: boolean;

  @ApiProperty({ example: '103' })
  periodoLetivoId!: string;

  @ApiProperty({
    example: 'SUB',
    description:
      'Qual prova do semestre este lote preencheu. Elegivel para a SUB e quem ' +
      'nao tem prova DA SUB — quem fez so a N2 entra.',
  })
  rodada!: string;

  @ApiProperty({ example: 'secretaria@ucb.br' })
  iniciadoPor!: string;

  @ApiProperty({ example: 4812 })
  totalElegiveis!: number;

  @ApiProperty({ example: 1200, description: 'Quantos ja foram resolvidos.' })
  processados!: number;

  @ApiProperty({ example: 4640, description: 'Quantos ganharam lugar.' })
  alocados!: number;

  @ApiProperty({
    example: { SEM_VAGA: 130, SEM_CONTA_D2L: 11 },
    description:
      'Contagem por motivo. As chaves sao os valores de MotivoExcecao.',
    additionalProperties: { type: 'number' },
  })
  excecoes!: Partial<Record<MotivoExcecao, number>>;

  @ApiProperty({
    example: null,
    nullable: true,
    type: String,
    description: 'Preenchido so quando a execucao INTEIRA falha.',
  })
  erro!: string | null;

  @ApiProperty({ example: '2026-08-12T20:10:00.000Z' })
  iniciadoEm!: Date;

  @ApiProperty({
    example: '2026-08-12T20:35:00.000Z',
    nullable: true,
    type: Date,
  })
  concluidoEm!: Date | null;

  @ApiProperty({
    example: '2026-08-12T20:35:00.000Z',
    description:
      'Sinal de vida, batido a cada fatia de alunos. E o que distingue um lote ' +
      'lento de um lote morto.',
  })
  atualizadoEm!: Date;
}
