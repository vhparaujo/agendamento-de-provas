import { Module } from '@nestjs/common';
import { PoloController } from '../controller/polo.controller';
import { PoloService } from '../service/polo.service';

@Module({
  controllers: [PoloController],
  providers: [PoloService],
  exports: [PoloService],
})
export class PoloModule {}
