import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Perfil } from '../../enums/perfil.enum';
import { AuthService } from './auth.service';

const SENHA = 'senha-correta-123';
const CONFIG: Record<string, string> = {
  JWT_SECRET: 'segredo-de-teste-com-tamanho',
  JWT_REFRESH_SECRET: 'outro-segredo-de-teste-grande',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: { admin: { findUnique: jest.Mock; update: jest.Mock } };
  let jwt: JwtService;
  let hash: string;

  beforeAll(async () => {
    hash = await bcrypt.hash(SENHA, 4); // custo baixo só no teste
  });

  beforeEach(async () => {
    prisma = {
      admin: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: new JwtService({}) },
        {
          provide: ConfigService,
          useValue: {
            get: (chave: string) => CONFIG[chave],
            getOrThrow: (chave: string) => CONFIG[chave],
          },
        },
      ],
    }).compile();

    service = modulo.get(AuthService);
    jwt = modulo.get(JwtService);
  });

  const adminAtivo = {
    id: 'admin-1',
    email: 'admin@ucb.br',
    senhaHash: '',
    ativo: true,
    mustChangePassword: false,
  };

  describe('loginAdmin', () => {
    it('emite access + refresh token com credenciais validas', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
      });

      const tokens = await service.loginAdmin('admin@ucb.br', SENHA);

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
      expect(tokens.accessToken).not.toBe(tokens.refreshToken);

      const payload = jwt.verify(tokens.accessToken, {
        secret: CONFIG.JWT_SECRET,
      });
      expect(payload).toMatchObject({ sub: 'admin-1', perfil: Perfil.ADMIN });
    });

    it('registra o ultimo login', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
      });

      await service.loginAdmin('admin@ucb.br', SENHA);

      expect(prisma.admin.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { ultimoLogin: expect.any(Date) } }),
      );
    });

    it('rejeita senha errada', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
      });

      await expect(
        service.loginAdmin('admin@ucb.br', 'senha-errada'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejeita admin inativo mesmo com a senha certa', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
        ativo: false,
      });

      await expect(service.loginAdmin('admin@ucb.br', SENHA)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('nao revela se o e-mail existe: mesma mensagem nos dois casos', async () => {
      prisma.admin.findUnique.mockResolvedValue(null);
      const inexistente = await service
        .loginAdmin('ninguem@ucb.br', SENHA)
        .catch((e: Error) => e.message);

      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
      });
      const senhaErrada = await service
        .loginAdmin('admin@ucb.br', 'errada')
        .catch((e: Error) => e.message);

      expect(inexistente).toBe(senhaErrada);
    });

    it('propaga mustChangePassword para o token', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
        mustChangePassword: true,
      });

      const tokens = await service.loginAdmin('admin@ucb.br', SENHA);

      expect(tokens.mustChangePassword).toBe(true);
      expect(
        jwt.verify(tokens.accessToken, { secret: CONFIG.JWT_SECRET }),
      ).toMatchObject({ mustChangePassword: true });
    });
  });

  describe('refreshAdmin', () => {
    it('troca um refresh token valido por tokens novos', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
      });
      const { refreshToken } = await service.loginAdmin('admin@ucb.br', SENHA);

      await expect(service.refreshAdmin(refreshToken)).resolves.toHaveProperty(
        'accessToken',
      );
    });

    it('recusa um ACCESS token no lugar do refresh', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
      });
      const { accessToken } = await service.loginAdmin('admin@ucb.br', SENHA);

      await expect(service.refreshAdmin(accessToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('recusa refresh de admin desativado depois da emissao', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
      });
      const { refreshToken } = await service.loginAdmin('admin@ucb.br', SENHA);

      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        ativo: false,
      });

      await expect(service.refreshAdmin(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('trocarSenha', () => {
    it('limpa mustChangePassword ao trocar', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
        mustChangePassword: true,
      });

      await service.trocarSenha('admin-1', SENHA, 'nova-senha-forte');

      expect(prisma.admin.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mustChangePassword: false }),
        }),
      );
    });

    it('exige a senha atual correta', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
      });

      await expect(
        service.trocarSenha('admin-1', 'chute', 'nova-senha-forte'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('impede repetir a senha atual', async () => {
      prisma.admin.findUnique.mockResolvedValue({
        ...adminAtivo,
        senhaHash: hash,
      });

      await expect(
        service.trocarSenha('admin-1', SENHA, SENHA),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
