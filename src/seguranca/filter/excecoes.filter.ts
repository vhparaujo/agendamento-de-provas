import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { AuditoriaService } from '../service/auditoria.service';
import { extrairAtor, extrairIp } from '../requisicao.util';
import { corpoAmigavel } from './mensagens-amigaveis';

/**
 * Filtro global. Faz duas coisas que a resposta padrao do Nest nao faz:
 *
 * 1. **Audita** 401/403/429 como evento de seguranca (ASVS 16.3.1–16.3.2).
 *    Sem isto, um ataque de forca bruta ou uma varredura de rotas nao deixa
 *    rastro nenhum.
 * 2. **Fecha o 500** (OWASP A10). Erro inesperado devolve mensagem generica +
 *    um `erroId`; o stack fica no log, correlacionado pelo mesmo id. O usuario
 *    reporta o id, o time acha a linha — sem expor internals do servidor.
 *
 * Erros de negocio (400/404/409...) passam intactos: a mensagem deles E o
 * contrato com o front. So as mensagens automaticas do Nest/class-validator,
 * em ingles, sao trocadas por texto para leigo (`mensagens-amigaveis.ts`).
 */
@Catch()
export class ExcecoesFilter implements ExceptionFilter {
  private readonly logger = new Logger('Excecao');

  constructor(private readonly auditoria: AuditoriaService) {}

  catch(excecao: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // Tipado como HttpStatus (e nao `number`) para que as comparacoes abaixo
    // sejam checadas pelo compilador contra o enum, nao contra um numero solto.
    const status: HttpStatus =
      excecao instanceof HttpException
        ? excecao.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const contexto = {
      ator: extrairAtor(req),
      rota: `${req.method} ${req.originalUrl}`,
      ip: extrairIp(req),
    };

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.responderErroInterno(excecao, res, contexto);
      return;
    }

    this.auditarSeRelevante(status, excecao, contexto);

    res.status(status).json(
      excecao instanceof HttpException
        ? corpoAmigavel(excecao.getResponse(), status)
        : {
            statusCode: status,
            message: 'Não foi possível concluir. Tente de novo.',
          },
    );
  }

  /**
   * 401/403 = tentativa de acesso barrada. 429 = limite de requisicoes.
   * Os tres sao sinal de ataque quando se repetem; por isso viram evento
   * nomeado, e nao apenas uma linha de log qualquer.
   */
  private auditarSeRelevante(
    status: HttpStatus,
    excecao: unknown,
    contexto: { ator?: string; rota: string; ip?: string },
  ): void {
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      this.auditoria.registrar('LIMITE_REQUISICOES', contexto);
      return;
    }

    if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
      this.auditoria.registrar('ACESSO_NEGADO', {
        ...contexto,
        detalhe: `${status}: ${mensagemDe(excecao)}`,
      });
    }
  }

  private responderErroInterno(
    excecao: unknown,
    res: Response,
    contexto: { ator?: string; rota: string; ip?: string },
  ): void {
    const erroId = randomUUID();

    this.auditoria.registrar('ERRO_INTERNO', {
      ...contexto,
      erroId,
      detalhe: mensagemDe(excecao),
    });

    // O stack vai para o log da aplicacao, nunca para a resposta.
    this.logger.error(
      `erroId=${erroId} ${contexto.rota}`,
      excecao instanceof Error ? excecao.stack : String(excecao),
    );

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message:
        'Ocorreu um erro inesperado. Tente de novo em instantes; se continuar, ' +
        'informe ao suporte o código abaixo.',
      erroId,
    });
  }
}

/**
 * Extrai um texto curto da excecao para a linha de auditoria.
 *
 * O corpo de uma HttpException pode ser string, objeto com `message`, ou array
 * de mensagens (e o formato do ValidationPipe quando varios campos falham).
 * Cada caso e tratado explicitamente: um `String(objeto)` aqui viraria
 * "[object Object]" no log, inutil justamente quando alguem for investigar.
 */
function mensagemDe(excecao: unknown): string {
  if (excecao instanceof HttpException) {
    const corpo = excecao.getResponse();

    if (typeof corpo === 'string') return corpo;

    const mensagem = (corpo as { message?: unknown }).message;

    if (Array.isArray(mensagem)) return mensagem.map(textoDe).join('; ');
    if (typeof mensagem === 'string') return mensagem;

    return excecao.message;
  }

  return excecao instanceof Error ? excecao.message : textoDe(excecao);
}

function textoDe(valor: unknown): string {
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') {
    return String(valor);
  }

  return JSON.stringify(valor) ?? 'desconhecido';
}
