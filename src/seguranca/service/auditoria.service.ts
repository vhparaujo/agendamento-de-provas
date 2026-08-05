import { Injectable, Logger } from '@nestjs/common';

/**
 * Eventos de seguranca auditaveis (ASVS 5.0 16.3.1–16.3.4).
 *
 * A lista e fechada de proposito: evento novo entra aqui, e nao como string
 * solta espalhada pelos services. Assim da para grepar tudo que e auditado num
 * lugar so, e o log fica consultavel por nome de evento.
 */
export type EventoSeguranca =
  | 'LOGIN_OK'
  | 'LOGIN_FALHOU'
  | 'REFRESH_OK'
  | 'REFRESH_FALHOU'
  | 'SENHA_TROCADA'
  | 'SENHA_TROCA_FALHOU'
  | 'ADMIN_CRIADO'
  | 'ADMIN_SENHA_RESETADA'
  | 'ADMIN_ATIVO_ALTERADO'
  | 'LTI_LAUNCH_OK'
  | 'LTI_LAUNCH_RECUSADO'
  // Troca do codigo do redirect pelo token, feita pelo portal do aluno.
  | 'LTI_SESSAO_OK'
  | 'LTI_SESSAO_RECUSADA'
  | 'AGENDAMENTO_CRIADO'
  | 'AGENDAMENTO_RECUSADO'
  | 'AGENDAMENTO_REMANEJADO'
  | 'AGENDAMENTO_CANCELADO'
  | 'D2L_AUTORIZACAO_OK'
  | 'D2L_AUTORIZACAO_FALHOU'
  | 'D2L_TOKEN_RENOVADO'
  | 'D2L_TOKEN_RENOVACAO_FALHOU'
  | 'ACESSO_NEGADO'
  | 'LIMITE_REQUISICOES'
  | 'ROTA_SEM_CONTROLE_DE_ACESSO'
  | 'ERRO_INTERNO';

export interface ContextoEvento {
  /** Quem: e-mail do admin, matricula do aluno, ou undefined se anonimo. */
  ator?: string;
  /** Onde: metodo + rota. */
  rota?: string;
  ip?: string;
  /** O que mais importar para investigar depois. Nunca senha, token ou hash. */
  detalhe?: string;
  /** Correlaciona a linha de log com o id devolvido ao cliente num 500. */
  erroId?: string;
}

/**
 * Campos que NUNCA podem ser passados em `detalhe`. Nao ha checagem automatica
 * — e disciplina de quem chama. Documentado aqui para nao restar duvida:
 * senha, senha provisoria, hash, access token, refresh token, id_token do LTI.
 */
@Injectable()
export class AuditoriaService {
  private readonly logger = new Logger('Seguranca');

  /**
   * Uma linha JSON por evento, com quando/onde/quem/o-que (ASVS 16.2.1).
   *
   * Formato estruturado porque log de seguranca serve para ser consultado, nao
   * lido: `grep LOGIN_FALHOU | jq` responde "quantas tentativas contra este
   * e-mail na ultima hora" sem parsear texto livre.
   */
  registrar(evento: EventoSeguranca, contexto: ContextoEvento = {}): void {
    const linha = JSON.stringify({
      evento,
      quando: new Date().toISOString(),
      ator: limpar(contexto.ator),
      rota: limpar(contexto.rota),
      ip: limpar(contexto.ip),
      detalhe: limpar(contexto.detalhe),
      erroId: contexto.erroId,
    });

    if (EVENTOS_DE_FALHA.has(evento)) {
      this.logger.warn(linha);
      return;
    }

    this.logger.log(linha);
  }
}

const EVENTOS_DE_FALHA = new Set<EventoSeguranca>([
  'LOGIN_FALHOU',
  'REFRESH_FALHOU',
  'SENHA_TROCA_FALHOU',
  'LTI_LAUNCH_RECUSADO',
  'LTI_SESSAO_RECUSADA',
  'AGENDAMENTO_RECUSADO',
  'D2L_AUTORIZACAO_FALHOU',
  'D2L_TOKEN_RENOVACAO_FALHOU',
  'ACESSO_NEGADO',
  'LIMITE_REQUISICOES',
  'ROTA_SEM_CONTROLE_DE_ACESSO',
  'ERRO_INTERNO',
]);

/**
 * Neutraliza log injection (ASVS 16.4.1). Boa parte do que chega aqui vem do
 * cliente — e-mail do login, rota, User-Agent. Sem isso, um "e-mail" contendo
 * `\n{"evento":"LOGIN_OK"...}` forjaria uma linha de auditoria inteira e
 * envenenaria qualquer investigacao futura.
 *
 * O JSON.stringify ja escaparia as aspas e quebras, mas a limpeza acontece
 * antes de proposito: o dia em que alguem trocar o formato do log por texto
 * simples, a protecao continua de pe.
 */
function limpar(valor?: string): string | undefined {
  if (valor === undefined) return undefined;

  return (
    valor
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, 300)
      .trim()
  );
}
