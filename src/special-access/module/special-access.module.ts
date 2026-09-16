import { Module } from '@nestjs/common';
import { D2lModule } from '../../d2l/module/d2l.module';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { SenhaQuizModule } from '../../senha-quiz/module/senha-quiz.module';
import { SpecialAccessController } from '../controller/special-access.controller';
import { ConfiguracaoSpecialAccessService } from '../service/configuracao-special-access.service';
import { SpecialAccessService } from '../service/special-access.service';

/**
 * Special access por agendamento (15/09/2026): a configuracao (tempo por
 * modalidade, extra do NIOP, modo) e o lote que grava o acesso de cada aluno.
 *
 * Depende do `SenhaQuizModule` pelo questionario-alvo, que e o MESMO dos lotes
 * de senha e de preparo. A marca do NIOP mora no modulo de alunos, onde a tela
 * a edita; este modulo so a le.
 *
 * PrismaService e AuditoriaService vem de modulos globais.
 */
@Module({
  imports: [D2lModule, PeriodoModule, SenhaQuizModule],
  controllers: [SpecialAccessController],
  providers: [ConfiguracaoSpecialAccessService, SpecialAccessService],
})
export class SpecialAccessModule {}
