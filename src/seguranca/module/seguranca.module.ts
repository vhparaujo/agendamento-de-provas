import { Global, Module } from '@nestjs/common';
import { AuditoriaService } from '../service/auditoria.service';

/**
 * Global porque auditoria e transversal: qualquer service precisa registrar
 * evento sem que cada modulo tenha de importar este aqui. E o mesmo tratamento
 * dado ao PrismaModule.
 */
@Global()
@Module({
  providers: [AuditoriaService],
  exports: [AuditoriaService],
})
export class SegurancaModule {}
