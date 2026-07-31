import { Module } from '@nestjs/common';
import { TurmaService } from '../service/turma.service';

@Module({
  providers: [TurmaService],
  exports: [TurmaService],
})
export class TurmaModule {}
