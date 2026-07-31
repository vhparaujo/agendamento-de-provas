import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { BCRYPT_ROUNDS } from '../../auth/service/auth.service';

export interface AdminResumo {
  id: string;
  email: string;
  nome: string | null;
  ativo: boolean;
  mustChangePassword: boolean;
  ultimoLogin: Date | null;
  createdAt: Date;
}

const SELECAO = {
  id: true,
  email: true,
  nome: true,
  ativo: true,
  mustChangePassword: true,
  ultimoLogin: true,
  createdAt: true,
} as const;

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  listar(): Promise<AdminResumo[]> {
    return this.prisma.admin.findMany({
      select: SELECAO,
      orderBy: { createdAt: 'asc' },
    });
  }

  async criar(dados: {
    email: string;
    nome?: string;
    senha?: string;
  }): Promise<{ admin: AdminResumo; senhaProvisoria?: string }> {
    const jaExiste = await this.prisma.admin.findUnique({
      where: { email: dados.email },
    });

    if (jaExiste) {
      throw new ConflictException('Ja existe um administrador com este e-mail');
    }

    // Senha informada ou gerada: nos dois casos a troca e obrigatoria no
    // primeiro acesso, para que ninguem alem do dono conheca a senha final.
    const senhaProvisoria = dados.senha ?? gerarSenhaProvisoria();

    const admin = await this.prisma.admin.create({
      data: {
        email: dados.email,
        nome: dados.nome,
        senhaHash: await bcrypt.hash(senhaProvisoria, BCRYPT_ROUNDS),
        mustChangePassword: true,
      },
      select: SELECAO,
    });

    // Devolvida uma unica vez; nunca fica recuperavel depois.
    return dados.senha ? { admin } : { admin, senhaProvisoria };
  }

  /** Reset administrativo: um admin gera senha provisoria para outro. */
  async resetarSenha(
    id: string,
    solicitanteId: string,
  ): Promise<{ admin: AdminResumo; senhaProvisoria: string }> {
    const alvo = await this.prisma.admin.findUnique({ where: { id } });

    if (!alvo) throw new NotFoundException('Administrador nao encontrado');

    const senhaProvisoria = gerarSenhaProvisoria();

    const admin = await this.prisma.admin.update({
      where: { id },
      data: {
        senhaHash: await bcrypt.hash(senhaProvisoria, BCRYPT_ROUNDS),
        mustChangePassword: true,
        resetToken: null,
        resetTokenExpiry: null,
      },
      select: SELECAO,
    });

    void solicitanteId; // reservado para auditoria futura

    return { admin, senhaProvisoria };
  }

  async definirAtivo(
    id: string,
    ativo: boolean,
    solicitanteId: string,
  ): Promise<AdminResumo> {
    if (id === solicitanteId && !ativo) {
      throw new BadRequestException(
        'Um administrador nao pode desativar a si mesmo',
      );
    }

    const existe = await this.prisma.admin.findUnique({ where: { id } });
    if (!existe) throw new NotFoundException('Administrador nao encontrado');

    // Nunca deixar o sistema sem nenhum admin ativo.
    if (!ativo) {
      const ativosRestantes = await this.prisma.admin.count({
        where: { ativo: true, id: { not: id } },
      });

      if (ativosRestantes === 0) {
        throw new BadRequestException(
          'Nao e possivel desativar o ultimo administrador ativo',
        );
      }
    }

    return this.prisma.admin.update({
      where: { id },
      data: { ativo },
      select: SELECAO,
    });
  }
}

/** Senha provisoria legivel para ser repassada por telefone/e-mail interno. */
function gerarSenhaProvisoria(): string {
  return randomBytes(9).toString('base64url');
}
