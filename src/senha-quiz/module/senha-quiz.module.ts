import { Module } from '@nestjs/common';
import { D2lModule } from '../../d2l/module/d2l.module';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { GradeSenhasController } from '../controller/grade-senhas.controller';
import { SenhaQuizController } from '../controller/senha-quiz.controller';
import { GradeSenhasService } from '../service/grade-senhas.service';
import { ResolucaoOrgUnitService } from '../service/resolucao-orgunit.service';
import { SenhaQuizCron } from '../service/senha-quiz.cron';
import { SenhaQuizService } from '../service/senha-quiz.service';

/**
 * Troca em massa da senha (`Password`) dos questionarios de prova no Brightspace.
 *
 * Uma execucao = uma celula da grade (dia + turno), aplicada em todas as turmas
 * do CSV que pertencem ao periodo letivo vigente.
 *
 * ⚠️ A ORDEM DOS CONTROLLERS IMPORTA. `SenhaQuizController` serve
 * `senhas-de-prova/execucoes/...` e `GradeSenhasController` tem
 * `senhas-de-prova/:id/...`; declarar a grade primeiro faria o `:id` disputar a
 * palavra "execucoes". Mesma armadilha ja documentada em `agendamento.module.ts`.
 *
 * PrismaService e AuditoriaService vem de modulos globais.
 */
@Module({
  imports: [D2lModule, PeriodoModule],
  controllers: [SenhaQuizController, GradeSenhasController],
  providers: [
    GradeSenhasService,
    ResolucaoOrgUnitService,
    SenhaQuizService,
    SenhaQuizCron,
  ],
  exports: [SenhaQuizService, GradeSenhasService],
})
export class SenhaQuizModule {}
