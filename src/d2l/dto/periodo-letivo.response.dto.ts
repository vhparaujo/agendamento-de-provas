import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PeriodoLetivoD2L } from '../service/d2l-enrollments.service';

/**
 * Uma opcao do dropdown de periodo letivo. O `id` e exatamente o valor que vai
 * em `periodoLetivoId` no `POST /periodos`.
 */
export class PeriodoLetivoD2lDto implements PeriodoLetivoD2L {
  @ApiProperty({
    example: '29715',
    description:
      'OrgUnitId do Periodo Letivo no Brightspace. E o que deve ser enviado como ' +
      '`periodoLetivoId` ao criar o periodo de agendamento.',
  })
  id!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '2023/2',
    description: 'Nome do org unit, como o Brightspace o exibe.',
  })
  nome!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026_1',
    description: 'Code do org unit. Pode vir vazio.',
  })
  codigo!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 2026,
    description:
      'Ano lido do nome. `null` quando o nome nao segue "AAAA/S" — o tenant tem ' +
      'org units desse tipo que nao sao semestre (ex: "Esperancar").',
  })
  ano!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 1,
    description: 'Semestre lido do nome ("2026/1" -> 1).',
  })
  semestre!: number | null;
}
