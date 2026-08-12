import { Module } from '@nestjs/common';
import { D2lModule } from '../../d2l/module/d2l.module';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { TurmaModule } from '../../turma/module/turma.module';
import { AgendamentoAdminController } from '../controller/agendamento-admin.controller';
import { CompulsorioController } from '../controller/compulsorio.controller';
import { PortalController } from '../controller/portal.controller';
import { AgendamentoAdminService } from '../service/agendamento-admin.service';
import { AgendamentoService } from '../service/agendamento.service';
import { CompulsorioService } from '../service/compulsorio.service';
import { DisciplinasDoAlunoService } from '../service/disciplinas-do-aluno.service';

@Module({
  imports: [PeriodoModule, TurmaModule, D2lModule],
  controllers: [
    PortalController,
    // ANTES do AgendamentoAdminController: aquele tem `@Get(':id')`, que casaria
    // com "compulsorio" e responderia 400 no lugar desta rota.
    CompulsorioController,
    AgendamentoAdminController,
  ],
  providers: [
    AgendamentoService,
    AgendamentoAdminService,
    CompulsorioService,
    DisciplinasDoAlunoService,
  ],
  exports: [AgendamentoService, AgendamentoAdminService],
})
export class AgendamentoModule {}
