import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';
import type { SituacaoPeriodo } from '../../periodo/service/periodo.service';
import type {
  AgendamentoConfirmado,
  DisciplinasDoVinculo,
  FaixaDisponivel,
} from '../service/agendamento.service';

const DESCRICAO_ALUNO_ID =
  'Qual vinculo (curso) — vem em `vinculos[].alunoId` na resposta do launch. ' +
  'Pode ser omitido por quem tem um curso so.';

export class AgendarDto {
  @ApiProperty({
    example: 14,
    description: 'Horario escolhido (`faixaId` de GET /portal/faixas).',
  })
  @IsInt()
  @Min(1)
  faixaId!: number;

  @ApiPropertyOptional({ example: 4821, description: DESCRICAO_ALUNO_ID })
  @IsOptional()
  @IsInt()
  @Min(1)
  alunoId?: number;
}

export class MensagemPortalDto {
  @ApiProperty({
    example:
      'Agendamento cancelado. A vaga voltou a ficar disponivel — escolha outro horario enquanto o prazo estiver aberto.',
  })
  mensagem!: string;
}

export class TrocarHorarioDto {
  @ApiProperty({
    example: 21,
    description:
      'O novo horario. A troca e atomica: se o horario novo nao tiver vaga, ' +
      'voce continua com o que ja tinha.',
  })
  @IsInt()
  @Min(1)
  faixaId!: number;
}

class PoloDoPortalDto {
  @ApiProperty({ example: 6 })
  id!: number;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  nome!: string;
}

class SalaDoPortalDto {
  @ApiProperty({ example: 21 })
  id!: number;

  @ApiProperty({ example: 'M114' })
  nome!: string;
}

class ModalidadeDoPortalDto {
  @ApiProperty({
    example: 'EAD',
    enum: ['EAD', 'SEMI', 'MODULAR', 'PRESENCIAL'],
  })
  codigo!: string;

  @ApiProperty({ example: 'EaD' })
  nome!: string;

  @ApiProperty({ example: 180, description: 'Duracao da prova em minutos.' })
  duracaoMinutos!: number;
}

class DisciplinaDoPortalDto {
  @ApiProperty({
    example: '6606',
    description: 'orgUnitId da turma no D2L.',
  })
  orgUnitId!: string;

  @ApiProperty({ nullable: true, example: 'Psicologia Geral' })
  nomeDisciplina!: string | null;
}

export class FaixaDisponivelDto implements FaixaDisponivel {
  @ApiProperty({
    example: 14,
    description: 'E este id que vai no POST /portal/agendamentos.',
  })
  faixaId!: number;

  @ApiProperty({ type: String, format: 'date', example: '2026-08-20' })
  data!: Date;

  @ApiProperty({ example: '08:30' })
  horaInicio!: string;

  @ApiProperty({ example: '11:30' })
  horaFim!: string;

  @ApiProperty({ example: 180, description: 'Tamanho da janela, em minutos.' })
  duracaoMinutos!: number;

  @ApiProperty({ type: PoloDoPortalDto })
  polo!: PoloDoPortalDto;

  @ApiProperty({
    example: 50,
    description: 'Total ofertado neste horario para a modalidade do aluno.',
  })
  vagas!: number;

  @ApiProperty({
    example: 12,
    description: 'Vagas ainda livres, somando todas as salas do horario.',
  })
  disponiveis!: number;

  @ApiProperty({
    example: true,
    description:
      'Horario lotado continua na lista com `false`, para nao sumir sem explicacao.',
  })
  temVaga!: boolean;
}

export class AgendamentoConfirmadoDto implements AgendamentoConfirmado {
  @ApiProperty({ example: 501 })
  id!: number;

  @ApiProperty({ example: 4821, description: 'Vinculo (aluno + curso).' })
  alunoId!: number;

  @ApiProperty({ example: 'UC25426847' })
  matricula!: string;

  @ApiProperty({ example: 'PEDAGOGIA' })
  curso!: string;

  @ApiProperty({ example: 'CONFIRMADO', enum: ['CONFIRMADO', 'CANCELADO'] })
  status!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-08-20' })
  data!: Date;

  @ApiProperty({ example: '08:30' })
  horaInicio!: string;

  @ApiProperty({ example: '11:30' })
  horaFim!: string;

  @ApiProperty({ type: PoloDoPortalDto })
  polo!: PoloDoPortalDto;

  @ApiProperty({
    type: SalaDoPortalDto,
    description: 'Definida pela alocacao no momento da confirmacao.',
  })
  sala!: SalaDoPortalDto;

  @ApiProperty({ type: ModalidadeDoPortalDto })
  modalidade!: ModalidadeDoPortalDto;

  @ApiProperty({
    type: [DisciplinaDoPortalDto],
    description: 'Todas as disciplinas cobertas por esta reserva.',
  })
  disciplinas!: DisciplinaDoPortalDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  criadoEm!: Date;
}

export class DisciplinasAgendaveisDto implements DisciplinasDoVinculo {
  @ApiProperty({ example: 4821 })
  alunoId!: number;

  @ApiProperty({ example: 'PEDAGOGIA' })
  curso!: string;

  @ApiProperty({ type: [DisciplinaDoPortalDto] })
  disciplinas!: DisciplinaDoPortalDto[];

  @ApiProperty({
    example: true,
    description:
      'false quando a situacao no curso barra, ou nao ha disciplina com prova.',
  })
  podeAgendar!: boolean;

  @ApiPropertyOptional({
    example:
      'Nenhuma disciplina sua tem prova cadastrada neste periodo. Se voce tem prova, procure a secretaria academica.',
    description: 'Texto pronto para exibir quando `podeAgendar` for false.',
  })
  motivo?: string;
}

export class SituacaoPeriodoDto implements SituacaoPeriodo {
  @ApiProperty({ example: true })
  aberto!: boolean;

  @ApiPropertyOptional({
    example: '103',
    description: 'Id do periodo letivo no Brightspace.',
  })
  periodoLetivoId?: string;

  @ApiPropertyOptional({ nullable: true, example: '2026/2 — provas finais' })
  descricao?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  dataAbertura?: Date | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'O agendamento fecha por esta data/hora — nunca por vaga esgotada.',
  })
  dataFechamento?: Date;

  @ApiPropertyOptional({
    example: 'O prazo de agendamento encerrou em 18/08/2026 23:59.',
    description: 'Texto pronto para exibir. Ausente quando aberto.',
  })
  motivo?: string;
}
