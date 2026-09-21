import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
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

  /**
   * ==========================================================================
   * O ADMIN EDITA A PROPRIA CONTA (21/09/2026)
   * ==========================================================================
   * Nome e e-mail, para os TRES niveis: o perfil e da pessoa, nao do nivel
   * dela. A senha continua em `trocarSenha`, que ja existe.
   *
   * ⚠️ **Trocar o e-mail exige a senha atual, e isso nao e formalidade.** O
   * login e e-mail + senha, entao o e-mail e METADE da credencial. Sem a
   * re-autenticacao, um access token roubado (15 min de vida) bastaria para
   * mudar por qual endereco a conta entra — e o dono legitimo descobriria no
   * proximo login, sem ter como desfazer, porque neste sistema nao ha reset por
   * e-mail: quem repoe o acesso e outro superadministrador (ASVS 5.0, V6).
   *
   * Trocar so o NOME nao pede senha: nao muda credencial nenhuma, e exigi-la ali
   * ensinaria a digitar a senha para qualquer coisa.
   */
  async atualizarPerfil(
    adminId: string,
    dados: { nome?: string; email?: string; senhaAtual?: string },
  ): Promise<{ id: string; email: string; nome: string | null }> {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
    });

    if (!admin || !admin.ativo) {
      throw new UnauthorizedException(
        'Sua conta de administrador está inativa ou não existe mais. Procure outro administrador.',
      );
    }

    const trocaDeEmail =
      dados.email !== undefined && dados.email !== admin.email;

    if (trocaDeEmail) {
      // O DTO ja exige `senhaAtual` quando `email` vem; aqui a conferencia e do
      // VALOR. Mensagem identica a de `trocarSenha`: e o mesmo fato.
      if (!(await bcrypt.compare(dados.senhaAtual ?? '', admin.senhaHash))) {
        this.auditoria.registrar('ADMIN_PERFIL_ALTERACAO_FALHOU', {
          ator: admin.email,
          detalhe: 'senha atual incorreta na troca de e-mail',
        });

        throw new UnauthorizedException('Senha atual incorreta.');
      }

      /**
       * `Admin.email` e unique. A conferencia aqui existe pela MENSAGEM — sem
       * ela o conflito viraria um 500 generico e ninguem saberia o que corrigir.
       *
       * Ela aceita a mesma corrida que `AdminService.criar` ja aceita (dois
       * admins gravando o mesmo e-mail no mesmo instante): sao poucas pessoas, e
       * o unique do banco continua sendo a garantia de verdade.
       *
       * A frase nomeia o motivo em vez de ser vaga como a do login. Ali o
       * anonimo nao pode descobrir quais e-mails existem; aqui quem pergunta ja
       * esta autenticado como administrador da instituicao, e a vaguidao so
       * custaria a quem digitou o endereco de um colega por engano.
       */
      const ocupado = await this.prisma.admin.findUnique({
        where: { email: dados.email! },
      });

      if (ocupado) {
        throw new ConflictException(
          'Já existe um administrador com este e-mail.',
        );
      }
    }

    const nome = dados.nome === undefined ? undefined : dados.nome || null;

    const atualizado = await this.prisma.admin.update({
      where: { id: admin.id },
      data: {
        ...(nome !== undefined ? { nome } : {}),
        ...(trocaDeEmail ? { email: dados.email } : {}),
      },
      select: { id: true, email: true, nome: true },
    });

    /**
     * Auditado sempre que algo muda, e o e-mail sai com o DE e o PARA: ele e a
     * chave pela qual o resto do log de seguranca identifica a pessoa (`ator`),
     * e sem o par a trilha de antes da troca fica orfa.
     */
    this.auditoria.registrar('ADMIN_PERFIL_ALTERADO', {
      ator: admin.email,
      detalhe: [
        trocaDeEmail ? `e-mail ${admin.email} -> ${atualizado.email}` : null,
        nome !== undefined
          ? `nome ${admin.nome ?? '(vazio)'} -> ${nome ?? '(vazio)'}`
          : null,
      ]
        .filter(Boolean)
        .join('; '),
    });

    return atualizado;
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
