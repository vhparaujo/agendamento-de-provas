import { Module } from '@nestjs/common';
import { SalaFaixaController } from '../controller/sala-faixa.controller';
import { SalaFaixaService } from '../service/sala-faixa.service';

@Module({
  controllers: [SalaFaixaController],
  providers: [SalaFaixaService],
  exports: [SalaFaixaService],
})
export class SalaFaixaModule {}
