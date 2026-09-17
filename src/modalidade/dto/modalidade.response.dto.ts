import { ApiProperty } from '@nestjs/swagger';
import type { Modalidade } from '../service/modalidade.service';

export class ModalidadeDto implements Modalidade {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({
    example: 'EAD',
    enum: ['EAD', 'SEMI', 'MODULAR', 'PRESENCIAL'],
    description:
      'Chave estavel usada no dropdown do upload de alunos. Modular e MODULAR.',
  })
  codigo!: string;

  @ApiProperty({ example: 'EaD', description: 'Rotulo para exibicao.' })
  nome!: string;

  @ApiProperty({
    example: 180,
    description:
      'Duracao da prova. A faixa precisa ser pelo menos deste tamanho para ' +
      'receber uma sala deste formato.',
  })
  duracaoMinutos!: number;

  @ApiProperty({
    example: 180,
    description:
      'O tempo do questionario gravado no special access de quem e deste ' +
      'formato. Nao muda a faixa. O aluno do NIOP recebe este valor mais o ' +
      'tempo extra configurado.',
  })
  tempoDeProvaMinutos!: number;
}
