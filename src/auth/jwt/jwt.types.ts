import { Perfil } from '../../enums/perfil.enum';

/** Payload do access token de admin. */
export interface AdminJwtPayload {
  sub: string; // Admin.id
  email: string;
  perfil: Perfil.ADMIN;
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
 * e Psicologia/Hibrido) e agenda uma prova para cada.
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
}

/** Usuario autenticado anexado a request pelos guards. */
export type UsuarioAutenticado =
  | (AdminJwtPayload & { perfil: Perfil.ADMIN })
  | (AlunoJwtPayload & { perfil: Perfil.ALUNO });
