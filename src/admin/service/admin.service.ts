import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { NivelAdmin } from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { BCRYPT_ROUNDS } from '../../auth/service/auth.service';

export interface Admin {
  id: string;
  email: string;
  nome: string | null;
  nivel: NivelAdmin;
  ativo: boolean;
  mustChangePassword: boolean;
  ultimoLogin: Date | null;
  createdAt: Date;
}

const SELECAO = {
  id: true,
  email: true,
  nome: true,
  nivel: true,
  ativo: true,
  mustChangePassword: true,
  ultimoLogin: true,
  createdAt: true,
} as const;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  listar(): Promise<Admin[]> {
    return this.prisma.admin.findMany({
      select: SELECAO,
      orderBy: { createdAt: 'asc' },
    });
  }

  async criar(dados: {
    email: string;
    nome?: string;
    nivel: NivelAdmin;
    senha?: string;
  }): Promise<{ admin: Admin; senhaProvisoria?: string }> {
    const jaExiste = await this.prisma.admin.findUnique({
      where: { email: dados.email },
    });

    if (jaExiste) {
      throw new ConflictException(
        'Já existe um administrador com este e-mail.',
      );
    }

    // Senha informada ou gerada: nos dois casos a troca e obrigatoria no
    // primeiro acesso, para que ninguem alem do dono conheca a senha final.
    const senhaProvisoria = dados.senha ?? gerarSenhaProvisoria();

    const admin = await this.prisma.admin.create({
      data: {
        email: dados.email,
        nome: dados.nome,
        nivel: dados.nivel,
        senhaHash: await bcrypt.hash(senhaProvisoria, BCRYPT_ROUNDS),
        mustChangePassword: true,
      },
      select: SELECAO,
    });

    // O nivel entra no detalhe porque criar um SUPERADMIN e a acao mais forte
    // do sistema: quem investigar "quem deu acesso total a esta conta?" precisa
    // da resposta sem cruzar com o estado atual da tabela, que muda.
    this.auditoria.registrar('ADMIN_CRIADO', {
      detalhe:
        `novo admin ${admin.email} como ${admin.nivel} ` +
        `(senha ${dados.senha ? 'informada' : 'gerada'})`,
    });

    // Devolvida uma unica vez; nunca fica recuperavel depois.
    return dados.senha ? { admin } : { admin, senhaProvisoria };
  }

  /** Reset administrativo: um admin gera senha provisoria para outro. */
  async resetarSenha(
    id: string,
    solicitanteId: string,
  ): Promise<{ admin: Admin; senhaProvisoria: string }> {
    const alvo = await this.prisma.admin.findUnique({ where: { id } });

    if (!alvo)
      throw new NotFoundException(
        'Administrador não encontrado. Atualize a página e tente de novo.',
      );

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

    this.auditoria.registrar('ADMIN_SENHA_RESETADA', {
      ator: solicitanteId,
      detalhe: `senha de ${admin.email} resetada`,
    });

    return { admin, senhaProvisoria };
  }

  async definirAtivo(
    id: string,
    ativo: boolean,
    solicitanteId: string,
  ): Promise<Admin> {
    if (id === solicitanteId && !ativo) {
      throw new BadRequestException(
        'Um administrador não pode desativar a si mesmo.',
      );
    }

    const existe = await this.prisma.admin.findUnique({ where: { id } });
    if (!existe)
      throw new NotFoundException(
        'Administrador não encontrado. Atualize a página e tente de novo.',
      );

    // Nunca deixar o sistema sem nenhum admin ativo.
    if (!ativo) {
      await this.exigirOutroSuperadminAtivo(
        existe,
        'Não é possível desativar o último superadministrador ativo. ' +
          'Promova outra pessoa a superadministrador antes.',
      );

      const ativosRestantes = await this.prisma.admin.count({
        where: { ativo: true, id: { not: id } },
      });

      if (ativosRestantes === 0) {
        throw new BadRequestException(
          'Não é possível desativar o último administrador ativo.',
        );
      }
    }

    const atualizado = await this.prisma.admin.update({
      where: { id },
      data: { ativo },
      select: SELECAO,
    });

    this.auditoria.registrar('ADMIN_ATIVO_ALTERADO', {
      ator: solicitanteId,
      detalhe: `${atualizado.email} -> ativo=${ativo}`,
    });

    return atualizado;
  }

  /**
   * Troca o nivel de acesso de outro admin. So superadmin chega aqui (a rota
   * nao tem `@NiveisPermitidos`), e as duas travas abaixo sao o que impede o
   * sistema de ficar sem ninguem capaz de conceder acesso.
   */
  async definirNivel(
    id: string,
    nivel: NivelAdmin,
    solicitanteId: string,
  ): Promise<Admin> {
    /**
     * Ninguem muda o proprio nivel — a mesma familia da trava de auto-
     * desativacao, e pelo mesmo motivo: um superadmin que se rebaixasse por
     * engano perderia, no mesmo clique, a unica tela capaz de desfazer isso.
     * Nao ha caso legitimo: quem quer sair de superadmin pede a outro.
     */
    if (id === solicitanteId) {
      throw new BadRequestException(
        'Um administrador não pode alterar o próprio nível de acesso. ' +
          'Peça a outro superadministrador.',
      );
    }

    const alvo = await this.prisma.admin.findUnique({ where: { id } });

    if (!alvo)
      throw new NotFoundException(
        'Administrador não encontrado. Atualize a página e tente de novo.',
      );

    if (alvo.nivel === nivel) return this.projetar(id);

    if (nivel !== NivelAdmin.SUPERADMIN) {
      await this.exigirOutroSuperadminAtivo(
        alvo,
        'Não é possível rebaixar o último superadministrador ativo. ' +
          'Promova outra pessoa antes.',
      );
    }

    const atualizado = await this.prisma.admin.update({
      where: { id },
      data: { nivel },
      select: SELECAO,
    });

    this.auditoria.registrar('ADMIN_NIVEL_ALTERADO', {
      ator: solicitanteId,
      detalhe: `${atualizado.email}: ${alvo.nivel} -> ${nivel}`,
    });

    return atualizado;
  }

  /**
   * Recusa mexer no ALVO quando ele e o unico superadmin ativo que sobrou.
   *
   * Sem superadmin ativo ninguem cria admin, reseta senha nem concede nivel: o
   * sistema fica com telas funcionando e SEM caminho de volta, e o conserto
   * passa a ser um UPDATE no banco. A conta ignora o proprio alvo de proposito
   * — a pergunta e "sobra alguem depois desta mudanca?".
   */
  private async exigirOutroSuperadminAtivo(
    alvo: { id: string; nivel: NivelAdmin; ativo: boolean },
    mensagem: string,
  ): Promise<void> {
    if (alvo.nivel !== NivelAdmin.SUPERADMIN || !alvo.ativo) return;

    const outros = await this.prisma.admin.count({
      where: {
        ativo: true,
        nivel: NivelAdmin.SUPERADMIN,
        id: { not: alvo.id },
      },
    });

    if (outros === 0) throw new BadRequestException(mensagem);
  }

  /** O alvo na projecao publica, sem repetir o `select` em cada saida. */
  private projetar(id: string): Promise<Admin> {
    return this.prisma.admin.findUniqueOrThrow({
      where: { id },
      select: SELECAO,
    });
  }
}

/** Senha provisoria legivel para ser repassada por telefone/e-mail interno. */
function gerarSenhaProvisoria(): string {
  return randomBytes(9).toString('base64url');
}
