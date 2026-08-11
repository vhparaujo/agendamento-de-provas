import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  LinhaRejeitada,
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

/**
 * Alem dos numeros, a resposta destaca tudo que precisa de decisao humana:
 * linhas rejeitadas, status nunca vistos e polos que nao casaram.
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
