import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './database/prisma.service';
import { D2lEnrollmentsService } from './d2l/service/d2l-enrollments.service';
import { D2lOauthService } from './d2l/service/d2l-oauth.service';

/**
 * Estado da integracao com o Brightspace, do ponto de vista de quem monitora.
 *
 * - `desligado`      — `D2L_HABILITADO=false` ou faltam variaveis. Nao e problema:
 *                      o portal usa a turma do launch e agenda normalmente.
 * - `nao_autorizado` — ligada no .env, mas SEM refresh token gravado. **E o
 *                      estado perigoso**: a API se comporta como se a integracao
 *                      existisse e toda leitura de disciplina falha.
 * - `ok`             — ligada e autorizada.
 * - `desconhecido`   — nao deu para consultar (o banco esta fora).
 */
export type EstadoD2L = 'desligado' | 'nao_autorizado' | 'ok' | 'desconhecido';

export interface HealthStatus {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  d2l: EstadoD2L;
  timestamp: string;
}

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: D2lOauthService,
    private readonly enrollments: D2lEnrollmentsService,
  ) {}

  async health(): Promise<HealthStatus> {
    let database: HealthStatus['database'] = 'up';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }

    return {
      // `status` continua sendo SO o banco, de proposito. O healthcheck do
      // compose testa `status === 'ok'`, e marcar o container como unhealthy
      // porque uma integracao opcional nao foi autorizada faria o deploy parecer
      // quebrado quando a API esta servindo tudo. Quem monitora o D2L le o campo
      // `d2l` — que existe justamente para nao precisar dessa mistura.
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      d2l: await this.estadoD2L(database),
      timestamp: new Date().toISOString(),
    };
  }

  private async estadoD2L(
    database: HealthStatus['database'],
  ): Promise<EstadoD2L> {
    if (!this.enrollments.habilitado()) return 'desligado';

    // O refresh token mora no banco: sem ele nao ha o que consultar, e
    // 'nao_autorizado' seria um palpite — o token pode estar gravado e intacto.
    if (database === 'down') return 'desconhecido';

    try {
      return (await this.oauth.autorizado()) ? 'ok' : 'nao_autorizado';
    } catch (erro) {
      this.logger.warn(
        `Nao foi possivel ler o estado da integracao D2L: ${
          erro instanceof Error ? erro.message : String(erro)
        }`,
      );

      return 'desconhecido';
    }
  }
}
