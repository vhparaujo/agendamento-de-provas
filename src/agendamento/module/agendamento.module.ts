import { Module } from '@nestjs/common';
import { D2lModule } from '../../d2l/module/d2l.module';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { TurmaModule } from '../../turma/module/turma.module';
import { AgendamentoAdminController } from '../controller/agendamento-admin.controller';
import { PortalController } from '../controller/portal.controller';
import { AgendamentoAdminService } from '../service/agendamento-admin.service';
import { AgendamentoService } from '../service/agendamento.service';
import { DisciplinasDoAlunoService } from '../service/disciplinas-do-aluno.service';

@Module({
  imports: [PeriodoModule, TurmaModule, D2lModule],
  controllers: [PortalController, AgendamentoAdminController],
  providers: [
    AgendamentoService,
    AgendamentoAdminService,
    DisciplinasDoAlunoService,
  ],
  exports: [AgendamentoService, AgendamentoAdminService],
})
export class AgendamentoModule {}
