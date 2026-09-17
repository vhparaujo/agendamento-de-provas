import { ApiProperty } from '@nestjs/swagger';
import { SalaComLista } from '../service/lista-presenca.service';

/** Uma linha da tabela de listas de presenca: uma SALA de aplicacao. */
export class SalaComListaDto implements SalaComLista {
  @ApiProperty({
    example: 31,
    description:
      'A oferta (`SalaFaixa`). Identifica sala + horario + polo num id so, e ' +
      'e por ele que a folha avulsa e baixada.',
  })
  salaFaixaId!: number;

  @ApiProperty({ example: 14 })
  faixaId!: number;

  @ApiProperty({ example: 6 })
  poloId!: number;

  @ApiProperty({ example: 'Câmpus Asa Sul' })
  polo!: string;

  @ApiProperty({ example: 9 })
  salaId!: number;

  @ApiProperty({ example: 'SALA 1 EAD' })
  sala!: string;

  @ApiProperty({
    example: 'EaD',
    description:
      'Da OFERTA — o formato em que a sala esta travada nesta faixa. E a ' +
      'que aparece no cabecalho da folha; a coluna `Modalidade` da tabela sai ' +
      'do agendamento de cada aluno.',
  })
  modalidade!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-06-11' })
  data!: Date;

  @ApiProperty({ example: '09:00' })
  horaInicio!: string;

  @ApiProperty({ example: '12:00' })
  horaFim!: string;

  @ApiProperty({
    example: 40,
    description:
      'Capacidade da sala nesta faixa — o teto, nao o que sera impresso.',
  })
  vagas!: number;

  @ApiProperty({
    example: 3,
    description:
      'Agendamentos CONFIRMADOS nesta sala — as **linhas** da folha, nao ' +
      'pessoas distintas. Um RA com dois vinculos no mesmo formato ocupa ' +
      'duas vagas e assina duas vezes.',
  })
  totalAlunos!: number;

  @ApiProperty({
    example:
      'Lista de presenca - 11-06-2026 09h00-12h00 - Campus Asa Sul - SALA 1 EAD.pdf',
    description:
      'Nome com que a folha avulsa e baixada. O front usa este valor no ' +
      '`download` do link: resposta em blob nao expoe o `Content-Disposition`. ' +
      'Sai sem acento de proposito — ver `nome-de-arquivo.ts`.',
  })
  nomeArquivo!: string;
}
