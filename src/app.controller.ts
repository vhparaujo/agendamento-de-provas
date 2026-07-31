import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService, HealthStatus } from './app.service';
import { Publico } from './auth/roles.decorator';
import { TAGS } from './config/swagger';
import { HealthResponseDto } from './dto/health.response.dto';

@ApiTags(TAGS.SISTEMA)
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Publica: o healthcheck do docker-compose e o monitoramento consultam sem token.
  @Publico()
  @Get('health')
  @ApiOperation({
    summary: 'Health check',
    description:
      'Responde 200 mesmo com o banco fora — nesse caso `status` vira `degraded`. ' +
      'Usado pelo healthcheck do compose e por monitoramento.',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  health(): Promise<HealthStatus> {
    return this.appService.health();
  }
}
