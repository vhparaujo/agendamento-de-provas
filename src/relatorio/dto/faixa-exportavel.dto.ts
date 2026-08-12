import { ApiProperty } from '@nestjs/swagger';
import { FaixaExportavel } from '../service/relatorio.service';

export class FaixaExportavelDto implements FaixaExportavel {
  @ApiProperty({ example: 14 })
  faixaId!: number;

  @ApiProperty({ example: 6 })
  poloId!: number;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  polo!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-08-20' })
  data!: Date;

  @ApiProperty({ example: '08:30' })
  horaInicio!: string;

  @ApiProperty({ example: '11:30' })
  horaFim!: string;

  @ApiProperty({
    example: 52,
    description:
      'Matriculas DISTINTAS com prova confirmada nesta faixa, somando todas as ' +
      'salas. E a quantidade de linhas que o arquivo tera.',
  })
  totalAlunos!: number;

  @ApiProperty({
    example: '20-08-2026 08h30-11h30.csv',
    description:
      'Nome com que o arquivo desta faixa e baixado. O front usa este valor no ' +
      '`download` do link: resposta em blob nao expoe o `Content-Disposition`, e ' +
      'montar o nome no cliente deixaria a regra em dois lugares.',
  })
  nomeArquivo!: string;
}
