import { ApiProperty } from '@nestjs/swagger';
import type {
  AgendamentoAdmin,
  LinhaDoResumo,
  PaginaDeAgendamentos,
} from '../service/agendamento-admin.service';

class DisciplinaDoRelatorioDto {
  @ApiProperty({ example: '6606', description: 'orgUnitId da turma no D2L.' })
  orgUnitId!: string;

  @ApiProperty({ nullable: true, example: 'Psicologia Geral' })
  nomeDisciplina!: string | null;
}

export class AgendamentoAdminDto implements AgendamentoAdmin {
  @ApiProperty({ example: 501 })
  id!: number;

  @ApiProperty({ example: 'UC25426847' })
  matricula!: string;

  @ApiProperty({ nullable: true, example: 'DEBORA GEMIMA SILVA' })
  nome!: string | null;

  @ApiProperty({ nullable: true, example: 'debora@aluno.ucb.br' })
  email!: string | null;

  @ApiProperty({ example: 'NUTRIÇÃO' })
  curso!: string;

  @ApiProperty({
    example: 'Ativo',
    description: 'Valor bruto do CSV, como estava quando o aluno agendou.',
  })
  statusCurso!: string;

  @ApiProperty({ example: 'EaD' })
  modalidade!: string;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  polo!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-08-20' })
  data!: Date;

  @ApiProperty({ example: '08:30' })
  horaInicio!: string;

  @ApiProperty({ example: '11:30' })
  horaFim!: string;

  @ApiProperty({ example: 'M114', description: 'Sala definida pela alocacao.' })
  sala!: string;

  @ApiProperty({ example: 'CONFIRMADO', enum: ['CONFIRMADO', 'CANCELADO'] })
  status!: string;

  @ApiProperty({
    example: false,
    description:
      'true quando um admin remanejou, em vez da alocacao automatica.',
  })
  alocadoManual!: boolean;

  @ApiProperty({ example: '103' })
  periodoLetivoId!: string;

  @ApiProperty({ type: [DisciplinaDoRelatorioDto] })
  disciplinas!: DisciplinaDoRelatorioDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Quando o aluno confirmou — responde "quem chegou primeiro".',
  })
  criadoEm!: Date;
}

export class PaginaDeAgendamentosDto implements PaginaDeAgendamentos {
  @ApiProperty({ example: 412, description: 'Total que satisfaz o filtro.' })
  total!: number;

  @ApiProperty({ example: 1 })
  pagina!: number;

  @ApiProperty({ example: 50, description: 'Maximo 200 por pagina.' })
  porPagina!: number;

  @ApiProperty({ example: 9 })
  totalPaginas!: number;

  @ApiProperty({ type: [AgendamentoAdminDto] })
  itens!: AgendamentoAdminDto[];
}

export class LinhaDoResumoDto implements LinhaDoResumo {
  @ApiProperty({ example: 6 })
  poloId!: number;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  polo!: string;

  @ApiProperty({ example: 14 })
  faixaId!: number;

  @ApiProperty({ type: String, format: 'date', example: '2026-08-20' })
  data!: Date;

  @ApiProperty({ example: '08:30' })
  horaInicio!: string;

  @ApiProperty({ example: '11:30' })
  horaFim!: string;

  @ApiProperty({ example: 21 })
  salaId!: number;

  @ApiProperty({ example: 'M114' })
  sala!: string;

  @ApiProperty({ example: 'EaD' })
  modalidade!: string;

  @ApiProperty({ example: 40 })
  vagas!: number;

  @ApiProperty({ example: 40, description: 'Agendamentos confirmados.' })
  ocupadas!: number;

  @ApiProperty({
    example: 0,
    description: 'Sala com `ocupadas: 0` nem precisa ser aberta no dia.',
  })
  disponiveis!: number;
}
