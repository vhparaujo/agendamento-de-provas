import { Module } from '@nestjs/common';
import { D2lController } from '../controller/d2l.controller';
import { D2lEnrollmentsService } from '../service/d2l-enrollments.service';
import { D2lOauthService } from '../service/d2l-oauth.service';

/**
 * Integracao com a Valence API (D2L).
 *
 * Contem a autorizacao OAuth (obter e persistir o refresh token) e a LEITURA de
 * matriculas, que e o que descobre todas as disciplinas do aluno no semestre.
 * Gravar special access no quiz continua adiado pelo cliente — nao adicione nada
 * de quiz aqui sem ele pedir.
 *
 * PrismaService e AuditoriaService vem de modulos globais.
 */
@Module({
  controllers: [D2lController],
  providers: [D2lOauthService, D2lEnrollmentsService],
  exports: [D2lOauthService, D2lEnrollmentsService],
})
export class D2lModule {}
