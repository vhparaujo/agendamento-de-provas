import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ContextoLaunch } from '../jwt/jwt.types';
import type { ResultadoLaunch, VinculoLaunch } from '../lti/lti.service';

export class ModalidadeVinculoDto {
  @ApiProperty({
    enum: ['EAD', 'SEMI', 'MODULAR', 'PRESENCIAL'],
    example: 'EAD',
  })
  codigo!: string;

  @ApiProperty({ example: 'EaD' })
  nome!: string;

  @ApiProperty({
    example: 180,
    description:
      'Duracao da prova em minutos: EaD 180, Semi/Modular 90, Presencial 120. ' +
      'E o que determina em quais faixas este vinculo cabe.',
  })
  duracaoMinutos!: number;
}

export class PoloVinculoDto {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  nome!: string;
}

/**
 * Um vinculo = aluno + curso. O formato e o polo vem daqui, nunca do cliente.
 */
export class VinculoLaunchDto implements VinculoLaunch {
  @ApiProperty({
    example: 4821,
    description:
      'Identificador do vinculo. E ele que o portal envia ao agendar, nao a matricula.',
  })
  alunoId!: number;

  @ApiProperty({ example: 'PEDAGOGIA' })
  curso!: string;

  @ApiProperty({
    example: true,
    description:
      'Derivado do STATUS CURSO do CSV. false = reconhecido, porem sem direito a agendar.',
  })
  ativo!: boolean;

  @ApiProperty({ type: ModalidadeVinculoDto })
  modalidade!: ModalidadeVinculoDto;

  @ApiProperty({ type: PoloVinculoDto })
  polo!: PoloVinculoDto;
}

export class ContextoLaunchDto implements ContextoLaunch {
  @ApiProperty({
    example: '6606',
    description:
      'orgUnitId da turma no D2L — o mesmo identificador do CSV de turmas.',
  })
  orgUnitId!: string;

  @ApiPropertyOptional({
    example: 'GSPS0I10227',
    description:
      'Codigo da turma (`context.label`). E a chave de busca no CSV de turmas.',
  })
  codigo?: string;

  @ApiPropertyOptional({
    example: 'HISTÓRIA E CULTURA DO CORPO E DO MOVIMENTO',
    description: 'Nome da disciplina (`context.title`). Desempata o codigo.',
  })
  titulo?: string;
}

export class LaunchResponseDto implements ResultadoLaunch {
  @ApiProperty({
    description:
      'JWT interno do aluno. Curto e apenas para navegacao — a fonte de verdade continua sendo o cruzamento matricula x CSV.',
  })
  accessToken!: string;

  @ApiProperty({ example: '2h', description: 'Tempo de vida do accessToken.' })
  expiraEm!: string;

  @ApiProperty({
    example: 'UC25426847',
    description:
      'RA do aluno. Alfanumerico — zeros a esquerda sao significativos.',
  })
  matricula!: string;

  @ApiProperty({ nullable: true, example: 'JOAO DA SILVA' })
  nome!: string | null;

  @ApiProperty({
    example: false,
    description:
      'true quando o RA tem mais de um curso: o portal precisa perguntar de qual curso e a prova ' +
      'antes de listar as faixas. Cada vinculo gera seu proprio agendamento.',
  })
  precisaEscolherCurso!: boolean;

  @ApiProperty({ type: [VinculoLaunchDto], description: '1..n vinculos.' })
  vinculos!: VinculoLaunchDto[];

  @ApiPropertyOptional({
    type: ContextoLaunchDto,
    description:
      'Turma de onde o aluno clicou o link. Sem ela o aluno navega, mas nao agenda: ' +
      'nao ha disciplina para liberar no Brightspace.',
  })
  contexto?: ContextoLaunchDto;
}

/** Chave publica da ferramenta, no formato JWKS consumido pelo Brightspace. */
export class JwksResponseDto {
  @ApiProperty({
    isArray: true,
    type: 'object',
    additionalProperties: true,
    example: [
      {
        kty: 'RSA',
        use: 'sig',
        alg: 'RS256',
        kid: 'agendamento-provas-1',
        n: '...',
        e: 'AQAB',
      },
    ],
  })
  keys!: Record<string, unknown>[];
}
