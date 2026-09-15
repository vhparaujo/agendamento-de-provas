import { Module } from '@nestjs/common';
import { D2lCatalogoController } from '../controller/d2l-catalogo.controller';
import { D2lController } from '../controller/d2l.controller';
import { D2lCondicoesService } from '../service/d2l-condicoes.service';
import { D2lEnrollmentsService } from '../service/d2l-enrollments.service';
import { D2lGradesService } from '../service/d2l-grades.service';
import { D2lGruposService } from '../service/d2l-grupos.service';
import { D2lHttpService } from '../service/d2l-http.service';
import { D2lOauthService } from '../service/d2l-oauth.service';
import { D2lQuizzesService } from '../service/d2l-quizzes.service';

/**
 * Integracao com a Valence API (D2L).
 *
 * Contem a autorizacao OAuth (obter e persistir o refresh token) e a LEITURA de
 * matriculas, que e o que descobre todas as disciplinas do aluno no semestre.
 *
 * Desde 20/08/2026 contem tambem o cliente de NOTAS (`D2lGradesService`), que e
 * o que responde "este aluno pode fazer a substitutiva desta disciplina?" — a
 * regra em si mora em src/agendamento, nao aqui.
 *
 * Desde 18/08/2026 contem tambem o cliente de QUIZZES (`D2lQuizzesService`),
 * pedido pelo cliente para a troca em massa da senha das provas — ver
 * src/senha-quiz. **Gravar SPECIAL ACCESS continua adiado**: sao coisas
 * diferentes, e aquela decisao nao foi revista.
 *
 * Desde 26/08/2026 contem o cliente de CONDICOES DE LIBERACAO e GRUPOS
 * (`D2lCondicoesService`), que e o que troca QUAL GRUPO pode abrir a prova no
 * mesmo disparo que move a data. Ele nasceu separado do de quizzes porque as
 * condicoes nao sao campo do `QuizData`: sao um recurso do LP, com numeracao de
 * versao independente da do LE.
 *
 * Desde 14/09/2026 contem tambem a ESCRITA de grupos (`D2lGruposService`):
 * criar categoria e grupos e inscrever/remover alunos — ver src/grupos-d2l.
 *
 * PrismaService e AuditoriaService vem de modulos globais.
 */
@Module({
  controllers: [D2lController, D2lCatalogoController],
  providers: [
    D2lOauthService,
    D2lHttpService,
    D2lEnrollmentsService,
    D2lQuizzesService,
    D2lCondicoesService,
    D2lGradesService,
    D2lGruposService,
  ],
  exports: [
    D2lOauthService,
    D2lHttpService,
    D2lEnrollmentsService,
    D2lQuizzesService,
    D2lCondicoesService,
    D2lGradesService,
    D2lGruposService,
  ],
})
export class D2lModule {}
