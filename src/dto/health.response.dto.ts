import { ApiProperty } from '@nestjs/swagger';
import type { EstadoD2L, HealthStatus } from '../app.service';

export class HealthResponseDto implements HealthStatus {
  @ApiProperty({
    enum: ['ok', 'degraded'],
    example: 'ok',
    description:
      '`degraded` quando a API responde mas o banco esta fora. **Nao reflete o D2L**: ' +
      'integracao opcional nao pode marcar a API como quebrada — leia `d2l`.',
  })
  status!: 'ok' | 'degraded';

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database!: 'up' | 'down';

  @ApiProperty({
    enum: ['desligado', 'nao_autorizado', 'ok', 'desconhecido'],
    example: 'ok',
    description:
      'Estado da integracao com o Brightspace. `desligado` e normal (o portal usa a turma do ' +
      'launch). **`nao_autorizado` e o alerta**: ligada no .env e sem refresh token gravado — ' +
      'o aluno so consegue agendar a disciplina de onde clicou, e o compulsorio nao roda. ' +
      'Resolve-se reautorizando pelo browser (`GET /d2l/callback`).',
  })
  d2l!: EstadoD2L;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-31T13:45:12.482Z',
  })
  timestamp!: string;
}
