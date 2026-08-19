import { Module } from '@nestjs/common';
import { D2lCatalogoController } from '../controller/d2l-catalogo.controller';
import { D2lController } from '../controller/d2l.controller';
import { D2lEnrollmentsService } from '../service/d2l-enrollments.service';
import { D2lHttpService } from '../service/d2l-http.service';
import { D2lOauthService } from '../service/d2l-oauth.service';
import { D2lQuizzesService } from '../service/d2l-quizzes.service';

/**
 * Integracao com a Valence API (D2L).
 *
 * Contem a autorizacao OAuth (obter e persistir o refresh token) e a LEITURA de
 * matriculas, que e o que descobre todas as disciplinas do aluno no semestre.
 *
 * Desde 18/08/2026 contem tambem o cliente de QUIZZES (`D2lQuizzesService`),
 * pedido pelo cliente para a troca em massa da senha das provas — ver
 * src/senha-quiz. **Gravar SPECIAL ACCESS continua adiado**: sao coisas
 * diferentes, e aquela decisao nao foi revista.
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
  ],
  exports: [
    D2lOauthService,
    D2lHttpService,
    D2lEnrollmentsService,
    D2lQuizzesService,
  ],
})
export class D2lModule {}
