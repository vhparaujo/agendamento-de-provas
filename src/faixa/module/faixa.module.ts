import { Module } from '@nestjs/common';
import { FaixaController } from '../controller/faixa.controller';
import { FaixaService } from '../service/faixa.service';

@Module({
  controllers: [FaixaController],
  providers: [FaixaService],
  exports: [FaixaService],
})
export class FaixaModule {}
