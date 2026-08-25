import { Module } from '@nestjs/common';
import { D2lModule } from '../../d2l/module/d2l.module';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { GradeSenhasController } from '../controller/grade-senhas.controller';
import { SenhaQuizController } from '../controller/senha-quiz.controller';
import { GradeSenhasService } from '../service/grade-senhas.service';
import { ModalidadeDaTurmaService } from '../service/modalidade-da-turma.service';
import { ResolucaoOrgUnitService } from '../service/resolucao-orgunit.service';
import { SenhaQuizCron } from '../service/senha-quiz.cron';
import { SenhaQuizService } from '../service/senha-quiz.service';

/**
 * Escrita em massa nos questionarios de prova no Brightspace: a SENHA e a JANELA
 * de horario.
 *
 * `tipo: SENHA` — uma celula da grade (dia + turno), aplicada em todas as turmas
 * do CSV que pertencem ao periodo letivo vigente.
 *
 * `tipo: DATA` — uma janela (`StartDate`/`EndDate`), aplicada nas turmas de UMA
 * modalidade. A modalidade da turma nao existe no cadastro: e derivada dos
 * agendamentos confirmados (`ModalidadeDaTurmaService`).
 *
 * ⚠️ Os dois vivem no MESMO servico e na MESMA tabela de execucao de proposito.
 * Ambos fazem GET -> altera -> PUT no mesmo questionario, e o PUT substitui o
 * objeto inteiro; `recusarSeJaRodando()` os serializa consultando aquela tabela.
 * Separa-los deixaria o guard cego para metade das execucoes.
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
    ModalidadeDaTurmaService,
    SenhaQuizService,
    SenhaQuizCron,
  ],
  exports: [SenhaQuizService, GradeSenhasService],
})
export class SenhaQuizModule {}
