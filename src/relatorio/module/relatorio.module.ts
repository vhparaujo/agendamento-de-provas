import { Module } from '@nestjs/common';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { RelatorioController } from '../controller/relatorio.controller';
import { ListaPresencaService } from '../service/lista-presenca.service';

@Module({
  imports: [PeriodoModule],
  controllers: [RelatorioController],
  providers: [ListaPresencaService],
  exports: [ListaPresencaService],
})
export class RelatorioModule {}
