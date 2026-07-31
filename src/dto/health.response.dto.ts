import { ApiProperty } from '@nestjs/swagger';
import type { HealthStatus } from '../app.service';

export class HealthResponseDto implements HealthStatus {
  @ApiProperty({
    enum: ['ok', 'degraded'],
    example: 'ok',
    description: '`degraded` quando a API responde mas o banco esta fora.',
  })
  status!: 'ok' | 'degraded';

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database!: 'up' | 'down';

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-31T13:45:12.482Z',
  })
  timestamp!: string;
}
