import { ConfigService } from '@nestjs/config';
import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { D2lOauthService } from './d2l-oauth.service';

/**
 * O que estes testes protegem, em ordem de importancia:
 *
 * 1. O refresh token e GRAVADO. Perde-lo obriga a refazer a autorizacao inteira
 *    no Brightspace, porque o `code` que o gerou vale uma vez so.
 * 2. O access token NAO vaza em producao.
 * 3. Cada recusa do OAuth vira a acao certa: refazer a autorizacao (`code`
 *    queimado) ou corrigir o .env (cliente/redirect divergentes).
 */
describe('D2lOauthService', () => {
  const CONFIG_COMPLETA = {
    D2L_CLIENT_ID: 'cliente-123',
    D2L_CLIENT_SECRET: 'segredo-abc',
    D2L_REDIRECT_URI: 'https://exemplo.ngrok-free.dev/api/d2l/callback',
  };

  let upsert: jest.Mock;
  let findUnique: jest.Mock;
  let registrar: jest.Mock;
  let prisma: PrismaService;
  let auditoria: AuditoriaService;
  let fetchOriginal: typeof globalThis.fetch;

  beforeEach(() => {
    upsert = jest.fn().mockResolvedValue({});
    findUnique = jest.fn().mockResolvedValue({ id: 1, refreshToken: 'r-1' });
    registrar = jest.fn();
    prisma = {
      integracaoD2L: { upsert, findUnique },
    } as unknown as PrismaService;
    auditoria = { registrar } as unknown as AuditoriaService;
    fetchOriginal = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    jest.restoreAllMocks();
  });

  const servico = (env: Record<string, string> = CONFIG_COMPLETA) =>
    new D2lOauthService(new ConfigService(env), prisma, auditoria);

  /** Resposta do token endpoint, sem subir servidor. */
  const responderCom = (status: number, corpo: unknown) => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(corpo),
    });
  };

  it('grava o refresh token e devolve o access token fora de producao', async () => {
    responderCom(200, {
      access_token: 'access-xyz',
      refresh_token: 'refresh-xyz',
      expires_in: 3600,
      scope: 'enrollment:orgunit:read',
    });

    const resultado = await servico().trocarCodigoPorTokens('code-1');

    expect(upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      update: { refreshToken: 'refresh-xyz' },
      create: { id: 1, refreshToken: 'refresh-xyz' },
    });
    expect(resultado).toEqual({
      expiraEmSegundos: 3600,
      escopos: 'enrollment:orgunit:read',
      refreshTokenGravado: true,
      accessToken: 'access-xyz',
    });
  });

  it('em producao confirma o sucesso SEM devolver o access token', async () => {
    responderCom(200, {
      access_token: 'access-xyz',
      refresh_token: 'refresh-xyz',
      expires_in: 3600,
    });

    const resultado = await servico({
      ...CONFIG_COMPLETA,
      NODE_ENV: 'production',
    }).trocarCodigoPorTokens('code-1');

    // O refresh continua sendo gravado: o que muda e so o que sai na resposta.
    expect(upsert).toHaveBeenCalled();
    expect(resultado.accessToken).toBeUndefined();
    expect(resultado.refreshTokenGravado).toBe(true);
  });

  it('manda os parametros do authorization_code, com o redirect_uri configurado', async () => {
    responderCom(200, { access_token: 'a', refresh_token: 'r', expires_in: 1 });

    await servico().trocarCodigoPorTokens('code-1');

    const [, opcoes] = (globalThis.fetch as jest.Mock).mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];

    expect(opcoes.body.get('grant_type')).toBe('authorization_code');
    expect(opcoes.body.get('code')).toBe('code-1');
    expect(opcoes.body.get('redirect_uri')).toBe(
      CONFIG_COMPLETA.D2L_REDIRECT_URI,
    );
  });

  it('sem refresh token na resposta, grava nada e avisa em vez de quebrar', async () => {
    responderCom(200, { access_token: 'a', expires_in: 1800 });

    const resultado = await servico().trocarCodigoPorTokens('code-1');

    expect(upsert).not.toHaveBeenCalled();
    expect(resultado.refreshTokenGravado).toBe(false);
  });

  it('code queimado (invalid_grant) manda refazer a autorizacao', async () => {
    responderCom(400, { error: 'invalid_grant' });

    await expect(servico().trocarCodigoPorTokens('code-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(registrar).toHaveBeenCalledWith(
      'D2L_AUTORIZACAO_FALHOU',
      expect.anything(),
    );
  });

  it('invalid_client aponta o .env, nao o Brightspace', async () => {
    responderCom(400, {
      error: 'invalid_client',
      error_description: 'redirect_uri mismatch',
    });

    await expect(
      servico().trocarCodigoPorTokens('code-1'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('D2L_REDIRECT_URI') as unknown,
    });
  });

  it('token endpoint fora do ar vira 502, nao 500 generico', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('timeout'));

    await expect(servico().trocarCodigoPorTokens('code-1')).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('sem as variaveis no .env, diz QUAIS faltam antes de chamar a rede', async () => {
    globalThis.fetch = jest.fn();

    await expect(servico({}).trocarCodigoPorTokens('code-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('variavel declarada e VAZIA conta como ausente (regressao do bug do LTI)', async () => {
    globalThis.fetch = jest.fn();

    const vazio = servico({ ...CONFIG_COMPLETA, D2L_CLIENT_SECRET: '' });

    await expect(vazio.trocarCodigoPorTokens('code-1')).rejects.toMatchObject({
      message: expect.stringContaining('D2L_CLIENT_SECRET') as unknown,
    });
  });

  /**
   * A rotacao e o ponto delicado: o Brightspace invalida o refresh token a cada
   * uso. Gravar o novo e obrigatorio, renovar a toa e caro, e renovar duas vezes
   * em paralelo queima um dos dois tokens.
   */
  describe('obterAccessToken', () => {
    it('usa o refresh gravado e persiste o NOVO refresh token', async () => {
      responderCom(200, {
        access_token: 'access-2',
        refresh_token: 'r-2',
        expires_in: 3600,
        scope: 'enrollment:orgunit:read',
      });

      const token = await servico().obterAccessToken();

      expect(findUnique).toHaveBeenCalledWith({ where: { id: 1 } });

      const [, opcoes] = (globalThis.fetch as jest.Mock).mock.calls[0] as [
        string,
        { body: URLSearchParams },
      ];
      expect(opcoes.body.get('grant_type')).toBe('refresh_token');
      expect(opcoes.body.get('refresh_token')).toBe('r-1');
      // Sem isto, o proximo refresh usaria um token ja invalidado.
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { refreshToken: 'r-2' } }),
      );
      expect(token.valor).toBe('access-2');
      expect(token.escopos).toBe('enrollment:orgunit:read');
    });

    it('reaproveita o token em cache em vez de renovar de novo', async () => {
      responderCom(200, {
        access_token: 'access-2',
        refresh_token: 'r-2',
        expires_in: 3600,
      });

      const d2l = servico();
      const primeiro = await d2l.obterAccessToken();
      const segundo = await d2l.obterAccessToken();

      expect(segundo.valor).toBe(primeiro.valor);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('renova quando o token em cache esta perto de expirar', async () => {
      // Menor que a margem de seguranca: usar este token arriscaria expirar no
      // meio da chamada seguinte.
      responderCom(200, {
        access_token: 'quase-vencido',
        refresh_token: 'r-2',
        expires_in: 30,
      });

      const d2l = servico();
      await d2l.obterAccessToken();

      responderCom(200, {
        access_token: 'novinho',
        refresh_token: 'r-3',
        expires_in: 3600,
      });

      expect((await d2l.obterAccessToken()).valor).toBe('novinho');
    });

    it('duas chamadas concorrentes renovam UMA vez so', async () => {
      // Duas renovacoes em paralelo mandariam o mesmo refresh token duas vezes;
      // a segunda receberia invalid_grant depois de a primeira ja ter rotacionado.
      responderCom(200, {
        access_token: 'access-2',
        refresh_token: 'r-2',
        expires_in: 3600,
      });

      const d2l = servico();
      const [a, b] = await Promise.all([
        d2l.obterAccessToken(),
        d2l.obterAccessToken(),
      ]);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(a.valor).toBe(b.valor);
    });

    it('sem autorizacao previa, manda autorizar em vez de falhar na rede', async () => {
      findUnique.mockResolvedValue(null);
      globalThis.fetch = jest.fn();

      await expect(servico().obterAccessToken()).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refresh token invalidado pede REAUTORIZACAO, nao retry', async () => {
      responderCom(400, { error: 'invalid_grant' });

      await expect(servico().obterAccessToken()).rejects.toMatchObject({
        message: expect.stringContaining('reautorizar') as unknown,
      });
      expect(registrar).toHaveBeenCalledWith(
        'D2L_TOKEN_RENOVACAO_FALHOU',
        expect.anything(),
      );
    });

    it('uma renovacao que falha nao trava as proximas tentativas', async () => {
      responderCom(500, { error: 'server_error' });

      const d2l = servico();
      await expect(d2l.obterAccessToken()).rejects.toThrow();

      responderCom(200, {
        access_token: 'access-2',
        refresh_token: 'r-2',
        expires_in: 3600,
      });

      // Se a promessa em voo nao fosse limpa no erro, esta chamada devolveria a
      // falha anterior para sempre.
      expect((await d2l.obterAccessToken()).valor).toBe('access-2');
    });

    it('nao exige D2L_REDIRECT_URI: o refresh nao tem redirect', async () => {
      responderCom(200, {
        access_token: 'access-2',
        refresh_token: 'r-2',
        expires_in: 3600,
      });

      const semRedirect = servico({
        D2L_CLIENT_ID: 'cliente-123',
        D2L_CLIENT_SECRET: 'segredo-abc',
      });

      await expect(semRedirect.obterAccessToken()).resolves.toMatchObject({
        valor: 'access-2',
      });
    });
  });
});
