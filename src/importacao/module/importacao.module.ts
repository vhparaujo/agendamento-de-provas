import { Module } from '@nestjs/common';
import { ImportacaoController } from '../controller/importacao.controller';
import { ImportacaoAlunosService } from '../service/importacao-alunos.service';
import { ImportacaoTurmasService } from '../service/importacao-turmas.service';

@Module({
  controllers: [ImportacaoController],
  providers: [ImportacaoAlunosService, ImportacaoTurmasService],
  exports: [ImportacaoAlunosService, ImportacaoTurmasService],
})
export class ImportacaoModule {}
