import { Module } from '@nestjs/common';
import { AlunoAdminController } from '../controller/aluno-admin.controller';
import { AlunoAdminService } from '../service/aluno-admin.service';
import { AlunoService } from '../service/aluno.service';

@Module({
  controllers: [AlunoAdminController],
  providers: [AlunoService, AlunoAdminService],
  exports: [AlunoService],
})
export class AlunoModule {}
