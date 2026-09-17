import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Sala, SalaComPolo } from '../service/sala.service';

/** Teto defensivo: capacidade maior que isto e quase certamente erro de digitacao. */
const CAPACIDADE_MAXIMA = 1000;

export class CriarSalaDto {
  @ApiProperty({
    example: 6,
    description: 'Id do polo, escolhido no dropdown de GET /polos.',
  })
  @IsInt()
  @Min(1)
  poloId!: number;

  @ApiProperty({
    example: 'M114',
    maxLength: 191,
    description: 'Unico dentro do polo. Repetir o nome entre polos e normal.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Informe o nome da sala.' })
  @MaxLength(191)
  nome!: string;

  @ApiProperty({
    example: 40,
    minimum: 1,
    maximum: CAPACIDADE_MAXIMA,
    description:
      'Lugares fisicos. Vira o padrao de `vagas` quando a sala entra numa faixa, ' +
      'e o teto que `vagas` nao pode ultrapassar.',
  })
  @IsInt()
  @Min(1)
  @Max(CAPACIDADE_MAXIMA)
  capacidade!: number;
}

export class AtualizarSalaDto {
  @ApiPropertyOptional({ example: 'M114', maxLength: 191 })
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  nome?: string;

  @ApiPropertyOptional({
    example: 44,
    minimum: 1,
    maximum: CAPACIDADE_MAXIMA,
    description:
      'Vale para as PROXIMAS faixas. As vagas das faixas ja montadas nao mudam — ' +
      'elas vivem na SalaFaixa, e alterar retroativamente poderia deixar uma sala ' +
      'com mais agendamentos do que vagas.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CAPACIDADE_MAXIMA)
  capacidade?: number;

  @ApiPropertyOptional({
    example: false,
    description: 'Sala inativa nao aparece para montar novas faixas.',
  })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

class PoloResumoDto {
  @ApiProperty({ example: 6 })
  id!: number;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  nome!: string;
}

export class SalaDto implements Sala {
  @ApiProperty({ example: 21 })
  id!: number;

  @ApiProperty({ example: 6 })
  poloId!: number;

  @ApiProperty({ example: 'M114' })
  nome!: string;

  @ApiProperty({ example: 40 })
  capacidade!: number;

  @ApiProperty({ example: true })
  ativo!: boolean;
}

export class SalaComPoloDto extends SalaDto implements SalaComPolo {
  @ApiProperty({ type: PoloResumoDto })
  polo!: PoloResumoDto;

  @ApiProperty({
    example: 3,
    description:
      'Em quantas faixas esta sala ja foi ofertada. Maior que zero impede apagar.',
  })
  totalOfertas!: number;
}

export class RemocaoDto {
  @ApiProperty({ example: 'Sala "M114" removida' })
  mensagem!: string;
}
