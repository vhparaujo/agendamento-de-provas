import { Module } from '@nestjs/common';
import { D2lModule } from '../../d2l/module/d2l.module';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { GradeGruposController } from '../controller/grade-grupos.controller';
import { GradeSenhasController } from '../controller/grade-senhas.controller';
import { SenhaQuizController } from '../controller/senha-quiz.controller';
import { GradeGruposService } from '../service/grade-grupos.service';
import { GradeSenhasService } from '../service/grade-senhas.service';
import { ModalidadeDaTurmaService } from '../service/modalidade-da-turma.service';
import { ResolucaoGrupoService } from '../service/resolucao-grupo.service';
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
 * Desde 26/08/2026 o lote `DATA` faz uma terceira coisa no MESMO disparo: troca
 * o GRUPO que libera a prova, quando a janela tem `nomeGrupo`. Isso NAO virou um
 * `tipo` novo — e parte do lote de datas, pelo mesmo motivo pelo qual os dois
 * tipos ja moram juntos (ver o aviso abaixo) e porque o cliente pediu a troca
 * "nos mesmos horarios em que trocamos as datas". Um terceiro tipo obrigaria o
 * cron a gastar mais um tick e deixaria data e grupo em execucoes diferentes,
 * com relatorios separados para uma decisao so.
 *
 * ⚠️ A troca de grupo NAO passa pelo objeto do quiz: condicoes de liberacao sao
 * um recurso do LP (`D2lCondicoesService`), nao um campo do `QuizData`. Por isso
 * ela nao pode apagar `EndDate` nem `Password`, e por isso as duas escritas
 * falham independentemente — que e o que sustenta a decisao "falha de grupo nao
 * bloqueia a data".
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
 * `GradeGruposController` (`senhas-de-prova/grupos`) entra antes da grade de
 * senhas pelo mesmo motivo.
 *
 * Desde 14/09/2026 o grupo de cada disparo sai da GRADE DE GRUPOS (dia x janela),
 * com o nome fixo da janela como padrao — ver `grupo-do-dia.ts`.
 *
 * PrismaService e AuditoriaService vem de modulos globais.
 */
@Module({
  imports: [D2lModule, PeriodoModule],
  controllers: [
    SenhaQuizController,
    GradeGruposController,
    GradeSenhasController,
  ],
  providers: [
    GradeSenhasService,
    GradeGruposService,
    ResolucaoOrgUnitService,
    ResolucaoGrupoService,
    ModalidadeDaTurmaService,
    SenhaQuizService,
    SenhaQuizCron,
  ],
  exports: [SenhaQuizService, GradeSenhasService],
})
export class SenhaQuizModule {}
