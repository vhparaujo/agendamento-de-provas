import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PADRAO_HORA } from '../../components/horario.util';
import type { FaixaDetalhe, OfertaResumo } from '../service/faixa.service';

const MSG_HORA = 'Use o formato HH:MM em 24h (ex: 08:30)';

export class SalaDaFaixaDto {
  @ApiProperty({
    example: 21,
    description: 'Id da sala (GET /salas?poloId=...).',
  })
  @IsInt()
  @Min(1)
  salaId!: number;

  @ApiProperty({
    example: 1,
    description:
      'Formato desta sala NESTA faixa. A mesma sala pode ser Presencial numa ' +
      'faixa e EaD em outra — mas dentro de uma faixa fica travada nesta.',
  })
  @IsInt()
  @Min(1)
  modalidadeId!: number;

  @ApiPropertyOptional({
    example: 40,
    minimum: 1,
    description: 'Padrao: a capacidade da sala. Nao pode passar dela.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  vagas?: number;

  @ApiPropertyOptional({
    example: 1,
    minimum: 1,
    description:
      'Sequencia de preenchimento dentro de faixa+formato: a alocacao enche a ' +
      'de menor ordem antes de usar a proxima. Omitido, segue a ordem em que as ' +
      'salas vierem na lista.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  ordem?: number;
}

export class CriarFaixaDto {
  @ApiProperty({ example: 6, description: 'Polo onde a prova acontece.' })
  @IsInt()
  @Min(1)
  poloId!: number;

  @ApiProperty({
    example: '2026-08-20',
    format: 'date',
    description:
      'Dia da PROVA (AAAA-MM-DD). Independe da janela de agendamento, que e ' +
      'controlada pelo periodo.',
  })
  @IsISO8601(
    { strict: true },
    { message: 'data deve estar no formato AAAA-MM-DD' },
  )
  data!: string;

  @ApiProperty({ example: '08:30', description: MSG_HORA })
  @Matches(PADRAO_HORA, { message: `horaInicio: ${MSG_HORA}` })
  horaInicio!: string;

  @ApiProperty({
    example: '11:30',
    description: `${MSG_HORA}. A janela precisa comportar a prova mais longa ofertada nela.`,
  })
  @Matches(PADRAO_HORA, { message: `horaFim: ${MSG_HORA}` })
  horaFim!: string;

  @ApiProperty({
    type: [SalaDaFaixaDto],
    description:
      'As salas que atendem esta faixa, com o formato de cada uma. Faixa sem ' +
      'sala nao aparece para aluno nenhum, por isso ao menos uma e obrigatoria.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'informe ao menos uma sala' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SalaDaFaixaDto)
  salas!: SalaDaFaixaDto[];
}

export class AtualizarFaixaDto {
  @ApiPropertyOptional({ example: '2026-08-21', format: 'date' })
  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'data deve estar no formato AAAA-MM-DD' },
  )
  data?: string;

  @ApiPropertyOptional({ example: '09:00', description: MSG_HORA })
  @IsOptional()
  @Matches(PADRAO_HORA, { message: `horaInicio: ${MSG_HORA}` })
  horaInicio?: string;

  @ApiPropertyOptional({
    example: '12:00',
    description: `${MSG_HORA}. Encurtar a janela e recusado se ja houver oferta que nao caiba.`,
  })
  @IsOptional()
  @Matches(PADRAO_HORA, { message: `horaFim: ${MSG_HORA}` })
  horaFim?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Faixa inativa some da lista do aluno sem apagar quem ja agendou.',
  })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

export class AtualizarOfertaDto {
  @ApiPropertyOptional({
    example: 44,
    minimum: 1,
    maximum: 1000,
    description:
      'Nao pode passar da capacidade da sala nem ficar abaixo do numero de alunos ja agendados.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  vagas?: number;

  @ApiPropertyOptional({
    example: 2,
    minimum: 1,
    description: 'Unica dentro de faixa + formato.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  ordem?: number;
}

class ModalidadeResumoDto {
  @ApiProperty({ example: 1 })
  id!: number;

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

class PoloResumoDto {
  @ApiProperty({ example: 6 })
  id!: number;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  nome!: string;
}

export class OfertaResumoDto implements OfertaResumo {
  @ApiProperty({
    example: 55,
    description: 'Id da SalaFaixa — e para ele que o agendamento aponta.',
  })
  id!: number;

  @ApiProperty({ example: 21 })
  salaId!: number;

  @ApiProperty({ example: 'M114' })
  salaNome!: string;

  @ApiProperty({ type: ModalidadeResumoDto })
  modalidade!: ModalidadeResumoDto;

  @ApiProperty({ example: 40 })
  vagas!: number;

  @ApiProperty({
    example: 1,
    description: 'Ordem de preenchimento dentro de faixa + formato.',
  })
  ordem!: number;

  @ApiProperty({
    example: 12,
    description: 'Agendamentos ja feitos nesta sala.',
  })
  ocupadas!: number;

  @ApiProperty({
    example: 28,
    description: 'vagas - ocupadas, nunca negativo.',
  })
  disponiveis!: number;
}

export class FaixaDetalheDto implements FaixaDetalhe {
  @ApiProperty({ example: 14 })
  id!: number;

  @ApiProperty({ example: 6 })
  poloId!: number;

  @ApiProperty({ type: PoloResumoDto })
  polo!: PoloResumoDto;

  @ApiProperty({ type: String, format: 'date', example: '2026-08-20' })
  data!: Date;

  @ApiProperty({ example: '08:30' })
  horaInicio!: string;

  @ApiProperty({ example: '11:30' })
  horaFim!: string;

  @ApiProperty({
    example: 180,
    description:
      'Janela da faixa. Precisa comportar a prova mais longa ofertada.',
  })
  duracaoMinutos!: number;

  @ApiProperty({ example: true })
  ativo!: boolean;

  @ApiProperty({
    type: [OfertaResumoDto],
    description: 'As SalaFaixa desta faixa, ordenadas por formato e ordem.',
  })
  ofertas!: OfertaResumoDto[];
}

export class OfertaDetalheDto {
  @ApiProperty({ example: 55 })
  id!: number;

  @ApiProperty({ example: 14 })
  faixaId!: number;

  @ApiProperty({ example: 21 })
  salaId!: number;

  @ApiProperty({ example: 'M114' })
  salaNome!: string;

  @ApiProperty({ type: ModalidadeResumoDto })
  modalidade!: { id: number; codigo: string; nome: string };

  @ApiProperty({ example: 40 })
  vagas!: number;

  @ApiProperty({ example: 1 })
  ordem!: number;

  @ApiProperty({ example: 12 })
  ocupadas!: number;

  @ApiProperty({ example: 28 })
  disponiveis!: number;
}

export class RemocaoFaixaDto {
  @ApiProperty({ example: 'Faixa 14 removida' })
  mensagem!: string;
}
