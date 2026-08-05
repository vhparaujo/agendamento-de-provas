import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AlunoModule } from '../../aluno/module/aluno.module';
import { AuthController } from '../controller/auth.controller';
import { JwtAdminStrategy } from '../jwt/jwt-admin.strategy';
import { JwtAlunoStrategy } from '../jwt/jwt-aluno.strategy';
import { LtiController } from '../lti/lti.controller';
import { LtiKeysService } from '../lti/lti-keys.service';
import { LtiCodeStore } from '../lti/lti-code.store';
import { LtiStateStore } from '../lti/lti-state.store';
import { LtiService } from '../lti/lti.service';
import { AuthService } from '../service/auth.service';
import { JwtAdminGuard } from '../jwt/jwt-admin.guard';
import { JwtAlunoGuard } from '../jwt/jwt-aluno.guard';

@Module({
  imports: [ConfigModule, PassportModule, JwtModule.register({}), AlunoModule],
  controllers: [AuthController, LtiController],
  providers: [
    AuthService,
    JwtAdminStrategy,
    JwtAlunoStrategy,
    // Os guards por perfil viraram providers porque o AutenticacaoGuard (global,
    // declarado no AppModule) os injeta para delegar a decisao.
    JwtAdminGuard,
    JwtAlunoGuard,
    LtiService,
    LtiStateStore,
    LtiCodeStore,
    LtiKeysService,
  ],
  exports: [AuthService, JwtAdminGuard, JwtAlunoGuard],
})
export class AuthModule {}
