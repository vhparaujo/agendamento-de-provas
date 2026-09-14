import { ApiProperty } from '@nestjs/swagger';
import {
  DisciplinaDoPortalDto,
  ModalidadeDoPortalDto,
  PoloDoPortalDto,
  SalaDoPortalDto,
} from '../../agendamento/dto/portal.dto';
import type {
  AgendamentoIntegracao,
  AgendamentosDoAluno,
  PeriodoDoAgendamento,
  RecorteDoPeriodo,
  VinculoIntegracao,
} from '../service/integracao.service';

export class VinculoIntegracaoDto implements VinculoIntegracao {
  @ApiProperty({ example: 4821, description: 'Vinculo (aluno + curso).' })
  alunoId!: number;

  @ApiProperty({ example: 'SEGURANÇA DA INFORMAÇÃO' })
  curso!: string;

  @ApiProperty({
    example: 'Ativo',
    description: 'Valor bruto da coluna STATUS CURSO do CSV.',
  })
  statusCurso!: string;

  @ApiProperty({
    example: true,
    description:
      'Pode agendar? Derivado de `statusCurso` — hoje so "Ativo" agenda.',
  })
  ativo!: boolean;

  @ApiProperty({
    type: ModalidadeDoPortalDto,
    description: 'O formato do curso HOJE, segundo o ultimo CSV importado.',
  })
  modalidade!: ModalidadeDoPortalDto;

  @ApiProperty({
    type: PoloDoPortalDto,
    description:
      'O "Campus/Polo da Matricula" da tela do portal, segundo o ultimo CSV.',
  })
  polo!: PoloDoPortalDto;
}

export class PeriodoDoAgendamentoDto implements PeriodoDoAgendamento {
  @ApiProperty({ nullable: true, example: '2026/2 e 2026/1' })
  descricao!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dataAbertura!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  dataFechamento!: Date;

  @ApiProperty({
    example: true,
    description:
      '**So emita a declaracao com `true`.** Com o prazo aberto o aluno ainda ' +
      'troca de horario, e o documento afirmaria uma data que ele pode mudar. ' +
      'Toda janela que nao e a vigente vem `true`.',
  })
  prazoEncerrado!: boolean;
}

export class AgendamentoIntegracaoDto implements AgendamentoIntegracao {
  @ApiProperty({ example: 501 })
  id!: number;

  @ApiProperty({
    example: 4821,
    description:
      'De qual vinculo (curso) e a prova — casa com `vinculos[].alunoId`.',
  })
  alunoId!: number;

  @ApiProperty({ example: 'SEGURANÇA DA INFORMAÇÃO' })
  curso!: string;

  @ApiProperty({
    example: 'CONFIRMADO',
    enum: ['CONFIRMADO'],
    description: 'Canceladas nao sao devolvidas.',
  })
  status!: string;

  @ApiProperty({
    example: 'SUB',
    description:
      'Qual prova do semestre ("N2", "SUB"...). Texto livre no cadastro. A ' +
      'identidade da prova e o par `periodoLetivoId` + `rodada`.',
  })
  rodada!: string;

  @ApiProperty({
    example: 'Substitutiva (SUB)',
    description: 'A rodada por extenso; rodada desconhecida sai como veio.',
  })
  rodadaDescricao!: string;

  @ApiProperty({
    example: '12345',
    description: 'Org unit do Periodo Letivo no Brightspace.',
  })
  periodoLetivoId!: string;

  @ApiProperty({
    type: PeriodoDoAgendamentoDto,
    nullable: true,
    description:
      'A janela em que a prova foi marcada. `null` so em dado antigo cuja ' +
      'janela nao existe mais.',
  })
  periodo!: PeriodoDoAgendamentoDto | null;

  @ApiProperty({
    type: String,
    format: 'date',
    example: '2026-09-10',
    description: 'Dia da prova, AAAA-MM-DD — sem hora e sem fuso.',
  })
  data!: string;

  @ApiProperty({ example: '08:30', description: 'Horario de Brasilia.' })
  horaInicio!: string;

  @ApiProperty({ example: '11:30', description: 'Horario de Brasilia.' })
  horaFim!: string;

  @ApiProperty({
    type: ModalidadeDoPortalDto,
    description: 'O "Formato" da prova (modalidade e duracao).',
  })
  formato!: ModalidadeDoPortalDto;

  @ApiProperty({
    type: PoloDoPortalDto,
    description: 'Onde a prova ACONTECE (polo da faixa).',
  })
  polo!: PoloDoPortalDto;

  @ApiProperty({ type: SalaDoPortalDto })
  sala!: SalaDoPortalDto;

  @ApiProperty({
    type: [DisciplinaDoPortalDto],
    description: 'Todas as disciplinas cobertas por esta prova.',
  })
  disciplinas!: DisciplinaDoPortalDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Quando a reserva foi feita ("Agendamento realizado em").',
  })
  agendadoEm!: Date;

  @ApiProperty({
    example: false,
    description: 'A secretaria alocou ou remanejou esta prova.',
  })
  alocadoManual!: boolean;
}

export class FiltroDaConsultaDto {
  @ApiProperty({
    enum: ['atual'],
    nullable: true,
    example: null,
    description:
      'O recorte aplicado: `atual` = so a janela vigente; `null` = historico completo.',
  })
  periodo!: RecorteDoPeriodo;
}

export class AgendamentosDoAlunoDto implements AgendamentosDoAluno {
  @ApiProperty({ example: 'UC2642816' })
  matricula!: string;

  @ApiProperty({
    nullable: true,
    example: 'DARLYNG AGHATA MARIA PEREIRA',
    description:
      'Como veio no CSV de alunos. `null` quando a coluna veio vazia.',
  })
  nome!: string | null;

  @ApiProperty({ type: FiltroDaConsultaDto })
  filtro!: FiltroDaConsultaDto;

  @ApiProperty({
    type: [VinculoIntegracaoDto],
    description: 'Um por curso. Quem tem dois cursos faz uma prova para cada.',
  })
  vinculos!: VinculoIntegracaoDto[];

  @ApiProperty({
    type: [AgendamentoIntegracaoDto],
    description:
      'Provas confirmadas, da mais recente para a mais antiga. Vazia quando o ' +
      'aluno nao tem prova no recorte.',
  })
  agendamentos!: AgendamentoIntegracaoDto[];
}
