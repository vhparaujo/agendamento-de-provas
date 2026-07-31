import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ESTRATEGIA_ALUNO } from './jwt-aluno.strategy';

/**
 * Protege as rotas do portal do aluno. NAO valida elegibilidade (aluno inativo
 * tem token valido, mas e barrado na hora de agendar) — isso e regra de negocio,
 * nao de autenticacao.
 */
@Injectable()
export class JwtAlunoGuard extends AuthGuard(ESTRATEGIA_ALUNO) {}
