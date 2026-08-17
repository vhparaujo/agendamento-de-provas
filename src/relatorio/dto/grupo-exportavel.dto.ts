import { ApiProperty } from '@nestjs/swagger';
import { GrupoExportavel } from '../service/relatorio.service';

/** Uma linha da aba Relatorios: um horario de prova de UMA turma. */
export class GrupoExportavelDto implements GrupoExportavel {
  @ApiProperty({
    example: 14,
    description:
      'Uma das faixas que servem esta janela — a de menor id —, usada como ' +
      '**handle** na rota de download. Nao e o recorte do grupo: quando dois ' +
      'campi aplicam a mesma prova no mesmo dia e horario, as duas faixas ' +
      'devolvem o mesmo arquivo, com os alunos dos dois.',
  })
  faixaId!: number;

  @ApiProperty({
    example: '445566',
    description:
      'A disciplina no Brightspace (`course offering`). E dentro dela que o ' +
      'grupo e criado, e por isso ela faz parte da identidade do arquivo.',
  })
  orgUnitId!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-08-20' })
  data!: Date;

  @ApiProperty({ example: '08:30' })
  horaInicio!: string;

  @ApiProperty({ example: '11:30' })
  horaFim!: string;

  @ApiProperty({
    type: [String],
    example: ['Câmpus Asa Norte', 'Câmpus Taguatinga'],
    description:
      'Os campi que aplicam esta prova, em ordem alfabetica — quase sempre um ' +
      'so. E **informativo**: o grupo libera o quiz num horario, e onde a ' +
      'pessoa senta nao muda o acesso, entao o arquivo leva os alunos de todos ' +
      'eles. Filtrar por `poloId` estreita quais linhas aparecem aqui, nunca ' +
      'quem entra no arquivo.',
  })
  polos!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'GSPS0I10227',
    description:
      'Codigo do CSV de turmas, encontrado pelo `orgUnitId`. Vem `null` ' +
      'enquanto nenhum aluno daquela turma tiver entrado pelo LTI — e o launch ' +
      'que ensina o `orgUnitId` ao sistema.',
  })
  codigoTurma!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
  })
  nomeDisciplina!: string | null;

  @ApiProperty({
    example: 52,
    description:
      'Matriculas DISTINTAS com prova confirmada nesta janela **e** nesta ' +
      'turma, somando todas as salas de todos os polos que aplicam a prova ' +
      'neste dia e horario. E a quantidade de linhas que o arquivo tera.',
  })
  totalAlunos!: number;

  @ApiProperty({
    example: '20-08-2026 08h30-11h30 - GSPS0I10227 - HISTORIA E CULTURA.csv',
    description:
      'Nome com que o arquivo e baixado avulso. O front usa este valor no ' +
      '`download` do link: resposta em blob nao expoe o `Content-Disposition`, e ' +
      'montar o nome no cliente deixaria a regra em dois lugares. Sai sem ' +
      'acento de proposito — ver `nome-de-arquivo.ts`.',
  })
  nomeArquivo!: string;
}
