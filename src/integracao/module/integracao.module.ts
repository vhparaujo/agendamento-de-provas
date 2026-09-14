import { Module } from '@nestjs/common';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { IntegracaoController } from '../controller/integracao.controller';
import { IntegracaoService } from '../service/integracao.service';

/**
 * Rotas consumidas por OUTROS SISTEMAS da instituicao, autenticadas por API key
 * (`@SomenteIntegracao()`). Hoje, o emissor da declaracao de agendamento
 * assinada digitalmente.
 */
@Module({
  imports: [PeriodoModule],
  controllers: [IntegracaoController],
  providers: [IntegracaoService],
})
export class IntegracaoModule {}
