import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { Polo, PoloComContagens } from '../service/polo.service';

export class CriarPoloDto {
  @ApiProperty({
    example: 'Polo Anápolis - Jundiaí',
    maxLength: 191,
    description:
      'PRECISA ser identico ao valor da coluna CAMPUS no CSV de alunos — e a chave ' +
      'que liga aluno e polo na importacao. Um acento ou espaco a mais faz todos os ' +
      'alunos daquele campus serem rejeitados no proximo upload.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'nome e obrigatorio' })
  @MaxLength(191)
  nome!: string;

  @ApiPropertyOptional({
    example: 'Anápolis',
    description: 'Apenas informativo; nao entra em nenhuma regra.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  cidade?: string;
}

export class AtualizarPoloDto {
  @ApiPropertyOptional({
    example: 'Anápolis',
    nullable: true,
    description: 'Envie null para limpar.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  cidade?: string | null;

  @ApiPropertyOptional({
    example: false,
    description:
      'Polo inativo some do dropdown de cadastro de sala. Nao afeta faixas ja criadas.',
  })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

export class PoloDto implements Polo {
  @ApiProperty({ example: 6 })
  id!: number;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  nome!: string;

  @ApiProperty({ nullable: true, example: 'Taguatinga' })
  cidade!: string | null;

  @ApiProperty({ example: true })
  ativo!: boolean;
}

export class PoloComContagensDto extends PoloDto implements PoloComContagens {
  @ApiProperty({ example: 12, description: 'Salas cadastradas neste polo.' })
  totalSalas!: number;

  @ApiProperty({
    example: 2515,
    description: 'Vinculos de aluno importados neste polo (aluno + curso).',
  })
  totalAlunos!: number;
}
