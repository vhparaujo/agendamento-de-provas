import { Module } from '@nestjs/common';
import { PeriodoController } from '../controller/periodo.controller';
import { PeriodoService } from '../service/periodo.service';

@Module({
  controllers: [PeriodoController],
  providers: [PeriodoService],
  exports: [PeriodoService],
})
export class PeriodoModule {}
