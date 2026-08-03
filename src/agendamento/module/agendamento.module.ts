import { Module } from '@nestjs/common';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { TurmaModule } from '../../turma/module/turma.module';
import { PortalController } from '../controller/portal.controller';
import { AgendamentoService } from '../service/agendamento.service';
import { DisciplinasDoAlunoService } from '../service/disciplinas-do-aluno.service';

@Module({
  imports: [PeriodoModule, TurmaModule],
  controllers: [PortalController],
  providers: [AgendamentoService, DisciplinasDoAlunoService],
  exports: [AgendamentoService],
})
export class AgendamentoModule {}
