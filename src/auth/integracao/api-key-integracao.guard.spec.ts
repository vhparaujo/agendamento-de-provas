import {
  ExecutionContext,
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Perfil } from '../../enums/perfil.enum';
import { ApiKeyIntegracaoGuard } from './api-key-integracao.guard';

const CHAVE = 'a1b2c3d4'.repeat(5);
const NOVA = 'f9e8d7c6'.repeat(5);

function guardCom(env: Record<string, string | undefined>) {
  const config = { get: (nome: string) => env[nome] };

  return new ApiKeyIntegracaoGuard(config as unknown as ConfigService);
}

function requisicao(chave?: string, ip = '10.0.0.5') {
  return {
    ip,
    user: undefined as unknown,
    header: (nome: string) =>
      nome.toLowerCase() === 'x-api-key' ? chave : undefined,
  };
}

function contexto(req: ReturnType<typeof requisicao>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyIntegracaoGuard', () => {
  beforeAll(() => {
    // O aviso de "nenhuma chave" e esperado num dos casos; aqui ele so polui.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('libera a chave certa e grava o SISTEMA em req.user', () => {
    const guard = guardCom({ INTEGRACAO_API_KEYS: `emissor:${CHAVE}` });
    const req = requisicao(CHAVE);

    expect(guard.canActivate(contexto(req))).toBe(true);
    expect(req.user).toEqual({ perfil: Perfil.INTEGRACAO, sistema: 'emissor' });
  });

  it('401 com chave errada ou sem o header', () => {
    const guard = guardCom({ INTEGRACAO_API_KEYS: `emissor:${CHAVE}` });

    expect(() => guard.canActivate(contexto(requisicao(NOVA)))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(contexto(requisicao()))).toThrow(
      UnauthorizedException,
    );
  });

  /**
   * FAIL-CLOSED. O ambiente que esqueceu a variavel nao pode ficar com os dados
   * pessoais de todo aluno abertos — ele sobe, e a rota recusa tudo.
   */
  it('sem chave configurada, recusa ate uma chave "qualquer"', () => {
    const guard = guardCom({});

    expect(() => guard.canActivate(contexto(requisicao(CHAVE)))).toThrow(
      UnauthorizedException,
    );
  });

  it('aceita as duas chaves durante a rotacao', () => {
    const guard = guardCom({
      INTEGRACAO_API_KEYS: `emissor:${CHAVE},emissor:${NOVA}`,
    });

    expect(guard.canActivate(contexto(requisicao(CHAVE)))).toBe(true);
    expect(guard.canActivate(contexto(requisicao(NOVA)))).toBe(true);
  });

  /**
   * A origem e conferida ANTES da chave: de fora da lista, a resposta e 403
   * com chave certa ou errada, e ninguem de fora consegue testar chaves.
   */
  it('403 de um IP fora da lista, mesmo com a chave certa', () => {
    const guard = guardCom({
      INTEGRACAO_API_KEYS: `emissor:${CHAVE}`,
      INTEGRACAO_IPS_PERMITIDOS: '10.0.0.5',
    });

    expect(() =>
      guard.canActivate(contexto(requisicao(CHAVE, '203.0.113.9'))),
    ).toThrow(ForbiddenException);
    expect(guard.canActivate(contexto(requisicao(CHAVE, '10.0.0.5')))).toBe(
      true,
    );
  });
});
