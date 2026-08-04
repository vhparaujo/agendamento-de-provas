import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';
import type {
  AgendamentoAdmin,
  EventoDoHistorico,
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

export class RemanejarDto {
  @ApiPropertyOptional({
    example: 55,
    description:
      'Sala EXATA (id da SalaFaixa, de `GET /faixas/:id`). Use quando o admin ' +
      'escolhe a sala. Exclusivo com `faixaId`.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  salaFaixaId?: number;

  @ApiPropertyOptional({
    example: 14,
    description:
      'Outro horario, deixando a alocacao sequencial escolher a sala. ' +
      'Exclusivo com `salaFaixaId`.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  faixaId?: number;
}

export class MensagemDto {
  @ApiProperty({ example: 'Agendamento 501 cancelado. A vaga foi liberada.' })
  mensagem!: string;
}

export class EventoDoHistoricoDto implements EventoDoHistorico {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({
    example: 'TROCADO',
    enum: ['CRIADO', 'TROCADO', 'REMANEJADO', 'CANCELADO'],
    description:
      'TROCADO = o proprio aluno mudou de horario. REMANEJADO = um administrador moveu.',
  })
  evento!: string;

  @ApiProperty({
    example: 'ALUNO',
    enum: ['ALUNO', 'ADMIN'],
    description: 'QUEM fez — a resposta para "eu nao mudei nada".',
  })
  autorTipo!: string;

  @ApiProperty({
    example: 'UC25426847',
    description:
      'Matricula, quando foi o aluno; e-mail, quando foi o administrador.',
  })
  autor!: string;

  @ApiProperty({
    nullable: true,
    example: 'M114 · 20/08/2026 08:30-11:30',
    description: 'Situacao anterior, ja legivel.',
  })
  de!: string | null;

  @ApiProperty({
    nullable: true,
    example: 'LAB 203 · 21/08/2026 14:00-17:00',
    description: 'Situacao nova. Vazio num cancelamento.',
  })
  para!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  quando!: Date;
}
