import { Module } from '@nestjs/common';
import { AlunoService } from '../service/aluno.service';

@Module({
  providers: [AlunoService],
  exports: [AlunoService],
})
export class AlunoModule {}
