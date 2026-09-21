import { Perfil } from '../../enums/perfil.enum';
import { NivelAdmin } from '../../generated/prisma/client';

/** Payload do access token de admin. */
export interface AdminJwtPayload {
  sub: string; // Admin.id
  email: string;
  /**
   * Como o admin e chamado na tela ("Bem-vindo, Fulano"). Opcional no cadastro,
   * e ausente em token emitido antes deste campo existir — leia com `?? null`.
   * Renomear no banco so aparece no proximo refresh (no maximo 15 min).
   */
  nome?: string | null;
  perfil: Perfil.ADMIN;
  /**
   * O QUE este admin pode fazer (21/09/2026). Ver src/auth/jwt/niveis.ts.
   *
   * Opcional so por causa dos tokens emitidos ANTES de o nivel existir: ausente,
   * ele nao vale como superadmin — a estrategia recusa o token com 401 e o front
   * troca por um novo no refresh, que le o nivel do banco. Fechar aqui e o que
   * impede um access token velho de continuar abrindo tudo por 15 minutos.
   *
   * Trocar o nivel de alguem so aparece no proximo refresh (no maximo 15 min),
   * como o `nome`.
   */
  nivel?: NivelAdmin;
  mustChangePassword: boolean;
}

/** Payload do refresh token de admin (assinado com JWT_REFRESH_SECRET). */
export interface AdminRefreshPayload {
  sub: string;
  perfil: Perfil.ADMIN;
  tipo: 'refresh';
}

/**
 * Um vinculo = aluno + curso. Um mesmo RA pode ter mais de um (ex: Pedagogia/EaD
 * e Psicologia/Modular) e agenda uma prova para cada.
 */
export interface VinculoToken {
  alunoId: number; // AlunoImportado.id
  curso: string;
  modalidade: string; // Modalidade.codigo — define a duracao da prova
  poloId: number;
  /** Pode agendar? Derivado do STATUS CURSO (src/enums/status-curso.enum.ts). */
  ativo: boolean;
}

/**
 * A turma de onde o aluno clicou o link de agendamento (claim `context` do LTI).
 *
 * Os TRES campos importam, e por motivos diferentes:
 * - `codigo`  (`context.label`) — chave de busca no CSV de turmas. **Vem vazio
 *   neste tenant**; nesse caso sai do fim do `title` ("NOME - CODIGO"), ver
 *   `extrairCodigoDoTitulo`;
 * - `titulo`  (`context.title`) — desempata quando o codigo de turma se repete;
 * - `orgUnitId` (`context.id`)  — identificador no D2L, gravado no agendamento.
 *
 * O CSV de turmas NAO traz orgUnitId: o cruzamento e por codigo + disciplina.
 */
export interface ContextoLaunch {
  orgUnitId: string;
  codigo?: string;
  titulo?: string;
}

/**
 * Payload do JWT interno do aluno. Curta duracao e SO para manter a navegacao no
 * portal — a fonte de verdade dos dados do aluno continua sendo o cruzamento
 * matricula x CSV, nunca o que o cliente manda.
 *
 * Os vinculos vao DENTRO do token justamente para que o agendamento possa
 * verificar que o alunoId escolhido pelo portal pertence mesmo a esta matricula,
 * sem confiar em nada que venha do cliente.
 */
export interface AlunoJwtPayload {
  sub: string; // matricula (RA)
  perfil: Perfil.ALUNO;
  userIdD2L: string; // UserId numerico do Valence, vindo do launch
  vinculos: VinculoToken[]; // 1..n
  /** Ausente quando o launch nao trouxe o claim `context`. */
  contexto?: ContextoLaunch;
}

/**
 * Quem chama pela API key de integracao: um SISTEMA, nao uma pessoa. Nao e JWT —
 * mora aqui porque e o que o `ApiKeyIntegracaoGuard` grava em `req.user`, ao lado
 * dos outros dois perfis.
 */
export interface IntegracaoPayload {
  perfil: Perfil.INTEGRACAO;
  /** O nome dado a chave em `INTEGRACAO_API_KEYS` ("emissor-declaracao"). */
  sistema: string;
}

/** Usuario autenticado anexado a request pelos guards. */
export type UsuarioAutenticado =
  | (AdminJwtPayload & { perfil: Perfil.ADMIN })
  | (AlunoJwtPayload & { perfil: Perfil.ALUNO })
  | IntegracaoPayload;
