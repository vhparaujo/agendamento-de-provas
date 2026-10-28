import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  PaginaDeTurmas,
  ResultadoRenomeacao,
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

  @ApiProperty({
    nullable: true,
    example: 'SAUDE COLET.',
    description:
      'Como a planilha chama esta turma, quando ela foi renomeada pela tela. ' +
      'Null = nunca renomeada. E por ele que a reimportacao reconhece a turma ' +
      'em vez de criar outra.',
  })
  nomeNaPlanilha!: string | null;
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

export class RemocaoTurmaDto {
  @ApiProperty({
    example:
      'Turma "GEG09I30108 — LIDERANCA GESTAO DE CONFLITOS E NEGOCIACAO" ' +
      'removida do catalogo. Tire a linha da planilha tambem: o proximo upload ' +
      'do CSV a traria de volta.',
    description:
      'O aviso sobre a planilha faz parte da resposta de proposito: a remocao ' +
      'so dura ate o proximo upload se a linha continuar no CSV.',
  })
  mensagem!: string;
}

export class RenomeacaoTurmaDto implements ResultadoRenomeacao {
  @ApiProperty({
    example:
      'Turma "GSPS0I10227" renomeada de "SAUDE COLET." para "SAUDE COLETIVA", ' +
      'e 42 agendamento(s) confirmado(s) passaram a mostrar o nome novo.',
  })
  mensagem!: string;

  @ApiProperty({ type: TurmaImportadaDto })
  turma!: TurmaImportadaDto;

  @ApiProperty({
    example: 42,
    description:
      'Agendamentos confirmados desta disciplina que passaram a mostrar o nome ' +
      'novo. Cancelados e relatorios de execucao ficam com o nome antigo.',
  })
  agendamentosAtualizados!: number;
}
