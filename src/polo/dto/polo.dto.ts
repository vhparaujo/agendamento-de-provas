import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { NOMES_DOS_FUSOS } from '../service/fusos';
import type { Polo, PoloComContagens } from '../service/polo.service';

export class CriarPoloDto {
  @ApiProperty({
    example: 'Polo Anápolis - Jundiaí',
    maxLength: 191,
    description:
      'PRECISA ser identico ao valor da coluna CAMPUS no CSV de alunos — e a chave ' +
      'que liga aluno e polo na importacao. Um acento ou espaco a mais faz todos os ' +
      'alunos daquele campus serem rejeitados no proximo upload.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'nome e obrigatorio' })
  @MaxLength(191)
  nome!: string;

  @ApiPropertyOptional({
    example: 'Anápolis',
    description: 'Apenas informativo; nao entra em nenhuma regra.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  cidade?: string;
}

export class AtualizarPoloDto {
  @ApiPropertyOptional({
    example: 'Anápolis',
    nullable: true,
    description: 'Envie null para limpar.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  cidade?: string | null;

  @ApiPropertyOptional({
    example: false,
    description:
      'Polo inativo nao aceita sala nem faixa nova — e assim que um campus sai ' +
      'da oferta. Nao afeta o que ja existe: salas, faixas e provas ja marcadas ' +
      'continuam valendo, e o aluno segue vendo a prova dele.',
  })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;

  @ApiPropertyOptional({
    example: 'America/Rio_Branco',
    description:
      'O fuso IANA em que as faixas deste polo sao lidas. Decide a que horas o ' +
      'special access abre e fecha a prova de quem faz prova aqui: "09:00" em ' +
      'America/Rio_Branco e 11:00 de Brasilia. Lista em `GET /polos/fusos`.',
  })
  @IsOptional()
  @IsIn(NOMES_DOS_FUSOS, {
    message: 'fuso deve ser um dos listados em GET /polos/fusos',
  })
  fuso?: string;
}

export class FusoDto {
  @ApiProperty({ example: 'America/Rio_Branco' })
  fuso!: string;

  @ApiProperty({ example: 'Acre — Cruzeiro do Sul (UTC-5)' })
  rotulo!: string;
}

export class PoloDto implements Polo {
  @ApiProperty({ example: 6 })
  id!: number;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  nome!: string;

  @ApiProperty({ nullable: true, example: 'Taguatinga' })
  cidade!: string | null;

  @ApiProperty({ example: true })
  ativo!: boolean;

  @ApiProperty({
    example: 'America/Sao_Paulo',
    description: 'Fuso IANA das faixas deste polo.',
  })
  fuso!: string;
}

export class PoloComContagensDto extends PoloDto implements PoloComContagens {
  @ApiProperty({ example: 12, description: 'Salas cadastradas neste polo.' })
  totalSalas!: number;

  @ApiProperty({
    example: 4,
    description:
      'Faixas cadastradas neste polo, INCLUSIVE as de datas passadas — sao elas ' +
      'que sustentam os agendamentos ja realizados. Com as outras duas contagens ' +
      'em zero, o polo pode ser apagado.',
  })
  totalFaixas!: number;

  @ApiProperty({
    example: 2515,
    description: 'Vinculos de aluno importados neste polo (aluno + curso).',
  })
  totalAlunos!: number;
}

export class RemocaoPoloDto {
  @ApiProperty({ example: 'Polo "Polo Formosa" removido' })
  mensagem!: string;
}
