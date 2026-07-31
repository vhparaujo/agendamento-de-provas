import { Module } from '@nestjs/common';
import { SalaController } from '../controller/sala.controller';
import { SalaService } from '../service/sala.service';

@Module({
  controllers: [SalaController],
  providers: [SalaService],
  exports: [SalaService],
})
export class SalaModule {}
