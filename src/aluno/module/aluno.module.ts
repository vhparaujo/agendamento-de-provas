import { Module } from '@nestjs/common';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { AlunoAdminController } from '../controller/aluno-admin.controller';
import { AlunoAdminService } from '../service/aluno-admin.service';
import { AlunoService } from '../service/aluno.service';
import { MesclagemVinculosService } from '../service/mesclagem-vinculos.service';
import { NiopService } from '../service/niop.service';

@Module({
  // A mesclagem precisa saber quais periodos letivos formam a JANELA vigente:
  // as provas de dois vinculos da mesma pessoa podem estar sob org units
  // diferentes (modulo e semestre) e ainda assim ser a mesma prova.
  imports: [PeriodoModule],
  controllers: [AlunoAdminController],
  providers: [
    AlunoService,
    AlunoAdminService,
    MesclagemVinculosService,
    NiopService,
  ],
  exports: [AlunoService],
})
export class AlunoModule {}
