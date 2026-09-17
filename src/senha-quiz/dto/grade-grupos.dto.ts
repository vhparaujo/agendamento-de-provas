import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { CelulaDeGrupo } from '../service/grade-grupos.service';

/**
 * So o dia, sem hora. `IsDateString` aceitaria "2026-09-16T10:00:00Z", e
 * `dataUtcDeIso` montaria uma data invalida a partir disso.
 */
const PADRAO_DIA = /^\d{4}-\d{2}-\d{2}$/;

export class CelulaDeGrupoDto {
  @ApiProperty({
    example: '2026-09-16',
    description:
      'O dia da PROVA (AAAA-MM-DD). Para a janela que dispara a noite, e o dia ' +
      'SEGUINTE ao disparo — o mesmo dia que o questionario passa a ter.',
  })
  @Matches(PADRAO_DIA, { message: 'data deve estar em AAAA-MM-DD' })
  data!: string;

  @ApiProperty({ example: 10, description: 'A janela (sessao) do formato.' })
  @IsInt()
  @Min(1)
  janelaDeProvaId!: number;

  @ApiPropertyOptional({
    example: 'Prova EaD 16/09 - 15h',
    nullable: true,
    description:
      'O NOME do grupo no Brightspace, livre. **Vazio ou nulo APAGA a celula**, ' +
      'e o dia volta a usar o nome fixo da janela (se houver).\n\n' +
      'Mudar o nome sobe a versao da celula, o que libera a janela para ' +
      'disparar de novo HOJE — e assim que a correcao vale no mesmo dia.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nomeGrupo?: string | null;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description:
      'Opcional. Nula = usa a categoria da janela. So e preciso quando o mesmo ' +
      'nome existe em duas categorias da turma.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  categoriaGrupo?: string | null;
}

export class SalvarGradeDeGruposDto {
  @ApiProperty({
    type: [CelulaDeGrupoDto],
    description:
      'As celulas a gravar. Celula que nao vier aqui NAO e tocada — ao ' +
      'contrario do PUT das janelas, este nao substitui a grade inteira.',
  })
  @IsArray()
  @ArrayMinSize(1)
  // Uma semana cheia sao ~84 celulas; o teto so barra corpo absurdo.
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CelulaDeGrupoDto)
  celulas!: CelulaDeGrupoDto[];
}

export class CelulaDeGrupoResponseDto implements CelulaDeGrupo {
  @ApiProperty({ example: 31 })
  id!: number;

  @ApiProperty({ example: '2026-09-16', description: 'O dia da prova.' })
  data!: string;

  @ApiProperty({ example: 10 })
  janelaDeProvaId!: number;

  @ApiProperty({ example: 'Prova EaD 16/09 - 15h' })
  nomeGrupo!: string;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Nula = usa a categoria da janela.',
  })
  categoriaGrupo!: string | null;

  @ApiProperty({
    example: 1,
    description:
      'Sobe quando o nome ou a categoria mudam. E o que libera um novo ' +
      'disparo no mesmo dia depois de uma correcao.',
  })
  versao!: number;

  @ApiProperty({ example: 'secretaria@ucb.br' })
  atualizadoPor!: string;

  @ApiProperty({ example: '2026-09-14T12:00:00.000Z' })
  atualizadoEm!: Date;
}
