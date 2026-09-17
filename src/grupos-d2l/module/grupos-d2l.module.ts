import { Module } from '@nestjs/common';
import { D2lModule } from '../../d2l/module/d2l.module';
import { FaixaModule } from '../../faixa/module/faixa.module';
import { PeriodoModule } from '../../periodo/module/periodo.module';
import { SenhaQuizModule } from '../../senha-quiz/module/senha-quiz.module';
import { GruposD2lController } from '../controller/grupos-d2l.controller';
import { GruposD2lService } from '../service/grupos-d2l.service';
import { NomesDosGruposService } from '../service/nomes-dos-grupos.service';

/**
 * Grupos de prova no Brightspace pela API (14/09/2026): os nomes por bloco, as
 * pendencias de horario e os dois lotes (criar, inscrever).
 *
 * Depende do `SenhaQuizModule` e nao o contrario: os nomes MORAM na grade de
 * grupos de la, e a categoria de cada turma sai da mesma derivacao de
 * formato que o lote de datas usa.
 *
 * PrismaService e AuditoriaService vem de modulos globais.
 */
@Module({
  imports: [D2lModule, PeriodoModule, SenhaQuizModule, FaixaModule],
  controllers: [GruposD2lController],
  providers: [NomesDosGruposService, GruposD2lService],
})
export class GruposD2lModule {}
