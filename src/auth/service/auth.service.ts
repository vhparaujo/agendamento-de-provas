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
      throw new UnauthorizedException('Credenciais invalidas');
    }

    await this.prisma.admin.update({
      where: { id: admin.id },
      data: { ultimoLogin: new Date() },
    });

    return this.emitirTokensAdmin(
      admin.id,
      admin.email,
      admin.mustChangePassword,
    );
  }

  async refreshAdmin(refreshToken: string): Promise<TokensAdmin> {
    let payload: AdminRefreshPayload;

    try {
      payload = await this.jwt.verifyAsync<AdminRefreshPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token invalido ou expirado');
    }

    // Um access token nao pode ser trocado por tokens novos.
    if (payload.tipo !== 'refresh' || payload.perfil !== Perfil.ADMIN) {
      throw new UnauthorizedException('Refresh token invalido');
    }

    const admin = await this.prisma.admin.findUnique({
      where: { id: payload.sub },
    });

    if (!admin || !admin.ativo) {
      throw new UnauthorizedException('Administrador inativo ou inexistente');
    }

    return this.emitirTokensAdmin(
      admin.id,
      admin.email,
      admin.mustChangePassword,
    );
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
      throw new UnauthorizedException('Administrador inativo ou inexistente');
    }

    if (!(await bcrypt.compare(senhaAtual, admin.senhaHash))) {
      throw new UnauthorizedException('Senha atual incorreta');
    }

    if (await bcrypt.compare(novaSenha, admin.senhaHash)) {
      throw new BadRequestException('A nova senha deve ser diferente da atual');
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

    return { mensagem: 'Senha alterada com sucesso' };
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

  private async emitirTokensAdmin(
    id: string,
    email: string,
    mustChangePassword: boolean,
  ): Promise<TokensAdmin> {
    const accessPayload: AdminJwtPayload = {
      sub: id,
      email,
      perfil: Perfil.ADMIN,
      mustChangePassword,
    };

    const refreshPayload: AdminRefreshPayload = {
      sub: id,
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

    return { accessToken, refreshToken, mustChangePassword };
  }
}
