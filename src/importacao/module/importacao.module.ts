import { Module } from '@nestjs/common';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { ImportacaoController } from '../controller/importacao.controller';
import { ImportacaoAlunosService } from '../service/importacao-alunos.service';
import { ImportacaoTurmasService } from '../service/importacao-turmas.service';

@Module({
  // O aviso de "troca com prova marcada" so olha o semestre vigente, e quem
  // sabe qual e ele e o PeriodoService.
  imports: [PeriodoModule],
  controllers: [ImportacaoController],
  providers: [ImportacaoAlunosService, ImportacaoTurmasService],
  exports: [ImportacaoAlunosService, ImportacaoTurmasService],
})
export class ImportacaoModule {}
