import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  PaginaDeTurmas,
  TurmaImportadaDetalhe,
  TurmaImportadaResumo,
} from '../service/turma-admin.service';

export class TurmaImportadaDto implements TurmaImportadaResumo {
  @ApiProperty({ example: 214 })
  id!: number;

  @ApiProperty({
    example: 'GSPS0I10227',
    description:
      'Coluna "Código da Turma". Ele SE REPETE entre disciplinas — sozinho nao ' +
      'identifica a oferta.',
  })
  codigoTurma!: string;

  @ApiProperty({ example: 'SAUDE COLETIVA' })
  nomeDisciplina!: string;

  @ApiProperty({
    nullable: true,
    example: 'GSPS01EAD048',
    description:
      'Codigo da DISCIPLINA, extraido dos parenteses da 3a coluna do CSV. E o ' +
      'outro token do `Code` composto do Brightspace e o que separa disciplinas ' +
      'diferentes rodando sob o mesmo codigo de turma.',
  })
  codigoEad!: string | null;

  @ApiProperty({
    nullable: true,
    example: '338291',
    description:
      'Id da oferta no D2L. O CSV nao traz: ele e **aprendido** nos launches ' +
      '(cada aluno entrega o `context.id` da turma dele) e nunca sobrescrito. ' +
      'Null = nenhum aluno entrou por esta turma ainda.',
  })
  orgUnitId!: string | null;
}

export class PaginaDeTurmasDto implements PaginaDeTurmas {
  @ApiProperty({ example: 318, description: 'Turmas que casam com o filtro.' })
  total!: number;

  @ApiProperty({ example: 1 })
  pagina!: number;

  @ApiProperty({ example: 50 })
  porPagina!: number;

  @ApiProperty({ example: 7 })
  totalPaginas!: number;

  @ApiProperty({ type: [TurmaImportadaDto] })
  itens!: TurmaImportadaDto[];
}

export class ImportacaoDaTurmaDto {
  @ApiProperty({ example: 8 })
  id!: number;

  @ApiProperty({ example: 'turmas-2026-1.csv' })
  nomeArquivo!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-08-04T12:39:02.000Z',
  })
  createdAt!: Date;
}

export class TurmaImportadaDetalheDto
  extends TurmaImportadaDto
  implements TurmaImportadaDetalhe
{
  @ApiPropertyOptional({
    type: ImportacaoDaTurmaDto,
    nullable: true,
    description: 'De qual upload esta turma veio.',
  })
  importacao!: ImportacaoDaTurmaDto | null;

  @ApiProperty({
    nullable: true,
    example: 42,
    description:
      'Agendamentos confirmados que cobrem esta disciplina. **Null — nao zero — ' +
      'quando o `orgUnitId` ainda nao foi aprendido**: sem ele nao ha como ' +
      'contar, e "0" faria parecer que ninguem marcou.',
  })
  totalAgendamentos!: number | null;
}
