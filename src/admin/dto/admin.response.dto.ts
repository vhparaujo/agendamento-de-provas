import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NivelAdmin } from '../../generated/prisma/client';
import type { Admin } from '../service/admin.service';

/** Projecao publica de um administrador. Nunca inclui `senhaHash`. */
export class AdminResumoDto implements Admin {
  @ApiProperty({
    format: 'uuid',
    example: '8f1c9d2e-4b7a-4c53-9f61-2a0d5e8b7c14',
  })
  id!: string;

  @ApiProperty({ example: 'coordenacao@ucb.br' })
  email!: string;

  @ApiProperty({ nullable: true, example: 'Maria da Silva' })
  nome!: string | null;

  @ApiProperty({
    enum: NivelAdmin,
    example: NivelAdmin.ASSISTENTE_OPERACIONAL,
    description: 'O que esta conta pode fazer. Ver PATCH /admins/:id/nivel.',
  })
  nivel!: NivelAdmin;

  @ApiProperty({ example: true })
  ativo!: boolean;

  @ApiProperty({
    example: true,
    description: 'Admin recem-criado ou com senha resetada nasce com true.',
  })
  mustChangePassword!: boolean;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    example: '2026-07-30T18:22:04.000Z',
    description: 'null enquanto o admin nunca tiver feito login.',
  })
  ultimoLogin!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-12T09:03:41.000Z',
  })
  createdAt!: Date;
}

export class AdminCriadoResponseDto {
  @ApiProperty({ type: AdminResumoDto })
  admin!: AdminResumoDto;

  @ApiPropertyOptional({
    example: 'k3Jd8fQaLm2p',
    description:
      'So aparece quando a senha NAO foi informada no request. Devolvida UMA unica vez — ' +
      'depois disso nao ha como recupera-la, apenas resetar.',
  })
  senhaProvisoria?: string;
}

export class SenhaResetadaResponseDto {
  @ApiProperty({ type: AdminResumoDto })
  admin!: AdminResumoDto;

  @ApiProperty({
    example: 'k3Jd8fQaLm2p',
    description:
      'Repasse ao dono da conta por canal interno. Devolvida UMA unica vez.',
  })
  senhaProvisoria!: string;
}
