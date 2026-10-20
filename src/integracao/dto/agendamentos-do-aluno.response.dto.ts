import { ApiProperty } from '@nestjs/swagger';
import {
  DisciplinaDoPortalDto,
  ModalidadeDoPortalDto,
  PoloDoPortalDto,
  SalaDoPortalDto,
} from '../../agendamento/dto/portal.dto';
import type {
  AgendamentoDaListaIntegracao,
  AgendamentoIntegracao,
  AgendamentosDoAluno,
  DisciplinaIntegracao,
  FiltroAplicado,
  PaginaDeAgendamentosIntegracao,
  PeriodoIntegracao,
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

export class PeriodoIntegracaoDto implements PeriodoIntegracao {
  @ApiProperty({
    example: 12,
    description: 'Id da janela — o `periodoId` de cada prova aponta para ca.',
  })
  id!: number;

  @ApiProperty({
    example: 'SUB',
    description:
      'Qual prova do semestre ("N2", "SUB"...). Texto livre no cadastro.',
  })
  rodada!: string;

  @ApiProperty({
    example: 'Substitutiva (SUB)',
    description: 'A rodada por extenso; rodada desconhecida sai como veio.',
  })
  rodadaDescricao!: string;

  @ApiProperty({ nullable: true, example: '2026/2 e 2026/1' })
  descricao!: string | null;

  @ApiProperty({
    type: [String],
    example: ['142286', '142290'],
    description:
      'Os periodos letivos que a janela cobre: o do modulo (EaD, Semi, ' +
      'Modular) e o do semestre (Presencial).',
  })
  periodoLetivoIds!: string[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dataAbertura!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  dataFechamento!: Date;

  @ApiProperty({
    example: true,
    description:
      '**So emita a declaracao de prova desta janela com `true`.** Com o ' +
      'prazo aberto o aluno ainda troca de horario, e o documento afirmaria ' +
      'uma data que ele pode mudar. Toda janela que nao e a vigente vem `true`.',
  })
  prazoEncerrado!: boolean;
}

export class DisciplinaIntegracaoDto
  extends DisciplinaDoPortalDto
  implements DisciplinaIntegracao
{
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'GSPS0I10227',
    description:
      'Codigo da turma, do CSV de turmas. `null` quando a turma nao esta la.',
  })
  codigoTurma!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'GSPS02EAD003',
    description:
      'Codigo da disciplina, do CSV de turmas. `null` quando a turma nao esta ' +
      'la ou o CSV nao trouxe o codigo.',
  })
  codigoDisciplina!: string | null;
}

export class AgendamentoIntegracaoDto implements AgendamentoIntegracao {
  @ApiProperty({ example: 501 })
  id!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12,
    description:
      'A janela da prova, em `periodos[]` — e la que estao rodada, datas e ' +
      '`prazoEncerrado`. `null` so em dado antigo cuja janela nao existe mais.',
  })
  periodoId!: number | null;

  @ApiProperty({
    example: 4821,
    description:
      'De qual vinculo (curso) e a prova — casa com `vinculos[].alunoId` na ' +
      'consulta por RA.',
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
    example: '142286',
    description:
      'Org unit do Periodo Letivo no Brightspace, do formato DESTE aluno — na ' +
      'mesma janela, EaD e Presencial tem ids diferentes.',
  })
  periodoLetivoId!: string;

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
    description: 'O formato da prova e a sua duracao.',
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
    type: [DisciplinaIntegracaoDto],
    description: 'Todas as disciplinas cobertas por esta prova.',
  })
  disciplinas!: DisciplinaIntegracaoDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Quando a reserva foi feita ("Agendamento realizado em").',
  })
  agendadoEm!: Date;

  @ApiProperty({
    example: false,
    description: 'A administracao alocou ou remanejou esta prova.',
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
    type: [PeriodoIntegracaoDto],
    description:
      'As janelas em que este RA tem prova, da mais recente para a mais ' +
      'antiga — uma vez so, e nao repetidas em cada prova.',
  })
  periodos!: PeriodoIntegracaoDto[];

  @ApiProperty({
    type: [AgendamentoIntegracaoDto],
    description:
      'Provas confirmadas, da mais recente para a mais antiga. Vazia quando o ' +
      'aluno nao tem prova no recorte.',
  })
  agendamentos!: AgendamentoIntegracaoDto[];
}

export class AgendamentoDaListaIntegracaoDto
  extends AgendamentoIntegracaoDto
  implements AgendamentoDaListaIntegracao
{
  @ApiProperty({ example: 'UC2642816' })
  matricula!: string;

  @ApiProperty({
    nullable: true,
    example: 'DARLYNG AGHATA MARIA PEREIRA',
    description:
      'Do vinculo da prova, como veio no CSV. `null` quando a coluna veio vazia.',
  })
  nome!: string | null;
}

export class FiltroAplicadoDto implements FiltroAplicado {
  @ApiProperty({
    enum: ['atual'],
    nullable: true,
    example: 'atual',
    description:
      '`atual` = a janela vigente; `null` = o periodo letivo informado na URL.',
  })
  periodo!: 'atual' | null;

  @ApiProperty({
    type: [String],
    example: ['12345', '12346'],
    description:
      'Os periodos letivos efetivamente consultados. No `atual`, os da janela ' +
      'vigente (as duas grades); vazio quando nao ha janela cadastrada.',
  })
  periodoLetivoIds!: string[];

  @ApiProperty({
    nullable: true,
    example: 'SUB',
    description:
      'A rodada consultada. `null` = todas as rodadas do periodo letivo.',
  })
  rodada!: string | null;
}

export class PaginaDeAgendamentosIntegracaoDto implements PaginaDeAgendamentosIntegracao {
  @ApiProperty({ type: FiltroAplicadoDto })
  filtro!: FiltroAplicadoDto;

  @ApiProperty({
    type: [PeriodoIntegracaoDto],
    description:
      'As janelas do recorte, uma vez so — iguais em todas as paginas. No ' +
      '`atual`, so a vigente. **So emita declaracao de prova cuja janela tenha ' +
      '`prazoEncerrado: true`.**',
  })
  periodos!: PeriodoIntegracaoDto[];

  @ApiProperty({ example: 6812, description: 'Total que satisfaz o filtro.' })
  total!: number;

  @ApiProperty({ example: 1 })
  pagina!: number;

  @ApiProperty({ example: 100, description: 'Maximo 500 por pagina.' })
  porPagina!: number;

  @ApiProperty({ example: 69 })
  totalPaginas!: number;

  @ApiProperty({
    type: [AgendamentoDaListaIntegracaoDto],
    description:
      'Provas confirmadas, por data, horario e matricula. Vazia fora do ' +
      'intervalo de paginas.',
  })
  itens!: AgendamentoDaListaIntegracaoDto[];
}
