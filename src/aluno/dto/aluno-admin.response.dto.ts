import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  AgendamentoDoAluno,
  AlunoImportadoDetalhe,
  AlunoImportadoResumo,
  PaginaDeAlunos,
} from '../service/aluno-admin.service';

export class AlunoImportadoDto implements AlunoImportadoResumo {
  @ApiProperty({ example: 3187, description: 'Id do vinculo (aluno + curso).' })
  id!: number;

  @ApiProperty({
    example: 'UC24424289',
    description: 'RA. Alfanumerico — zeros a esquerda fazem parte dele.',
  })
  matricula!: string;

  @ApiProperty({ nullable: true, example: 'MONICA RIBEIRO MARQUES' })
  nome!: string | null;

  @ApiProperty({
    nullable: true,
    example: 'monica.marques@aluno.ucb.br',
    description: 'E-mail institucional. Vazio em parte das linhas do CSV.',
  })
  email!: string | null;

  @ApiProperty({ example: 'PEDAGOGIA' })
  curso!: string;

  @ApiProperty({
    example: 'Ativo',
    description: 'Valor bruto da coluna STATUS CURSO, como veio na planilha.',
  })
  statusCurso!: string;

  @ApiProperty({
    example: true,
    description:
      'Se este vinculo PODE AGENDAR. Derivado de `statusCurso` pela lista de ' +
      'src/enums/status-curso.enum.ts — nao e o mesmo que STATUS CURSO == "Ativo".',
  })
  ativo!: boolean;

  @ApiProperty({ example: 'EaD' })
  modalidade!: string;

  @ApiProperty({ example: 'Câmpus Ceilândia' })
  polo!: string;

  @ApiProperty({
    example: 1,
    description:
      'Agendamentos CONFIRMADOS deste vinculo. 0 = ainda nao marcou prova.',
  })
  totalAgendamentos!: number;
}

export class PaginaDeAlunosDto implements PaginaDeAlunos {
  @ApiProperty({
    example: 7519,
    description: 'Vinculos que casam com o filtro.',
  })
  total!: number;

  @ApiProperty({ example: 1 })
  pagina!: number;

  @ApiProperty({ example: 50 })
  porPagina!: number;

  @ApiProperty({ example: 151 })
  totalPaginas!: number;

  @ApiProperty({ type: [AlunoImportadoDto] })
  itens!: AlunoImportadoDto[];
}

export class AgendamentoDoAlunoDto implements AgendamentoDoAluno {
  @ApiProperty({ example: 501 })
  id!: number;

  @ApiProperty({
    type: String,
    format: 'date',
    example: '2026-08-20',
    description: 'Data da prova.',
  })
  data!: Date;

  @ApiProperty({ example: '08:30' })
  horaInicio!: string;

  @ApiProperty({ example: '11:30' })
  horaFim!: string;

  @ApiProperty({ example: 'M114' })
  sala!: string;

  @ApiProperty({ example: 'Câmpus Ceilândia' })
  polo!: string;

  @ApiProperty({ enum: ['CONFIRMADO', 'CANCELADO'], example: 'CONFIRMADO' })
  status!: string;

  @ApiProperty({ example: '103' })
  periodoLetivoId!: string;
}

export class ImportacaoDeOrigemDto {
  @ApiProperty({ example: 7 })
  id!: number;

  @ApiProperty({ example: 'alunos-ead-2026-1.csv' })
  nomeArquivo!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-30T14:11:57.000Z',
  })
  createdAt!: Date;
}

export class OutroVinculoDto {
  @ApiProperty({ example: 3188 })
  id!: number;

  @ApiProperty({ example: 'PSICOLOGIA' })
  curso!: string;

  @ApiProperty({
    example: 'Modular',
    description: 'Pode ser diferente da modalidade deste vinculo.',
  })
  modalidade!: string;
}

export class AlunoImportadoDetalheDto
  extends AlunoImportadoDto
  implements AlunoImportadoDetalhe
{
  @ApiPropertyOptional({
    type: ImportacaoDeOrigemDto,
    nullable: true,
    description: 'De qual upload este vinculo veio.',
  })
  importacao!: ImportacaoDeOrigemDto | null;

  @ApiProperty({
    type: [OutroVinculoDto],
    description:
      'Os outros vinculos da MESMA matricula. Um RA em dois cursos agenda duas ' +
      'provas, com duracoes possivelmente diferentes.',
  })
  outrosVinculos!: OutroVinculoDto[];

  @ApiProperty({
    type: [AgendamentoDoAlunoDto],
    description:
      'Provas marcadas por este vinculo, incluindo as CANCELADAS — no ' +
      'atendimento, "cancelou dia 12" e uma resposta; sumir nao e.',
  })
  agendamentos!: AgendamentoDoAlunoDto[];
}
