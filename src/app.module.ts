import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/module/admin.module';
import { AgendamentoModule } from './agendamento/module/agendamento.module';
import { AlunoModule } from './aluno/module/aluno.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AutenticacaoGuard } from './auth/jwt/autenticacao.guard';
import { AuthModule } from './auth/module/auth.module';
import { validateEnv } from './config/env.validation';
import { throttlerConfig } from './config/throttler.config';
import { D2lModule } from './d2l/module/d2l.module';
import { PrismaModule } from './database/prisma.module';
import { FaixaModule } from './faixa/module/faixa.module';
import { GruposD2lModule } from './grupos-d2l/module/grupos-d2l.module';
import { ImportacaoModule } from './importacao/module/importacao.module';
import { IntegracaoModule } from './integracao/module/integracao.module';
import { ModalidadeModule } from './modalidade/module/modalidade.module';
import { PeriodoModule } from './periodo/module/periodo.module';
import { PoloModule } from './polo/module/polo.module';
import { RelatorioModule } from './relatorio/module/relatorio.module';
import { SalaFaixaModule } from './sala-faixa/module/sala-faixa.module';
import { SalaModule } from './sala/module/sala.module';
import { ExcecoesFilter } from './seguranca/filter/excecoes.filter';
import { SegurancaModule } from './seguranca/module/seguranca.module';
import { SenhaQuizModule } from './senha-quiz/module/senha-quiz.module';
import { SpecialAccessModule } from './special-access/module/special-access.module';
import { TurmaModule } from './turma/module/turma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot(throttlerConfig),
    // Primeira lib de agendamento do projeto. Existe por causa do cron que troca
    // a senha das provas no horario — ver src/senha-quiz/service/senha-quiz.cron.ts.
    ScheduleModule.forRoot(),
    SegurancaModule,
    PrismaModule,
    AuthModule,
    AdminModule,
    AlunoModule,
    ImportacaoModule,
    TurmaModule,
    // Estrutura fisica e oferta de vagas (etapa 5)
    ModalidadeModule,
    PoloModule,
    SalaModule,
    FaixaModule,
    SalaFaixaModule,
    // Portal do aluno (etapa 6)
    PeriodoModule,
    AgendamentoModule,
    // Exportacoes para outro sistema (grupos do Brightspace por horario)
    RelatorioModule,
    // Integracao D2L: por enquanto so a autorizacao OAuth (etapa 8 adiada)
    D2lModule,
    // Troca em massa da senha dos questionarios (etapa 10)
    SenhaQuizModule,
    GruposD2lModule,
    // Special access por agendamento (15/09/2026)
    SpecialAccessModule,
    // Dados para outros sistemas, por API key (emissor da declaracao assinada)
    IntegracaoModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // A ORDEM IMPORTA: guards globais rodam na ordem em que sao declarados.
    // O limite de requisicoes vem PRIMEIRO, de proposito — quem esta fazendo
    // forca bruta precisa esbarrar no 429 antes de gastar um bcrypt do servidor.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AutenticacaoGuard },
    { provide: APP_FILTER, useClass: ExcecoesFilter },
  ],
})
export class AppModule {}
