import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { Perfil } from '../../enums/perfil.enum';
import { NivelAdmin } from '../../generated/prisma/client';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import {
  AdminJwtPayload,
  AdminRefreshPayload,
  AlunoJwtPayload,
} from '../jwt/jwt.types';

export const BCRYPT_ROUNDS = 12;

/**
 * Hash descartavel usado quando o e-mail nao existe. Comparar contra ele mantem
 * o custo do login constante, para que o tempo de resposta nao revele se um
 * e-mail esta cadastrado (enumeracao de usuarios).
 */
const HASH_FALSO = bcrypt.hashSync('senha-inexistente', BCRYPT_ROUNDS);

/**
 * `expiresIn` do jsonwebtoken tem um tipo literal ("15m" | "7d" | ...) que uma
 * string vinda do .env nao satisfaz em tempo de compilacao. O valor e validado
 * pela propria lib em runtime; aqui so estreitamos o tipo.
 */
type Duracao = JwtSignOptions['expiresIn'];
const duracao = (valor: string | undefined, padrao: string): Duracao =>
  (valor ?? padrao) as Duracao;

export interface TokensAdmin {
  accessToken: string;
  refreshToken: string;
  mustChangePassword: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async loginAdmin(email: string, senha: string): Promise<TokensAdmin> {
    const admin = await this.prisma.admin.findUnique({ where: { email } });

    // Mesma mensagem para e-mail inexistente, senha errada e conta inativa:
    // qualquer diferenca vira um oraculo para descobrir e-mails validos.
    const senhaConfere = await bcrypt.compare(
      senha,
      admin?.senhaHash ?? HASH_FALSO,
    );

    if (!admin || !admin.ativo || !senhaConfere) {
      // O log distingue o motivo real; a RESPOSTA continua uniforme. Quem
      // investiga precisa saber se foi conta inexistente ou senha errada; o
      // atacante nao pode saber (ASVS 16.3.1 sem virar oraculo de enumeracao).
      this.auditoria.registrar('LOGIN_FALHOU', {
        ator: email,
        detalhe: !admin
          ? 'e-mail nao cadastrado'
          : !admin.ativo
            ? 'conta inativa'
            : 'senha incorreta',
      });

      throw new UnauthorizedException('E-mail ou senha inválidos.');
    }

    this.auditoria.registrar('LOGIN_OK', { ator: email });

    await this.prisma.admin.update({
      where: { id: admin.id },
      data: { ultimoLogin: new Date() },
    });

    return this.emitirTokensAdmin(admin);
  }

  async refreshAdmin(refreshToken: string): Promise<TokensAdmin> {
    let payload: AdminRefreshPayload;

    try {
      payload = await this.jwt.verifyAsync<AdminRefreshPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      this.auditoria.registrar('REFRESH_FALHOU', {
        detalhe: 'assinatura invalida ou token expirado',
      });

      throw new UnauthorizedException('Sua sessão expirou. Entre novamente.');
    }

    // Um access token nao pode ser trocado por tokens novos.
    if (payload.tipo !== 'refresh' || payload.perfil !== Perfil.ADMIN) {
      // Tentativa de usar access token como refresh: quase sempre intencional.
      this.auditoria.registrar('REFRESH_FALHOU', {
        ator: payload.sub,
        detalhe: 'token nao e do tipo refresh de admin',
      });

      throw new UnauthorizedException(
        'Sua sessão não é válida. Entre novamente.',
      );
    }

    const admin = await this.prisma.admin.findUnique({
      where: { id: payload.sub },
    });

    if (!admin || !admin.ativo) {
      this.auditoria.registrar('REFRESH_FALHOU', {
        ator: payload.sub,
        detalhe: 'admin inativo ou inexistente',
      });

      throw new UnauthorizedException(
        'Sua conta de administrador está inativa ou não existe mais. Procure outro administrador.',
      );
    }

    this.auditoria.registrar('REFRESH_OK', { ator: admin.email });

    return this.emitirTokensAdmin(admin);
  }

  async trocarSenha(
    adminId: string,
    senhaAtual: string,
    novaSenha: string,
  ): Promise<{ mensagem: string }> {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
    });

    if (!admin || !admin.ativo) {
      throw new UnauthorizedException(
        'Sua conta de administrador está inativa ou não existe mais. Procure outro administrador.',
      );
    }

    if (!(await bcrypt.compare(senhaAtual, admin.senhaHash))) {
      this.auditoria.registrar('SENHA_TROCA_FALHOU', {
        ator: admin.email,
        detalhe: 'senha atual incorreta',
      });

      throw new UnauthorizedException('Senha atual incorreta.');
    }

    if (await bcrypt.compare(novaSenha, admin.senhaHash)) {
      throw new BadRequestException(
        'A nova senha deve ser diferente da atual.',
      );
    }

    await this.prisma.admin.update({
      where: { id: admin.id },
      data: {
        senhaHash: await bcrypt.hash(novaSenha, BCRYPT_ROUNDS),
        mustChangePassword: false,
        // campos de reset por e-mail existem no schema, mas ficam fora do MVP
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    this.auditoria.registrar('SENHA_TROCADA', { ator: admin.email });

    return { mensagem: 'Senha alterada com sucesso.' };
  }

  /** JWT interno do aluno — curto, so para navegacao no portal. */
  async emitirTokenAluno(
    dados: Omit<AlunoJwtPayload, 'perfil'>,
  ): Promise<{ accessToken: string; expiraEm: string }> {
    const expiraEm = this.config.get<string>('JWT_ALUNO_EXPIRES_IN') ?? '2h';

    const accessToken = await this.jwt.signAsync(
      { ...dados, perfil: Perfil.ALUNO } satisfies AlunoJwtPayload,
      {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        expiresIn: duracao(expiraEm, '2h'),
      },
    );

    return { accessToken, expiraEm };
  }

  /**
   * ⚠️ O `nivel` vai no ACCESS token e NAO no refresh.
   *
   * O refresh e trocado relendo o admin do banco, entao o nivel do proximo par
   * sai de la — e por isso rebaixar alguem passa a valer em no maximo 15 min,
   * sem ninguem precisar deslogar a pessoa. Grava-lo no refresh congelaria o
   * nivel por 7 dias.
   */
  private async emitirTokensAdmin(admin: {
    id: string;
    email: string;
    nome: string | null;
    nivel: NivelAdmin;
    mustChangePassword: boolean;
  }): Promise<TokensAdmin> {
    const accessPayload: AdminJwtPayload = {
      sub: admin.id,
      email: admin.email,
      nome: admin.nome,
      perfil: Perfil.ADMIN,
      nivel: admin.nivel,
      mustChangePassword: admin.mustChangePassword,
    };

    const refreshPayload: AdminRefreshPayload = {
      sub: admin.id,
      perfil: Perfil.ADMIN,
      tipo: 'refresh',
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        expiresIn: duracao(this.config.get<string>('JWT_EXPIRES_IN'), '15m'),
      }),
      this.jwt.signAsync(refreshPayload, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: duracao(
          this.config.get<string>('JWT_REFRESH_EXPIRES_IN'),
          '7d',
        ),
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      mustChangePassword: admin.mustChangePassword,
    };
  }
}
