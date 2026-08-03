import { Module } from '@nestjs/common';
import { PeriodoService } from '../service/periodo.service';

@Module({
  providers: [PeriodoService],
  exports: [PeriodoService],
})
export class PeriodoModule {}
