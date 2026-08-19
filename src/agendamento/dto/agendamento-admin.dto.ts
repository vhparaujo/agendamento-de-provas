import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';
import type {
  AgendamentoAdmin,
  AgendamentoPeloAdmin,
  EventoDoHistorico,
  LinhaDoResumo,
  OrigemDasDisciplinas,
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

  @ApiProperty({
    example: 'SUB',
    description:
      'Qual prova do semestre — "N2" (regular), "SUB" (substitutiva).',
  })
  rodada!: string;

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

/**
 * O agendamento feito PELO ADMIN, em vez de pelo aluno.
 *
 * Os dois destinos sao os mesmos do remanejo — e de proposito: "o admin escolhe
 * a sala ou deixa a alocacao escolher" e uma pergunta so, e duas formas de
 * responde-la em dois formatos diferentes viraria duas telas que fazem a mesma
 * coisa de jeitos incompativeis.
 */
export class AgendarPeloAdminDto {
  @ApiProperty({
    example: 3120,
    description:
      'O VINCULO (aluno + curso), de `GET /alunos`. Nao e a matricula: um RA ' +
      'com dois cursos faz duas provas, e o id diz de qual delas se trata.',
  })
  @IsInt()
  @Min(1)
  alunoId!: number;

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
      'O horario, deixando a alocacao sequencial escolher a sala (enche a de ' +
      'menor `ordem` ate lotar). Exclusivo com `salaFaixaId`.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  faixaId?: number;

  /**
   * O `ativo` do vinculo diz "pode agendar" — e por padrao esta rota o respeita,
   * como o portal. Este campo e a decisao explicita de agendar assim mesmo.
   */
  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Agenda mesmo com a situacao do curso bloqueando (Trancado, Cancelado…). ' +
      'Sem ele a rota recusa com 409. A decisao fica registrada na auditoria e ' +
      'volta em `avisos`.',
  })
  @IsOptional()
  @IsBoolean()
  ignorarStatusCurso?: boolean;
}

export class AgendamentoPeloAdminDto implements AgendamentoPeloAdmin {
  @ApiProperty({ type: AgendamentoAdminDto })
  agendamento!: AgendamentoAdminDto;

  @ApiProperty({
    example: 'BRIGHTSPACE',
    enum: ['BRIGHTSPACE', 'RESERVA_ANTERIOR'],
    description:
      'De onde saiu a lista de disciplinas que esta prova cobre. ' +
      '`BRIGHTSPACE` = lidas agora na Valence. `RESERVA_ANTERIOR` = copiadas da ' +
      'reserva anterior do aluno neste semestre, porque a integracao nao ' +
      'respondeu (o motivo vem em `avisos`).',
  })
  origemDasDisciplinas!: OrigemDasDisciplinas;

  @ApiProperty({
    type: [String],
    example: [
      'A conta deste aluno esta DESATIVADA no Brightspace: do jeito que esta, ele nao conseguiria abrir a prova.',
    ],
    description:
      'O que a secretaria precisa saber, sem que nada disso tenha impedido o ' +
      'agendamento. Vazio quando nao ha ressalva.',
  })
  avisos!: string[];
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
