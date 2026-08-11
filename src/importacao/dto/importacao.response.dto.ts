import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  AlteracaoComAgendamento,
  LinhaRejeitada,
  Mudanca,
  ResultadoImportacaoAlunos,
} from '../service/importacao-alunos.service';
import type { ResultadoImportacaoTurmas } from '../service/importacao-turmas.service';

export class LinhaRejeitadaDto implements LinhaRejeitada {
  @ApiProperty({
    example: 42,
    description: 'Numero da linha no arquivo (1 = primeira apos o cabecalho).',
  })
  linha!: number;

  @ApiProperty({
    example: 'A06103080',
    description: 'RA da linha. Vazio quando o proprio RA foi o motivo.',
  })
  matricula!: string;

  @ApiProperty({
    example: 'MARIA DE SOUZA',
    description:
      'Coluna ALUNO, como veio no arquivo. Serve para achar a linha na planilha.',
  })
  nome!: string;

  @ApiProperty({ example: 'ADMINISTRACAO', description: 'Coluna CURSO.' })
  curso!: string;

  @ApiProperty({ example: 'Campus Ceilandia', description: 'Coluna CAMPUS.' })
  campus!: string;

  @ApiProperty({
    example: 'CAMPUS "Polo Inexistente" nao casou com nenhum polo',
  })
  motivo!: string;
}

export class StatusDesconhecidoDto {
  @ApiProperty({
    example: 'Reintegrado',
    description:
      'Grafia encontrada no arquivo que nao esta em nenhuma das duas listas de src/enums/status-curso.enum.ts.',
  })
  status!: string;

  @ApiProperty({ example: 3 })
  ocorrencias!: number;
}

export class PoloNaoEncontradoDto {
  @ApiProperty({
    example: 'Polo Novo - GO',
    description:
      'Valor de CAMPUS que nao casou com nenhum Polo.nome do seed. Corrija adicionando a linha em prisma/seed-polos.ts.',
  })
  campus!: string;

  @ApiProperty({ example: 17 })
  ocorrencias!: number;
}

export class MudancaDto implements Mudanca {
  @ApiProperty({ example: 'EaD', description: 'Valor anterior.' })
  de!: string;

  @ApiProperty({ example: 'Modular', description: 'Valor gravado agora.' })
  para!: string;
}

/**
 * Um vinculo que JA TINHA PROVA MARCADA e mudou de modalidade ou de polo.
 *
 * A reserva continua apontando para a sala antiga — prova de outra duracao, ou
 * em outro campus — e nada mais no sistema reclama. O aviso existe porque o
 * sintoma so aparece dias depois e disfarcado: o remanejo passa a ser recusado
 * com "esta sala nao e da modalidade do aluno".
 */
export class AlteracaoComAgendamentoDto implements AlteracaoComAgendamento {
  @ApiProperty({
    example: 128,
    description: 'Numero da linha no arquivo (1 = primeira apos o cabecalho).',
  })
  linha!: number;

  @ApiProperty({ example: 'UC24424289' })
  matricula!: string;

  @ApiProperty({ example: 'MONICA RIBEIRO MARQUES' })
  nome!: string;

  @ApiProperty({ example: 'PEDAGOGIA' })
  curso!: string;

  @ApiPropertyOptional({
    type: MudancaDto,
    description:
      'Presente so quando a modalidade mudou. A prova marcada passa a ter outra ' +
      'duracao que a da sala em que o aluno esta alocado.',
  })
  modalidade?: MudancaDto;

  @ApiPropertyOptional({
    type: MudancaDto,
    description:
      'Presente so quando o polo mudou. A prova marcada continua no campus anterior.',
  })
  polo?: MudancaDto;

  @ApiProperty({
    example: 1,
    description:
      'Reservas confirmadas do vinculo. Conta so o semestre vigente quando ha ' +
      'periodo cadastrado — prova de semestre passado ja aconteceu.',
  })
  agendamentosConfirmados!: number;
}

/**
 * Alem dos numeros, a resposta destaca tudo que precisa de decisao humana:
 * linhas rejeitadas, status nunca vistos, polos que nao casaram e trocas que
 * mexeram em quem ja tem prova marcada.
 */
export class ResultadoImportacaoAlunosDto implements ResultadoImportacaoAlunos {
  @ApiProperty({ example: 7, description: 'Id do registro de auditoria.' })
  importacaoId!: number;

  @ApiProperty({ example: 'alunos-ead-2026-1.csv' })
  arquivo!: string;

  @ApiProperty({ example: 'EAD' })
  modalidade!: string;

  @ApiProperty({ example: 4312 })
  totalLinhas!: number;

  @ApiProperty({ example: 4102 })
  criados!: number;

  @ApiProperty({
    example: 198,
    description: 'Reenviar o mesmo arquivo atualiza; nunca duplica.',
  })
  atualizados!: number;

  @ApiProperty({
    example: 4008,
    description: 'Vinculos gravados cujo STATUS CURSO permite agendar.',
  })
  podemAgendar!: number;

  @ApiProperty({ example: 292 })
  bloqueados!: number;

  @ApiProperty({ type: [LinhaRejeitadaDto] })
  rejeitadas!: LinhaRejeitadaDto[];

  @ApiProperty({
    type: [StatusDesconhecidoDto],
    description: 'Status fora das listas conhecidas — bloqueiam por seguranca.',
  })
  statusDesconhecidos!: StatusDesconhecidoDto[];

  @ApiProperty({ type: [PoloNaoEncontradoDto] })
  polosNaoEncontrados!: PoloNaoEncontradoDto[];

  @ApiProperty({
    type: [AlteracaoComAgendamentoDto],
    description:
      'Vinculos COM PROVA MARCADA cuja modalidade ou polo mudaram nesta ' +
      'importacao. Nao bloqueia o upload — a planilha e a fonte de verdade e ' +
      'pode estar corrigindo um cadastro errado —, mas cada linha aqui pede ' +
      'decisao: remanejar a reserva ou cancela-la.',
  })
  alteracoesComAgendamento!: AlteracaoComAgendamentoDto[];
}

export class TurmaRejeitadaDto {
  @ApiProperty({
    example: 12,
    description: 'Numero da linha no arquivo (1 = primeira apos o cabecalho).',
  })
  linha!: number;

  @ApiProperty({
    example: 'OrgUnitId vazio — sem ele a linha nao identifica turma nenhuma',
  })
  motivo!: string;
}

export class ResultadoImportacaoTurmasDto implements ResultadoImportacaoTurmas {
  @ApiProperty({ example: 8, description: 'Id do registro de auditoria.' })
  importacaoId!: number;

  @ApiProperty({ example: 'turmas-2026-1.csv' })
  arquivo!: string;

  @ApiProperty({ example: 320 })
  totalLinhas!: number;

  @ApiProperty({ example: 318 })
  criadas!: number;

  @ApiProperty({
    example: 0,
    description: 'Reenviar o mesmo arquivo atualiza; nunca duplica.',
  })
  atualizadas!: number;

  @ApiProperty({ type: [TurmaRejeitadaDto] })
  rejeitadas!: TurmaRejeitadaDto[];
}

/** Uma entrada do historico de importacoes. */
export class ImportacaoCsvDto {
  @ApiProperty({ example: 7 })
  id!: number;

  @ApiProperty({ enum: ['ALUNOS', 'SALAS', 'TURMAS'], example: 'ALUNOS' })
  tipo!: string;

  @ApiProperty({ example: 'alunos-ead-2026-1.csv' })
  nomeArquivo!: string;

  @ApiProperty({ example: 4312 })
  totalLinhas!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 'admin@ucb.br',
    description: 'E-mail do admin que subiu o arquivo.',
  })
  importadoPor!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-30T14:11:57.000Z',
  })
  createdAt!: Date;
}
