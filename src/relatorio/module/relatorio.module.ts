import { Module } from '@nestjs/common';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { RelatorioController } from '../controller/relatorio.controller';
import { ListaPresencaService } from '../service/lista-presenca.service';
import { RelatorioService } from '../service/relatorio.service';

@Module({
  imports: [PeriodoModule],
  controllers: [RelatorioController],
  providers: [RelatorioService, ListaPresencaService],
  exports: [RelatorioService, ListaPresencaService],
})
export class RelatorioModule {}
