import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import type { ResultadoMesclagem } from '../service/mesclagem-vinculos.service';

export class MesclarVinculosDto {
  /**
   * Id do vinculo ANTIGO, o que sera absorvido e apagado. E o
   * `candidatas[].alunoId` do relatorio de importacao; o vinculo que fica vai
   * na URL.
   */
  @ApiProperty({
    example: 4821,
    description:
      'Id do vinculo a ser absorvido e APAGADO. Seus agendamentos e excecoes ' +
      'passam para o vinculo da URL. Precisa ser da MESMA matricula.',
  })
  @IsInt()
  @Min(1)
  absorverId!: number;
}

export class VinculoMescladoDto {
  @ApiProperty({ example: 9134 })
  id!: number;

  @ApiProperty({ example: 'UC25426847' })
  matricula!: string;

  @ApiProperty({ example: 'Psicologia — Bacharelado' })
  curso!: string;
}

export class VinculoAbsorvidoDto {
  @ApiProperty({ example: 4821 })
  id!: number;

  @ApiProperty({ example: 'PSICOLOGIA' })
  curso!: string;
}

export class ResultadoMesclagemDto implements ResultadoMesclagem {
  @ApiProperty({
    type: VinculoMescladoDto,
    description: 'O vinculo que ficou, com a grafia da planilha nova.',
  })
  destino!: VinculoMescladoDto;

  @ApiProperty({
    type: VinculoAbsorvidoDto,
    description: 'O vinculo que deixou de existir.',
  })
  absorvido!: VinculoAbsorvidoDto;

  @ApiProperty({
    example: 1,
    description: 'Provas que passaram a pertencer ao vinculo de destino.',
  })
  agendamentosMovidos!: number;

  @ApiProperty({
    example: 0,
    description:
      'Linhas de excecao do compulsorio movidas — o historico de "ficou sem ' +
      'vaga" continua apontando para alguem que existe.',
  })
  excecoesMovidas!: number;

  @ApiProperty({
    type: [String],
    example: [],
    description:
      'O que a mesclagem deixou inconsistente: os dois vinculos divergiam em ' +
      'modalidade ou polo, e as provas herdadas continuam nas salas antigas. ' +
      'Nao bloqueia — quem decide entre remanejar e cancelar e a secretaria.',
  })
  avisos!: string[];
}
