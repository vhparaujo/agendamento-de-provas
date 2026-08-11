import { Module } from '@nestjs/common';
import { TurmaAdminController } from '../controller/turma-admin.controller';
import { TurmaAdminService } from '../service/turma-admin.service';
import { TurmaService } from '../service/turma.service';

@Module({
  controllers: [TurmaAdminController],
  providers: [TurmaService, TurmaAdminService],
  exports: [TurmaService],
})
export class TurmaModule {}
