import type { Request } from 'express';
import { Perfil } from '../enums/perfil.enum';
import type { UsuarioAutenticado } from '../auth/jwt/jwt.types';

/**
 * `Express.User` e uma interface vazia — o Passport espera que cada projeto a
 * complete. Em vez de augmentar o namespace global (que afetaria todo o
 * projeto), estreitamos aqui, no unico ponto que precisa: quem escreve em
 * `req.user` sao os nossos guards, e o que eles gravam e sempre um
 * UsuarioAutenticado.
 */
type RequisicaoAutenticada = Request & { user?: UsuarioAutenticado };

/**
 * Quem fez a requisicao, para a trilha de auditoria.
 *
 * Le do `request.user` — que so existe depois do guard, ou seja, so quando o
 * token foi validado. Nunca le de header ou body: o ator precisa ser um fato
 * verificado, nao uma auto-declaracao do cliente.
 */
export function extrairAtor(req: Request): string | undefined {
  const usuario = (req as RequisicaoAutenticada).user;

  if (!usuario) return undefined;

  // `perfil` e o discriminante da uniao: depois do if, o TS sabe quais campos
  // existem em cada ramo.
  if (usuario.perfil === Perfil.ADMIN) {
    return `admin:${usuario.email || usuario.sub}`;
  }

  if (usuario.perfil === Perfil.ALUNO) {
    return `aluno:${usuario.sub}`;
  }

  if (usuario.perfil === Perfil.INTEGRACAO) {
    return `integracao:${usuario.sistema}`;
  }

  return undefined;
}

/**
 * IP de origem.
 *
 * ATENCAO ao publicar atras de proxy/load balancer: sem `trust proxy`, o
 * `req.ip` vira o IP do proxy e TODO o trafego parece vir de um endereco so —
 * o que quebra tanto a auditoria quanto o rate limiting por IP. Com `trust
 * proxy` ligado indevidamente, o cliente falsifica o proprio IP via
 * X-Forwarded-For. Ligue apenas quando houver um proxy confiavel na frente.
 */
export function extrairIp(req: Request): string | undefined {
  return req.ip ?? req.socket?.remoteAddress ?? undefined;
}
